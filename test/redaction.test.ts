import { describe, expect, it } from "vitest";
import { SYSTEM } from "@/core/actor";
import { applyRedactions } from "@/core/redaction";
import { HouseJudgeService } from "@/court/house-judge-service";
import { FakeModel } from "@/model/fake-model";
import {
  createTestCourt,
  driveToDeliberation,
  expectCourtError,
  fileStandardCase,
  type TestCourt,
} from "./helpers";

/** The Fake World harvest event's summary, which a takedown removes. */
async function harvestSummary(t: TestCourt): Promise<string> {
  return (await t.world.getEvent("action_72882"))!.summary;
}

describe("record-visibility gate (core)", () => {
  it("only operators redact; the court records world takedowns only for world evidence", async () => {
    const t = await createTestCourt();
    const { caseId, evidence } = await fileStandardCase(t);
    const state = await driveToDeliberation(t, caseId);
    const statementId = state.statements[0]!.statementId;
    const target = { kind: "EVIDENCE" as const, evidenceId: evidence[0]!.evidenceId };

    await expectCourtError(
      t.court.redactRecord(caseId, t.as(t.agents.maple), { target, reason: "Mine." }),
      "NOT_AUTHORIZED",
    );
    await expectCourtError(
      t.court.redactRecord(caseId, SYSTEM, { target: { kind: "STATEMENT", statementId }, reason: "x" }),
      "VALIDATION_FAILED",
    );
    await expectCourtError(
      t.court.redactRecord(caseId, t.admin, { target, reason: "" }),
      "VALIDATION_FAILED",
    );
    const redacted = await t.court.redactRecord(caseId, t.admin, {
      target: { kind: "STATEMENT", statementId },
      reason: "Personal data.",
    });
    expect(redacted.statements[0]).toMatchObject({
      text: "[Removed by MuseCourt: Personal data.]",
      redaction: { source: "OPERATOR", reason: "Personal data." },
    });
    // The procedure is untouched: the case is still where it was.
    expect(redacted.stage).toBe(state.stage);
  });

  it("re-checks world evidence before a verdict, so a taken-down event's words never enter the judgment record", async () => {
    const t = await createTestCourt();
    const words = await harvestSummary(t);
    const { caseId } = await fileStandardCase(t);
    await driveToDeliberation(t, caseId);
    t.world.takeDown("action_72882");
    const closed = await t.act(caseId, t.agents.sol, {
      type: "IssueVerdict",
      finding: "NOT_LIABLE",
      reasoning: "Consent was not disproved.",
    });
    expect(closed.outcome).toBe("VERDICT");
    expect(closed.evidence[0]).toMatchObject({ redaction: { source: "WORLD_TAKEDOWN" } });
    expect(JSON.stringify(closed)).not.toContain(words);
    const events = await t.court.getCaseEvents(caseId);
    const redactedAt = events.findIndex((e) => e.type === "RecordRedacted");
    expect(redactedAt).toBeGreaterThan(-1);
    expect(redactedAt).toBeLessThan(events.findIndex((e) => e.type === "VerdictIssued"));
    expect(JSON.stringify(applyRedactions(events))).not.toContain(words);
    expect(JSON.stringify(events)).toContain(words); // the log keeps the original
  });

  it("Solon never sees words a world has taken down", async () => {
    const t = await createTestCourt();
    const words = await harvestSummary(t);
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.nova, { type: "RespondToComplaint", response: "Maple allowed it." });
    for (let i = 0; i < 12; i++) {
      const state = (await t.court.getCase(caseId))!;
      if (state.stage === "DELIBERATION") break;
      t.clock.set(state.deadline!);
      await t.court.expireDeadline(caseId);
    }
    t.world.takeDown("action_72882");
    const model = new FakeModel({
      judgment: () => ({
        finding: "NOT_LIABLE",
        reasoning: "Nothing in the record shows a breach.",
        sentence: [],
        citedLawIds: ["property"],
        citedEvidenceIds: [],
      }),
    });
    await new HouseJudgeService(t.court, model, t.readModels).deliberate(caseId);
    expect(JSON.stringify(model.judgmentRequests[0])).not.toContain(words);
  });

  it("a world that cannot answer never blocks a verdict", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToDeliberation(t, caseId);
    t.world.offline = true;
    const closed = await t.act(caseId, t.agents.sol, {
      type: "IssueVerdict",
      finding: "NOT_LIABLE",
      reasoning: "Consent was not disproved.",
    });
    expect(closed.outcome).toBe("VERDICT");
    expect(closed.evidence[0]!.redaction).toBeNull();
  });
});
