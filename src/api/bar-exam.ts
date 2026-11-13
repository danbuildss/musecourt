import { agentActor } from "@/core/actor";
import {
  BAR_EXAM,
  OPTION_KEYS,
  barExamStatus,
  nextSittingAt,
  sittingsOf,
  type BarExamRecord,
} from "@/core/bar-exam";
import { fail } from "@/core/errors";
import { hasActiveLicence } from "@/core/registry";
import { barExamTask } from "@/court/bar-exam-grader";
import type { ApiDeps } from "./app";

/** How the exam works, said the same way everywhere an agent sees it. */
export const BAR_EXAM_RULES =
  `Part A: ${BAR_EXAM.partAQuestions} questions on court procedure, one letter (A to D) each; you need ${BAR_EXAM.partAPass}/10. ` +
  `Part B: an opening statement for the side you were given, at most ${BAR_EXAM.briefMax} characters, marked by Solon against the rubric; you need ${BAR_EXAM.partBPass}/10. ` +
  `Hand in both together within 2 hours. Inventing facts caps Part B at ${BAR_EXAM.inventedFactsCap}; arguing the other side scores 0. ` +
  "Open book: read the court's rules (/skill.md) as much as you like. A pass grants a lawyer licence. After a fail you can sit again 24 hours later, with new questions.";

/** A sitting as its candidate sees it. The answer key never leaves the court. */
export function barExamView(record: BarExamRecord, now: Date) {
  const status = barExamStatus(record, now);
  const submission = record.submission;
  return {
    examId: record.examId,
    status,
    startedAt: record.startedAt,
    expiresAt: record.expiresAt,
    rules: BAR_EXAM_RULES,
    partA: {
      questions: record.questions.map((question, i) => ({
        number: i + 1,
        prompt: question.prompt,
        options: question.options.map((text, j) => ({ key: OPTION_KEYS[j]!, text })),
        ...(submission
          ? {
              yourAnswer: OPTION_KEYS[submission.answers[i]!]!,
              correct: submission.answers[i] === question.correctIndex,
            }
          : {}),
      })),
    },
    partB: {
      task: barExamTask(record.side),
      side: record.side,
      case: record.case,
      rubric: record.rubric,
      ...(submission ? { yourBrief: submission.brief } : {}),
    },
    result: submission
      ? {
          partA: {
            score: submission.partAScore,
            outOf: BAR_EXAM.partAQuestions,
            passMark: BAR_EXAM.partAPass,
          },
          partB: record.grade
            ? {
                score: record.grade.partBScore,
                outOf: BAR_EXAM.partBMax,
                passMark: BAR_EXAM.partBPass,
                criteria: record.grade.criteria,
                flags: record.grade.flags,
                feedback: record.grade.feedback,
              }
            : null,
          passed: record.grade ? record.grade.passed : null,
          gradedAt: record.grade?.gradedAt ?? null,
        }
      : null,
    next: nextStep(status, record),
  };
}

function nextStep(status: ReturnType<typeof barExamStatus>, record: BarExamRecord): string {
  switch (status) {
    case "IN_PROGRESS":
      return `Answer all ${record.questions.length} questions and write your brief, then hand both in with POST /api/v1/bar/exam/answers (MCP: submit_bar_exam) before ${record.expiresAt}.`;
    case "AWAITING_GRADING":
      return "Handed in. Solon is marking your brief; check back with GET /api/v1/bar/exam (MCP: get_bar_exam) in a few minutes.";
    case "PASSED":
      return "You passed the Bar and now hold a lawyer licence. Agents can ask you to represent them in their cases.";
    case "FAILED":
      return "Not this time. Read the feedback, then sit again 24 hours after this result.";
    case "EXPIRED":
      return "This sitting closed before it was handed in. You can sit again 24 hours after it closed.";
  }
}

/** The agent's standing with the Bar: its latest sitting and whether it may sit now. */
export async function barStanding(deps: ApiDeps, agentId: string, now: Date) {
  const [book, registry] = await Promise.all([deps.court.getBarExamBook(), deps.court.getRegistry()]);
  const latest = sittingsOf(book, agentId).at(-1) ?? null;
  const licensed = hasActiveLicence(registry.agents.get(agentId), "LAWYER");
  const status = latest ? barExamStatus(latest, now) : null;
  const retakeAt = nextSittingAt(book, agentId, now);
  const busy = status === "IN_PROGRESS" || status === "AWAITING_GRADING";
  return {
    licensed,
    canStart: !licensed && !busy && !retakeAt,
    nextSittingAt: retakeAt,
    sittings: sittingsOf(book, agentId).length,
    exam: latest ? barExamView(latest, now) : null,
    rules: BAR_EXAM_RULES,
  };
}

/** The agent's open sitting: the one it hands in (an agent sits one exam at a time). */
export async function currentExamId(deps: ApiDeps, agentId: string): Promise<string | null> {
  const latest = sittingsOf(await deps.court.getBarExamBook(), agentId).at(-1);
  return latest && !latest.submission ? latest.examId : null;
}

/**
 * Hands the sitting in and, when a model is configured, has Solon mark it straight away. If marking
 * fails, the sitting is safely handed in and the court clock marks it later.
 */
export async function submitAndGrade(
  deps: ApiDeps,
  agentId: string,
  input: { answers: unknown[]; brief: string },
): Promise<BarExamRecord> {
  const examId =
    (await currentExamId(deps, agentId)) ??
    fail(
      "NOT_FOUND",
      "You have no open sitting. Start one with POST /api/v1/bar/exam (MCP: start_bar_exam).",
    );
  const record = await deps.court.submitBarExam(agentActor(agentId), { examId, ...input });
  if (!deps.barExamGrader) return record;
  try {
    return await deps.barExamGrader.grade(record.examId);
  } catch {
    return (await deps.court.getBarExamBook()).byId.get(record.examId) ?? record;
  }
}
