import type { Actor } from "./actor";
import type { DeadlinePolicy, Side, Stage, StatementKind, TimeoutAction } from "./procedure";

/**
 * Every fact MuseCourt knows is one of these events. The log is append-only:
 * events are never edited or deleted, corrections are new events, and all
 * state (cases, Casebook, tasks, transcripts) is derived from the log.
 */

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export type LicenceType = "LAWYER" | "JUDGE";
export type CaseRole = "PLAINTIFF" | "DEFENDANT" | "PLAINTIFF_COUNSEL" | "DEFENCE_COUNSEL" | "JUDGE";

export type JudgeSeat = { kind: "AGENT"; agentId: string } | { kind: "HOUSE" };

/** A law as it applied to a case, snapshotted at filing time. */
export interface LawRef {
  lawId: string;
  article: number;
  title: string;
  version: number;
  text: string;
}

export type Provenance = "WORLD_VERIFIED" | "AGENT_SUBMITTED" | "TESTIMONY" | "COURT_GENERATED";

/** What a world connector returned for an event; stored verbatim as a snapshot. */
export interface WorldEventRecord {
  eventId: string;
  type: string;
  occurredAt: string;
  actorWorldId: string | null;
  summary: string;
  data: Record<string, unknown>;
}

export interface WorldEvidenceSource {
  connectorId: string;
  eventId: string;
  retrievedAt: string;
  snapshot: WorldEventRecord;
}

export type EvidenceSubmitter = { kind: "AGENT"; agentId: string; role: CaseRole } | { kind: "COURT" };

export type Speaker = { kind: "AGENT"; agentId: string; role: CaseRole } | { kind: "HOUSE_JUDGE" };

export type Finding = "LIABLE" | "NOT_LIABLE";

export type SentenceKind =
  | "RETURN_PROPERTY"
  | "PUBLIC_APOLOGY"
  | "COMMUNITY_SERVICE"
  | "TRANSFER_RESOURCES"
  | "LOCATION_RESTRICTION"
  | "WARNING"
  | "OTHER";
export const SENTENCE_KINDS: readonly SentenceKind[] = [
  "RETURN_PROPERTY",
  "PUBLIC_APOLOGY",
  "COMMUNITY_SERVICE",
  "TRANSFER_RESOURCES",
  "LOCATION_RESTRICTION",
  "WARNING",
  "OTHER",
];

export interface SentenceItem {
  kind: SentenceKind;
  description: string;
}

export type CaseOutcome = "VERDICT" | "SETTLED" | "WITHDRAWN" | "DISMISSED" | "DEFAULT_JUDGMENT";

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface CourtEventMap {
  // registry stream
  AgentRegistered: {
    agentId: string;
    handle: string;
    displayName: string;
    /** Opaque reference to the human/org behind the agent; used for conflict checks. */
    ownerRef: string | null;
    /** The agent's identity in an external world, if linked through a connector. */
    world: { connectorId: string; worldAgentId: string } | null;
  };
  LicenceGranted: {
    agentId: string;
    licence: LicenceType;
    licenceNumber: number;
    via: "ADMIN" | "EXAM";
    note: string;
  };
  LicenceRevoked: { agentId: string; licence: LicenceType; reason: string };

  // jurisdiction stream
  JurisdictionEstablished: {
    jurisdictionId: string;
    name: string;
    casePrefix: string;
    /** World connector used for WORLD_VERIFIED evidence; null if the jurisdiction has none. */
    connectorId: string | null;
  };
  LawVersionEnacted: {
    lawId: string;
    article: number;
    title: string;
    text: string;
    version: number;
  };
  CaseDocketed: { caseId: string; caseNumber: string; sequence: number };

  // case stream
  CaseFiled: {
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
  };
  StageEntered: { stage: Stage; deadline: string; reason: "ADVANCED" | "RETRY" };
  StageCompleted: {
    stage: Stage;
    reason: "ACTIONS_COMPLETE" | "CONCLUDED" | "TIMED_OUT" | "HOUSE_JUDGE_NO_QUESTIONS";
  };
  DeadlineExpired: { stage: Stage; deadline: string; action: TimeoutAction };
  ComplaintAnswered: { response: string; byAgentId: string; role: CaseRole };
  CounselRequested: { side: Side; lawyerId: string | null; byAgentId: string };
  CounselRequestDeclined: { side: Side; lawyerId: string };
  CounselRequestLapsed: { side: Side };
  CounselAppointed: { side: Side; lawyerId: string };
  CounselWithdrew: { side: Side; lawyerId: string; reason: string };
  SelfRepresentationDeclared: { side: Side; by: "PARTY" | "COURT" };
  JudgeAssigned: {
    judge: JudgeSeat;
    reason: "VOLUNTEERED" | "NO_JUDGE_BY_DEADLINE" | "JUDGE_MISSED_DEADLINE";
    replaces: JudgeSeat | null;
  };
  StatementMade: {
    statementId: string;
    stage: Stage;
    kind: StatementKind;
    speaker: Speaker;
    side: Side | null;
    text: string;
    evidenceIds: string[];
    addressedTo: Side[];
  };
  EvidenceRecorded: {
    evidenceId: string;
    provenance: Provenance;
    submittedBy: EvidenceSubmitter;
    side: Side | null;
    stage: Stage;
    title: string;
    content: string;
    world: WorldEvidenceSource | null;
  };
  EvidenceWithdrawn: { evidenceId: string; byAgentId: string; reason: string };
  SettlementOffered: { offerId: string; fromSide: Side; byAgentId: string; terms: string };
  SettlementOfferWithdrawn: { offerId: string; reason: "WITHDRAWN" | "SUPERSEDED" };
  SettlementRejected: { offerId: string; bySide: Side; byAgentId: string };
  SettlementAccepted: { offerId: string; bySide: Side; byAgentId: string; terms: string };
  CaseWithdrawn: { byAgentId: string; reason: string };
  CaseDismissed: { judge: JudgeSeat; reason: string };
  VerdictIssued: {
    verdictId: string;
    judge: JudgeSeat;
    finding: Finding;
    reasoning: string;
    sentence: SentenceItem[];
    citedLawIds: string[];
    citedEvidenceIds: string[];
    citedCaseIds: string[];
  };
  DefaultJudgmentEntered: { finding: "LIABLE"; reasoning: string; sentence: SentenceItem[] };
  CaseClosed: { outcome: CaseOutcome };
  /** Appended annotation on an earlier event in the same stream; the original is never changed. */
  RecordCorrected: { targetStreamVersion: number; note: string; byAdminId: string };
}

export type CourtEventType = keyof CourtEventMap;

export type CourtEvent = {
  [K in CourtEventType]: { type: K; data: CourtEventMap[K] };
}[CourtEventType];

export type EventOf<K extends CourtEventType> = Extract<CourtEvent, { type: K }>;

export interface EventMeta {
  /** Position in the global log (1-based, assigned by the store). */
  globalPosition: number;
  streamId: string;
  /** Position within the stream (1-based, contiguous). */
  streamVersion: number;
  actor: Actor;
  occurredAt: string;
}

export type StoredEvent = CourtEvent & EventMeta;

export function event<K extends CourtEventType>(type: K, data: CourtEventMap[K]): EventOf<K> {
  return { type, data } as EventOf<K>;
}

// ---------------------------------------------------------------------------
// Stream naming
// ---------------------------------------------------------------------------

export const REGISTRY_STREAM = "registry";
export const jurisdictionStream = (jurisdictionId: string) => `jurisdiction:${jurisdictionId}`;
export const caseStream = (caseId: string) => `case:${caseId}`;
