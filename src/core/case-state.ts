import type {
  CaseOutcome,
  CaseRole,
  EvidenceSubmitter,
  Finding,
  JudgeSeat,
  LawRef,
  Provenance,
  SentenceItem,
  Speaker,
  StoredEvent,
  WorldEvidenceSource,
} from "./events";
import type { DeadlinePolicy, Side, Stage, StatementKind } from "./procedure";

/**
 * CaseState is a pure projection of a case stream. It is rebuilt from events
 * for every command, so it can never drift from the log.
 */

export type Representation =
  { mode: "UNRESOLVED" } | { mode: "SELF" } | { mode: "COUNSEL"; lawyerId: string };

export interface RoleHolding {
  agentId: string;
  role: CaseRole;
  current: boolean;
}

export interface StatementRecord {
  statementId: string;
  stage: Stage;
  kind: StatementKind;
  speaker: Speaker;
  side: Side | null;
  text: string;
  evidenceIds: string[];
  addressedTo: Side[];
  at: string;
  streamVersion: number;
}

export interface EvidenceRecord {
  evidenceId: string;
  provenance: Provenance;
  submittedBy: EvidenceSubmitter;
  side: Side | null;
  stage: Stage;
  title: string;
  content: string;
  world: WorldEvidenceSource | null;
  at: string;
  withdrawn: { byAgentId: string; reason: string; at: string } | null;
}

export interface SettlementOfferRecord {
  offerId: string;
  fromSide: Side;
  byAgentId: string;
  terms: string;
  /** LAPSED: still open when the case closed (derived from CaseClosed; no separate event). */
  status: "OPEN" | "ACCEPTED" | "REJECTED" | "WITHDRAWN" | "SUPERSEDED" | "LAPSED";
  at: string;
}

export interface VerdictRecord {
  kind: "VERDICT" | "DEFAULT_JUDGMENT";
  verdictId: string | null;
  judge: JudgeSeat | null;
  finding: Finding;
  reasoning: string;
  sentence: SentenceItem[];
  citedLawIds: string[];
  citedEvidenceIds: string[];
  citedCaseIds: string[];
  at: string;
}

export interface CorrectionRecord {
  targetStreamVersion: number;
  note: string;
  byAdminId: string;
  at: string;
}

/** Activity in the current visit to the current stage. Reset on every StageEntered. */
export interface StageActivity {
  statementsBySide: Record<Side, number>;
  judgeStatements: number;
}

export interface CaseState {
  version: number;
  caseId: string;
  caseNumber: string;
  jurisdictionId: string;
  title: string;
  plaintiffId: string;
  defendantId: string;
  complaint: string;
  remedySought: string;
  charges: LawRef[];
  deadlinePolicy: DeadlinePolicy;
  filedAt: string;

  status: "OPEN" | "CLOSED";
  stage: Stage | null;
  stageEnteredAt: string | null;
  deadline: string | null;
  activity: StageActivity;
  /** Sides the judge addressed with questions in this case's JUDGE_QUESTIONS stage. */
  questionsAddressedTo: Side[];

  response: { text: string; byAgentId: string; at: string } | null;
  representation: Record<Side, Representation>;
  counselRequests: Record<Side, { lawyerId: string | null; byAgentId: string } | null>;
  judge: JudgeSeat | null;
  /** Every role any agent has ever held in this case, current and former. */
  roles: RoleHolding[];

  statements: StatementRecord[];
  evidence: EvidenceRecord[];
  offers: SettlementOfferRecord[];

  outcome: CaseOutcome | null;
  verdict: VerdictRecord | null;
  closure: { reason: string; by: string } | null;
  closedAt: string | null;
  corrections: CorrectionRecord[];
}

const freshActivity = (): StageActivity => ({
  statementsBySide: { PLAINTIFF: 0, DEFENCE: 0 },
  judgeStatements: 0,
});

function releaseRole(state: CaseState, agentId: string, role: CaseRole) {
  for (const holding of state.roles) {
    if (holding.agentId === agentId && holding.role === role) holding.current = false;
  }
}

function holdRole(state: CaseState, agentId: string, role: CaseRole) {
  const existing = state.roles.find((h) => h.agentId === agentId && h.role === role);
  if (existing) existing.current = true;
  else state.roles.push({ agentId, role, current: true });
}

/** Applies one event. Mutates and returns `state` (callers own the object). */
export function evolveCase(state: CaseState | null, e: StoredEvent): CaseState | null {
  if (e.type === "CaseFiled") {
    const d = e.data;
    return {
      version: e.streamVersion,
      caseId: d.caseId,
      caseNumber: d.caseNumber,
      jurisdictionId: d.jurisdictionId,
      title: d.title,
      plaintiffId: d.plaintiffId,
      defendantId: d.defendantId,
      complaint: d.complaint,
      remedySought: d.remedySought,
      charges: d.charges,
      deadlinePolicy: d.deadlinePolicy,
      filedAt: e.occurredAt,
      status: "OPEN",
      stage: null,
      stageEnteredAt: null,
      deadline: null,
      activity: freshActivity(),
      questionsAddressedTo: [],
      response: null,
      representation: { PLAINTIFF: { mode: "UNRESOLVED" }, DEFENCE: { mode: "UNRESOLVED" } },
      counselRequests: { PLAINTIFF: null, DEFENCE: null },
      judge: null,
      roles: [
        { agentId: d.plaintiffId, role: "PLAINTIFF", current: true },
        { agentId: d.defendantId, role: "DEFENDANT", current: true },
      ],
      statements: [],
      evidence: [],
      offers: [],
      outcome: null,
      verdict: null,
      closure: null,
      closedAt: null,
      corrections: [],
    };
  }
  if (!state) return state;
  state.version = e.streamVersion;

  switch (e.type) {
    case "StageEntered":
      state.stage = e.data.stage;
      state.stageEnteredAt = e.occurredAt;
      state.deadline = e.data.deadline;
      state.activity = freshActivity();
      break;
    case "StageCompleted":
    case "DeadlineExpired":
      break;
    case "ComplaintAnswered":
      state.response = { text: e.data.response, byAgentId: e.data.byAgentId, at: e.occurredAt };
      break;
    case "CounselRequested":
      state.counselRequests[e.data.side] = { lawyerId: e.data.lawyerId, byAgentId: e.data.byAgentId };
      state.representation[e.data.side] = { mode: "UNRESOLVED" };
      break;
    case "CounselRequestDeclined":
    case "CounselRequestLapsed":
      state.counselRequests[e.data.side] = null;
      break;
    case "CounselAppointed":
      state.counselRequests[e.data.side] = null;
      state.representation[e.data.side] = { mode: "COUNSEL", lawyerId: e.data.lawyerId };
      holdRole(state, e.data.lawyerId, e.data.side === "PLAINTIFF" ? "PLAINTIFF_COUNSEL" : "DEFENCE_COUNSEL");
      break;
    case "CounselWithdrew": {
      releaseRole(
        state,
        e.data.lawyerId,
        e.data.side === "PLAINTIFF" ? "PLAINTIFF_COUNSEL" : "DEFENCE_COUNSEL",
      );
      // Before trial the side must choose again; once trial has begun the party continues alone.
      const pretrial = state.stage === "AWAITING_RESPONSE" || state.stage === "PRE_TRIAL";
      state.representation[e.data.side] = pretrial ? { mode: "UNRESOLVED" } : { mode: "SELF" };
      break;
    }
    case "SelfRepresentationDeclared":
      state.counselRequests[e.data.side] = null;
      state.representation[e.data.side] = { mode: "SELF" };
      break;
    case "JudgeAssigned":
      if (state.judge?.kind === "AGENT") releaseRole(state, state.judge.agentId, "JUDGE");
      state.judge = e.data.judge;
      if (e.data.judge.kind === "AGENT") holdRole(state, e.data.judge.agentId, "JUDGE");
      break;
    case "StatementMade": {
      const d = e.data;
      state.statements.push({ ...d, at: e.occurredAt, streamVersion: e.streamVersion });
      if (d.side) state.activity.statementsBySide[d.side] += 1;
      else state.activity.judgeStatements += 1;
      if (d.kind === "QUESTION") state.questionsAddressedTo = [...d.addressedTo];
      break;
    }
    case "EvidenceRecorded":
      state.evidence.push({ ...e.data, at: e.occurredAt, withdrawn: null });
      break;
    case "EvidenceWithdrawn": {
      const item = state.evidence.find((x) => x.evidenceId === e.data.evidenceId);
      if (item) item.withdrawn = { byAgentId: e.data.byAgentId, reason: e.data.reason, at: e.occurredAt };
      break;
    }
    case "SettlementOffered":
      state.offers.push({ ...e.data, status: "OPEN", at: e.occurredAt });
      break;
    case "SettlementOfferWithdrawn":
    case "SettlementRejected":
    case "SettlementAccepted": {
      const offer = state.offers.find((o) => o.offerId === e.data.offerId);
      if (offer) {
        offer.status =
          e.type === "SettlementAccepted"
            ? "ACCEPTED"
            : e.type === "SettlementRejected"
              ? "REJECTED"
              : e.data.reason === "SUPERSEDED"
                ? "SUPERSEDED"
                : "WITHDRAWN";
      }
      break;
    }
    case "CaseWithdrawn":
      state.closure = { reason: e.data.reason, by: e.data.byAgentId };
      break;
    case "CaseDismissed":
      state.closure = {
        reason: e.data.reason,
        by: e.data.judge.kind === "AGENT" ? e.data.judge.agentId : "HOUSE_JUDGE",
      };
      break;
    case "VerdictIssued":
      state.verdict = { kind: "VERDICT", ...e.data, at: e.occurredAt };
      break;
    case "DefaultJudgmentEntered":
      state.verdict = {
        kind: "DEFAULT_JUDGMENT",
        verdictId: null,
        judge: null,
        finding: e.data.finding,
        reasoning: e.data.reasoning,
        sentence: e.data.sentence,
        citedLawIds: [],
        citedEvidenceIds: [],
        citedCaseIds: [],
        at: e.occurredAt,
      };
      break;
    case "CaseClosed":
      for (const offer of state.offers) if (offer.status === "OPEN") offer.status = "LAPSED";
      state.status = "CLOSED";
      state.outcome = e.data.outcome;
      state.closedAt = e.occurredAt;
      state.stage = null;
      state.deadline = null;
      break;
    case "RecordCorrected":
      state.corrections.push({ ...e.data, at: e.occurredAt });
      break;
    default:
      break;
  }
  return state;
}

export function buildCase(events: Iterable<StoredEvent>): CaseState | null {
  let state: CaseState | null = null;
  for (const e of events) state = evolveCase(state, e);
  return state;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function partyOf(state: CaseState, side: Side): string {
  return side === "PLAINTIFF" ? state.plaintiffId : state.defendantId;
}

export function counselOf(state: CaseState, side: Side): string | null {
  const rep = state.representation[side];
  return rep.mode === "COUNSEL" ? rep.lawyerId : null;
}

/** Who speaks for a side: its counsel, otherwise the party itself. */
export function representativeOf(state: CaseState, side: Side): string {
  return counselOf(state, side) ?? partyOf(state, side);
}

/** The side an agent speaks for (as representative), if any. */
export function sideRepresentedBy(state: CaseState, agentId: string): Side | null {
  if (representativeOf(state, "PLAINTIFF") === agentId) return "PLAINTIFF";
  if (representativeOf(state, "DEFENCE") === agentId) return "DEFENCE";
  return null;
}

/** The side an agent belongs to as party or current counsel. */
export function sideOfMember(state: CaseState, agentId: string): Side | null {
  for (const side of ["PLAINTIFF", "DEFENCE"] as const) {
    if (partyOf(state, side) === agentId || counselOf(state, side) === agentId) return side;
  }
  return null;
}

export function isSeatedJudgeAgent(state: CaseState, agentId: string): boolean {
  return state.judge?.kind === "AGENT" && state.judge.agentId === agentId;
}

export function activeEvidence(state: CaseState): EvidenceRecord[] {
  return state.evidence.filter((e) => !e.withdrawn);
}

export function openOfferFrom(state: CaseState, side: Side): SettlementOfferRecord | undefined {
  return state.offers.find((o) => o.fromSide === side && o.status === "OPEN");
}
