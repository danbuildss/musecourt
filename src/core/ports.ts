import type { Actor } from "./actor";
import type { CourtEvent, Finding, LawRef, SentenceItem, StoredEvent, WorldEventRecord } from "./events";

/**
 * Ports: the only ways the core reaches the outside world. Adapters live in
 * src/infra (storage), src/connectors (worlds) and src/model (LLMs).
 */

// ---------------------------------------------------------------------------
// Event store
// ---------------------------------------------------------------------------

export interface AppendBatch {
  streamId: string;
  /** Number of events the caller saw in the stream (0 = the stream must be new). */
  expectedVersion: number;
  events: CourtEvent[];
}

export interface AppendOptions {
  actor: Actor;
  occurredAt: Date;
}

/**
 * Append-only event store. `append` is atomic across all batches and fails
 * with CONCURRENCY_CONFLICT if any stream moved past its expected version.
 * There is deliberately no update or delete.
 */
export interface EventStore {
  readStream(streamId: string): Promise<StoredEvent[]>;
  /** All events after `afterPosition`, in global order. */
  readAll(afterPosition?: number): Promise<StoredEvent[]>;
  append(batches: AppendBatch[], options: AppendOptions): Promise<StoredEvent[]>;
}

// ---------------------------------------------------------------------------
// World connectors
// ---------------------------------------------------------------------------

/**
 * A world MuseCourt can verify evidence (and, optionally, identities) against.
 * Implementations live in src/connectors. Ownership and search come later.
 */
export interface WorldConnector {
  readonly id: string;
  /**
   * Returns the event, or null if the world has no such event. Throws `WorldEventNotKept` if the
   * world no longer keeps it, and any other error if the world is unreachable or its answer could
   * not be authenticated.
   */
  getEvent(eventId: string): Promise<WorldEventRecord | null>;
  /**
   * Present when the world can take down words after the fact. Re-checks an admitted event (using
   * its stored proof where needed) and says whether the world has since removed its words.
   * Throws if the world cannot answer now.
   */
  recheckEvent?(record: WorldEventRecord): Promise<{ redacted: boolean }>;
  /**
   * Present when the world can prove identities (Phase 6, R1). Verifies a proof that the presenter
   * controls a world identity, issued for exactly this `audience` and `nonce`. Throws
   * `WorldIdentityProofRejected` for an invalid proof; any other error means the world could not
   * be reached.
   */
  verifyIdentityProof?(proof: string, expected: WorldProofExpectation): Promise<VerifiedWorldIdentity>;
  /** How an agent obtains a proof for this challenge from its world (shown with the challenge). */
  identityProofInstructions?(expected: WorldProofExpectation): string;
}

export interface WorldProofExpectation {
  /** MuseCourt's exact public origin, which the proof must name. */
  audience: string;
  /** The one-time challenge MuseCourt issued. */
  nonce: string;
}

/** A world identity whose proof checked out. */
export interface VerifiedWorldIdentity {
  /** The world's stable id for the agent (never a renameable username). */
  worldAgentId: string;
  /** The world's id for this proof (e.g. a JWT id), kept for the record. */
  proofId: string;
  issuedAt: string;
  expiresAt: string;
  /** Opaque owner reference vouched for by the world, if any (feeds conflict-of-interest rules). */
  ownerRef: string | null;
  /** Public facts the world vouched for at verification time (username, standing, status…). */
  attributes: Record<string, unknown>;
}

/** The world had this event but no longer keeps it (e.g. past its retention window). */
export class WorldEventNotKept extends Error {
  constructor(message = "The world no longer keeps this event.") {
    super(message);
    this.name = "WorldEventNotKept";
  }
}

/** An identity proof that failed verification. `reason` is a short machine-readable cause. */
export class WorldIdentityProofRejected extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "WorldIdentityProofRejected";
  }
}

// ---------------------------------------------------------------------------
// Model (LLM) port
// ---------------------------------------------------------------------------

/**
 * Provider-neutral evaluation tasks. A model only ever drafts; the core
 * validates drafts exactly like agent input and makes every decision.
 */
export interface CourtModel {
  draftHouseJudgment(request: HouseJudgmentRequest): Promise<HouseJudgmentDraft>;
  gradeBarExam(request: BarExamGradingRequest): Promise<BarExamGrade>;
}

export interface HouseJudgmentRequest {
  persona: string;
  caseNumber: string;
  title: string;
  complaint: string;
  remedySought: string;
  response: string | null;
  charges: LawRef[];
  evidence: Array<{
    evidenceId: string;
    provenance: string;
    side: string | null;
    title: string;
    content: string;
  }>;
  statements: Array<{ stage: string; kind: string; side: string | null; speakerRole: string; text: string }>;
}

export interface HouseJudgmentDraft {
  finding: Finding;
  reasoning: string;
  sentence: SentenceItem[];
  citedLawIds: string[];
  citedEvidenceIds: string[];
}

export interface BarExamGradingRequest {
  examId: string;
  questions: Array<{ questionId: string; prompt: string; rubric: string }>;
  answers: Array<{ questionId: string; answer: string }>;
}

export interface BarExamGrade {
  scores: Array<{ questionId: string; score: number; feedback: string }>;
  overallFeedback: string;
}
