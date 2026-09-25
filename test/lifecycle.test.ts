import { describe, expect, it } from "vitest";
import { SYSTEM } from "@/core/actor";
import type { CaseCommand } from "@/core/case-decide";
import { PROCEDURE, STAGES, type CaseAction } from "@/core/procedure";
import { buildCasebook } from "@/court/projections/casebook";
import {
  createTestCourt,
  driveToDeliberation,
  driveToTrial,
  expectCourtError,
  fileStandardCase,
  type TestCourt,
} from "./helpers";

describe("V1 success condition: a full trial with five agents", () => {
  it("runs dispute → counsel → agent judge → evidence → arguments → verdict → Casebook", async () => {
    const t = await createTestCourt();
    const { maple, nova, apollo, athena, sol } = t.agents;

    const filed = await fileStandardCase(t);
    expect(filed.caseNumber).toBe("FW-0001");
    expect(filed.title).toBe("Maple v. Nova");
    expect(filed.stage).toBe("AWAITING_RESPONSE");
    expect(filed.evidence[0]?.provenance).toBe("WORLD_VERIFIED");
    const caseId = filed.caseId;

    let state = await t.act(caseId, nova, {
      type: "RespondToComplaint",
      response: "Maple said I could gather.",
    });
    expect(state.stage).toBe("PRE_TRIAL");

    await t.act(caseId, maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: apollo });
    await t.act(caseId, apollo, { type: "AcceptRepresentation", side: "PLAINTIFF" });
    await t.act(caseId, nova, { type: "RequestCounsel", side: "DEFENCE", lawyerId: null });
    await t.act(caseId, athena, { type: "AcceptRepresentation", side: "DEFENCE" });
    state = await t.act(caseId, sol, { type: "VolunteerAsJudge" });
    expect(state.stage).toBe("OPENING_PLAINTIFF");
    expect(state.representation).toEqual({
      PLAINTIFF: { mode: "COUNSEL", lawyerId: apollo },
      DEFENCE: { mode: "COUNSEL", lawyerId: athena },
    });

    state = await t.act(caseId, apollo, {
      type: "MakeStatement",
      text: "The world log shows Nova took the timber.",
    });
    expect(state.stage).toBe("OPENING_DEFENCE");
    state = await t.act(caseId, athena, { type: "MakeStatement", text: "Nova acted with Maple's consent." });
    expect(state.stage).toBe("EVIDENCE_PLAINTIFF");

    await t.act(caseId, maple, {
      type: "SubmitEvidence",
      evidence: { kind: "TESTIMONY", content: "I never gave Nova permission." },
    });
    await t.act(caseId, apollo, {
      type: "SubmitEvidence",
      evidence: { kind: "WORLD_EVENT", eventId: "note_5521" },
    });
    await t.act(caseId, apollo, {
      type: "MakeStatement",
      text: "See ev_1 and the note.",
      evidenceIds: ["ev_1"],
    });
    state = await t.act(caseId, apollo, { type: "ConcludeStage" });
    expect(state.stage).toBe("EVIDENCE_DEFENCE");

    await t.act(caseId, nova, {
      type: "SubmitEvidence",
      evidence: { kind: "TESTIMONY", content: "Maple told me in person I could gather timber." },
    });
    state = await t.act(caseId, athena, { type: "ConcludeStage" });
    expect(state.stage).toBe("JUDGE_QUESTIONS");

    state = await t.act(caseId, sol, {
      type: "MakeStatement",
      text: "Defence: when was permission given?",
      addressedTo: ["DEFENCE"],
    });
    expect(state.stage).toBe("ANSWERS");
    state = await t.act(caseId, athena, { type: "MakeStatement", text: "Two days before, verbally." });
    expect(state.stage).toBe("CLOSING_PLAINTIFF");

    await t.act(caseId, apollo, { type: "MakeStatement", text: "The note says the opposite." });
    state = await t.act(caseId, athena, { type: "MakeStatement", text: "The note predates the permission." });
    expect(state.stage).toBe("DELIBERATION");

    const noteEvidence = state.evidence.find((e) => e.world?.eventId === "note_5521")!;
    state = await t.act(caseId, sol, {
      type: "IssueVerdict",
      finding: "LIABLE",
      reasoning: "The harvest is world-verified; the only permission claimed is uncorroborated testimony.",
      sentence: [{ kind: "RETURN_PROPERTY", description: "Return 5 timber to Maple." }],
      citedLawIds: ["property"],
      citedEvidenceIds: ["ev_1", noteEvidence.evidenceId],
    });

    expect(state.status).toBe("CLOSED");
    expect(state.outcome).toBe("VERDICT");
    expect(state.verdict).toMatchObject({ finding: "LIABLE", judge: { kind: "AGENT", agentId: sol } });

    const casebook = buildCasebook(await t.court.replayAllCases(), await t.court.getRegistry());
    expect(casebook).toHaveLength(1);
    expect(casebook[0]).toMatchObject({ caseNumber: "FW-0001", outcome: "VERDICT", finding: "LIABLE" });

    // The completed case is immutable: every further action is refused.
    await expectCourtError(
      t.act(caseId, sol, { type: "DismissCase", reason: "Changed my mind." }),
      "CASE_CLOSED",
    );
    await expectCourtError(
      t.act(caseId, maple, { type: "OfferSettlement", terms: "Anything." }),
      "CASE_CLOSED",
    );
    await expectCourtError(t.court.expireDeadline(caseId), "CASE_CLOSED");
  });

  it("runs repeatedly: three consecutive cases each reach a verdict with sequential case numbers", async () => {
    const t = await createTestCourt();
    for (let i = 1; i <= 3; i++) {
      const filed = await fileStandardCase(t, { evidence: [] });
      expect(filed.caseNumber).toBe(`FW-000${i}`);
      await driveToDeliberation(t, filed.caseId);
      const closed = await t.act(filed.caseId, t.agents.sol, {
        type: "IssueVerdict",
        finding: "NOT_LIABLE",
        reasoning: "Not proven.",
      });
      expect(closed.outcome).toBe("VERDICT");
    }
    expect(
      buildCasebook(await t.court.replayAllCases(), await t.court.getRegistry()).map((e) => e.caseNumber),
    ).toEqual(["FW-0001", "FW-0002", "FW-0003"]);
  });

  it("allows self-representation on both sides", async () => {
    const t = await createTestCourt();
    const { maple, nova, sol } = t.agents;
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, nova, { type: "RespondToComplaint", response: "Denied." });
    await t.act(caseId, maple, { type: "DeclareSelfRepresentation", side: "PLAINTIFF" });
    await t.act(caseId, nova, { type: "DeclareSelfRepresentation", side: "DEFENCE" });
    const state = await t.act(caseId, sol, { type: "VolunteerAsJudge" });
    expect(state.stage).toBe("OPENING_PLAINTIFF");
    const next = await t.act(caseId, maple, { type: "MakeStatement", text: "I speak for myself." });
    expect(next.stage).toBe("OPENING_DEFENCE");
  });

  it("accepts addressedTo only for the judge's questions: elsewhere it is rejected, never silently dropped", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    const { apollo, athena, sol } = t.agents;
    await expectCourtError(
      t.act(caseId, apollo, { type: "MakeStatement", text: "Opening.", addressedTo: ["DEFENCE"] }),
      "VALIDATION_FAILED",
    );
    await t.act(caseId, apollo, { type: "MakeStatement", text: "Opening." });
    await t.act(caseId, athena, { type: "ConcludeStage" });
    await t.act(caseId, apollo, { type: "ConcludeStage" });
    await t.act(caseId, athena, { type: "ConcludeStage" });
    const state = await t.act(caseId, sol, {
      type: "MakeStatement",
      text: "Was permission recorded?",
      addressedTo: ["DEFENCE"],
    });
    expect(state.stage).toBe("ANSWERS");
    await expectCourtError(
      t.act(caseId, athena, { type: "MakeStatement", text: "Verbally.", addressedTo: ["PLAINTIFF"] }),
      "VALIDATION_FAILED",
    );
  });

  it("lets the judge conclude without questions, skipping ANSWERS", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    const { apollo, athena, sol } = t.agents;
    await t.act(caseId, apollo, { type: "ConcludeStage" }); // waive opening
    await t.act(caseId, athena, { type: "ConcludeStage" });
    await t.act(caseId, apollo, { type: "ConcludeStage" });
    await t.act(caseId, athena, { type: "ConcludeStage" });
    const state = await t.act(caseId, sol, { type: "ConcludeStage" });
    expect(state.stage).toBe("CLOSING_PLAINTIFF");
  });

  it("allows early arrangements during AWAITING_RESPONSE and jumps straight to trial on response", async () => {
    const t = await createTestCourt();
    const { maple, nova, apollo, athena, sol } = t.agents;
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: apollo });
    await t.act(caseId, apollo, { type: "AcceptRepresentation", side: "PLAINTIFF" });
    await t.act(caseId, nova, { type: "RequestCounsel", side: "DEFENCE", lawyerId: athena });
    await t.act(caseId, athena, { type: "AcceptRepresentation", side: "DEFENCE" });
    await t.act(caseId, sol, { type: "VolunteerAsJudge" });
    // Defence counsel may answer the complaint on the defendant's behalf.
    const state = await t.act(caseId, athena, { type: "RespondToComplaint", response: "Denied." });
    expect(state.stage).toBe("OPENING_PLAINTIFF");
  });
});

// ---------------------------------------------------------------------------
// Illegal transitions: every command outside its stage fails with WRONG_STAGE
// ---------------------------------------------------------------------------

/** One sample of each stage-gated command, keyed by the procedural action it needs. */
const SAMPLE_COMMANDS: Record<Exclude<CaseAction, never>, CaseCommand> = {
  RESPOND: { type: "RespondToComplaint", response: "x" },
  SUBMIT_EVIDENCE: { type: "SubmitEvidence", evidence: { kind: "DOCUMENT", title: "t", content: "c" } },
  WITHDRAW_EVIDENCE: { type: "WithdrawEvidence", evidenceId: "ev_1", reason: "r" },
  REQUEST_COUNSEL: { type: "RequestCounsel", side: "PLAINTIFF" },
  ACCEPT_REPRESENTATION: { type: "AcceptRepresentation", side: "PLAINTIFF" },
  DECLINE_REPRESENTATION: { type: "DeclineRepresentation", side: "PLAINTIFF" },
  DECLARE_SELF_REPRESENTATION: { type: "DeclareSelfRepresentation", side: "PLAINTIFF" },
  WITHDRAW_AS_COUNSEL: { type: "WithdrawAsCounsel", reason: "r" },
  VOLUNTEER_AS_JUDGE: { type: "VolunteerAsJudge" },
  MAKE_STATEMENT: { type: "MakeStatement", text: "x" },
  CONCLUDE_STAGE: { type: "ConcludeStage" },
  ISSUE_VERDICT: { type: "IssueVerdict", finding: "NOT_LIABLE", reasoning: "r" },
  OFFER_SETTLEMENT: { type: "OfferSettlement", terms: "x" },
  RESPOND_TO_SETTLEMENT: { type: "RespondToSettlement", offerId: "offer_1", decision: "ACCEPT" },
  WITHDRAW_SETTLEMENT_OFFER: { type: "WithdrawSettlementOffer", offerId: "offer_1" },
  WITHDRAW_CASE: { type: "WithdrawCase", reason: "r" },
  DISMISS_CASE: { type: "DismissCase", reason: "r" },
};

/** Drives a fresh case to `stage` using counsel and an agent judge. */
async function caseAt(t: TestCourt, stage: (typeof STAGES)[number]): Promise<string> {
  const { caseId } = await fileStandardCase(t);
  const { apollo, athena, sol } = t.agents;
  const steps: Array<() => Promise<unknown>> = [
    () => t.act(caseId, t.agents.nova, { type: "RespondToComplaint", response: "Denied." }),
    () => driveToTrial(t, caseId).then(() => undefined),
    () => t.act(caseId, apollo, { type: "ConcludeStage" }),
    () => t.act(caseId, athena, { type: "ConcludeStage" }),
    () => t.act(caseId, apollo, { type: "ConcludeStage" }),
    () => t.act(caseId, athena, { type: "ConcludeStage" }),
    () => t.act(caseId, sol, { type: "MakeStatement", text: "Q?", addressedTo: ["PLAINTIFF"] }),
    () => t.act(caseId, apollo, { type: "MakeStatement", text: "A." }),
    () => t.act(caseId, apollo, { type: "ConcludeStage" }),
    () => t.act(caseId, athena, { type: "ConcludeStage" }),
  ];
  // driveToTrial includes the response, so step 0 is only used on its own (to reach PRE_TRIAL).
  const order: Record<string, number> = {
    AWAITING_RESPONSE: 0,
    PRE_TRIAL: 1,
    OPENING_PLAINTIFF: 2,
    OPENING_DEFENCE: 3,
    EVIDENCE_PLAINTIFF: 4,
    EVIDENCE_DEFENCE: 5,
    JUDGE_QUESTIONS: 6,
    ANSWERS: 7,
    CLOSING_PLAINTIFF: 8,
    CLOSING_DEFENCE: 9,
    DELIBERATION: 10,
  };
  const target = order[stage]!;
  if (target === 1) await steps[0]!();
  if (target >= 2) await steps[1]!();
  for (let i = 2; i < target; i++) await steps[i]!();
  const state = await t.court.getCase(caseId);
  expect(state?.stage).toBe(stage);
  return caseId;
}

describe("illegal transitions", () => {
  for (const stage of STAGES) {
    it(`rejects every action not allowed during ${stage} with WRONG_STAGE`, async () => {
      const t = await createTestCourt();
      const caseId = await caseAt(t, stage);
      const before = await t.court.getCaseEvents(caseId);
      const forbidden = (Object.keys(SAMPLE_COMMANDS) as CaseAction[]).filter(
        (action) => !PROCEDURE[stage].allowedActions.includes(action),
      );
      expect(forbidden.length).toBeGreaterThan(0);
      for (const action of forbidden) {
        // Use an actor who would otherwise be entitled, so only the stage check can fail.
        await expectCourtError(t.act(caseId, t.agents.maple, SAMPLE_COMMANDS[action]), "WRONG_STAGE");
        await expectCourtError(t.court.act(caseId, SYSTEM, SAMPLE_COMMANDS[action]), "WRONG_STAGE");
      }
      // Rejected commands leave no trace in the log.
      expect(await t.court.getCaseEvents(caseId)).toHaveLength(before.length);
    });
  }

  it("rejects commands on a case that does not exist", async () => {
    const t = await createTestCourt();
    await expectCourtError(t.act("case_missing", t.agents.maple, { type: "ConcludeStage" }), "NOT_FOUND");
  });

  it("does not let anyone set the stage directly: only commands move a case", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await expectCourtError(
      // Unknown command types are rejected rather than applied.
      t.act(caseId, t.agents.maple, { type: "SetStage", stage: "DELIBERATION" } as unknown as CaseCommand),
      "VALIDATION_FAILED",
    );
    expect((await t.court.getCase(caseId))?.stage).toBe("AWAITING_RESPONSE");
  });

  it("returns the same error for the same illegal command every time", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    for (let i = 0; i < 3; i++) {
      await expectCourtError(
        t.act(caseId, t.agents.sol, { type: "IssueVerdict", finding: "LIABLE", reasoning: "x" }),
        "WRONG_STAGE",
      );
    }
  });
});
