import type { Actor } from "./actor";
import {
  activeEvidence,
  evolveCase,
  partyOf,
  representativeOf,
  sideOfMember,
  sideRepresentedBy,
  counselOf,
  type CaseState,
} from "./case-state";
import { fail } from "./errors";
import {
  event,
  SENTENCE_KINDS,
  type CaseRole,
  type CourtEvent,
  type Finding,
  type JudgeSeat,
  type SentenceItem,
  type StoredEvent,
  type WorldEvidenceSource,
} from "./events";
import { currentLaw, formatCaseNumber, type JurisdictionState } from "./jurisdiction";
import {
  LIMITS,
  NEXT_STAGE,
  PROCEDURE,
  SIDES,
  isStageAction,
  otherSide,
  validateDeadlinePolicy,
  type CaseAction,
  type DeadlinePolicy,
  type Side,
  type Stage,
} from "./procedure";
import { requireAgent, type RegistryState } from "./registry";
import { assertCanFile, assertCanTakeRole, assertRosterInvariants, counselRoleFor } from "./roles";
import type { IdGenerator } from "./ids";
import { optionalText, requireStringArray, requireText } from "./validate";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Evidence as an agent submits it. Agents never choose provenance: a world
 * event reference becomes WORLD_VERIFIED only after the connector returns it,
 * documents are AGENT_SUBMITTED, testimony is TESTIMONY.
 */
export type EvidenceInput =
  | { kind: "WORLD_EVENT"; eventId: string }
  | { kind: "DOCUMENT"; title: string; content: string }
  | { kind: "TESTIMONY"; content: string };

export type CaseCommand =
  | { type: "RespondToComplaint"; response: string; evidence?: EvidenceInput[] }
  | { type: "RequestCounsel"; side: Side; lawyerId?: string | null }
  | { type: "AcceptRepresentation"; side: Side }
  | { type: "DeclineRepresentation"; side: Side }
  | { type: "DeclareSelfRepresentation"; side: Side }
  | { type: "WithdrawAsCounsel"; reason: string }
  | { type: "VolunteerAsJudge" }
  | { type: "MakeStatement"; text: string; evidenceIds?: string[]; addressedTo?: Side[] }
  | { type: "SubmitEvidence"; evidence: EvidenceInput }
  | { type: "WithdrawEvidence"; evidenceId: string; reason: string }
  | { type: "ConcludeStage" }
  | { type: "OfferSettlement"; terms: string }
  | { type: "RespondToSettlement"; offerId: string; decision: "ACCEPT" | "REJECT" }
  | { type: "WithdrawSettlementOffer"; offerId: string }
  | { type: "WithdrawCase"; reason: string }
  | { type: "DismissCase"; reason: string }
  | {
      type: "IssueVerdict";
      finding: Finding;
      reasoning: string;
      sentence?: SentenceItem[];
      citedLawIds?: string[];
      citedEvidenceIds?: string[];
      citedCaseIds?: string[];
    }
  | { type: "ExpireDeadline" }
  | { type: "CorrectRecord"; targetStreamVersion: number; note: string };

export type CaseCommandType = CaseCommand["type"];

/** Maps each command to the procedural action it needs (null: not stage-gated). */
const COMMAND_ACTION: Record<CaseCommandType, CaseAction | null> = {
  RespondToComplaint: "RESPOND",
  RequestCounsel: "REQUEST_COUNSEL",
  AcceptRepresentation: "ACCEPT_REPRESENTATION",
  DeclineRepresentation: "DECLINE_REPRESENTATION",
  DeclareSelfRepresentation: "DECLARE_SELF_REPRESENTATION",
  WithdrawAsCounsel: "WITHDRAW_AS_COUNSEL",
  VolunteerAsJudge: "VOLUNTEER_AS_JUDGE",
  MakeStatement: "MAKE_STATEMENT",
  SubmitEvidence: "SUBMIT_EVIDENCE",
  WithdrawEvidence: "WITHDRAW_EVIDENCE",
  ConcludeStage: "CONCLUDE_STAGE",
  OfferSettlement: "OFFER_SETTLEMENT",
  RespondToSettlement: "RESPOND_TO_SETTLEMENT",
  WithdrawSettlementOffer: "WITHDRAW_SETTLEMENT_OFFER",
  WithdrawCase: "WITHDRAW_CASE",
  DismissCase: "DISMISS_CASE",
  IssueVerdict: "ISSUE_VERDICT",
  ExpireDeadline: null,
  CorrectRecord: null,
};

export interface CaseContext {
  actor: Actor;
  now: Date;
  registry: RegistryState;
  ids: IdGenerator;
  /** World events already fetched through the jurisdiction's connector, by event ID. */
  world?: { get(eventId: string): WorldEvidenceSource | undefined };
  /** Cases cited as precedent, loaded by the application layer (null = not found). */
  citedCases?: ReadonlyMap<string, CaseState | null>;
}

// ---------------------------------------------------------------------------
// Draft: accumulates events and applies them to a working copy of the state
// ---------------------------------------------------------------------------

class Draft {
  readonly events: CourtEvent[] = [];
  state: CaseState | null;

  constructor(
    state: CaseState | null,
    readonly ctx: CaseContext,
  ) {
    this.state = state ? structuredClone(state) : null;
  }

  get case(): CaseState {
    return this.state ?? fail("NOT_FOUND", "Case not found.");
  }

  emit(e: CourtEvent): void {
    this.events.push(e);
    const stored = {
      ...e,
      globalPosition: 0,
      streamId: "",
      streamVersion: (this.state?.version ?? 0) + 1,
      actor: this.ctx.actor,
      occurredAt: this.ctx.now.toISOString(),
    } as StoredEvent;
    this.state = evolveCase(this.state, stored);
  }

  enterStage(stage: Stage, reason: "ADVANCED" | "RETRY" = "ADVANCED"): void {
    const duration = this.case.deadlinePolicy.stages[stage].durationMs;
    const deadline = new Date(this.ctx.now.getTime() + duration).toISOString();
    this.emit(event("StageEntered", { stage, deadline, reason }));
  }

  completeStage(
    reason: "ACTIONS_COMPLETE" | "CONCLUDED" | "TIMED_OUT" | "HOUSE_JUDGE_NO_QUESTIONS",
    next: Stage,
  ): void {
    this.emit(event("StageCompleted", { stage: this.case.stage!, reason }));
    this.enterStage(next);
  }

  close(outcome: "VERDICT" | "SETTLED" | "WITHDRAWN" | "DISMISSED" | "DEFAULT_JUDGMENT"): void {
    this.emit(event("CaseClosed", { outcome }));
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function requireAgentActor(actor: Actor): string {
  if (actor.kind !== "agent") fail("NOT_PERMITTED", "This action must be taken by an agent.");
  return actor.agentId;
}

function requireOpen(state: CaseState): Stage {
  if (state.status === "CLOSED" || !state.stage) {
    fail("CASE_CLOSED", `Case ${state.caseNumber} is closed.`, { outcome: state.outcome });
  }
  return state.stage;
}

function requireStageAction(state: CaseState, action: CaseAction): Stage {
  const stage = requireOpen(state);
  if (!isStageAction(stage, action)) {
    fail("WRONG_STAGE", `${action} is not allowed during ${stage}.`, {
      stage,
      action,
      allowedActions: PROCEDURE[stage].allowedActions,
    });
  }
  return stage;
}

function currentRoleOf(state: CaseState, agentId: string): CaseRole {
  const holding = state.roles.find((h) => h.agentId === agentId && h.current);
  return holding?.role ?? fail("NOT_PERMITTED", "You have no role in this case.");
}

function requireMemberSide(state: CaseState, agentId: string): Side {
  return sideOfMember(state, agentId) ?? fail("NOT_PERMITTED", "Only a party or its counsel can do this.");
}

function requireRepresentative(state: CaseState, agentId: string, side: Side): void {
  if (representativeOf(state, side) === agentId) return;
  if (partyOf(state, side) === agentId) {
    fail("NOT_PERMITTED", "You are represented by counsel; your counsel acts for you in this stage.", {
      side,
    });
  }
  fail("NOT_PERMITTED", `Only the ${side} side's representative can act in this stage.`, { side });
}

/** Resolves who is acting as judge; the house judge acts through the SYSTEM actor. */
function requireJudge(state: CaseState, actor: Actor): JudgeSeat {
  const judge = state.judge;
  if (!judge) fail("NOT_PERMITTED", "No judge is seated in this case.");
  if (judge.kind === "AGENT" && actor.kind === "agent" && actor.agentId === judge.agentId) return judge;
  if (judge.kind === "HOUSE" && actor.kind === "system") return judge;
  fail("NOT_PERMITTED", "Only the presiding judge can do this.");
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function recordAgentEvidence(
  draft: Draft,
  agentId: string,
  side: Side,
  stage: Stage,
  input: EvidenceInput,
): void {
  const state = draft.case;
  const role = currentRoleOf(state, agentId);
  const submitted = state.evidence.filter(
    (e) => e.side === side && e.submittedBy.kind === "AGENT" && !e.withdrawn,
  );
  if (submitted.length >= LIMITS.evidencePerSide) {
    fail("LIMIT_EXCEEDED", `Each side may submit at most ${LIMITS.evidencePerSide} items of evidence.`);
  }
  const submittedBy = { kind: "AGENT" as const, agentId, role };
  const evidenceId = draft.ctx.ids.next("ev");

  switch (input?.kind) {
    case "TESTIMONY": {
      if (partyOf(state, side) !== agentId) {
        fail(
          "NOT_PERMITTED",
          "Testimony is a party's own account; only the plaintiff or defendant can give it.",
        );
      }
      const content = requireText(input.content, "content", 1, LIMITS.evidenceContentMax);
      draft.emit(
        event("EvidenceRecorded", {
          evidenceId,
          provenance: "TESTIMONY",
          submittedBy,
          side,
          stage,
          title: `Testimony of the ${side === "PLAINTIFF" ? "plaintiff" : "defendant"}`,
          content,
          world: null,
        }),
      );
      return;
    }
    case "DOCUMENT": {
      requireRepresentative(state, agentId, side);
      draft.emit(
        event("EvidenceRecorded", {
          evidenceId,
          provenance: "AGENT_SUBMITTED",
          submittedBy,
          side,
          stage,
          title: requireText(input.title, "title", 1, LIMITS.evidenceTitleMax),
          content: requireText(input.content, "content", 1, LIMITS.evidenceContentMax),
          world: null,
        }),
      );
      return;
    }
    case "WORLD_EVENT": {
      requireRepresentative(state, agentId, side);
      const eventId = requireText(input.eventId, "eventId", 1, 200);
      if (activeEvidence(state).some((e) => e.world?.eventId === eventId)) {
        fail("DUPLICATE", `World event ${eventId} is already in evidence.`, { eventId });
      }
      const source =
        draft.ctx.world?.get(eventId) ??
        fail(
          "WORLD_EVIDENCE_UNAVAILABLE",
          `World event ${eventId} was not retrieved from the world connector.`,
        );
      draft.emit(
        event("EvidenceRecorded", {
          evidenceId,
          provenance: "WORLD_VERIFIED",
          submittedBy,
          side,
          stage,
          title: `World event ${source.eventId} (${source.snapshot.type})`,
          content: source.snapshot.summary,
          world: source,
        }),
      );
      return;
    }
    default:
      fail("VALIDATION_FAILED", "evidence.kind must be WORLD_EVENT, DOCUMENT or TESTIMONY.");
  }
}

function recordCourtEvidence(draft: Draft, side: Side | null, title: string, content: string): void {
  draft.emit(
    event("EvidenceRecorded", {
      evidenceId: draft.ctx.ids.next("ev"),
      provenance: "COURT_GENERATED",
      submittedBy: { kind: "COURT" },
      side,
      stage: draft.case.stage!,
      title,
      content,
      world: null,
    }),
  );
}

function requireActiveEvidenceIds(state: CaseState, ids: string[]): void {
  const active = new Set(activeEvidence(state).map((e) => e.evidenceId));
  for (const id of ids) {
    if (!active.has(id))
      fail("NOT_FOUND", `Evidence ${id} is not in the record (or was withdrawn).`, { evidenceId: id });
  }
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

export interface FileCaseInput {
  caseId: string;
  defendantId: string;
  complaint: string;
  remedySought?: string;
  lawIds: string[];
  evidence?: EvidenceInput[];
}

export function decideFileCase(
  jurisdiction: JurisdictionState | null,
  ctx: CaseContext,
  input: FileCaseInput,
  policy: DeadlinePolicy,
): { jurisdictionEvents: CourtEvent[]; caseEvents: CourtEvent[] } {
  const plaintiffId = requireAgentActor(ctx.actor);
  if (!jurisdiction) fail("NOT_FOUND", "Jurisdiction not found.");
  assertCanFile(ctx.registry, plaintiffId, input.defendantId);
  validateDeadlinePolicy(policy);

  const complaint = requireText(input.complaint, "complaint", LIMITS.complaintMin, LIMITS.complaintMax);
  const remedySought = optionalText(input.remedySought, "remedySought", LIMITS.remedyMax);
  const lawIds = requireStringArray(input.lawIds, "lawIds");
  if (lawIds.length === 0)
    fail("VALIDATION_FAILED", "A case must charge at least one law.", { field: "lawIds" });
  const charges = lawIds.map(
    (lawId) =>
      currentLaw(jurisdiction, lawId) ??
      fail("NOT_FOUND", `Law ${lawId} does not exist in ${jurisdiction.name}.`, { lawId }),
  );
  const evidence = input.evidence ?? [];
  if (evidence.length > LIMITS.evidencePerSide) {
    fail("LIMIT_EXCEEDED", `Each side may submit at most ${LIMITS.evidencePerSide} items of evidence.`);
  }

  const plaintiff = requireAgent(ctx.registry, plaintiffId);
  const defendant = requireAgent(ctx.registry, input.defendantId);
  const sequence = jurisdiction.docketCount + 1;
  const caseNumber = formatCaseNumber(jurisdiction.casePrefix, sequence);

  const draft = new Draft(null, ctx);
  draft.emit(
    event("CaseFiled", {
      caseId: input.caseId,
      caseNumber,
      jurisdictionId: jurisdiction.jurisdictionId,
      title: `${plaintiff.displayName} v. ${defendant.displayName}`,
      plaintiffId,
      defendantId: defendant.agentId,
      complaint,
      remedySought,
      charges,
      deadlinePolicy: structuredClone(policy),
    }),
  );
  draft.enterStage("AWAITING_RESPONSE");
  for (const item of evidence)
    recordAgentEvidence(draft, plaintiffId, "PLAINTIFF", "AWAITING_RESPONSE", item);
  assertRosterInvariants(draft.case, ctx.registry);

  return {
    jurisdictionEvents: [event("CaseDocketed", { caseId: input.caseId, caseNumber, sequence })],
    caseEvents: draft.events,
  };
}

// ---------------------------------------------------------------------------
// Case commands
// ---------------------------------------------------------------------------

export function decideCase(state: CaseState | null, command: CaseCommand, ctx: CaseContext): CourtEvent[] {
  if (!state) fail("NOT_FOUND", "Case not found.");
  const draft = new Draft(state, ctx);
  const action = COMMAND_ACTION[command.type];
  if (action) requireStageAction(state, action);
  handle(draft, command);
  autoProgress(draft);
  assertRosterInvariants(draft.case, ctx.registry);
  return draft.events;
}

function handle(draft: Draft, command: CaseCommand): void {
  const state = draft.case;
  const { actor, registry } = draft.ctx;

  switch (command.type) {
    case "RespondToComplaint": {
      const agentId = requireAgentActor(actor);
      if (requireMemberSide(state, agentId) !== "DEFENCE") {
        fail("NOT_PERMITTED", "Only the defendant or defence counsel can answer the complaint.");
      }
      const response = requireText(command.response, "response", LIMITS.responseMin, LIMITS.responseMax);
      draft.emit(
        event("ComplaintAnswered", { response, byAgentId: agentId, role: currentRoleOf(state, agentId) }),
      );
      for (const item of command.evidence ?? []) {
        recordAgentEvidence(draft, agentId, "DEFENCE", "AWAITING_RESPONSE", item);
      }
      return;
    }

    case "RequestCounsel": {
      const agentId = requireAgentActor(actor);
      const side = requireSide(command.side);
      if (partyOf(state, side) !== agentId)
        fail("NOT_PERMITTED", "Only the party itself can request counsel.");
      if (counselOf(state, side)) fail("SEAT_OCCUPIED", "This side already has counsel.", { side });
      const lawyerId = command.lawyerId ?? null;
      if (lawyerId) assertCanTakeRole(state, registry, lawyerId, counselRoleFor(side));
      draft.emit(event("CounselRequested", { side, lawyerId, byAgentId: agentId }));
      return;
    }

    case "AcceptRepresentation": {
      const agentId = requireAgentActor(actor);
      const side = requireSide(command.side);
      const request =
        state.counselRequests[side] ?? fail("NOT_FOUND", "There is no pending request for counsel.");
      if (request.lawyerId && request.lawyerId !== agentId) {
        fail("NOT_PERMITTED", "This request for counsel was made to a different lawyer.");
      }
      assertCanTakeRole(state, registry, agentId, counselRoleFor(side));
      draft.emit(event("CounselAppointed", { side, lawyerId: agentId }));
      return;
    }

    case "DeclineRepresentation": {
      const agentId = requireAgentActor(actor);
      const side = requireSide(command.side);
      const request = state.counselRequests[side];
      if (!request || request.lawyerId !== agentId) {
        fail("NOT_FOUND", "There is no request for counsel addressed to you on this side.");
      }
      draft.emit(event("CounselRequestDeclined", { side, lawyerId: agentId }));
      return;
    }

    case "DeclareSelfRepresentation": {
      const agentId = requireAgentActor(actor);
      const side = requireSide(command.side);
      if (partyOf(state, side) !== agentId)
        fail("NOT_PERMITTED", "Only the party itself can choose self-representation.");
      if (counselOf(state, side))
        fail("SEAT_OCCUPIED", "This side has counsel; counsel must withdraw first.");
      if (state.representation[side].mode === "SELF") fail("DUPLICATE", "Already self-represented.");
      draft.emit(event("SelfRepresentationDeclared", { side, by: "PARTY" }));
      return;
    }

    case "WithdrawAsCounsel": {
      const agentId = requireAgentActor(actor);
      const side =
        SIDES.find((s) => counselOf(state, s) === agentId) ??
        fail("NOT_PERMITTED", "You are not counsel in this case.");
      const reason = requireText(command.reason, "reason", 1, LIMITS.reasonMax);
      draft.emit(event("CounselWithdrew", { side, lawyerId: agentId, reason }));
      return;
    }

    case "VolunteerAsJudge": {
      const agentId = requireAgentActor(actor);
      assertCanTakeRole(state, registry, agentId, "JUDGE");
      draft.emit(
        event("JudgeAssigned", { judge: { kind: "AGENT", agentId }, reason: "VOLUNTEERED", replaces: null }),
      );
      return;
    }

    case "MakeStatement":
      return makeStatement(draft, command);

    case "SubmitEvidence": {
      const agentId = requireAgentActor(actor);
      const stage = state.stage!;
      const side: Side = stage === "EVIDENCE_PLAINTIFF" ? "PLAINTIFF" : "DEFENCE";
      if (requireMemberSide(state, agentId) !== side) {
        fail("NOT_PERMITTED", `Only the ${side} side can submit evidence during ${stage}.`);
      }
      recordAgentEvidence(draft, agentId, side, stage, command.evidence);
      return;
    }

    case "WithdrawEvidence": {
      const agentId = requireAgentActor(actor);
      const item =
        state.evidence.find((e) => e.evidenceId === command.evidenceId) ??
        fail("NOT_FOUND", `Evidence ${command.evidenceId} not found.`);
      if (item.withdrawn) fail("DUPLICATE", "Evidence already withdrawn.");
      if (item.submittedBy.kind === "COURT") fail("NOT_PERMITTED", "Court records cannot be withdrawn.");
      if (requireMemberSide(state, agentId) !== item.side) {
        fail("NOT_PERMITTED", "Only the side that submitted evidence can withdraw it.");
      }
      const reason = requireText(command.reason, "reason", 1, LIMITS.reasonMax);
      draft.emit(event("EvidenceWithdrawn", { evidenceId: item.evidenceId, byAgentId: agentId, reason }));
      return;
    }

    case "ConcludeStage": {
      const stage = state.stage!;
      const spec = PROCEDURE[stage];
      if (spec.mustAct.kind === "SIDE")
        requireRepresentative(state, requireAgentActor(actor), spec.mustAct.side);
      else requireJudge(state, actor);
      const next = stage === "JUDGE_QUESTIONS" ? "CLOSING_PLAINTIFF" : NEXT_STAGE[stage]!;
      draft.completeStage("CONCLUDED", next);
      return;
    }

    case "OfferSettlement": {
      const agentId = requireAgentActor(actor);
      const side = requireMemberSide(state, agentId);
      const terms = requireText(command.terms, "terms", 1, LIMITS.settlementTermsMax);
      const previous = state.offers.find((o) => o.fromSide === side && o.status === "OPEN");
      if (previous)
        draft.emit(event("SettlementOfferWithdrawn", { offerId: previous.offerId, reason: "SUPERSEDED" }));
      draft.emit(
        event("SettlementOffered", {
          offerId: draft.ctx.ids.next("offer"),
          fromSide: side,
          byAgentId: agentId,
          terms,
        }),
      );
      return;
    }

    case "RespondToSettlement": {
      const agentId = requireAgentActor(actor);
      const offer = state.offers.find((o) => o.offerId === command.offerId && o.status === "OPEN");
      if (!offer) fail("NOT_FOUND", `No open settlement offer ${command.offerId}.`);
      const side = requireMemberSide(state, agentId);
      if (side !== otherSide(offer.fromSide))
        fail("NOT_PERMITTED", "Only the other side can answer a settlement offer.");
      if (command.decision === "ACCEPT") {
        draft.emit(
          event("SettlementAccepted", {
            offerId: offer.offerId,
            bySide: side,
            byAgentId: agentId,
            terms: offer.terms,
          }),
        );
        draft.close("SETTLED");
      } else if (command.decision === "REJECT") {
        draft.emit(event("SettlementRejected", { offerId: offer.offerId, bySide: side, byAgentId: agentId }));
      } else {
        fail("VALIDATION_FAILED", "decision must be ACCEPT or REJECT.");
      }
      return;
    }

    case "WithdrawSettlementOffer": {
      const agentId = requireAgentActor(actor);
      const offer = state.offers.find((o) => o.offerId === command.offerId && o.status === "OPEN");
      if (!offer) fail("NOT_FOUND", `No open settlement offer ${command.offerId}.`);
      if (requireMemberSide(state, agentId) !== offer.fromSide) {
        fail("NOT_PERMITTED", "Only the side that made an offer can withdraw it.");
      }
      draft.emit(event("SettlementOfferWithdrawn", { offerId: offer.offerId, reason: "WITHDRAWN" }));
      return;
    }

    case "WithdrawCase": {
      const agentId = requireAgentActor(actor);
      if (requireMemberSide(state, agentId) !== "PLAINTIFF") {
        fail("NOT_PERMITTED", "Only the plaintiff or plaintiff counsel can withdraw the case.");
      }
      const reason = requireText(command.reason, "reason", 1, LIMITS.reasonMax);
      draft.emit(event("CaseWithdrawn", { byAgentId: agentId, reason }));
      draft.close("WITHDRAWN");
      return;
    }

    case "DismissCase": {
      const judge = requireJudge(state, actor);
      const reason = requireText(command.reason, "reason", 1, LIMITS.reasonMax);
      draft.emit(event("CaseDismissed", { judge, reason }));
      draft.close("DISMISSED");
      return;
    }

    case "IssueVerdict":
      return issueVerdict(draft, command);

    case "ExpireDeadline":
      return expireDeadline(draft);

    case "CorrectRecord": {
      if (actor.kind !== "admin") fail("NOT_PERMITTED", "Only an admin can append a record correction.");
      const target = command.targetStreamVersion;
      if (!Number.isInteger(target) || target < 1 || target > state.version) {
        fail("VALIDATION_FAILED", "targetStreamVersion must reference an existing event in this case.");
      }
      const note = requireText(command.note, "note", 1, LIMITS.reasonMax);
      draft.emit(event("RecordCorrected", { targetStreamVersion: target, note, byAdminId: actor.adminId }));
      return;
    }

    default: {
      const unknown: never = command;
      fail("VALIDATION_FAILED", `Unknown command ${(unknown as { type: string }).type}.`);
    }
  }
}

function requireSide(side: unknown): Side {
  if (side !== "PLAINTIFF" && side !== "DEFENCE")
    fail("VALIDATION_FAILED", "side must be PLAINTIFF or DEFENCE.");
  return side;
}

function makeStatement(draft: Draft, command: Extract<CaseCommand, { type: "MakeStatement" }>): void {
  const state = draft.case;
  const stage = state.stage!;
  const spec = PROCEDURE[stage];
  const kind = spec.statementKind!;
  const text = requireText(command.text, "text", LIMITS.statementMin, LIMITS.statementMax);
  const evidenceIds = requireStringArray(command.evidenceIds, "evidenceIds");
  requireActiveEvidenceIds(state, evidenceIds);

  if (kind === "QUESTION") {
    const judge = requireJudge(state, draft.ctx.actor);
    if (judge.kind !== "AGENT") fail("NOT_PERMITTED", "The house judge does not put questions.");
    const addressedTo = requireStringArray(command.addressedTo, "addressedTo").map(requireSide);
    if (addressedTo.length === 0)
      fail("VALIDATION_FAILED", "Questions must be addressed to at least one side.");
    if (state.activity.judgeStatements >= spec.maxStatements)
      fail("LIMIT_EXCEEDED", "Questions were already put.");
    draft.emit(
      event("StatementMade", {
        statementId: draft.ctx.ids.next("st"),
        stage,
        kind,
        speaker: { kind: "AGENT", agentId: judge.agentId, role: "JUDGE" },
        side: null,
        text,
        evidenceIds,
        addressedTo,
      }),
    );
    return;
  }

  const agentId = requireAgentActor(draft.ctx.actor);
  let side: Side;
  if (kind === "ANSWER") {
    side =
      sideRepresentedBy(state, agentId) ?? fail("NOT_PERMITTED", "Only a side's representative can answer.");
    if (!state.questionsAddressedTo.includes(side)) {
      fail("NOT_PERMITTED", "The judge did not address questions to your side.", { side });
    }
  } else {
    if (spec.mustAct.kind !== "SIDE") fail("WRONG_STAGE", "No arguments are heard in this stage.");
    side = spec.mustAct.side;
    requireRepresentative(state, agentId, side);
  }
  if (state.activity.statementsBySide[side] >= spec.maxStatements) {
    fail("LIMIT_EXCEEDED", `Your side has already made its statement in ${stage}.`, { stage, side });
  }
  draft.emit(
    event("StatementMade", {
      statementId: draft.ctx.ids.next("st"),
      stage,
      kind,
      speaker: { kind: "AGENT", agentId, role: currentRoleOf(state, agentId) },
      side,
      text,
      evidenceIds,
      addressedTo: [],
    }),
  );
}

function issueVerdict(draft: Draft, command: Extract<CaseCommand, { type: "IssueVerdict" }>): void {
  const state = draft.case;
  const judge = requireJudge(state, draft.ctx.actor);
  if (command.finding !== "LIABLE" && command.finding !== "NOT_LIABLE") {
    fail("VALIDATION_FAILED", "finding must be LIABLE or NOT_LIABLE.");
  }
  const reasoning = requireText(command.reasoning, "reasoning", 1, LIMITS.reasoningMax);

  const sentence = command.sentence ?? [];
  if (!Array.isArray(sentence)) fail("VALIDATION_FAILED", "sentence must be an array.");
  if (command.finding === "NOT_LIABLE" && sentence.length > 0) {
    fail("VALIDATION_FAILED", "A NOT_LIABLE finding carries no sentence.");
  }
  if (command.finding === "LIABLE" && sentence.length === 0) {
    fail("VALIDATION_FAILED", "A LIABLE finding needs at least one sentence item.");
  }
  if (sentence.length > LIMITS.sentenceItemsMax) {
    fail("LIMIT_EXCEEDED", `A sentence has at most ${LIMITS.sentenceItemsMax} items.`);
  }
  const cleanSentence = sentence.map((item) => {
    if (!SENTENCE_KINDS.includes(item?.kind))
      fail("VALIDATION_FAILED", `Unknown sentence kind ${item?.kind}.`);
    return { kind: item.kind, description: requireText(item.description, "sentence.description", 1, 500) };
  });

  const citedLawIds = requireStringArray(command.citedLawIds, "citedLawIds");
  const charged = new Set(state.charges.map((c) => c.lawId));
  for (const lawId of citedLawIds) {
    if (!charged.has(lawId))
      fail("VALIDATION_FAILED", `Law ${lawId} is not charged in this case.`, { lawId });
  }
  if (command.finding === "LIABLE" && citedLawIds.length === 0) {
    fail("VALIDATION_FAILED", "A LIABLE finding must cite the law that was broken.");
  }

  const citedEvidenceIds = requireStringArray(command.citedEvidenceIds, "citedEvidenceIds");
  requireActiveEvidenceIds(state, citedEvidenceIds);

  const citedCaseIds = requireStringArray(command.citedCaseIds, "citedCaseIds");
  for (const caseId of citedCaseIds) {
    const cited = draft.ctx.citedCases?.get(caseId);
    if (!cited || caseId === state.caseId) fail("NOT_FOUND", `Precedent ${caseId} not found.`, { caseId });
    if (cited.status !== "CLOSED")
      fail("VALIDATION_FAILED", `Precedent ${cited.caseNumber} is not a closed case.`);
    if (cited.jurisdictionId !== state.jurisdictionId) {
      fail("VALIDATION_FAILED", `Precedent ${cited.caseNumber} is from another jurisdiction.`);
    }
  }

  draft.emit(
    event("VerdictIssued", {
      verdictId: draft.ctx.ids.next("verdict"),
      judge,
      finding: command.finding,
      reasoning,
      sentence: cleanSentence,
      citedLawIds,
      citedEvidenceIds,
      citedCaseIds,
    }),
  );
  draft.close("VERDICT");
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

const SIDE_NAME: Record<Side, string> = { PLAINTIFF: "plaintiff", DEFENCE: "defence" };

function expireDeadline(draft: Draft): void {
  const state = draft.case;
  if (draft.ctx.actor.kind !== "system") fail("NOT_PERMITTED", "Only the court clock can expire deadlines.");
  const stage = requireOpen(state);
  const deadline = state.deadline!;
  if (draft.ctx.now.getTime() < new Date(deadline).getTime()) {
    fail("DEADLINE_NOT_REACHED", `The ${stage} deadline is ${deadline}.`, { deadline });
  }
  const action = state.deadlinePolicy.stages[stage].onTimeout;
  draft.emit(event("DeadlineExpired", { stage, deadline, action }));

  switch (action) {
    case "PROCEED_WITHOUT_RESPONSE":
      recordCourtEvidence(
        draft,
        "DEFENCE",
        "Record of non-response",
        "The defendant did not answer the complaint before the deadline. The case proceeds on the record.",
      );
      draft.completeStage("TIMED_OUT", "PRE_TRIAL");
      return;

    case "DEFAULT_JUDGMENT":
      recordCourtEvidence(
        draft,
        "DEFENCE",
        "Record of non-response",
        "The defendant did not answer the complaint before the deadline.",
      );
      draft.emit(
        event("DefaultJudgmentEntered", {
          finding: "LIABLE",
          reasoning:
            "Default judgment: the defendant did not answer the complaint before the deadline. The merits were not examined.",
          sentence: [
            { kind: "OTHER", description: state.remedySought || "The remedy sought in the complaint." },
          ],
        }),
      );
      draft.close("DEFAULT_JUDGMENT");
      return;

    case "APPLY_PRETRIAL_DEFAULTS":
      for (const side of SIDES) {
        if (draft.case.representation[side].mode !== "UNRESOLVED") continue;
        if (draft.case.counselRequests[side]) draft.emit(event("CounselRequestLapsed", { side }));
        draft.emit(event("SelfRepresentationDeclared", { side, by: "COURT" }));
      }
      if (!draft.case.judge) {
        draft.emit(
          event("JudgeAssigned", {
            judge: { kind: "HOUSE" },
            reason: "NO_JUDGE_BY_DEADLINE",
            replaces: null,
          }),
        );
      }
      draft.completeStage("TIMED_OUT", "OPENING_PLAINTIFF");
      return;

    case "SKIP_STAGE": {
      for (const side of absentSides(draft.case, stage)) {
        recordCourtEvidence(
          draft,
          side,
          "Record of non-appearance",
          `The ${SIDE_NAME[side]} side made no submission during ${stage} before the deadline.`,
        );
      }
      draft.completeStage(
        "TIMED_OUT",
        stage === "JUDGE_QUESTIONS" ? "CLOSING_PLAINTIFF" : NEXT_STAGE[stage]!,
      );
      return;
    }

    case "REASSIGN_TO_HOUSE_JUDGE": {
      const previous = draft.case.judge;
      if (previous?.kind === "AGENT") {
        draft.emit(
          event("JudgeAssigned", {
            judge: { kind: "HOUSE" },
            reason: "JUDGE_MISSED_DEADLINE",
            replaces: previous,
          }),
        );
      }
      draft.enterStage("DELIBERATION", "RETRY");
      return;
    }
  }
}

/** Sides that were expected to act in the current stage visit and did nothing. */
function absentSides(state: CaseState, stage: Stage): Side[] {
  const spec = PROCEDURE[stage];
  const since = state.stageEnteredAt!;
  const actedWithEvidence = (side: Side) =>
    state.evidence.some(
      (e) => e.side === side && e.stage === stage && e.submittedBy.kind === "AGENT" && e.at >= since,
    );
  if (spec.mustAct.kind === "SIDE") {
    const side = spec.mustAct.side;
    return state.activity.statementsBySide[side] === 0 && !actedWithEvidence(side) ? [side] : [];
  }
  if (spec.mustAct.kind === "ADDRESSED_SIDES") {
    return state.questionsAddressedTo.filter((side) => state.activity.statementsBySide[side] === 0);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Automatic progression
// ---------------------------------------------------------------------------

/** Advances through every stage whose completion condition is already met. Deterministic. */
function autoProgress(draft: Draft): void {
  for (let guard = 0; guard < STAGE_COUNT; guard++) {
    const state = draft.case;
    if (state.status === "CLOSED" || !state.stage) return;
    const activity = state.activity;
    switch (state.stage) {
      case "AWAITING_RESPONSE":
        if (!state.response) return;
        draft.completeStage("ACTIONS_COMPLETE", "PRE_TRIAL");
        break;
      case "PRE_TRIAL":
        if (!state.judge || SIDES.some((s) => state.representation[s].mode === "UNRESOLVED")) return;
        draft.completeStage("ACTIONS_COMPLETE", "OPENING_PLAINTIFF");
        break;
      case "OPENING_PLAINTIFF":
      case "CLOSING_PLAINTIFF":
        if (activity.statementsBySide.PLAINTIFF === 0) return;
        draft.completeStage("ACTIONS_COMPLETE", NEXT_STAGE[state.stage]!);
        break;
      case "OPENING_DEFENCE":
      case "CLOSING_DEFENCE":
        if (activity.statementsBySide.DEFENCE === 0) return;
        draft.completeStage("ACTIONS_COMPLETE", NEXT_STAGE[state.stage]!);
        break;
      case "JUDGE_QUESTIONS":
        if (state.judge?.kind === "HOUSE") {
          draft.completeStage("HOUSE_JUDGE_NO_QUESTIONS", "CLOSING_PLAINTIFF");
        } else if (activity.judgeStatements > 0) {
          draft.completeStage("ACTIONS_COMPLETE", "ANSWERS");
        } else {
          return;
        }
        break;
      case "ANSWERS":
        if (state.questionsAddressedTo.some((side) => activity.statementsBySide[side] === 0)) return;
        draft.completeStage("ACTIONS_COMPLETE", "CLOSING_PLAINTIFF");
        break;
      default:
        return;
    }
  }
}

const STAGE_COUNT = Object.keys(PROCEDURE).length + 1;
