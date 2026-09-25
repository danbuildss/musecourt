import { describe, expect, it } from "vitest";
import { buildCasebook } from "@/court/projections/casebook";
import { toCaseView } from "@/court/projections/case-view";
import { opportunitiesForAgent, tasksForAgent } from "@/court/projections/tasks";
import { buildTranscript } from "@/court/projections/transcript";
import {
  createTestCourt,
  driveToDeliberation,
  driveToTrial,
  fileStandardCase,
  type TestCourt,
} from "./helpers";

async function tasksOf(t: TestCourt, agentId: string) {
  return tasksForAgent(agentId, await t.court.replayAllCases()).map((task) => task.kind);
}

describe("agent tasks", () => {
  it("tells each agent exactly what the court is waiting for", async () => {
    const t = await createTestCourt();
    const { maple, nova, apollo, athena, sol, bob } = t.agents;
    const { caseId } = await fileStandardCase(t);

    expect(await tasksOf(t, nova)).toEqual(["RESPOND_TO_COMPLAINT"]);
    expect(await tasksOf(t, maple)).toEqual([]);

    await t.act(caseId, nova, { type: "RespondToComplaint", response: "Denied." });
    expect(await tasksOf(t, maple)).toEqual(["ARRANGE_REPRESENTATION"]);
    expect(await tasksOf(t, nova)).toEqual(["ARRANGE_REPRESENTATION"]);

    await t.act(caseId, maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: apollo });
    expect(await tasksOf(t, apollo)).toEqual(["ANSWER_COUNSEL_REQUEST"]);
    expect(await tasksOf(t, maple)).toEqual([]);

    await t.act(caseId, apollo, { type: "AcceptRepresentation", side: "PLAINTIFF" });
    await t.act(caseId, nova, { type: "RequestCounsel", side: "DEFENCE", lawyerId: athena });
    await t.act(caseId, athena, { type: "AcceptRepresentation", side: "DEFENCE" });
    await t.act(caseId, sol, { type: "VolunteerAsJudge" });

    expect(await tasksOf(t, apollo)).toEqual(["MAKE_OPENING_STATEMENT"]);
    expect(await tasksOf(t, maple)).toEqual([]); // represented: counsel acts
    await t.act(caseId, apollo, { type: "MakeStatement", text: "Opening." });
    expect(await tasksOf(t, athena)).toEqual(["MAKE_OPENING_STATEMENT"]);
    await t.act(caseId, athena, { type: "MakeStatement", text: "Opening." });
    expect(await tasksOf(t, apollo)).toEqual(["PRESENT_EVIDENCE"]);
    await t.act(caseId, apollo, { type: "ConcludeStage" });
    await t.act(caseId, athena, { type: "ConcludeStage" });
    expect(await tasksOf(t, sol)).toEqual(["PUT_QUESTIONS_OR_CONCLUDE"]);
    await t.act(caseId, sol, { type: "MakeStatement", text: "Q?", addressedTo: ["DEFENCE"] });
    expect(await tasksOf(t, athena)).toEqual(["ANSWER_QUESTIONS"]);
    expect(await tasksOf(t, apollo)).toEqual([]);

    await t.act(caseId, nova, { type: "OfferSettlement", terms: "Return 5 timber." });
    expect(await tasksOf(t, maple)).toEqual(["REVIEW_SETTLEMENT_OFFER"]);
    expect(await tasksOf(t, apollo)).toEqual(["REVIEW_SETTLEMENT_OFFER"]);
    expect(await tasksOf(t, bob)).toEqual([]);
  });

  it("asks the judge for a verdict in deliberation and nothing after closure", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToDeliberation(t, caseId);
    expect(await tasksOf(t, t.agents.sol)).toEqual(["ISSUE_VERDICT"]);
    await t.act(caseId, t.agents.sol, {
      type: "IssueVerdict",
      finding: "NOT_LIABLE",
      reasoning: "Not proven.",
    });
    for (const agentId of Object.values(t.agents)) expect(await tasksOf(t, agentId)).toEqual([]);
  });

  it("each task carries the deadline and allowed actions", async () => {
    const t = await createTestCourt();
    const filed = await fileStandardCase(t);
    const [task] = tasksForAgent(t.agents.nova, await t.court.replayAllCases());
    expect(task).toMatchObject({
      caseNumber: "FW-0001",
      stage: "AWAITING_RESPONSE",
      deadline: filed.deadline,
    });
    expect(task!.allowedActions).toContain("RESPOND");
  });
});

describe("opportunities", () => {
  it("lists open counsel requests and empty benches only for eligible agents", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.maple, { type: "RequestCounsel", side: "PLAINTIFF", lawyerId: null });
    const registry = await t.court.getRegistry();
    const cases = await t.court.replayAllCases();

    expect(opportunitiesForAgent(t.agents.apollo, cases, registry).map((o) => [o.kind, o.side])).toEqual([
      ["REPRESENT_PARTY", "PLAINTIFF"],
    ]);
    expect(opportunitiesForAgent(t.agents.sol, cases, registry).map((o) => o.kind)).toEqual([
      "REPRESENT_PARTY",
      "JUDGE_CASE",
    ]);
    expect(opportunitiesForAgent(t.agents.bob, cases, registry)).toEqual([]);
    expect(opportunitiesForAgent(t.agents.maple, cases, registry)).toEqual([]);
  });
});

describe("case view", () => {
  it("always labels Solon as the MuseCourt House Judge", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    for (let i = 0; i < 2; i++) {
      const s = (await t.court.getCase(caseId))!;
      t.clock.set(s.deadline!);
      await t.court.expireDeadline(caseId);
    }
    const view = toCaseView((await t.court.getCase(caseId))!, await t.court.getRegistry());
    expect(view.judge).toEqual({ kind: "HOUSE", name: "Solon", label: "Solon (MuseCourt House Judge)" });
    const transcript = buildTranscript(await t.court.getCaseEvents(caseId), await t.court.getRegistry());
    expect(transcript.some((l) => l.text.includes("Solon (MuseCourt House Judge) takes the bench"))).toBe(
      true,
    );
  });

  it("describes the current stage, parties and representation", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    const view = toCaseView((await t.court.getCase(caseId))!, await t.court.getRegistry());
    expect(view.stage).toMatchObject({ name: "OPENING_PLAINTIFF" });
    expect(view.parties.plaintiff.handle).toBe("maple");
    expect(view.representation.PLAINTIFF).toMatchObject({
      mode: "COUNSEL",
      representative: { handle: "apollo" },
    });
    expect(view.judge).toMatchObject({ kind: "AGENT", label: "Judge Sol" });
  });
});

describe("transcript and casebook", () => {
  it("renders a readable transcript from the events", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToDeliberation(t, caseId);
    await t.act(caseId, t.agents.sol, {
      type: "IssueVerdict",
      finding: "LIABLE",
      reasoning: "The harvest is world-verified.",
      sentence: [{ kind: "RETURN_PROPERTY", description: "Return 5 timber" }],
      citedLawIds: ["property"],
      citedEvidenceIds: ["ev_1"],
    });
    const lines = buildTranscript(await t.court.getCaseEvents(caseId), await t.court.getRegistry()).map(
      (l) => l.text,
    );
    expect(lines[0]).toContain("FW-0001 Maple v. Nova filed. Charges: Art. 1 Property (v1)");
    expect(lines).toContain(
      "Evidence ev_1 — World event action_72882 (harvest) [World-verified ✓]: Nova harvested 5 timber from plot 17 (owned by Maple).",
    );
    expect(lines.some((l) => l.startsWith("VERDICT by Judge Sol: LIABLE."))).toBe(true);
    expect(lines.at(-1)).toBe("Case closed (VERDICT).");
  });

  it("the Casebook lists closed cases only, with outcomes, and cited precedent is validated", async () => {
    const t = await createTestCourt();
    const settled = await fileStandardCase(t);
    const offer = await t.act(settled.caseId, t.agents.nova, {
      type: "OfferSettlement",
      terms: "Return it.",
    });
    await t.act(settled.caseId, t.agents.maple, {
      type: "RespondToSettlement",
      offerId: offer.offers[0]!.offerId,
      decision: "ACCEPT",
    });
    const open = await fileStandardCase(t, { evidence: [] });

    const tried = await fileStandardCase(t, { evidence: [] });
    await driveToDeliberation(t, tried.caseId);
    await t.act(tried.caseId, t.agents.sol, {
      type: "IssueVerdict",
      finding: "NOT_LIABLE",
      reasoning: "Following the settled matter.",
      citedCaseIds: [settled.caseId],
    });

    const casebook = buildCasebook(await t.court.replayAllCases(), await t.court.getRegistry());
    expect(casebook.map((e) => [e.caseNumber, e.outcome, e.finding])).toEqual([
      ["FW-0001", "SETTLED", null],
      ["FW-0003", "VERDICT", "NOT_LIABLE"],
    ]);
    expect(casebook.find((e) => e.caseId === open.caseId)).toBeUndefined();
  });

  it("a verdict cannot cite an open or unknown case as precedent", async () => {
    const t = await createTestCourt();
    const open = await fileStandardCase(t, { evidence: [] });
    const tried = await fileStandardCase(t, { evidence: [] });
    await driveToDeliberation(t, tried.caseId);
    const verdict = (citedCaseIds: string[]) =>
      t.act(tried.caseId, t.agents.sol, {
        type: "IssueVerdict",
        finding: "NOT_LIABLE",
        reasoning: "x",
        citedCaseIds,
      });
    await expect(verdict([open.caseId])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(verdict(["case_unknown"])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(verdict([tried.caseId])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
