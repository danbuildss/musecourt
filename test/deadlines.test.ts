import { describe, expect, it } from "vitest";
import { SYSTEM } from "@/core/actor";
import { isCourtError } from "@/core/errors";
import {
  DEFAULT_DEADLINE_POLICY,
  PROCEDURE,
  STAGES,
  validateDeadlinePolicy,
  type DeadlinePolicy,
} from "@/core/procedure";
import { createTestCourt, driveToTrial, expectCourtError, fileStandardCase, type TestCourt } from "./helpers";

const HOUR = 60 * 60 * 1000;

async function expireCurrent(t: TestCourt, caseId: string) {
  const state = (await t.court.getCase(caseId))!;
  t.clock.set(state.deadline!);
  return t.court.expireDeadline(caseId);
}

describe("deadlines", () => {
  it("every stage has a deadline set from the policy when it is entered", async () => {
    const t = await createTestCourt();
    const state = await fileStandardCase(t);
    expect(state.deadline).toBe(new Date(Date.parse("2026-01-01T00:00:00Z") + 48 * HOUR).toISOString());
  });

  it("cannot expire before the deadline, and only the court clock can expire it", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    t.clock.advanceHours(47);
    await expectCourtError(t.court.expireDeadline(caseId), "DEADLINE_NOT_REACHED");
    t.clock.advanceHours(1);
    await expectCourtError(t.act(caseId, t.agents.maple, { type: "ExpireDeadline" }), "NOT_AUTHORIZED");
    await expectCourtError(t.court.act(caseId, t.admin, { type: "ExpireDeadline" }), "NOT_AUTHORIZED");
    const state = await t.court.expireDeadline(caseId);
    expect(state.stage).toBe("PRE_TRIAL");
  });

  it("a silent defendant does not block the case (PROCEED_WITHOUT_RESPONSE, the default)", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    const state = await expireCurrent(t, caseId);
    expect(state.stage).toBe("PRE_TRIAL");
    expect(state.response).toBeNull();
    expect(state.evidence.at(-1)).toMatchObject({
      provenance: "COURT_GENERATED",
      title: "Record of non-response",
    });
  });

  it("DEFAULT_JUDGMENT policy closes the case for the plaintiff when the defendant is silent", async () => {
    const policy: DeadlinePolicy = structuredClone(DEFAULT_DEADLINE_POLICY);
    policy.stages.AWAITING_RESPONSE.onTimeout = "DEFAULT_JUDGMENT";
    const t = await createTestCourt({ policy });
    const { caseId } = await fileStandardCase(t);
    const state = await expireCurrent(t, caseId);
    expect(state.status).toBe("CLOSED");
    expect(state.outcome).toBe("DEFAULT_JUDGMENT");
    expect(state.verdict).toMatchObject({
      kind: "DEFAULT_JUDGMENT",
      finding: "LIABLE",
      sentence: [{ kind: "OTHER", description: "Return 5 timber." }],
    });
  });

  it("pre-trial defaults: unresolved sides become self-represented, empty bench goes to Solon, pending requests lapse", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.nova, { type: "RespondToComplaint", response: "Denied." });
    await t.act(caseId, t.agents.maple, {
      type: "RequestCounsel",
      side: "PLAINTIFF",
      lawyerId: t.agents.apollo,
    });
    const state = await expireCurrent(t, caseId);
    expect(state.stage).toBe("OPENING_PLAINTIFF");
    expect(state.representation).toEqual({ PLAINTIFF: { mode: "SELF" }, DEFENCE: { mode: "SELF" } });
    expect(state.counselRequests).toEqual({ PLAINTIFF: null, DEFENCE: null });
    expect(state.judge).toEqual({ kind: "HOUSE" });
    const types = (await t.court.getCaseEvents(caseId)).map((e) => e.type);
    expect(types).toContain("CounselRequestLapsed");
  });

  it("the house judge never blocks on questions: JUDGE_QUESTIONS is skipped automatically", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await expireCurrent(t, caseId); // → PRE_TRIAL
    await expireCurrent(t, caseId); // → OPENING_PLAINTIFF with Solon
    for (const stage of ["OPENING_PLAINTIFF", "OPENING_DEFENCE", "EVIDENCE_PLAINTIFF"] as const) {
      expect((await t.court.getCase(caseId))!.stage).toBe(stage);
      await expireCurrent(t, caseId);
    }
    const state = await expireCurrent(t, caseId); // EVIDENCE_DEFENCE → (JUDGE_QUESTIONS skipped) → CLOSING
    expect(state.stage).toBe("CLOSING_PLAINTIFF");
  });

  it("silent sides get a court record of non-appearance and the trial moves on", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    const state = await expireCurrent(t, caseId);
    expect(state.stage).toBe("OPENING_DEFENCE");
    expect(state.evidence.at(-1)).toMatchObject({
      provenance: "COURT_GENERATED",
      side: "PLAINTIFF",
      title: "Record of non-appearance",
    });
  });

  it("a side that submitted evidence but never concluded is not recorded as absent", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t, { evidence: [] });
    await driveToTrial(t, caseId);
    await t.act(caseId, t.agents.apollo, { type: "ConcludeStage" });
    await t.act(caseId, t.agents.athena, { type: "ConcludeStage" });
    await t.act(caseId, t.agents.apollo, {
      type: "SubmitEvidence",
      evidence: { kind: "WORLD_EVENT", eventId: "action_72882" },
    });
    const state = await expireCurrent(t, caseId);
    expect(state.stage).toBe("EVIDENCE_DEFENCE");
    expect(state.evidence.filter((e) => e.provenance === "COURT_GENERATED")).toHaveLength(0);
  });

  it("an unanswered question is recorded and the trial moves to closing", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    for (let i = 0; i < 4; i++)
      await t.act(caseId, i % 2 ? t.agents.athena : t.agents.apollo, { type: "ConcludeStage" });
    await t.act(caseId, t.agents.sol, {
      type: "MakeStatement",
      text: "Both: explain.",
      addressedTo: ["PLAINTIFF", "DEFENCE"],
    });
    await t.act(caseId, t.agents.apollo, { type: "MakeStatement", text: "Our answer." });
    const state = await expireCurrent(t, caseId);
    expect(state.stage).toBe("CLOSING_PLAINTIFF");
    const records = state.evidence.filter((e) => e.provenance === "COURT_GENERATED");
    expect(records.map((r) => r.side)).toEqual(["DEFENCE"]);
  });

  it("a judge who misses deliberation is replaced by Solon; Solon retries rather than blocking", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    for (let i = 0; i < 12; i++) {
      const s = (await t.court.getCase(caseId))!;
      if (s.stage === "DELIBERATION") break;
      await expireCurrent(t, caseId);
    }
    let state = await expireCurrent(t, caseId);
    expect(state.stage).toBe("DELIBERATION");
    expect(state.judge).toEqual({ kind: "HOUSE" });
    const replaced = (await t.court.getCaseEvents(caseId)).find(
      (e) => e.type === "JudgeAssigned" && e.data.reason === "JUDGE_MISSED_DEADLINE",
    );
    expect(replaced?.type === "JudgeAssigned" && replaced.data.replaces).toEqual({
      kind: "AGENT",
      agentId: t.agents.sol,
    });
    // The replaced judge can no longer rule.
    await expectCourtError(
      t.act(caseId, t.agents.sol, { type: "IssueVerdict", finding: "NOT_LIABLE", reasoning: "Late." }),
      "NOT_AUTHORIZED",
    );
    const firstDeadline = state.deadline;
    state = await expireCurrent(t, caseId);
    expect(state.stage).toBe("DELIBERATION");
    expect(state.deadline! > firstDeadline!).toBe(true);
  });

  it("no case can remain blocked: a case where nobody ever acts still reaches deliberation", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    for (let i = 0; i < STAGES.length + 2; i++) {
      const state = (await t.court.getCase(caseId))!;
      if (state.stage === "DELIBERATION") break;
      await expireCurrent(t, caseId);
    }
    const state = (await t.court.getCase(caseId))!;
    expect(state.stage).toBe("DELIBERATION");
    expect(state.judge).toEqual({ kind: "HOUSE" });
  });

  it("processDueDeadlines expires only overdue cases and is safe to run repeatedly", async () => {
    const t = await createTestCourt();
    const first = await fileStandardCase(t);
    t.clock.advanceHours(24);
    const second = await fileStandardCase(t, { evidence: [] });
    t.clock.advanceHours(24); // first is due, second is not
    expect(await t.court.processDueDeadlines()).toEqual([{ caseId: first.caseId, result: "EXPIRED" }]);
    expect(await t.court.processDueDeadlines()).toEqual([]);
    expect((await t.court.getCase(second.caseId))!.stage).toBe("AWAITING_RESPONSE");
  });

  it("each case keeps the policy it was filed under", async () => {
    const t = await createTestCourt();
    const state = await fileStandardCase(t);
    expect(state.deadlinePolicy).toEqual(DEFAULT_DEADLINE_POLICY);
    expect(state.deadlinePolicy).not.toBe(DEFAULT_DEADLINE_POLICY);
  });

  it("uses a configurable policy", async () => {
    const policy: DeadlinePolicy = structuredClone(DEFAULT_DEADLINE_POLICY);
    policy.version = "fast";
    policy.stages.AWAITING_RESPONSE.durationMs = 2 * HOUR;
    const t = await createTestCourt({ policy });
    const state = await fileStandardCase(t);
    expect(state.deadline).toBe("2026-01-01T02:00:00.000Z");
  });
});

describe("deadline policy validation", () => {
  it("accepts the default policy", () => {
    expect(() => validateDeadlinePolicy(DEFAULT_DEADLINE_POLICY)).not.toThrow();
  });

  it("rejects timeout actions a stage does not allow", () => {
    const policy = structuredClone(DEFAULT_DEADLINE_POLICY);
    policy.stages.OPENING_PLAINTIFF.onTimeout = "DEFAULT_JUDGMENT";
    expect(() => validateDeadlinePolicy(policy)).toThrowError(/not allowed/);
  });

  it("rejects durations under a minute and missing stages", () => {
    const tooShort = structuredClone(DEFAULT_DEADLINE_POLICY);
    tooShort.stages.PRE_TRIAL.durationMs = 1000;
    expect(() => validateDeadlinePolicy(tooShort)).toThrowError(/at least 1 minute/);
    const missing = structuredClone(DEFAULT_DEADLINE_POLICY) as { stages: Partial<DeadlinePolicy["stages"]> };
    delete missing.stages.DELIBERATION;
    try {
      validateDeadlinePolicy(missing as DeadlinePolicy);
      expect.fail("expected failure");
    } catch (error) {
      expect(isCourtError(error, "VALIDATION_FAILED")).toBe(true);
    }
  });

  it("every stage allows at least one timeout action, so every stage can always end", () => {
    for (const stage of STAGES) expect(PROCEDURE[stage].allowedTimeoutActions.length).toBeGreaterThan(0);
  });

  it("an invalid policy is refused when the court starts", async () => {
    const policy = structuredClone(DEFAULT_DEADLINE_POLICY);
    policy.stages.DELIBERATION.onTimeout = "SKIP_STAGE";
    await expect(createTestCourt({ policy })).rejects.toThrowError(/not allowed/);
  });

  it("the system actor cannot use deadlines to skip ahead", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await expectCourtError(t.court.act(caseId, SYSTEM, { type: "ExpireDeadline" }), "DEADLINE_NOT_REACHED");
  });
});

describe("acting after a deadline", () => {
  it("fails with DEADLINE_PASSED for every stage action until the clock applies the timeout", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    t.clock.advanceHours(48);
    await expectCourtError(
      t.act(caseId, t.agents.nova, { type: "RespondToComplaint", response: "Late." }),
      "DEADLINE_PASSED",
    );
    await expectCourtError(
      t.act(caseId, t.agents.maple, { type: "OfferSettlement", terms: "Late." }),
      "DEADLINE_PASSED",
    );
    await expectCourtError(t.act(caseId, t.agents.sol, { type: "VolunteerAsJudge" }), "DEADLINE_PASSED");
    // Stage checks still come first, and admin corrections are not stage actions.
    await expectCourtError(
      t.act(caseId, t.agents.sol, { type: "IssueVerdict", finding: "LIABLE", reasoning: "x" }),
      "WRONG_STAGE",
    );
    await t.court.act(caseId, t.admin, {
      type: "CorrectRecord",
      targetStreamVersion: 1,
      note: "Still allowed.",
    });
    const state = await t.court.expireDeadline(caseId);
    expect(state.stage).toBe("PRE_TRIAL");
    const ok = await t.act(caseId, t.agents.sol, { type: "VolunteerAsJudge" });
    expect(ok.judge).toEqual({ kind: "AGENT", agentId: t.agents.sol });
  });
});
