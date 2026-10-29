import { SYSTEM, agentActor, type Actor } from "@/core/actor";
import {
  decideCase,
  decideFileCase,
  type CaseCommand,
  type EvidenceInput,
  type FileCaseInput,
} from "@/core/case-decide";
import { buildCase, isSeatedJudgeAgent, type CaseState } from "@/core/case-state";
import type { Clock } from "@/core/clock";
import { CourtError, fail, isCourtError } from "@/core/errors";
import {
  REGISTRY_STREAM,
  SUMMONSES_STREAM,
  caseStream,
  event,
  jurisdictionStream,
  type CourtEvent,
  type LicenceType,
  type RedactionTarget,
  type StoredEvent,
  type WorldEvidenceSource,
} from "@/core/events";
import type { IdGenerator } from "@/core/ids";
import {
  buildJurisdiction,
  decideEnactLaw,
  decideEstablishJurisdiction,
  type EnactLawInput,
  type JurisdictionState,
} from "@/core/jurisdiction";
import { applyRedactions } from "@/core/redaction";
import {
  WorldEventNotKept,
  WorldIdentityProofRejected,
  type EventStore,
  type WorldConnector,
  type WorldProofExpectation,
} from "@/core/ports";
import { opportunitiesForAgent, type Opportunity } from "./projections/tasks";
import type { ReadModels } from "./read-models/types";
import { DEFAULT_DEADLINE_POLICY, validateDeadlinePolicy, type DeadlinePolicy } from "@/core/procedure";
import {
  buildSummonsBook,
  decideAnswerSummons,
  decideIssueSummons,
  requireSummons,
  summonsCodeFrom,
  type SummonsBook,
  type SummonsRecord,
  type SummonsTarget,
} from "@/core/summons";
import {
  buildRegistry,
  decideGrantLicence,
  decideLinkWallet,
  decideLinkWorldIdentity,
  decideRegisterAgent,
  decideRevokeLicence,
  type AgentRecord,
  type RegisterAgentInput,
  type RegistryState,
} from "@/core/registry";

export interface CourtDeps {
  store: EventStore;
  /** Derived query state, kept in step with the store by the projector. */
  readModels: ReadModels;
  clock: Clock;
  ids: IdGenerator;
  connectors?: WorldConnector[];
  /** Policy snapshotted onto newly filed cases. Existing cases keep theirs. */
  deadlinePolicy?: DeadlinePolicy;
}

/**
 * Optimistic-concurrency retries. Hot streams (the registry, a busy case) can
 * see several writers at once, so retries back off with jitter. Each retry
 * re-reads state and re-validates, so it can never apply a stale decision.
 */
const MAX_ATTEMPTS = 8;
const backoffMs = (attempt: number) => Math.min(200, 5 * 2 ** attempt) * (0.5 + Math.random());

/**
 * Application service: loads streams, asks the core to decide, appends the
 * resulting events. REST, MCP and the website all go through this class and
 * never write events themselves.
 */
export class Court {
  private readonly connectors: Map<string, WorldConnector>;
  private readonly policy: DeadlinePolicy;

  constructor(private readonly deps: CourtDeps) {
    this.connectors = new Map((deps.connectors ?? []).map((c) => [c.id, c]));
    this.policy = deps.deadlinePolicy ?? DEFAULT_DEADLINE_POLICY;
    validateDeadlinePolicy(this.policy);
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  /**
   * Registers an agent. `beforeAppend` runs after validation and before the
   * AgentRegistered event is appended (e.g. to store the agent's initial
   * credential first, so an agent can never exist without one). It may run
   * more than once if the append is retried, so it must be idempotent.
   */
  async registerAgent(
    input: Omit<RegisterAgentInput, "agentId">,
    actor: Actor = SYSTEM,
    hooks: { beforeAppend?: (agentId: string) => Promise<void> } = {},
  ): Promise<AgentRecord> {
    const agentId = this.deps.ids.next("agent");
    await this.retrying(async () => {
      const registry = await this.getRegistry();
      const events = decideRegisterAgent(registry, actor, { ...input, agentId });
      await hooks.beforeAppend?.(agentId);
      await this.append([{ streamId: REGISTRY_STREAM, expectedVersion: registry.version, events }], actor);
    });
    return (await this.getRegistry()).agents.get(agentId)!;
  }

  /** Links a wallet the caller already proved it controls (the API checks the signature). */
  async linkWallet(actor: Actor, address: string): Promise<AgentRecord> {
    if (actor.kind !== "agent") fail("NOT_AUTHORIZED", "Only an agent can link a wallet.");
    await this.decideRegistry(actor, (registry) =>
      decideLinkWallet(registry, actor, { agentId: actor.agentId, address }),
    );
    return (await this.getRegistry()).agents.get(actor.agentId)!;
  }

  /** The agent that signs in with this wallet, if any. */
  async agentByWallet(address: string): Promise<string | null> {
    return (await this.getRegistry()).wallets.get(address) ?? null;
  }

  async grantLicence(
    input: { agentId: string; licence: LicenceType; note?: string },
    actor: Actor,
  ): Promise<AgentRecord> {
    await this.decideRegistry(actor, (registry) => decideGrantLicence(registry, actor, input));
    return (await this.getRegistry()).agents.get(input.agentId)!;
  }

  async revokeLicence(
    input: { agentId: string; licence: LicenceType; reason: string },
    actor: Actor,
  ): Promise<AgentRecord> {
    await this.decideRegistry(actor, (registry) => decideRevokeLicence(registry, actor, input));
    return (await this.getRegistry()).agents.get(input.agentId)!;
  }

  /** Whether the connector can verify identity proofs (Phase 6, R1). */
  supportsWorldIdentity(connectorId: string): boolean {
    return typeof this.connectors.get(connectorId)?.verifyIdentityProof === "function";
  }

  /** How an agent obtains a proof from this world, if the connector says. */
  worldIdentityInstructions(connectorId: string, expected: WorldProofExpectation): string | null {
    return this.connectors.get(connectorId)?.identityProofInstructions?.(expected) ?? null;
  }

  /**
   * Verifies a world identity proof through its connector, then links the identity to the acting
   * agent. The connector does the IO; the core decides (one identity per agent, one agent per
   * identity, agents act only for themselves).
   */
  async linkWorldIdentity(
    actor: Actor,
    input: { connectorId: string; proof: string } & WorldProofExpectation,
  ): Promise<AgentRecord> {
    if (actor.kind !== "agent") fail("NOT_AUTHORIZED", "Only an agent can link a world identity.");
    const connector = this.connectors.get(input.connectorId);
    if (!connector?.verifyIdentityProof) {
      fail("VALIDATION_FAILED", `World ${input.connectorId} cannot verify identities here.`, {
        connectorId: input.connectorId,
      });
    }
    let verified;
    try {
      verified = await connector.verifyIdentityProof(input.proof, {
        audience: input.audience,
        nonce: input.nonce,
      });
    } catch (error) {
      if (error instanceof WorldIdentityProofRejected) {
        fail("VALIDATION_FAILED", `The identity proof was rejected: ${error.message}`, {
          field: "proof",
          reason: error.reason,
        });
      }
      throw new CourtError(
        "WORLD_UNAVAILABLE",
        `The ${connector.id} world could not be reached. Try again later.`,
        {
          connectorId: connector.id,
          cause: (error as Error).message,
        },
      );
    }
    await this.decideRegistry(actor, (registry) =>
      decideLinkWorldIdentity(registry, actor, {
        agentId: actor.agentId,
        connectorId: input.connectorId,
        verified,
      }),
    );
    return (await this.getRegistry()).agents.get(actor.agentId)!;
  }

  private async decideRegistry(
    actor: Actor,
    decide: (registry: RegistryState) => CourtEvent[],
  ): Promise<void> {
    await this.retrying(async () => {
      const registry = await this.getRegistry();
      await this.append(
        [{ streamId: REGISTRY_STREAM, expectedVersion: registry.version, events: decide(registry) }],
        actor,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Jurisdictions and law
  // -------------------------------------------------------------------------

  async establishJurisdiction(
    input: { jurisdictionId: string; name: string; casePrefix: string; connectorId?: string | null },
    actor: Actor,
  ): Promise<JurisdictionState> {
    await this.decideJurisdiction(input.jurisdictionId, actor, (state) =>
      decideEstablishJurisdiction(state, actor, input),
    );
    return (await this.getJurisdiction(input.jurisdictionId))!;
  }

  async enactLaw(jurisdictionId: string, input: EnactLawInput, actor: Actor): Promise<JurisdictionState> {
    await this.decideJurisdiction(jurisdictionId, actor, (state) => decideEnactLaw(state, actor, input));
    return (await this.getJurisdiction(jurisdictionId))!;
  }

  private async decideJurisdiction(
    jurisdictionId: string,
    actor: Actor,
    decide: (state: JurisdictionState | null) => CourtEvent[],
  ): Promise<void> {
    await this.retrying(async () => {
      const streamId = jurisdictionStream(jurisdictionId);
      const events = await this.deps.store.readStream(streamId);
      await this.append(
        [{ streamId, expectedVersion: events.length, events: decide(buildJurisdiction(events)) }],
        actor,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Cases
  // -------------------------------------------------------------------------

  async fileCase(
    actor: Actor,
    input: Omit<FileCaseInput, "caseId"> & { jurisdictionId: string },
  ): Promise<CaseState> {
    const caseId = this.deps.ids.next("case");
    const jurisdictionStreamId = jurisdictionStream(input.jurisdictionId);

    const decide = async (world: WorldLookup, ids: IdGenerator) => {
      const jurisdictionEvents = await this.deps.store.readStream(jurisdictionStreamId);
      const jurisdiction = buildJurisdiction(jurisdictionEvents);
      const registry = await this.getRegistry();
      const decision = decideFileCase(
        jurisdiction,
        { actor, now: this.deps.clock.now(), registry, ids, world },
        { ...input, caseId },
        this.policy,
      );
      return { jurisdiction, jurisdictionVersion: jurisdictionEvents.length, decision };
    };

    await this.retrying(async () => {
      // Probe first so ordinary validation errors win over world lookups.
      const probe = await decide(PROBE_WORLD, PROBE_IDS);
      const world = await this.lookupWorldEvidence(probe.jurisdiction!, input.evidence ?? []);
      const { jurisdictionVersion, decision } = await decide(world, this.deps.ids);
      await this.append(
        [
          {
            streamId: jurisdictionStreamId,
            expectedVersion: jurisdictionVersion,
            events: decision.jurisdictionEvents,
          },
          { streamId: caseStream(caseId), expectedVersion: 0, events: decision.caseEvents },
        ],
        actor,
      );
    });
    return (await this.getCase(caseId))!;
  }

  /**
   * Runs every check a filing runs, world evidence included, and stores nothing: no case, no
   * event, no case number used. Fails exactly as `fileCase` would.
   */
  async checkFiling(
    actor: Actor,
    input: Omit<FileCaseInput, "caseId"> & { jurisdictionId: string },
  ): Promise<FilingPreview> {
    const jurisdiction = buildJurisdiction(
      await this.deps.store.readStream(jurisdictionStream(input.jurisdictionId)),
    );
    const registry = await this.getRegistry();
    const decide = (world: WorldLookup) =>
      decideFileCase(
        jurisdiction,
        { actor, now: this.deps.clock.now(), registry, ids: PROBE_IDS, world },
        { ...input, caseId: "case_probe" },
        this.policy,
      );
    // Probe first so ordinary validation errors win over world lookups, as in fileCase.
    decide(PROBE_WORLD);
    const world = await this.lookupWorldEvidence(jurisdiction!, input.evidence ?? []);
    return filingPreview(decide(world).caseEvents, input.evidence?.length ?? 0);
  }

  // -------------------------------------------------------------------------
  // Summonses: a case waiting for a defendant who is not at the court yet
  // -------------------------------------------------------------------------

  /**
   * Issues a summons. The case is validated exactly as a filing would be (laws, wording, evidence,
   * world events), but nothing is filed or published until the summoned agent answers.
   */
  /** The filing checks a summons runs now, against a stand-in defendant, world evidence included. */
  private async checkSummonsFiling(
    actor: Actor,
    input: Omit<FileCaseInput, "caseId" | "defendantId"> & { jurisdictionId: string },
  ): Promise<{ complaint: string; remedySought: string; caseEvents: CourtEvent[] }> {
    const jurisdiction = await this.getJurisdiction(input.jurisdictionId);
    const registry = await this.getRegistry();
    // Dry-run the filing against a stand-in defendant so every filing rule applies now.
    const standIn = "agent_summoned_probe";
    const probeRegistry = { ...registry, agents: new Map(registry.agents) };
    probeRegistry.agents.set(standIn, {
      agentId: standIn,
      handle: "summoned",
      displayName: "Summoned agent",
      ownerRef: null,
      world: null,
      wallet: null,
      registeredAt: this.deps.clock.now().toISOString(),
      licences: {},
    });
    const filing = decideFileCase(
      jurisdiction,
      { actor, now: this.deps.clock.now(), registry: probeRegistry, ids: PROBE_IDS, world: PROBE_WORLD },
      { ...input, caseId: "case_probe", defendantId: standIn },
      this.policy,
    );
    // World events are checked now, so a defendant never answers a summons that cannot be filed.
    await this.lookupWorldEvidence(jurisdiction!, input.evidence ?? []);
    const filed = filing.caseEvents.find((e) => e.type === "CaseFiled");
    return {
      complaint: filed?.type === "CaseFiled" ? filed.data.complaint : input.complaint,
      remedySought: filed?.type === "CaseFiled" ? filed.data.remedySought : "",
      caseEvents: filing.caseEvents,
    };
  }

  /**
   * Runs every check issuing a summons runs (filing rules, world evidence, the open-summons
   * limit) and stores nothing. Fails exactly as `issueSummons` would.
   */
  async checkSummons(
    actor: Actor,
    input: Omit<FileCaseInput, "caseId" | "defendantId"> & { jurisdictionId: string; target: SummonsTarget },
  ): Promise<FilingPreview> {
    if (actor.kind !== "agent") fail("NOT_AUTHORIZED", "Only an agent can issue a summons.");
    const { complaint, remedySought, caseEvents } = await this.checkSummonsFiling(actor, input);
    decideIssueSummons(
      await this.getSummonsBook(),
      { actor, now: this.deps.clock.now(), registry: await this.getRegistry() },
      {
        summonsId: "summons_probe",
        code: "SMN-PROBE",
        jurisdictionId: input.jurisdictionId,
        target: input.target,
        complaint,
        remedySought,
        lawIds: input.lawIds,
        evidence: input.evidence ?? [],
      },
    );
    return filingPreview(caseEvents, input.evidence?.length ?? 0);
  }

  async issueSummons(
    actor: Actor,
    input: Omit<FileCaseInput, "caseId" | "defendantId"> & { jurisdictionId: string; target: SummonsTarget },
  ): Promise<SummonsRecord> {
    if (actor.kind !== "agent") fail("NOT_AUTHORIZED", "Only an agent can issue a summons.");
    const summonsId = this.deps.ids.next("summons");
    const code = summonsCodeFrom(this.deps.ids.next("smncode"));
    const { complaint, remedySought } = await this.checkSummonsFiling(actor, input);
    await this.retrying(async () => {
      const book = await this.getSummonsBook();
      const events = decideIssueSummons(
        book,
        { actor, now: this.deps.clock.now(), registry: await this.getRegistry() },
        {
          summonsId,
          code,
          jurisdictionId: input.jurisdictionId,
          target: input.target,
          complaint,
          remedySought,
          lawIds: input.lawIds,
          evidence: input.evidence ?? [],
        },
      );
      await this.append([{ streamId: SUMMONSES_STREAM, expectedVersion: book.version, events }], actor);
    });
    return (await this.getSummonsBook()).byId.get(summonsId)!;
  }

  /**
   * The summoned agent answers: the case is filed with the summoning agent as plaintiff and the
   * summons is marked answered, in one atomic write. From then on it is an ordinary case.
   */
  async answerSummons(actor: Actor, code: string): Promise<CaseState> {
    const caseId = this.deps.ids.next("case");
    await this.retrying(async () => {
      const book = await this.getSummonsBook();
      const record = requireSummons(book, code);
      const registry = await this.getRegistry();
      const defendantId = decideAnswerSummons(record, { actor, now: this.deps.clock.now(), registry });
      const plaintiff = agentActor(record.plaintiffId);
      const jurisdictionStreamId = jurisdictionStream(record.jurisdictionId);
      const input: FileCaseInput = {
        caseId,
        defendantId,
        complaint: record.complaint,
        remedySought: record.remedySought,
        lawIds: record.lawIds,
        evidence: record.evidence,
      };
      const decide = async (world: WorldLookup, ids: IdGenerator) => {
        const jurisdictionEvents = await this.deps.store.readStream(jurisdictionStreamId);
        const jurisdiction = buildJurisdiction(jurisdictionEvents);
        const decision = decideFileCase(
          jurisdiction,
          { actor: plaintiff, now: this.deps.clock.now(), registry, ids, world },
          input,
          this.policy,
        );
        return { jurisdiction, jurisdictionVersion: jurisdictionEvents.length, decision };
      };
      const probe = await decide(PROBE_WORLD, PROBE_IDS);
      const world = await this.lookupWorldEvidence(probe.jurisdiction!, record.evidence);
      const { jurisdictionVersion, decision } = await decide(world, this.deps.ids);
      await this.append(
        [
          {
            streamId: jurisdictionStreamId,
            expectedVersion: jurisdictionVersion,
            events: decision.jurisdictionEvents,
          },
          { streamId: caseStream(caseId), expectedVersion: 0, events: decision.caseEvents },
          {
            streamId: SUMMONSES_STREAM,
            expectedVersion: book.version,
            events: [event("SummonsAnswered", { summonsId: record.summonsId, defendantId, caseId })],
          },
        ],
        plaintiff,
      );
    });
    return (await this.getCase(caseId))!;
  }

  async getSummons(code: string): Promise<SummonsRecord> {
    return requireSummons(await this.getSummonsBook(), code);
  }

  /** The summonses an agent has issued, newest first. */
  async summonsesIssuedBy(agentId: string): Promise<SummonsRecord[]> {
    const book = await this.getSummonsBook();
    return [...book.byId.values()].filter((s) => s.plaintiffId === agentId).reverse();
  }

  private async getSummonsBook(): Promise<SummonsBook> {
    return buildSummonsBook(await this.deps.store.readStream(SUMMONSES_STREAM));
  }

  /** Every case action goes through here: the core decides, the store records. */
  async act(caseId: string, actor: Actor, command: CaseCommand): Promise<CaseState> {
    // A verdict is when the record is most likely to be read and republished: check for takedowns
    // first. Only for the seated judge in deliberation, so nobody else can make MuseCourt call a
    // world (Solon's service re-checks before it drafts).
    if (command.type === "IssueVerdict" && actor.kind === "agent") {
      const state = await this.getCase(caseId);
      if (state?.stage === "DELIBERATION" && isSeatedJudgeAgent(state, actor.agentId)) {
        await this.recheckWorldEvidence(caseId);
      }
    }
    await this.retrying(async () => {
      const streamId = caseStream(caseId);
      const events = await this.deps.store.readStream(streamId);
      const state = buildCase(events);
      const registry = await this.getRegistry();
      const citedCases = await this.loadCitedCases(command);
      const ctx = { actor, now: this.deps.clock.now(), registry, ids: this.deps.ids, citedCases };

      let world: WorldLookup = PROBE_WORLD;
      const evidence = evidenceInputsOf(command);
      if (evidence.some((e) => e.kind === "WORLD_EVENT")) {
        decideCase(state, command, { ...ctx, ids: PROBE_IDS, world: PROBE_WORLD });
        const jurisdiction = await this.getJurisdiction(state!.jurisdictionId);
        world = await this.lookupWorldEvidence(jurisdiction!, evidence);
      }
      const decided = decideCase(state, command, { ...ctx, world });
      await this.append([{ streamId, expectedVersion: events.length, events: decided }], actor);
    });
    return (await this.getCase(caseId))!;
  }

  /** An operator removes the words of a piece of evidence or a statement (record-visibility gate). */
  redactRecord(
    caseId: string,
    actor: Actor,
    input: { target: RedactionTarget; reason: string },
  ): Promise<CaseState> {
    return this.act(caseId, actor, { type: "RedactRecord", ...input });
  }

  /**
   * Asks each world whether it has since taken down the words of evidence admitted from it, and
   * records a WORLD_TAKEDOWN redaction for each one it has. Best effort: a world that cannot answer
   * now is counted as failed and checked again later; it never blocks the case.
   */
  async recheckWorldEvidence(caseId: string): Promise<{ checked: number; redacted: number; failed: number }> {
    const result = { checked: 0, redacted: 0, failed: 0 };
    const state = await this.getCase(caseId);
    for (const item of state?.evidence ?? []) {
      if (!item.world || item.redaction) continue;
      const connector = this.connectors.get(item.world.connectorId);
      if (!connector?.recheckEvent) continue;
      result.checked += 1;
      let redacted: boolean;
      try {
        ({ redacted } = await connector.recheckEvent(item.world.snapshot));
      } catch {
        result.failed += 1;
        continue;
      }
      if (!redacted) continue;
      try {
        await this.act(caseId, SYSTEM, {
          type: "RedactRecord",
          target: { kind: "EVIDENCE", evidenceId: item.evidenceId },
          reason: `${connector.id} took down the words of event ${item.world.eventId}.`,
        });
        result.redacted += 1;
      } catch (error) {
        if (!isCourtError(error, "DUPLICATE")) throw error;
      }
    }
    return result;
  }

  expireDeadline(caseId: string): Promise<CaseState> {
    return this.act(caseId, SYSTEM, { type: "ExpireDeadline" });
  }

  /** Open counsel requests and empty benches this agent is eligible to take (conflict-checked). */
  async findOpportunities(agentId: string, limit = 50): Promise<Opportunity[]> {
    const candidates = new Map<string, true>();
    for (const needs of ["LAWYER", "JUDGE"] as const) {
      for (const c of await this.deps.readModels.listCases({ status: "OPEN", needs, limit, offset: 0 })) {
        candidates.set(c.caseId, true);
      }
    }
    const states: CaseState[] = [];
    for (const caseId of candidates.keys()) {
      const state = await this.getCase(caseId);
      if (state) states.push(state);
    }
    return opportunitiesForAgent(agentId, states, await this.getRegistry());
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getRegistry(): Promise<RegistryState> {
    return buildRegistry(await this.deps.store.readStream(REGISTRY_STREAM));
  }

  async getJurisdiction(jurisdictionId: string): Promise<JurisdictionState | null> {
    return buildJurisdiction(await this.deps.store.readStream(jurisdictionStream(jurisdictionId)));
  }

  /** The court's current time (the same clock every decision uses). */
  now(): Date {
    return this.deps.clock.now();
  }

  async getCase(caseId: string): Promise<CaseState | null> {
    return buildCase(await this.deps.store.readStream(caseStream(caseId)));
  }

  /** The raw log, originals included. Internal use only: public surfaces use getPublicCaseEvents. */
  getCaseEvents(caseId: string): Promise<StoredEvent[]> {
    return this.deps.store.readStream(caseStream(caseId));
  }

  /** The case's events as the public may see them: every redaction applied. */
  async getPublicCaseEvents(caseId: string): Promise<StoredEvent[]> {
    return applyRedactions(await this.getCaseEvents(caseId));
  }

  /**
   * Replays every case from the full log. For rebuilds, tests and audits only:
   * API reads go through the read models.
   */
  async replayAllCases(): Promise<CaseState[]> {
    const byStream = new Map<string, StoredEvent[]>();
    for (const e of await this.deps.store.readAll()) {
      if (!e.streamId.startsWith("case:")) continue;
      const list = byStream.get(e.streamId) ?? [];
      list.push(e);
      byStream.set(e.streamId, list);
    }
    return [...byStream.values()].map((events) => buildCase(events)!).filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async append(
    batches: Array<{ streamId: string; expectedVersion: number; events: CourtEvent[] }>,
    actor: Actor,
  ) {
    return this.deps.store.append(batches, { actor, occurredAt: this.deps.clock.now() });
  }

  private async retrying(work: () => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (!isCourtError(error, "CONCURRENCY_CONFLICT") || attempt >= MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
      }
    }
  }

  private async loadCitedCases(command: CaseCommand): Promise<Map<string, CaseState | null>> {
    const cited = new Map<string, CaseState | null>();
    if (command.type === "IssueVerdict" && Array.isArray(command.citedCaseIds)) {
      for (const caseId of command.citedCaseIds) {
        if (typeof caseId === "string") cited.set(caseId, await this.getCase(caseId));
      }
    }
    return cited;
  }

  private async lookupWorldEvidence(
    jurisdiction: JurisdictionState,
    inputs: EvidenceInput[],
  ): Promise<WorldLookup> {
    const found = new Map<string, WorldEvidenceSource>();
    const eventIds = inputs.flatMap((e) => (e.kind === "WORLD_EVENT" ? [e.eventId] : []));
    if (eventIds.length === 0) return found;
    const connector = jurisdiction.connectorId ? this.connectors.get(jurisdiction.connectorId) : undefined;
    if (!connector) {
      fail(
        "WORLD_EVIDENCE_UNAVAILABLE",
        `${jurisdiction.name} has no world connector available to verify evidence.`,
      );
    }
    for (const eventId of eventIds) {
      let snapshot;
      try {
        snapshot = await connector.getEvent(eventId);
      } catch (error) {
        if (error instanceof WorldEventNotKept) {
          fail("WORLD_EVIDENCE_NOT_FOUND", `${connector.id} no longer keeps event ${eventId}.`, {
            eventId,
            reason: "NOT_KEPT",
          });
        }
        throw new CourtError(
          "WORLD_EVIDENCE_UNAVAILABLE",
          `The ${connector.id} world could not be reached. Try again later.`,
          {
            connectorId: connector.id,
            cause: (error as Error).message,
          },
        );
      }
      if (!snapshot)
        fail("WORLD_EVIDENCE_NOT_FOUND", `${connector.id} has no event ${eventId}.`, { eventId });
      found.set(eventId, {
        connectorId: connector.id,
        eventId,
        retrievedAt: this.deps.clock.now().toISOString(),
        snapshot,
      });
    }
    return found;
  }
}

type WorldLookup = { get(eventId: string): WorldEvidenceSource | undefined };

/** Pretends every world event exists, so a dry run surfaces all non-world validation errors first. */
const PROBE_WORLD: WorldLookup = {
  get: (eventId) => ({
    connectorId: "probe",
    eventId,
    retrievedAt: new Date(0).toISOString(),
    snapshot: {
      eventId,
      type: "probe",
      occurredAt: new Date(0).toISOString(),
      actorWorldId: null,
      summary: "probe",
      data: {},
    },
  }),
};

/** Dry runs must not consume real IDs. */
const PROBE_IDS: IdGenerator = { next: (prefix) => `${prefix}_probe` };

function evidenceInputsOf(command: CaseCommand): EvidenceInput[] {
  if (command.type === "SubmitEvidence") return command.evidence ? [command.evidence] : [];
  if (command.type === "RespondToComplaint") return command.evidence ?? [];
  return [];
}

/** What a filing would create, without creating it. */
export interface FilingPreview {
  jurisdictionId: string;
  title: string;
  plaintiffId: string;
  defendantId: string;
  charges: Array<{ lawId: string; article: number; title: string }>;
  evidence: number;
  firstStage: string;
  /** When the defendant's answer would be due, counted from now. */
  answerDeadline: string;
}

function filingPreview(caseEvents: CourtEvent[], evidence: number): FilingPreview {
  const filed = caseEvents.find((e) => e.type === "CaseFiled");
  const stage = caseEvents.find((e) => e.type === "StageEntered");
  if (filed?.type !== "CaseFiled" || stage?.type !== "StageEntered") {
    throw new Error("A filing decision always files the case and enters its first stage.");
  }
  return {
    jurisdictionId: filed.data.jurisdictionId,
    title: filed.data.title,
    plaintiffId: filed.data.plaintiffId,
    defendantId: filed.data.defendantId,
    charges: filed.data.charges.map(({ lawId, article, title }) => ({ lawId, article, title })),
    evidence,
    firstStage: stage.data.stage,
    answerDeadline: stage.data.deadline,
  };
}
