import { describe, expect, it } from "vitest";
import type { HouseJudgmentDraft } from "@/core/ports";
import { tasksForCase } from "@/court/projections/tasks";
import { buildTranscript } from "@/court/projections/transcript";
import { FakeModel } from "@/model/fake-model";
import { createTestCourt, driveToTrial, expectCourtError, fileStandardCase, type TestCourt } from "./helpers";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const at = (t: TestCourt, ms: number) => new Date(t.clock.now().getTime() + ms).toISOString();

/** A case in OPENING_PLAINTIFF with Sol (an agent judge) on the bench and counsel on both sides. */
async function trialWithAgentJudge() {
  const t = await createTestCourt();
  const { caseId } = await fileStandardCase(t);
  await driveToTrial(t, caseId);
  return { t, caseId };
}

/** A case in OPENING_PLAINTIFF with Solon on the bench and both parties representing themselves. */
async function trialWithSolon() {
  const t = await createTestCourt();
  const { caseId } = await fileStandardCase(t);
  await t.act(caseId, t.agents.nova, { type: "RespondToComplaint", response: "Denied." });
  await t.act(caseId, t.agents.maple, { type: "DeclareSelfRepresentation", side: "PLAINTIFF" });
  await t.act(caseId, t.agents.nova, { type: "DeclareSelfRepresentation", side: "DEFENCE" });
  return { t, caseId };
}

/** Both self-represented sides waive every stage until Solon deliberates. */
async function toDeliberation(t: TestCourt, caseId: string) {
  for (const agent of [
    t.agents.maple,
    t.agents.nova,
    t.agents.maple,
    t.agents.nova,
    t.agents.maple,
    t.agents.nova,
  ]) {
    await t.act(caseId, agent, { type: "ConcludeStage" });
  }
  expect((await t.court.getCase(caseId))!.stage).toBe("DELIBERATION");
}

describe("adjournment: the judge sets when the hearing resumes", () => {
  it("pauses the case until the set time, then the stage resumes with its full time", async () => {
    const { t, caseId } = await trialWithAgentJudge();
    const { sol, apollo, athena } = t.agents;
    const until = at(t, 7 * DAY);
    const state = await t.act(caseId, sol, { type: "Adjourn", until, reason: "Hearing resumes next week." });
    expect(state.adjournment).toMatchObject({ until, reason: "Hearing resumes next week.", requestId: null });
    expect(state.deadline).toBe(until);

    // Nothing proceeds while adjourned, except settlement and exits.
    await expectCourtError(t.act(caseId, apollo, { type: "MakeStatement", text: "Opening." }), "ADJOURNED");
    await expectCourtError(t.act(caseId, apollo, { type: "ConcludeStage" }), "ADJOURNED");
    await t.act(caseId, athena, { type: "OfferSettlement", terms: "An apology." });
    expect(tasksForCase(apollo, (await t.court.getCase(caseId))!).map((x) => x.kind)).toEqual([
      "REVIEW_SETTLEMENT_OFFER",
    ]);

    // At the set time, the next action resumes the hearing first.
    t.clock.set(until);
    const resumed = await t.act(caseId, apollo, { type: "MakeStatement", text: "Opening." });
    expect(resumed.adjournment).toBeNull();
    expect(resumed.stage).toBe("OPENING_DEFENCE");
    const types = (await t.court.getCaseEvents(caseId)).map((e) => e.type);
    expect(types.slice(types.indexOf("CaseAdjourned"))).toContain("HearingResumed");
  });

  it("the court clock resumes a case nobody touches, without treating it as a missed deadline", async () => {
    const { t, caseId } = await trialWithAgentJudge();
    const until = at(t, 2 * DAY);
    await t.act(caseId, t.agents.sol, {
      type: "Adjourn",
      until,
      reason: "Waiting for the island's records.",
    });
    t.clock.set(until);
    expect(await t.courtClock().tick()).toMatchObject({ advanced: 1, failed: 0 });
    const state = (await t.court.getCase(caseId))!;
    expect(state.adjournment).toBeNull();
    expect(state.stage).toBe("OPENING_PLAINTIFF");
    expect(state.deadline).toBe(at(t, 24 * HOUR));
    const events = await t.court.getCaseEvents(caseId);
    expect(events.some((e) => e.type === "DeadlineExpired")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "HearingResumed", data: { stage: "OPENING_PLAINTIFF" } });
  });

  it("only the judge adjourns, between 10 minutes and 30 days ahead, at most 5 times", async () => {
    const { t, caseId } = await trialWithAgentJudge();
    const { sol, apollo } = t.agents;
    await expectCourtError(
      t.act(caseId, apollo, { type: "Adjourn", until: at(t, DAY), reason: "I want a break." }),
      "NOT_AUTHORIZED",
    );
    for (const until of [at(t, 5 * MINUTE), at(t, 31 * DAY), "next tuesday"]) {
      await expectCourtError(
        t.act(caseId, sol, { type: "Adjourn", until, reason: "x" }),
        "VALIDATION_FAILED",
      );
    }
    for (let i = 1; i <= 5; i++) {
      await t.act(caseId, sol, { type: "Adjourn", until: at(t, i * HOUR), reason: `Adjournment ${i}.` });
    }
    await expectCourtError(
      t.act(caseId, sol, { type: "Adjourn", until: at(t, 9 * HOUR), reason: "Once more." }),
      "LIMIT_EXCEEDED",
    );
  });
});

describe("deadlines: the judge gives a stage more or less time", () => {
  it("moves the current stage's deadline, and the clock follows it", async () => {
    const { t, caseId } = await trialWithAgentJudge();
    const sooner = at(t, 30 * MINUTE);
    const state = await t.act(caseId, t.agents.sol, {
      type: "SetDeadline",
      deadline: sooner,
      reason: "Both sides are here; keep it moving.",
    });
    expect(state.deadline).toBe(sooner);
    t.clock.set(sooner);
    await t.courtClock().tick();
    expect((await t.court.getCase(caseId))!.stage).toBe("OPENING_DEFENCE");
    await expectCourtError(
      t.act(caseId, t.agents.apollo, { type: "SetDeadline", deadline: at(t, DAY), reason: "More time." }),
      "NOT_AUTHORIZED",
    );
  });
});

describe("evidence orders", () => {
  it("the ordered side answers at any stage, even while adjourned; the other side cannot", async () => {
    const { t, caseId } = await trialWithAgentJudge();
    const { sol, apollo, athena } = t.agents;
    const dueBy = at(t, 3 * DAY);
    await t.act(caseId, sol, {
      type: "Adjourn",
      until: dueBy,
      reason: "The defence must produce the permit.",
    });
    let state = await t.act(caseId, sol, {
      type: "OrderEvidence",
      side: "DEFENCE",
      request: "The written permission to gather on Maple's plot.",
      dueBy,
    });
    const orderId = state.evidenceOrders[0]!.orderId;
    expect(tasksForCase(athena, state).map((x) => [x.kind, x.deadline])).toEqual([
      ["PROVIDE_ORDERED_EVIDENCE", dueBy],
    ]);

    const permit = { kind: "DOCUMENT" as const, title: "Permit", content: "Maple: you may gather here." };
    await expectCourtError(
      t.act(caseId, apollo, { type: "SubmitEvidence", evidence: permit, orderId }),
      "NOT_AUTHORIZED",
    );
    state = await t.act(caseId, athena, { type: "SubmitEvidence", evidence: permit, orderId });
    const produced = state.evidence.at(-1)!;
    expect(produced).toMatchObject({ side: "DEFENCE", orderId, stage: "OPENING_PLAINTIFF" });
    expect(state.evidenceOrders[0]!.answeredBy).toBe(produced.evidenceId);
    expect(tasksForCase(athena, state)).toEqual([]);
    await expectCourtError(
      t.act(caseId, athena, { type: "SubmitEvidence", evidence: permit, orderId }),
      "DUPLICATE",
    );
  });

  it("an order is due by its time", async () => {
    const { t, caseId } = await trialWithAgentJudge();
    const dueBy = at(t, HOUR);
    const state = await t.act(caseId, t.agents.sol, {
      type: "OrderEvidence",
      side: "PLAINTIFF",
      request: "Proof of ownership of the plot.",
      dueBy,
    });
    t.clock.set(dueBy);
    await expectCourtError(
      t.act(caseId, t.agents.apollo, {
        type: "SubmitEvidence",
        evidence: { kind: "DOCUMENT", title: "Deed", content: "Plot 7 belongs to Maple." },
        orderId: state.evidenceOrders[0]!.orderId,
      }),
      "DEADLINE_PASSED",
    );
  });
});

describe("requests for time", () => {
  it("Solon rules at once: one granted request per side, up to 7 days ahead", async () => {
    const { t, caseId } = await trialWithSolon();
    const { nova } = t.agents;
    const until = at(t, 2 * DAY);
    let state = await t.act(caseId, nova, {
      type: "RequestAdjournment",
      until,
      reason: "My witness is away until Thursday.",
    });
    expect(state.adjournment).toMatchObject({ until, judge: { kind: "HOUSE" } });
    expect(state.adjournmentRequests.find((r) => r.side === "DEFENCE")).toMatchObject({ status: "GRANTED" });

    t.clock.set(until);
    state = await t.act(caseId, nova, { type: "RequestAdjournment", until: at(t, DAY), reason: "Again." });
    expect(state.adjournment).toBeNull();
    expect(state.adjournmentRequests.filter((r) => r.side === "DEFENCE").map((r) => r.status)).toEqual([
      "GRANTED",
      "REFUSED",
    ]);
  });

  it("refuses more than 7 days ahead", async () => {
    const { t, caseId } = await trialWithSolon();
    const state = await t.act(caseId, t.agents.maple, {
      type: "RequestAdjournment",
      until: at(t, 8 * DAY),
      reason: "Travelling.",
    });
    expect(state.adjournment).toBeNull();
    expect(state.adjournmentRequests[0]).toMatchObject({
      status: "REFUSED",
      ruling: { reason: "Solon grants at most 7 days at a time. Ask for an earlier date." },
    });
  });

  it("an agent judge grants or refuses, with a reason to refuse", async () => {
    const { t, caseId } = await trialWithAgentJudge();
    const { sol, maple, athena } = t.agents;
    let state = await t.act(caseId, maple, {
      type: "RequestAdjournment",
      until: at(t, 2 * DAY),
      reason: "Collecting receipts.",
    });
    const request = state.adjournmentRequests[0]!;
    expect(request.status).toBe("OPEN");
    expect(tasksForCase(sol, state).map((x) => x.kind)).toContain("RULE_ON_REQUEST");
    await expectCourtError(
      t.act(caseId, maple, { type: "RequestAdjournment", until: at(t, DAY), reason: "And again." }),
      "DUPLICATE",
    );
    await expectCourtError(
      t.act(caseId, sol, { type: "RuleOnRequest", requestId: request.requestId, decision: "REFUSE" }),
      "VALIDATION_FAILED",
    );
    state = await t.act(caseId, athena, {
      type: "RequestAdjournment",
      until: at(t, 3 * DAY),
      reason: "We need longer.",
    });
    state = await t.act(caseId, sol, {
      type: "RuleOnRequest",
      requestId: state.adjournmentRequests[1]!.requestId,
      decision: "REFUSE",
      reason: "Two days is enough.",
    });
    expect(state.adjournmentRequests[1]).toMatchObject({ status: "REFUSED" });

    state = await t.act(caseId, sol, {
      type: "RuleOnRequest",
      requestId: request.requestId,
      decision: "GRANT",
    });
    expect(state.adjournment).toMatchObject({ requestId: request.requestId, until: request.until });
    // While adjourned, a new request waits until the hearing resumes.
    await expectCourtError(
      t.act(caseId, athena, { type: "RequestAdjournment", until: at(t, 4 * DAY), reason: "Longer still." }),
      "ADJOURNED",
    );
  });

  it("needs a judge on the bench to ask", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await expectCourtError(
      t.act(caseId, t.agents.nova, { type: "RequestAdjournment", until: at(t, DAY), reason: "Away." }),
      "WRONG_STAGE",
    );
  });
});

describe("Solon adjourns when the record is not enough, at most twice", () => {
  const adjourn: HouseJudgmentDraft = {
    decision: "ADJOURN",
    reason: "Nothing shows whether permission was given.",
    days: 2,
    orders: [{ side: "DEFENCE", request: "Any record of Maple's permission." }],
  };
  const verdict: HouseJudgmentDraft = {
    finding: "LIABLE",
    reasoning: "No permission was produced when ordered.",
    sentence: [{ kind: "RETURN_PROPERTY", description: "Return 5 timber." }],
    citedLawIds: ["property"],
    citedEvidenceIds: [],
  };

  it("adjourns with orders, waits, then rules on the fuller record", async () => {
    const drafts = [adjourn, verdict];
    const model = new FakeModel({ judgment: () => drafts.shift()! });
    const { t, caseId } = await trialWithSolon();
    await toDeliberation(t, caseId);

    const clock = t.courtClock({ model });
    await clock.tick();
    let state = (await t.court.getCase(caseId))!;
    expect(state.adjournment).toMatchObject({ judge: { kind: "HOUSE" }, reason: adjourn.reason });
    expect(state.evidenceOrders).toMatchObject([
      { side: "DEFENCE", request: "Any record of Maple's permission.", dueBy: state.adjournment!.until },
    ]);
    expect(model.judgmentRequests[0]!.adjournmentsLeft).toBe(2);

    // While adjourned, the clock leaves Solon alone, and reports nothing as failed.
    expect(await clock.tick()).toMatchObject({ failed: 0, solon: { ruled: 0, failed: 0 } });

    t.clock.set(state.adjournment!.until);
    await clock.tick(); // resumes the hearing
    await clock.tick(); // Solon rules
    state = (await t.court.getCase(caseId))!;
    expect(state.outcome).toBe("VERDICT");
    expect(model.judgmentRequests[1]).toMatchObject({
      adjournmentsLeft: 1,
      evidenceOrders: [{ side: "DEFENCE", answeredBy: null }],
    });
  });

  it("cannot adjourn a third time: the draft is refused and the case waits for a ruling", async () => {
    const model = new FakeModel({ judgment: () => adjourn });
    const { t, caseId } = await trialWithSolon();
    await toDeliberation(t, caseId);
    for (let round = 0; round < 2; round++) {
      await t.courtClock({ model }).tick(); // Solon adjourns
      t.clock.set((await t.court.getCase(caseId))!.adjournment!.until);
      await t.court.expireDeadline(caseId); // the hearing resumes
    }
    const summary = await t.courtClock({ model }).tick();
    expect(summary.solon).toMatchObject({ failed: 1 });
    expect(summary.failures).toEqual([{ caseId, code: "LIMIT_EXCEEDED" }]);
    expect(model.judgmentRequests.at(-1)!.adjournmentsLeft).toBe(0);
    expect((await t.court.getCase(caseId))!.status).toBe("OPEN");
  });
});

describe("the public record", () => {
  it("tells the whole story in the transcript", async () => {
    const { t, caseId } = await trialWithAgentJudge();
    const { sol, maple } = t.agents;
    await t.act(caseId, maple, {
      type: "RequestAdjournment",
      until: at(t, DAY),
      reason: "Collecting receipts.",
    });
    const requestId = (await t.court.getCase(caseId))!.adjournmentRequests[0]!.requestId;
    await t.act(caseId, sol, { type: "RuleOnRequest", requestId, decision: "GRANT" });
    await t.act(caseId, sol, {
      type: "OrderEvidence",
      side: "PLAINTIFF",
      request: "The receipts.",
      dueBy: at(t, DAY),
    });
    const transcript = buildTranscript(await t.court.getCaseEvents(caseId), await t.court.getRegistry())
      .map((line) => line.text)
      .join("\n");
    expect(transcript).toContain("asked to adjourn until");
    expect(transcript).toContain("adjourned the case until");
    expect(transcript).toContain("(granting request req_");
    expect(transcript).toContain("ordered the PLAINTIFF side to produce evidence");
  });
});
