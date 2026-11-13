import { BAR_EXAM, awaitingGrading, type BarExamRecord } from "@/core/bar-exam";
import { fail } from "@/core/errors";
import type { BarExamGradingRequest, CourtModel } from "@/core/ports";
import type { Court } from "./court";

/** The task every candidate gets, word for word. */
export function barExamTask(side: "PLAINTIFF" | "DEFENCE"): string {
  return `You are counsel for the ${side === "PLAINTIFF" ? "plaintiff" : "defence"}. Write your opening statement in at most ${BAR_EXAM.briefMax} characters, using only the facts and evidence given.`;
}

/** Builds the marking request. The brief travels as a data field, never as instructions. */
export function buildBarExamGradingRequest(record: BarExamRecord): BarExamGradingRequest {
  if (!record.submission) fail("WRONG_STAGE", "This sitting has not been handed in.");
  return {
    examId: record.examId,
    task: barExamTask(record.side),
    case: {
      title: record.case.title,
      facts: record.case.facts,
      evidence: [...record.case.evidence],
      law: record.case.law,
    },
    side: record.side,
    rubric: record.rubric,
    brief: record.submission.brief,
  };
}

/**
 * Has Solon mark handed-in sittings. The model drafts marks; the core checks them and decides the
 * result. If the model fails or drafts marks that don't fit the rubric, the sitting simply waits
 * and the court clock tries again.
 */
export class BarExamGrader {
  constructor(
    private readonly court: Court,
    private readonly model: CourtModel,
  ) {}

  async grade(examId: string): Promise<BarExamRecord> {
    const record = (await this.court.getBarExamBook()).byId.get(examId);
    if (!record) fail("NOT_FOUND", "No sitting with that ID.");
    if (record.grade) return record;
    const grade = await this.model.gradeBarExam(buildBarExamGradingRequest(record));
    return this.court.recordBarExamGrade(examId, grade);
  }

  /** Marks up to `limit` waiting sittings, oldest first. One failure never blocks the rest. */
  async gradeWaiting(limit = 5): Promise<{ waiting: number; graded: number; failed: string[] }> {
    const waiting = awaitingGrading(await this.court.getBarExamBook());
    const failed: string[] = [];
    let graded = 0;
    for (const record of waiting.slice(0, limit)) {
      try {
        await this.grade(record.examId);
        graded += 1;
      } catch {
        failed.push(record.examId);
      }
    }
    return { waiting: waiting.length, graded, failed };
  }
}
