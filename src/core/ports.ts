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
 * A world MuseCourt can verify evidence against. Implementations live in
 * src/connectors. Identity, ownership and search come later.
 */
export interface WorldConnector {
  readonly id: string;
  /** Returns the event, or null if the world has no such event. Throws if the world is unreachable. */
  getEvent(eventId: string): Promise<WorldEventRecord | null>;
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
