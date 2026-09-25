import { SYSTEM } from "@/core/actor";
import { activeEvidence, type CaseState } from "@/core/case-state";
import { fail } from "@/core/errors";
import { HOUSE_JUDGE } from "@/core/house-judge";
import type { CourtModel, HouseJudgmentRequest } from "@/core/ports";
import type { Court } from "./court";

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
  };
}

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
  ) {}

  async deliberate(caseId: string): Promise<CaseState> {
    const state = await this.court.getCase(caseId);
    if (!state) fail("NOT_FOUND", "Case not found.");
    if (state.status !== "OPEN" || state.stage !== "DELIBERATION" || state.judge?.kind !== "HOUSE") {
      fail("WRONG_STAGE", "The house judge only rules on cases it presides over that are in deliberation.");
    }
    const draft = await this.model.draftHouseJudgment(buildHouseJudgmentRequest(state));
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

  /** Rules on every case waiting for the house judge. Failures are reported, not thrown. */
  async deliberatePending(): Promise<Array<{ caseId: string; ok: boolean; error?: string }>> {
    const waiting = (await this.court.listCases()).filter(
      (c) => c.status === "OPEN" && c.stage === "DELIBERATION" && c.judge?.kind === "HOUSE",
    );
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
