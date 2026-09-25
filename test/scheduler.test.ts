import { describe, expect, it } from "vitest";
import type { CaseCommand } from "@/core/case-decide";
import { CourtError } from "@/core/errors";
import type { HouseJudgmentDraft } from "@/core/ports";
import { CourtClock } from "@/court/court-clock";
import { FakeModel } from "@/model/fake-model";
import {
  createTestCourt,
  driveToDeliberation,
  driveToTrial,
  fileStandardCase,
  type TestCourt,
} from "./helpers";

const notLiable: HouseJudgmentDraft = {
  finding: "NOT_LIABLE",
  reasoning: "The record does not establish the claim.",
  sentence: [],
  citedLawIds: [],
  citedEvidenceIds: [],
};
const solonModel = () => new FakeModel({ judgment: () => notLiable });

async function jumpToDeadline(t: TestCourt, caseId: string) {
  const state = (await t.court.getCase(caseId))!;
  t.clock.set(state.deadline!);
}

const typesOf = async (t: TestCourt, caseId: string) =>
  (await t.court.getCaseEvents(caseId)).map((e) => e.type);

describe("court clock: abandoned cases always reach the right next state", () => {
  it("1. silent defendant: the case proceeds on the record (no default win)", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await jumpToDeadline(t, caseId);
    expect(await t.courtClock().tick()).toMatchObject({ inspected: 1, advanced: 1, failed: 0 });
    const state = (await t.court.getCase(caseId))!;
    expect(state).toMatchObject({ status: "OPEN", stage: "PRE_TRIAL", response: null });
    expect(state.evidence.at(-1)).toMatchObject({
      provenance: "COURT_GENERATED",
      title: "Record of non-response",
    });
  });

  it("2. no counsel found: an open request lapses and the side is self-represented", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.nova, { type: "RespondToComplaint", response: "Denied." });
    await t.act(caseId, t.agents.maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: null });
    await t.act(caseId, t.agents.sol, { type: "VolunteerAsJudge" });
    await jumpToDeadline(t, caseId);
    await t.courtClock().tick();
    const state = (await t.court.getCase(caseId))!;
    expect(state.stage).toBe("OPENING_PLAINTIFF");
    expect(state.representation).toEqual({ PLAINTIFF: { mode: "SELF" }, DEFENCE: { mode: "SELF" } });
    expect(state.judge).toEqual({ kind: "AGENT", agentId: t.agents.sol });
    expect(await typesOf(t, caseId)).toContain("CounselRequestLapsed");
  });

  it("3. a lawyer misses a statement deadline: non-appearance is recorded and the trial moves on", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    await jumpToDeadline(t, caseId);
    await t.courtClock().tick();
    const state = (await t.court.getCase(caseId))!;
    expect(state.stage).toBe("OPENING_DEFENCE");
    expect(state.representation.PLAINTIFF).toEqual({ mode: "COUNSEL", lawyerId: t.agents.apollo });
    expect(state.evidence.at(-1)).toMatchObject({ side: "PLAINTIFF", title: "Record of non-appearance" });
  });

  it("4a. a judge who misses questioning: the stage is skipped straight to closing", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    for (const agent of [t.agents.apollo, t.agents.athena, t.agents.apollo, t.agents.athena]) {
      await t.act(caseId, agent, { type: "ConcludeStage" });
    }
    expect((await t.court.getCase(caseId))!.stage).toBe("JUDGE_QUESTIONS");
    await jumpToDeadline(t, caseId);
    await t.courtClock().tick();
    expect((await t.court.getCase(caseId))!.stage).toBe("CLOSING_PLAINTIFF");
  });

  it("4b. a judge who misses deliberation is replaced by Solon, who then rules", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToDeliberation(t, caseId);
    await jumpToDeadline(t, caseId);
    const summary = await t.courtClock({ model: solonModel() }).tick();
    expect(summary).toMatchObject({ advanced: 1, solon: { pending: 1, ruled: 1, failed: 0 } });
    const state = (await t.court.getCase(caseId))!;
    expect(state).toMatchObject({
      status: "CLOSED",
      outcome: "VERDICT",
      verdict: { judge: { kind: "HOUSE" } },
    });
  });

  it("5. no volunteer judge: Solon takes the bench at the pre-trial deadline and skips questions", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.nova, { type: "RespondToComplaint", response: "Denied." });
    await t.act(caseId, t.agents.maple, { type: "DeclareSelfRepresentation", side: "PLAINTIFF" });
    await t.act(caseId, t.agents.nova, { type: "DeclareSelfRepresentation", side: "DEFENCE" });
    await jumpToDeadline(t, caseId);
    await t.courtClock().tick();
    expect((await t.court.getCase(caseId))!.judge).toEqual({ kind: "HOUSE" });
    for (const agent of [t.agents.maple, t.agents.nova, t.agents.maple, t.agents.nova]) {
      await t.act(caseId, agent, { type: "ConcludeStage" });
    }
    // JUDGE_QUESTIONS never waits on Solon.
    expect((await t.court.getCase(caseId))!.stage).toBe("CLOSING_PLAINTIFF");
  });

  it("5b. without a configured model, Solon cases wait (awaitingModel) and deliberation retries at its deadline", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    for (let i = 0; i < 12; i++) {
      const s = (await t.court.getCase(caseId))!;
      if (s.stage === "DELIBERATION") break;
      await jumpToDeadline(t, caseId);
      await t.courtClock().tick();
    }
    expect(await t.courtClock().tick()).toMatchObject({ solon: { pending: 1, awaitingModel: 1, ruled: 0 } });
    await jumpToDeadline(t, caseId);
    expect(await t.courtClock().tick()).toMatchObject({ advanced: 1 });
    expect((await t.court.getCase(caseId))!).toMatchObject({ status: "OPEN", stage: "DELIBERATION" });
    // A model failure is reported without details and leaves the case to retry.
    const failing = new FakeModel({
      judgment: () => {
        throw new Error("upstream model outage");
      },
    });
    const summary = await t.courtClock({ model: failing }).tick();
    expect(summary.solon).toMatchObject({ pending: 1, failed: 1 });
    expect(summary.failures).toEqual([{ caseId, code: "MODEL_ERROR" }]);
    expect((await t.court.getCase(caseId))!.status).toBe("OPEN");
  });

  it("6. settlement offers survive stage timeouts, are frozen while overdue, and lapse at closure", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    const offered = await t.act(caseId, t.agents.nova, {
      type: "OfferSettlement",
      terms: "Return 5 timber.",
    });
    const offerId = offered.offers[0]!.offerId;
    await jumpToDeadline(t, caseId);
    await expect(
      t.act(caseId, t.agents.maple, { type: "RespondToSettlement", offerId, decision: "ACCEPT" }),
    ).rejects.toMatchObject({ code: "DEADLINE_PASSED" });
    await t.courtClock().tick();
    const state = (await t.court.getCase(caseId))!;
    expect(state.stage).toBe("PRE_TRIAL");
    expect(state.offers[0]!.status).toBe("OPEN");
    const settled = await t.act(caseId, t.agents.maple, {
      type: "RespondToSettlement",
      offerId,
      decision: "ACCEPT",
    });
    expect(settled.outcome).toBe("SETTLED");

    // An offer nobody answered lapses when the case closes another way.
    const other = await fileStandardCase(t, { evidence: [] });
    await t.act(other.caseId, t.agents.nova, { type: "OfferSettlement", terms: "Apology." });
    const withdrawn = await t.act(other.caseId, t.agents.maple, { type: "WithdrawCase", reason: "Dropped." });
    expect(withdrawn.offers[0]!.status).toBe("LAPSED");
  });

  it("7. many cases expiring at once are all advanced by one tick", async () => {
    const t = await createTestCourt();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await fileStandardCase(t, { evidence: [] })).caseId);
    t.clock.advanceHours(48);
    expect(await t.courtClock().tick()).toMatchObject({
      inspected: 6,
      advanced: 6,
      failed: 0,
      moreDue: false,
    });
    for (const caseId of ids) expect((await t.court.getCase(caseId))!.stage).toBe("PRE_TRIAL");
  });

  it("7b. a small batch size processes the backlog across runs and reports moreDue", async () => {
    const t = await createTestCourt();
    for (let i = 0; i < 5; i++) await fileStandardCase(t, { evidence: [] });
    t.clock.advanceHours(48);
    const clock = new CourtClock({ court: t.court, readModels: t.readModels, clock: t.clock, batchSize: 2 });
    expect(await clock.tick()).toMatchObject({ advanced: 2, moreDue: true });
    expect(await clock.tick()).toMatchObject({ advanced: 2, moreDue: true });
    expect(await clock.tick()).toMatchObject({ advanced: 1, moreDue: false });
  });

  it("8. running the clock twice against the same deadline applies it once", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await jumpToDeadline(t, caseId);
    await t.courtClock().tick();
    const events = await t.court.getCaseEvents(caseId);
    expect(await t.courtClock().tick()).toMatchObject({ inspected: 0, advanced: 0 });
    expect(await t.court.getCaseEvents(caseId)).toEqual(events);
    expect((await typesOf(t, caseId)).filter((type) => type === "DeadlineExpired")).toHaveLength(1);
  });

  it("9. two overlapping clock runs (no lease) never apply a deadline twice", async () => {
    const t = await createTestCourt();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await fileStandardCase(t, { evidence: [] })).caseId);
    t.clock.advanceHours(48);
    const [a, b] = await Promise.all([
      t.courtClock({ lease: false }).tick(),
      t.courtClock({ lease: false }).tick(),
    ]);
    expect(a.advanced + b.advanced).toBe(4);
    expect(a.failed + b.failed).toBe(0);
    for (const caseId of ids) {
      expect((await typesOf(t, caseId)).filter((type) => type === "DeadlineExpired")).toHaveLength(1);
    }
  });

  it("9b. with the lease, an overlapping run backs off without doing anything", async () => {
    const t = await createTestCourt();
    await fileStandardCase(t);
    t.clock.advanceHours(48);
    const [a, b] = await Promise.all([t.courtClock().tick(), t.courtClock().tick()]);
    expect([a.lease, b.lease].sort()).toEqual(["ACQUIRED", "BUSY"]);
    expect(a.advanced + b.advanced).toBe(1);
  });

  it("10. one failing case does not prevent the others from advancing", async () => {
    const t = await createTestCourt();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await fileStandardCase(t, { evidence: [] })).caseId);
    t.clock.advanceHours(48);
    const broken = ids[1]!;
    const clock = new CourtClock({
      court: {
        expireDeadline: async (caseId: string) => {
          if (caseId === broken) throw new Error("corrupted stream: secret detail");
          return t.court.expireDeadline(caseId);
        },
      },
      readModels: t.readModels,
      clock: t.clock,
    });
    const summary = await clock.tick();
    expect(summary).toMatchObject({
      inspected: 3,
      advanced: 2,
      failed: 1,
      failures: [{ caseId: broken, code: "INTERNAL_ERROR" }],
    });
    expect(JSON.stringify(summary)).not.toContain("secret detail");
    expect((await t.court.getCase(ids[0]!))!.stage).toBe("PRE_TRIAL");
    expect((await t.court.getCase(ids[2]!))!.stage).toBe("PRE_TRIAL");
    expect((await t.court.getCase(broken))!.stage).toBe("AWAITING_RESPONSE");
    // A domain error is reported by code and also does not stop the run.
    const domainFailing = new CourtClock({
      court: { expireDeadline: async () => Promise.reject(new CourtError("INVARIANT_VIOLATION", "x")) },
      readModels: t.readModels,
      clock: t.clock,
    });
    expect((await domainFailing.tick()).failures).toEqual([{ caseId: broken, code: "INVARIANT_VIOLATION" }]);
  });

  it("11. closed cases are never processed", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.maple, { type: "WithdrawCase", reason: "Resolved." });
    const events = await t.court.getCaseEvents(caseId);
    t.clock.advanceHours(24 * 30);
    expect(await t.courtClock({ model: solonModel() }).tick()).toMatchObject({
      inspected: 0,
      advanced: 0,
      solon: { pending: 0 },
    });
    expect(await t.court.getCaseEvents(caseId)).toEqual(events);
  });

  it("12. a case that is not yet due is never advanced (and the boundary is inclusive)", async () => {
    const t = await createTestCourt();
    const { caseId, deadline } = await fileStandardCase(t);
    t.clock.set(new Date(Date.parse(deadline!) - 1));
    expect(await t.courtClock().tick()).toMatchObject({ inspected: 0, advanced: 0 });
    expect((await t.court.getCase(caseId))!.stage).toBe("AWAITING_RESPONSE");
    t.clock.set(deadline!);
    expect(await t.courtClock().tick()).toMatchObject({ inspected: 1, advanced: 1 });
  });
});

describe("invariant: no case gets permanently stuck because agents stop participating", () => {
  /** The happy path as a list of steps; the sweep abandons the case after each prefix. */
  const script = (t: TestCourt): Array<[string, CaseCommand]> => {
    const { maple, nova, apollo, athena, sol } = t.agents;
    return [
      [nova, { type: "RespondToComplaint", response: "Denied." }],
      [maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: apollo }],
      [apollo, { type: "AcceptRepresentation", side: "PLAINTIFF" }],
      [nova, { type: "RequestCounsel", side: "DEFENCE", lawyerId: null }],
      [athena, { type: "AcceptRepresentation", side: "DEFENCE" }],
      [sol, { type: "VolunteerAsJudge" }],
      [apollo, { type: "MakeStatement", text: "Opening." }],
      [athena, { type: "MakeStatement", text: "Opening." }],
      [apollo, { type: "ConcludeStage" }],
      [athena, { type: "ConcludeStage" }],
      [sol, { type: "MakeStatement", text: "Question?", addressedTo: ["PLAINTIFF", "DEFENCE"] }],
      [apollo, { type: "MakeStatement", text: "Answer." }],
      [athena, { type: "MakeStatement", text: "Answer." }],
      [apollo, { type: "MakeStatement", text: "Closing." }],
      [athena, { type: "MakeStatement", text: "Closing." }],
    ];
  };

  it("abandoning the case after any step still ends in a judgment, with only the clock and Solon acting", async () => {
    const steps = script(await createTestCourt()).length;
    for (let prefix = 0; prefix <= steps; prefix++) {
      const t = await createTestCourt();
      const { caseId } = await fileStandardCase(t);
      for (const [agentId, command] of script(t).slice(0, prefix)) await t.act(caseId, agentId, command);

      const clock = t.courtClock({ model: solonModel() });
      let ticks = 0;
      for (; ticks < 20; ticks++) {
        await clock.tick();
        const state = (await t.court.getCase(caseId))!;
        if (state.status === "CLOSED") break;
        t.clock.set(state.deadline!);
      }
      const final = (await t.court.getCase(caseId))!;
      expect(final.status, `abandoned after step ${prefix}`).toBe("CLOSED");
      expect(final.outcome).toBe("VERDICT");
      expect(ticks, `abandoned after step ${prefix}`).toBeLessThanOrEqual(12);
    }
  });
});
