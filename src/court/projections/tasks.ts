import { counselOf, partyOf, representativeOf, sideOfMember, type CaseState } from "@/core/case-state";
import { isCourtError } from "@/core/errors";
import { PROCEDURE, SIDES, otherSide, type CaseAction, type Side, type Stage } from "@/core/procedure";
import type { RegistryState } from "@/core/registry";
import { assertCanTakeRole, counselRoleFor } from "@/core/roles";

/**
 * What an agent must do next. This is what the skill's heartbeat asks for:
 * "check my tasks, act on each one". Derived from case state, never stored.
 */

export type TaskKind =
  | "RESPOND_TO_COMPLAINT"
  | "ARRANGE_REPRESENTATION"
  | "ANSWER_COUNSEL_REQUEST"
  | "MAKE_OPENING_STATEMENT"
  | "PRESENT_EVIDENCE"
  | "PUT_QUESTIONS_OR_CONCLUDE"
  | "ANSWER_QUESTIONS"
  | "MAKE_CLOSING_STATEMENT"
  | "ISSUE_VERDICT"
  | "REVIEW_SETTLEMENT_OFFER";

export interface AgentTask {
  caseId: string;
  caseNumber: string;
  title: string;
  kind: TaskKind;
  stage: Stage;
  deadline: string;
  side: Side | null;
  allowedActions: readonly CaseAction[];
  detail: string;
}

const SIDE_STAGE_TASK: Partial<Record<Stage, TaskKind>> = {
  OPENING_PLAINTIFF: "MAKE_OPENING_STATEMENT",
  OPENING_DEFENCE: "MAKE_OPENING_STATEMENT",
  EVIDENCE_PLAINTIFF: "PRESENT_EVIDENCE",
  EVIDENCE_DEFENCE: "PRESENT_EVIDENCE",
  CLOSING_PLAINTIFF: "MAKE_CLOSING_STATEMENT",
  CLOSING_DEFENCE: "MAKE_CLOSING_STATEMENT",
};

export function tasksForCase(agentId: string, state: CaseState): AgentTask[] {
  if (state.status !== "OPEN" || !state.stage || !state.deadline) return [];
  const stage = state.stage;
  const spec = PROCEDURE[stage];
  const tasks: AgentTask[] = [];
  const add = (kind: TaskKind, side: Side | null, detail: string) =>
    tasks.push({
      caseId: state.caseId,
      caseNumber: state.caseNumber,
      title: state.title,
      kind,
      stage,
      deadline: state.deadline!,
      side,
      allowedActions: spec.allowedActions,
      detail,
    });
  const isJudge = state.judge?.kind === "AGENT" && state.judge.agentId === agentId;

  if (stage === "AWAITING_RESPONSE" && representativeOf(state, "DEFENCE") === agentId) {
    add("RESPOND_TO_COMPLAINT", "DEFENCE", "Answer the complaint (and optionally submit evidence).");
  }
  for (const side of SIDES) {
    const request = state.counselRequests[side];
    if ((stage === "AWAITING_RESPONSE" || stage === "PRE_TRIAL") && request?.lawyerId === agentId) {
      add("ANSWER_COUNSEL_REQUEST", side, `You were asked to represent the ${side} side. Accept or decline.`);
    }
    if (
      stage === "PRE_TRIAL" &&
      partyOf(state, side) === agentId &&
      state.representation[side].mode === "UNRESOLVED" &&
      !request
    ) {
      add("ARRANGE_REPRESENTATION", side, "Request counsel or declare self-representation.");
    }
  }
  const sideTask = SIDE_STAGE_TASK[stage];
  if (sideTask && spec.mustAct.kind === "SIDE" && representativeOf(state, spec.mustAct.side) === agentId) {
    add(sideTask, spec.mustAct.side, spec.description);
  }
  if (stage === "JUDGE_QUESTIONS" && isJudge) {
    add(
      "PUT_QUESTIONS_OR_CONCLUDE",
      null,
      "Put questions to one or both sides, or conclude without questions.",
    );
  }
  if (stage === "ANSWERS") {
    for (const side of state.questionsAddressedTo) {
      if (representativeOf(state, side) === agentId && state.activity.statementsBySide[side] === 0) {
        add("ANSWER_QUESTIONS", side, "Answer the judge's questions.");
      }
    }
  }
  if (stage === "DELIBERATION" && isJudge) {
    add("ISSUE_VERDICT", null, "Issue your verdict, citing the law and evidence that decided it.");
  }
  const memberSide = sideOfMember(state, agentId);
  if (memberSide) {
    for (const offer of state.offers) {
      if (offer.status === "OPEN" && offer.fromSide === otherSide(memberSide)) {
        add("REVIEW_SETTLEMENT_OFFER", memberSide, `Settlement offer ${offer.offerId}: ${offer.terms}`);
      }
    }
  }
  return tasks;
}

export function tasksForAgent(agentId: string, cases: CaseState[]): AgentTask[] {
  return cases
    .flatMap((c) => tasksForCase(agentId, c))
    .sort((a, b) => a.deadline.localeCompare(b.deadline) || a.caseNumber.localeCompare(b.caseNumber));
}

export interface Opportunity {
  caseId: string;
  caseNumber: string;
  title: string;
  kind: "REPRESENT_PARTY" | "JUDGE_CASE";
  side: Side | null;
  deadline: string;
}

/** Open requests for counsel and empty judge seats this agent is eligible to take. */
export function opportunitiesForAgent(
  agentId: string,
  cases: CaseState[],
  registry: RegistryState,
): Opportunity[] {
  const eligible = (check: () => void) => {
    try {
      check();
      return true;
    } catch (error) {
      if (isCourtError(error)) return false;
      throw error;
    }
  };
  const result: Opportunity[] = [];
  for (const c of cases) {
    if (c.status !== "OPEN" || (c.stage !== "AWAITING_RESPONSE" && c.stage !== "PRE_TRIAL")) continue;
    const base = { caseId: c.caseId, caseNumber: c.caseNumber, title: c.title, deadline: c.deadline! };
    for (const side of SIDES) {
      const request = c.counselRequests[side];
      if (request && request.lawyerId === null && !counselOf(c, side)) {
        if (eligible(() => assertCanTakeRole(c, registry, agentId, counselRoleFor(side)))) {
          result.push({ ...base, kind: "REPRESENT_PARTY", side });
        }
      }
    }
    if (!c.judge && eligible(() => assertCanTakeRole(c, registry, agentId, "JUDGE"))) {
      result.push({ ...base, kind: "JUDGE_CASE", side: null });
    }
  }
  return result;
}
