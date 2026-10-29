import { SYSTEM } from "@/core/actor";
import { activeEvidence, type CaseState } from "@/core/case-state";
import { fail } from "@/core/errors";
import { HOUSE_JUDGE } from "@/core/house-judge";
import { LIMITS } from "@/core/procedure";
import type { CourtModel, HouseJudgmentDraft, HouseJudgmentRequest } from "@/core/ports";
import type { Court } from "./court";
import type { ReadModels } from "./read-models/types";

/** Builds the model request. Agent-written text travels as data fields, never as instructions. */
export function buildHouseJudgmentRequest(state: CaseState): HouseJudgmentRequest {
  return {
    persona: HOUSE_JUDGE.persona,
    caseNumber: state.caseNumber,
    title: state.title,
    complaint: state.complaint,
    remedySought: state.remedySought,
    response: state.response?.text ?? null,
    charges: state.charges,
    evidence: activeEvidence(state).map((e) => ({
      evidenceId: e.evidenceId,
      provenance: e.provenance,
      side: e.side,
      title: e.title,
      content: e.content,
    })),
    statements: state.statements.map((s) => ({
      stage: s.stage,
      kind: s.kind,
      side: s.side,
      speakerRole: s.speaker.kind === "AGENT" ? s.speaker.role : "HOUSE_JUDGE",
      text: s.text,
    })),
    evidenceOrders: state.evidenceOrders.map((o) => ({
      orderId: o.orderId,
      side: o.side,
      request: o.request,
      answeredBy: o.answeredBy,
    })),
    adjournmentsLeft: houseAdjournmentsLeft(state),
  };
}

/** Solon's own adjournments left, within the case's overall limit. */
export function houseAdjournmentsLeft(state: CaseState): number {
  const own = state.adjournments.filter((a) => a.judge.kind === "HOUSE" && !a.requestId).length;
  return Math.max(
    0,
    Math.min(LIMITS.houseAdjournmentsMax - own, LIMITS.adjournmentsMax - state.adjournments.length),
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Solon adjourns for 1 to 7 days, and orders at most 3 items at a time. */
const HOUSE_ADJOURN_DAYS = { min: 1, max: 7 };
const HOUSE_ORDERS_MAX = 3;

/**
 * Runs Solon, the MuseCourt House Judge. The model only drafts; the verdict
 * goes through the same core validation as any agent judge's verdict. If the
 * model fails or drafts something invalid, the case simply stays in
 * deliberation and the deadline policy retries later.
 */
export class HouseJudgeService {
  constructor(
    private readonly court: Court,
    private readonly model: CourtModel,
    private readonly readModels: ReadModels,
  ) {}

  async deliberate(caseId: string): Promise<CaseState> {
    // Words a world has taken down never reach the model.
    await this.court.recheckWorldEvidence(caseId);
    const state = await this.court.getCase(caseId);
    if (!state) fail("NOT_FOUND", "Case not found.");
    if (state.status !== "OPEN" || state.stage !== "DELIBERATION" || state.judge?.kind !== "HOUSE") {
      fail("WRONG_STAGE", "The house judge only rules on cases it presides over that are in deliberation.");
    }
    if (state.adjournment && this.court.now().getTime() < Date.parse(state.adjournment.until)) {
      fail("ADJOURNED", `Adjourned until ${state.adjournment.until}.`, { until: state.adjournment.until });
    }
    const request = buildHouseJudgmentRequest(state);
    const draft = await this.model.draftHouseJudgment(request);
    if (draft.decision === "ADJOURN") return this.adjourn(caseId, draft, request.adjournmentsLeft);
    return this.court.act(caseId, SYSTEM, {
      type: "IssueVerdict",
      finding: draft.finding,
      reasoning: draft.reasoning,
      sentence: draft.sentence,
      citedLawIds: draft.citedLawIds,
      citedEvidenceIds: draft.citedEvidenceIds,
      citedCaseIds: [],
    });
  }

  /**
   * The record is not enough: Solon adjourns and orders the evidence he needs. A draft that asks
   * for more than the rules allow is rejected like an invalid verdict, and the case stays put.
   */
  private async adjourn(
    caseId: string,
    draft: Extract<HouseJudgmentDraft, { decision: "ADJOURN" }>,
    adjournmentsLeft: number,
  ): Promise<CaseState> {
    if (adjournmentsLeft <= 0) {
      fail("LIMIT_EXCEEDED", "Solon has no adjournments left in this case: he must rule on the record.");
    }
    const days = Math.round(Number(draft.days));
    if (!Number.isFinite(days) || days < HOUSE_ADJOURN_DAYS.min || days > HOUSE_ADJOURN_DAYS.max) {
      fail("VALIDATION_FAILED", "Solon adjourns for 1 to 7 days.");
    }
    const orders = Array.isArray(draft.orders) ? draft.orders : [];
    if (orders.length < 1 || orders.length > HOUSE_ORDERS_MAX) {
      fail("VALIDATION_FAILED", `Solon adjourns only to order evidence: 1 to ${HOUSE_ORDERS_MAX} orders.`);
    }
    // Check every part before acting, so a bad draft never leaves an adjournment without its orders.
    const reason = typeof draft.reason === "string" ? draft.reason.trim() : "";
    if (!reason || reason.length > LIMITS.reasonMax)
      fail("VALIDATION_FAILED", "Solon's adjournment needs a reason.");
    for (const order of orders) {
      const request = typeof order.request === "string" ? order.request.trim() : "";
      if (!request || request.length > LIMITS.orderRequestMax) {
        fail(
          "VALIDATION_FAILED",
          "Each of Solon's evidence orders needs a request of up to 1000 characters.",
        );
      }
    }
    const until = new Date(this.court.now().getTime() + days * DAY_MS).toISOString();
    let state = await this.court.act(caseId, SYSTEM, { type: "Adjourn", until, reason });
    for (const order of orders) {
      state = await this.court.act(caseId, SYSTEM, {
        type: "OrderEvidence",
        side: order.side,
        request: order.request,
        dueBy: until,
      });
    }
    return state;
  }

  /** Rules on every case waiting for the house judge. Failures are reported, not thrown. */
  async deliberatePending(): Promise<Array<{ caseId: string; ok: boolean; error?: string }>> {
    const waiting = await this.readModels.listCases({
      status: "OPEN",
      stage: "DELIBERATION",
      judgeKind: "HOUSE",
      limit: 100,
      offset: 0,
    });
    const results: Array<{ caseId: string; ok: boolean; error?: string }> = [];
    for (const c of waiting) {
      try {
        await this.deliberate(c.caseId);
        results.push({ caseId: c.caseId, ok: true });
      } catch (error) {
        results.push({ caseId: c.caseId, ok: false, error: (error as Error).message });
      }
    }
    return results;
  }
}
