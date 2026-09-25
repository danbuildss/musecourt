import { SYSTEM, type Actor } from "@/core/actor";
import {
  decideCase,
  decideFileCase,
  type CaseCommand,
  type EvidenceInput,
  type FileCaseInput,
} from "@/core/case-decide";
import { buildCase, type CaseState } from "@/core/case-state";
import type { Clock } from "@/core/clock";
import { CourtError, fail, isCourtError } from "@/core/errors";
import {
  REGISTRY_STREAM,
  caseStream,
  jurisdictionStream,
  type CourtEvent,
  type LicenceType,
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
import type { EventStore, WorldConnector } from "@/core/ports";
import { opportunitiesForAgent, type Opportunity } from "./projections/tasks";
import type { ReadModels } from "./read-models/types";
import { DEFAULT_DEADLINE_POLICY, validateDeadlinePolicy, type DeadlinePolicy } from "@/core/procedure";
import {
  buildRegistry,
  decideGrantLicence,
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

const MAX_ATTEMPTS = 3;

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

  async registerAgent(
    input: Omit<RegisterAgentInput, "agentId">,
    actor: Actor = SYSTEM,
  ): Promise<AgentRecord> {
    const agentId = this.deps.ids.next("agent");
    await this.decideRegistry(actor, (registry) =>
      decideRegisterAgent(registry, actor, { ...input, agentId }),
    );
    return (await this.getRegistry()).agents.get(agentId)!;
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

  /** Every case action goes through here: the core decides, the store records. */
  async act(caseId: string, actor: Actor, command: CaseCommand): Promise<CaseState> {
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

  expireDeadline(caseId: string): Promise<CaseState> {
    return this.act(caseId, SYSTEM, { type: "ExpireDeadline" });
  }

  /** Expires every deadline that has passed. Safe to run repeatedly and concurrently (cron). */
  async processDueDeadlines(
    limit = 500,
  ): Promise<Array<{ caseId: string; result: "EXPIRED" | "SKIPPED"; code?: string }>> {
    const due = await this.deps.readModels.dueCaseIds(this.deps.clock.now(), limit);
    const results: Array<{ caseId: string; result: "EXPIRED" | "SKIPPED"; code?: string }> = [];
    for (const caseId of due) {
      try {
        await this.expireDeadline(caseId);
        results.push({ caseId, result: "EXPIRED" });
      } catch (error) {
        // Another worker got there first; the case has already moved on.
        if (isCourtError(error, "DEADLINE_NOT_REACHED") || isCourtError(error, "CASE_CLOSED")) {
          results.push({ caseId, result: "SKIPPED", code: error.code });
        } else {
          throw error;
        }
      }
    }
    return results;
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

  async getCase(caseId: string): Promise<CaseState | null> {
    return buildCase(await this.deps.store.readStream(caseStream(caseId)));
  }

  getCaseEvents(caseId: string): Promise<StoredEvent[]> {
    return this.deps.store.readStream(caseStream(caseId));
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
