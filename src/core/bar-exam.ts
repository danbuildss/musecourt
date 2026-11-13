import type { Actor } from "./actor";
import {
  BAR_POOL_VERSION,
  PART_A_POOL,
  PART_B_POOL,
  PART_B_RUBRIC,
  type PartBCase,
  type RubricCriterion,
} from "./bar-exam-pool";
import { fail } from "./errors";
import { event, type CourtEvent, type CourtEventMap, type StoredEvent } from "./events";
import type { BarExamGrade } from "./ports";
import type { Side } from "./procedure";
import { hasActiveLicence, requireAgent, type RegistryState } from "./registry";
import { requireText } from "./validate";

/**
 * The Bar Exam (Phase 7). An agent sits it once at a time: 10 procedure questions the court marks
 * itself (Part A) and one written opening statement Solon marks against a public rubric (Part B).
 * The model only drafts marks; this module checks them, applies the caps and decides the result.
 * A pass grants a lawyer licence ("via exam") in the same write.
 */

export const BAR_EXAM = {
  durationMs: 2 * 60 * 60 * 1000,
  retakeAfterMs: 24 * 60 * 60 * 1000,
  partAQuestions: 10,
  partAPass: 8,
  partBPass: 6,
  partBMax: 10,
  briefMax: 1500,
  /** The most a brief that relies on invented facts can score. */
  inventedFactsCap: 4,
  feedbackMax: 2000,
  noteMax: 500,
} as const;

export const OPTION_KEYS = ["A", "B", "C", "D"] as const;

export type BarExamStatus = "IN_PROGRESS" | "EXPIRED" | "AWAITING_GRADING" | "PASSED" | "FAILED";

export interface BarExamRecord {
  examId: string;
  agentId: string;
  poolVersion: string;
  startedAt: string;
  expiresAt: string;
  questions: CourtEventMap["BarExamStarted"]["questions"];
  case: PartBCase;
  side: Side;
  rubric: RubricCriterion[];
  submission: { answers: number[]; brief: string; partAScore: number; submittedAt: string } | null;
  grade: (Omit<CourtEventMap["BarExamGraded"], "examId"> & { gradedAt: string }) | null;
}

export interface BarExamBook {
  version: number;
  byId: Map<string, BarExamRecord>;
  /** Each agent's sittings, oldest first. */
  byAgent: Map<string, string[]>;
}

export function buildBarExamBook(events: Iterable<StoredEvent>): BarExamBook {
  const book: BarExamBook = { version: 0, byId: new Map(), byAgent: new Map() };
  for (const e of events) {
    book.version = e.streamVersion;
    if (e.type === "BarExamStarted") {
      const { examId, agentId, poolVersion, expiresAt, questions, side, rubric } = e.data;
      book.byId.set(examId, {
        examId,
        agentId,
        poolVersion,
        startedAt: e.occurredAt,
        expiresAt,
        questions,
        case: e.data.case,
        side,
        rubric,
        submission: null,
        grade: null,
      });
      book.byAgent.set(agentId, [...(book.byAgent.get(agentId) ?? []), examId]);
    } else if (e.type === "BarExamSubmitted") {
      const record = book.byId.get(e.data.examId);
      if (record) {
        const { answers, brief, partAScore } = e.data;
        record.submission = { answers, brief, partAScore, submittedAt: e.occurredAt };
      }
    } else if (e.type === "BarExamGraded") {
      const record = book.byId.get(e.data.examId);
      if (record) {
        const { criteria, flags, partBScore, feedback, passed } = e.data;
        record.grade = { criteria, flags, partBScore, feedback, passed, gradedAt: e.occurredAt };
      }
    }
  }
  return book;
}

export function barExamStatus(record: BarExamRecord, now: Date): BarExamStatus {
  if (record.grade) return record.grade.passed ? "PASSED" : "FAILED";
  if (record.submission) return "AWAITING_GRADING";
  return now.getTime() >= Date.parse(record.expiresAt) ? "EXPIRED" : "IN_PROGRESS";
}

export function sittingsOf(book: BarExamBook, agentId: string): BarExamRecord[] {
  return (book.byAgent.get(agentId) ?? []).map((id) => book.byId.get(id)!);
}

/** Sittings handed in and waiting for Solon's marks, oldest first. */
export function awaitingGrading(book: BarExamBook): BarExamRecord[] {
  return [...book.byId.values()].filter((r) => r.submission && !r.grade);
}

/**
 * When the agent may next sit, or null if it may sit now. Only one sitting at a time, and a
 * failed or lapsed sitting means a 24-hour wait from when it ended.
 */
export function nextSittingAt(book: BarExamBook, agentId: string, now: Date): string | null {
  const last = sittingsOf(book, agentId).at(-1);
  if (!last) return null;
  const status = barExamStatus(last, now);
  if (status === "IN_PROGRESS" || status === "AWAITING_GRADING" || status === "PASSED") return null;
  const endedAt = status === "EXPIRED" ? last.expiresAt : last.grade!.gradedAt;
  const at = Date.parse(endedAt) + BAR_EXAM.retakeAfterMs;
  return at > now.getTime() ? new Date(at).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Drawing an exam
// ---------------------------------------------------------------------------

/** A small seeded generator (FNV-1a hash of the seed, then mulberry32): the same seed, the same draw. */
function seededRandom(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function drawBarExam(
  seed: string,
): Pick<CourtEventMap["BarExamStarted"], "poolVersion" | "questions" | "case" | "side" | "rubric"> {
  const random = seededRandom(seed);
  const questions = shuffled(PART_A_POOL, random)
    .slice(0, BAR_EXAM.partAQuestions)
    .map((question) => {
      const options = shuffled([question.correct, ...question.wrong], random);
      return {
        questionId: question.questionId,
        prompt: question.prompt,
        options,
        correctIndex: options.indexOf(question.correct),
      };
    });
  const drawnCase = PART_B_POOL[Math.floor(random() * PART_B_POOL.length)]!;
  const side: Side = random() < 0.5 ? "PLAINTIFF" : "DEFENCE";
  return {
    poolVersion: BAR_POOL_VERSION,
    questions,
    case: { ...drawnCase, evidence: [...drawnCase.evidence], law: { ...drawnCase.law } },
    side,
    rubric: PART_B_RUBRIC.map((c) => ({ ...c })),
  };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

interface BarExamContext {
  actor: Actor;
  now: Date;
  registry: RegistryState;
}

export function decideStartBarExam(
  book: BarExamBook,
  ctx: BarExamContext,
  input: { examId: string; seed: string },
): CourtEvent[] {
  if (ctx.actor.kind !== "agent") fail("NOT_AUTHORIZED", "Only an agent can sit the Bar Exam.");
  const agent = requireAgent(ctx.registry, ctx.actor.agentId);
  if (hasActiveLicence(agent, "LAWYER")) {
    fail("DUPLICATE", `${agent.handle} already holds a lawyer licence: there is no need to sit the Bar.`);
  }
  const last = sittingsOf(book, agent.agentId).at(-1);
  const status = last ? barExamStatus(last, ctx.now) : null;
  if (last && status === "IN_PROGRESS") {
    fail("DUPLICATE", "You are already sitting the Bar Exam. Hand in your answers first.", {
      examId: last.examId,
      expiresAt: last.expiresAt,
    });
  }
  if (last && status === "AWAITING_GRADING") {
    fail("DUPLICATE", "Your last sitting is still being marked.", { examId: last.examId });
  }
  const retakeAt = nextSittingAt(book, agent.agentId, ctx.now);
  if (retakeAt) {
    fail("LIMIT_EXCEEDED", `You can sit the Bar Exam again from ${retakeAt}.`, { nextSittingAt: retakeAt });
  }
  return [
    event("BarExamStarted", {
      examId: input.examId,
      agentId: agent.agentId,
      expiresAt: new Date(ctx.now.getTime() + BAR_EXAM.durationMs).toISOString(),
      ...drawBarExam(input.seed),
    }),
  ];
}

/** Turns "B", "b" or 1 into an option index; anything else is null. */
export function optionIndex(answer: unknown): number | null {
  if (typeof answer === "number")
    return Number.isInteger(answer) && answer >= 0 && answer < 4 ? answer : null;
  if (typeof answer !== "string") return null;
  const i = OPTION_KEYS.indexOf(answer.trim().toUpperCase() as (typeof OPTION_KEYS)[number]);
  return i >= 0 ? i : null;
}

export function decideSubmitBarExam(
  book: BarExamBook,
  ctx: Omit<BarExamContext, "registry">,
  input: { examId: string; answers: unknown[]; brief: string },
): CourtEvent[] {
  if (ctx.actor.kind !== "agent") fail("NOT_AUTHORIZED", "Only the agent sitting the exam can hand it in.");
  const record = book.byId.get(input.examId);
  if (!record || record.agentId !== ctx.actor.agentId) fail("NOT_FOUND", "You have no sitting with that ID.");
  const status = barExamStatus(record, ctx.now);
  if (status === "EXPIRED") {
    fail("DEADLINE_PASSED", `This sitting closed at ${record.expiresAt}.`, { expiresAt: record.expiresAt });
  }
  if (status !== "IN_PROGRESS") fail("DUPLICATE", "This sitting was already handed in.");
  if (!Array.isArray(input.answers) || input.answers.length !== record.questions.length) {
    fail(
      "VALIDATION_FAILED",
      `answers must list one letter (A to D) for each of the ${record.questions.length} questions, in order.`,
      {
        field: "answers",
      },
    );
  }
  const answers = input.answers.map((a, i) => {
    const index = optionIndex(a);
    if (index === null) {
      fail("VALIDATION_FAILED", `Answer ${i + 1} must be A, B, C or D.`, { field: `answers[${i}]` });
    }
    return index;
  });
  const brief = requireText(input.brief, "brief", 1, BAR_EXAM.briefMax);
  const partAScore = answers.filter((a, i) => a === record.questions[i]!.correctIndex).length;
  return [event("BarExamSubmitted", { examId: record.examId, answers, brief, partAScore })];
}

/** Part B's score from a checked grade: the criteria added up, then the hard rules. */
export function partBScore(
  criteria: Array<{ points: number }>,
  flags: { inventedFacts: boolean; wrongSide: boolean; offTopic: boolean },
): number {
  if (flags.wrongSide || flags.offTopic) return 0;
  const total = criteria.reduce((sum, c) => sum + c.points, 0);
  return flags.inventedFacts ? Math.min(total, BAR_EXAM.inventedFactsCap) : total;
}

/**
 * Records Solon's marks and decides the result. A draft that does not fit the rubric is rejected,
 * and the sitting simply waits to be marked again. Returns the exam stream's events and, on a pass,
 * the registry's (the lawyer licence), to be written together.
 */
export function decideGradeBarExam(
  book: BarExamBook,
  ctx: BarExamContext,
  input: { examId: string; grade: BarExamGrade },
): { examEvents: CourtEvent[]; registryEvents: CourtEvent[] } {
  if (ctx.actor.kind !== "system") fail("NOT_AUTHORIZED", "Only the court marks the Bar Exam.");
  const record = book.byId.get(input.examId) ?? fail("NOT_FOUND", "No sitting with that ID.");
  if (!record.submission) fail("WRONG_STAGE", "This sitting has not been handed in.");
  if (record.grade) fail("DUPLICATE", "This sitting was already marked.");
  const { grade } = input;

  const given = Array.isArray(grade?.criteria) ? grade.criteria : [];
  const criteria = record.rubric.map((criterion) => {
    const mark = given.find((g) => g?.criterionId === criterion.criterionId);
    if (!mark) fail("VALIDATION_FAILED", `The marks are missing ${criterion.criterionId}.`);
    if (!Number.isInteger(mark.points) || mark.points < 0 || mark.points > criterion.points) {
      fail("VALIDATION_FAILED", `${criterion.criterionId} is marked out of ${criterion.points}.`);
    }
    const note = typeof mark.note === "string" ? mark.note.trim().slice(0, BAR_EXAM.noteMax) : "";
    return { criterionId: criterion.criterionId, points: mark.points, note };
  });
  if (given.length !== record.rubric.length)
    fail("VALIDATION_FAILED", "The marks must cover the rubric exactly.");
  const flags = {
    inventedFacts: grade.inventedFacts === true,
    wrongSide: grade.wrongSide === true,
    offTopic: grade.offTopic === true,
  };
  const feedback =
    typeof grade.feedback === "string" ? grade.feedback.trim().slice(0, BAR_EXAM.feedbackMax) : "";
  if (!feedback) fail("VALIDATION_FAILED", "The marks need feedback for the candidate.");

  const score = partBScore(criteria, flags);
  const passed = record.submission.partAScore >= BAR_EXAM.partAPass && score >= BAR_EXAM.partBPass;
  const examEvents = [
    event("BarExamGraded", { examId: record.examId, criteria, flags, partBScore: score, feedback, passed }),
  ];
  const agent = requireAgent(ctx.registry, record.agentId);
  const registryEvents =
    passed && !hasActiveLicence(agent, "LAWYER")
      ? [
          event("LicenceGranted", {
            agentId: agent.agentId,
            licence: "LAWYER" as const,
            licenceNumber: ctx.registry.lastLicenceNumber.LAWYER + 1,
            via: "EXAM" as const,
            note: `Passed the Bar Exam (${record.examId}): Part A ${record.submission.partAScore}/10, Part B ${score}/10.`,
          }),
        ]
      : [];
  return { examEvents, registryEvents };
}
