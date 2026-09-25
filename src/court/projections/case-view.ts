import { representativeOf, type CaseState } from "@/core/case-state";
import { PROCEDURE, SIDES, type Side } from "@/core/procedure";
import type { RegistryState } from "@/core/registry";
import { PROVENANCE_LABEL, agentRef, judgeView, type AgentRef } from "./labels";

/** JSON-friendly read model of one case, for the API and the debug view. */
export function toCaseView(state: CaseState, registry: RegistryState) {
  const representation = (side: Side) => {
    const rep = state.representation[side];
    const request = state.counselRequests[side];
    return {
      mode: rep.mode,
      counsel: rep.mode === "COUNSEL" ? agentRef(registry, rep.lawyerId) : null,
      representative: agentRef(registry, representativeOf(state, side)),
      pendingRequest: request
        ? {
            open: request.lawyerId === null,
            lawyer: request.lawyerId ? agentRef(registry, request.lawyerId) : null,
          }
        : null,
    };
  };
  const speakerLabel = (speaker: CaseState["statements"][number]["speaker"]): string =>
    speaker.kind === "HOUSE_JUDGE"
      ? judgeView(registry, { kind: "HOUSE" }).label
      : `${agentRef(registry, speaker.agentId).displayName} (${speaker.role})`;

  return {
    caseId: state.caseId,
    caseNumber: state.caseNumber,
    jurisdictionId: state.jurisdictionId,
    title: state.title,
    status: state.status,
    outcome: state.outcome,
    filedAt: state.filedAt,
    closedAt: state.closedAt,
    stage: state.stage
      ? {
          name: state.stage,
          description: PROCEDURE[state.stage].description,
          deadline: state.deadline,
          allowedActions: PROCEDURE[state.stage].allowedActions,
        }
      : null,
    parties: {
      plaintiff: agentRef(registry, state.plaintiffId),
      defendant: agentRef(registry, state.defendantId),
    },
    representation: Object.fromEntries(SIDES.map((s) => [s, representation(s)])) as Record<
      Side,
      ReturnType<typeof representation>
    >,
    judge: state.judge ? judgeView(registry, state.judge) : null,
    complaint: state.complaint,
    remedySought: state.remedySought,
    response: state.response,
    charges: state.charges,
    evidence: state.evidence.map((e) => ({
      evidenceId: e.evidenceId,
      provenance: e.provenance,
      provenanceLabel: PROVENANCE_LABEL[e.provenance],
      side: e.side,
      stage: e.stage,
      title: e.title,
      content: e.content,
      submittedBy: e.submittedBy.kind === "COURT" ? "MuseCourt" : agentRef(registry, e.submittedBy.agentId),
      world: e.world,
      at: e.at,
      withdrawn: e.withdrawn,
    })),
    statements: state.statements.map((s) => ({ ...s, speakerLabel: speakerLabel(s.speaker) })),
    offers: state.offers.map((o) => ({ ...o, by: agentRef(registry, o.byAgentId) })),
    verdict: state.verdict
      ? { ...state.verdict, judge: state.verdict.judge ? judgeView(registry, state.verdict.judge) : null }
      : null,
    closure: state.closure,
    corrections: state.corrections,
  };
}

export type CaseView = ReturnType<typeof toCaseView>;
export type { AgentRef };
