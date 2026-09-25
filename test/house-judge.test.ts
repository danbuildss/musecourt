import { describe, expect, it } from "vitest";
import { HOUSE_JUDGE } from "@/core/house-judge";
import type { HouseJudgmentDraft } from "@/core/ports";
import { HouseJudgeService } from "@/court/house-judge-service";
import { FakeModel } from "@/model/fake-model";
import { createTestCourt, expectCourtError, fileStandardCase, type TestCourt } from "./helpers";

/** A case where nobody acts, so it reaches deliberation before Solon. */
async function caseBeforeSolon(t: TestCourt) {
  const { caseId } = await fileStandardCase(t);
  await t.act(caseId, t.agents.nova, { type: "RespondToComplaint", response: "Maple allowed it." });
  for (let i = 0; i < 12; i++) {
    const state = (await t.court.getCase(caseId))!;
    if (state.stage === "DELIBERATION") break;
    t.clock.set(state.deadline!);
    await t.court.expireDeadline(caseId);
  }
  const state = (await t.court.getCase(caseId))!;
  expect(state).toMatchObject({ stage: "DELIBERATION", judge: { kind: "HOUSE" } });
  return caseId;
}

const liable: HouseJudgmentDraft = {
  finding: "LIABLE",
  reasoning: "ev_1 (world-verified) shows the harvest; no permission is in the record.",
  sentence: [{ kind: "RETURN_PROPERTY", description: "Return 5 timber." }],
  citedLawIds: ["property"],
  citedEvidenceIds: ["ev_1"],
};

describe("Solon, the MuseCourt House Judge", () => {
  it("drafts through the model port, and the verdict is recorded as the house judge's", async () => {
    const t = await createTestCourt();
    const caseId = await caseBeforeSolon(t);
    const model = new FakeModel({ judgment: () => liable });
    const state = await new HouseJudgeService(t.court, model).deliberate(caseId);
    expect(state.outcome).toBe("VERDICT");
    expect(state.verdict).toMatchObject({ judge: { kind: "HOUSE" }, finding: "LIABLE" });

    const request = model.judgmentRequests[0]!;
    expect(request.persona).toBe(HOUSE_JUDGE.persona);
    expect(request.charges.map((c) => [c.lawId, c.version])).toEqual([["property", 1]]);
    expect(request.evidence.map((e) => e.provenance)).toContain("WORLD_VERIFIED");
    expect(request.response).toBe("Maple allowed it.");
  });

  it("model drafts are validated like any judge's: invalid citations are refused and the case stays open", async () => {
    const t = await createTestCourt();
    const caseId = await caseBeforeSolon(t);
    const model = new FakeModel({ judgment: () => ({ ...liable, citedEvidenceIds: ["ev_invented"] }) });
    await expectCourtError(new HouseJudgeService(t.court, model).deliberate(caseId), "NOT_FOUND");
    const uncharged = new FakeModel({ judgment: () => ({ ...liable, citedLawIds: ["fraud"] }) });
    await expectCourtError(new HouseJudgeService(t.court, uncharged).deliberate(caseId), "VALIDATION_FAILED");
    expect((await t.court.getCase(caseId))!.status).toBe("OPEN");
  });

  it("a model failure never blocks the case: the deadline retries deliberation", async () => {
    const t = await createTestCourt();
    const caseId = await caseBeforeSolon(t);
    const failing = new FakeModel({
      judgment: () => {
        throw new Error("model unavailable");
      },
    });
    const service = new HouseJudgeService(t.court, failing);
    expect(await service.deliberatePending()).toEqual([{ caseId, ok: false, error: "model unavailable" }]);
    const state = (await t.court.getCase(caseId))!;
    t.clock.set(state.deadline!);
    const retried = await t.court.expireDeadline(caseId);
    expect(retried).toMatchObject({ stage: "DELIBERATION", judge: { kind: "HOUSE" } });

    const working = new HouseJudgeService(t.court, new FakeModel({ judgment: () => liable }));
    expect(await working.deliberatePending()).toEqual([{ caseId, ok: true }]);
  });

  it("only rules on cases it presides over in deliberation", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    const service = new HouseJudgeService(t.court, new FakeModel({ judgment: () => liable }));
    await expectCourtError(service.deliberate(caseId), "WRONG_STAGE");
    await expectCourtError(service.deliberate("case_missing"), "NOT_FOUND");
  });

  it("an agent cannot impersonate the house judge", async () => {
    const t = await createTestCourt();
    const caseId = await caseBeforeSolon(t);
    await expectCourtError(
      t.act(caseId, t.agents.sol, { type: "IssueVerdict", finding: "NOT_LIABLE", reasoning: "I am Solon." }),
      "NOT_PERMITTED",
    );
  });

  it("verdict validation: liable needs a sentence and a cited law; not liable carries no sentence", async () => {
    const t = await createTestCourt();
    const caseId = await caseBeforeSolon(t);
    const run = (draft: HouseJudgmentDraft) =>
      new HouseJudgeService(t.court, new FakeModel({ judgment: () => draft })).deliberate(caseId);
    await expectCourtError(run({ ...liable, sentence: [] }), "VALIDATION_FAILED");
    await expectCourtError(run({ ...liable, citedLawIds: [] }), "VALIDATION_FAILED");
    await expectCourtError(run({ ...liable, finding: "NOT_LIABLE" }), "VALIDATION_FAILED");
    await expectCourtError(
      run({ ...liable, sentence: [{ kind: "FINE" as "WARNING", description: "Pay 10 coins." }] }),
      "VALIDATION_FAILED",
    );
    await expectCourtError(run({ ...liable, finding: "GUILTY" as "LIABLE" }), "VALIDATION_FAILED");
  });
});
