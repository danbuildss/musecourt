import { describe, expect, it } from "vitest";
import { SYSTEM } from "@/core/actor";
import type { CaseCommand } from "@/core/case-decide";
import { toCaseView } from "@/court/projections/case-view";
import {
  createTestCourt,
  driveToDeliberation,
  driveToTrial,
  expectCourtError,
  fileStandardCase,
  type TestCourt,
} from "./helpers";

async function atPlaintiffEvidence(t: TestCourt) {
  const { caseId } = await fileStandardCase(t, { evidence: [] });
  await driveToTrial(t, caseId);
  await t.act(caseId, t.agents.apollo, { type: "ConcludeStage" });
  await t.act(caseId, t.agents.athena, { type: "ConcludeStage" });
  return caseId;
}

describe("evidence provenance", () => {
  it("records a world event fetched through the connector as WORLD_VERIFIED, with a snapshot", async () => {
    const t = await createTestCourt();
    const state = await fileStandardCase(t);
    const item = state.evidence[0]!;
    expect(item.provenance).toBe("WORLD_VERIFIED");
    expect(item.world).toMatchObject({
      connectorId: "fake-world",
      eventId: "action_72882",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      snapshot: { type: "harvest", actorWorldId: "nova" },
    });
  });

  it("keeps the snapshot even if the world later changes", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    t.world.addEvent({
      eventId: "action_72882",
      type: "harvest",
      occurredAt: "2025-12-30T14:02:11.000Z",
      actorWorldId: "someone-else",
      summary: "Rewritten history.",
      data: {},
    });
    const state = await t.court.getCase(caseId);
    expect(state!.evidence[0]!.world!.snapshot.summary).toBe(
      "Nova harvested 5 timber from plot 17 (owned by Maple).",
    );
  });

  it("records documents as AGENT_SUBMITTED and testimony as TESTIMONY", async () => {
    const t = await createTestCourt();
    const caseId = await atPlaintiffEvidence(t);
    await t.act(caseId, t.agents.apollo, {
      type: "SubmitEvidence",
      evidence: { kind: "DOCUMENT", title: "Receipt", content: "Maple bought the plot on day 3." },
    });
    const state = await t.act(caseId, t.agents.maple, {
      type: "SubmitEvidence",
      evidence: { kind: "TESTIMONY", content: "I was away and gave no permission." },
    });
    expect(state.evidence.map((e) => e.provenance)).toEqual(["AGENT_SUBMITTED", "TESTIMONY"]);
    expect(state.evidence[1]!.submittedBy).toEqual({
      kind: "AGENT",
      agentId: t.agents.maple,
      role: "PLAINTIFF",
    });
  });

  it("never lets an agent choose its own provenance", async () => {
    const t = await createTestCourt();
    const caseId = await atPlaintiffEvidence(t);
    for (const forged of ["WORLD_VERIFIED", "COURT_GENERATED", "AGENT_SUBMITTED"]) {
      const command = {
        type: "SubmitEvidence",
        evidence: { kind: forged, title: "Totally real", content: "Trust me." },
      } as unknown as CaseCommand;
      await expectCourtError(t.act(caseId, t.agents.apollo, command), "INVALID_EVIDENCE");
    }
    expect((await t.court.getCase(caseId))!.evidence).toHaveLength(0);
  });

  it("labels agent material as unverified in the case view", async () => {
    const t = await createTestCourt();
    const caseId = await atPlaintiffEvidence(t);
    await t.act(caseId, t.agents.apollo, {
      type: "SubmitEvidence",
      evidence: { kind: "DOCUMENT", title: "Screenshot", content: "Looks like a harvest." },
    });
    await t.act(caseId, t.agents.apollo, {
      type: "SubmitEvidence",
      evidence: { kind: "WORLD_EVENT", eventId: "action_72901" },
    });
    const view = toCaseView((await t.court.getCase(caseId))!, await t.court.getRegistry());
    expect(view.evidence.map((e) => e.provenanceLabel)).toEqual([
      "Submitted by an agent (not independently verified)",
      "World-verified ✓",
    ]);
  });

  it("rejects a world event the world does not know", async () => {
    const t = await createTestCourt();
    await expectCourtError(
      fileStandardCase(t, { evidence: [{ kind: "WORLD_EVENT", eventId: "action_made_up" }] }),
      "WORLD_EVIDENCE_NOT_FOUND",
    );
    expect(await t.court.replayAllCases()).toHaveLength(0);
  });

  it("reports an unreachable world as retryable and records nothing", async () => {
    const t = await createTestCourt();
    const caseId = await atPlaintiffEvidence(t);
    t.world.offline = true;
    await expectCourtError(
      t.act(caseId, t.agents.apollo, {
        type: "SubmitEvidence",
        evidence: { kind: "WORLD_EVENT", eventId: "action_72882" },
      }),
      "WORLD_EVIDENCE_UNAVAILABLE",
    );
    t.world.offline = false;
    const state = await t.act(caseId, t.agents.apollo, {
      type: "SubmitEvidence",
      evidence: { kind: "WORLD_EVENT", eventId: "action_72882" },
    });
    expect(state.evidence).toHaveLength(1);
  });

  it("checks the stage and actor before contacting the world", async () => {
    const t = await createTestCourt();
    const caseId = await atPlaintiffEvidence(t);
    t.world.offline = true;
    // Wrong side: fails on permissions, not on the (offline) world.
    await expectCourtError(
      t.act(caseId, t.agents.athena, {
        type: "SubmitEvidence",
        evidence: { kind: "WORLD_EVENT", eventId: "action_72882" },
      }),
      "NOT_AUTHORIZED",
    );
  });

  it("refuses world evidence in a jurisdiction without a connector", async () => {
    const t = await createTestCourt();
    await t.court.establishJurisdiction(
      { jurisdictionId: "offworld", name: "Offworld", casePrefix: "OW" },
      t.admin,
    );
    await t.court.enactLaw(
      "offworld",
      { lawId: "property", article: 1, title: "Property", text: "Do not take things." },
      t.admin,
    );
    await expectCourtError(
      t.court.fileCase(t.as(t.agents.maple), {
        jurisdictionId: "offworld",
        defendantId: t.agents.nova,
        complaint: "Nova took my things without asking.",
        lawIds: ["property"],
        evidence: [{ kind: "WORLD_EVENT", eventId: "action_72882" }],
      }),
      "WORLD_EVIDENCE_UNAVAILABLE",
    );
  });

  it("rejects the same world event twice in one case", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    await t.act(caseId, t.agents.apollo, { type: "ConcludeStage" });
    await t.act(caseId, t.agents.athena, { type: "ConcludeStage" });
    await expectCourtError(
      t.act(caseId, t.agents.apollo, {
        type: "SubmitEvidence",
        evidence: { kind: "WORLD_EVENT", eventId: "action_72882" },
      }),
      "DUPLICATE",
    );
  });

  it("only a party gives testimony; counsel cannot testify", async () => {
    const t = await createTestCourt();
    const caseId = await atPlaintiffEvidence(t);
    await expectCourtError(
      t.act(caseId, t.agents.apollo, {
        type: "SubmitEvidence",
        evidence: { kind: "TESTIMONY", content: "I saw it." },
      }),
      "NOT_AUTHORIZED",
    );
  });

  it("a represented party cannot submit documents; counsel does", async () => {
    const t = await createTestCourt();
    const caseId = await atPlaintiffEvidence(t);
    await expectCourtError(
      t.act(caseId, t.agents.maple, {
        type: "SubmitEvidence",
        evidence: { kind: "DOCUMENT", title: "Doc", content: "Content." },
      }),
      "NOT_AUTHORIZED",
    );
  });

  it("only the side whose evidence stage it is may submit", async () => {
    const t = await createTestCourt();
    const caseId = await atPlaintiffEvidence(t);
    await expectCourtError(
      t.act(caseId, t.agents.nova, {
        type: "SubmitEvidence",
        evidence: { kind: "TESTIMONY", content: "Me!" },
      }),
      "NOT_AUTHORIZED",
    );
  });

  it("the defendant may submit evidence with its response", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    const state = await t.act(caseId, t.agents.nova, {
      type: "RespondToComplaint",
      response: "Denied.",
      evidence: [{ kind: "TESTIMONY", content: "Maple let me." }],
    });
    expect(state.evidence.map((e) => [e.side, e.provenance])).toEqual([
      ["PLAINTIFF", "WORLD_VERIFIED"],
      ["DEFENCE", "TESTIMONY"],
    ]);
  });

  it("limits each side to 10 items", async () => {
    const t = await createTestCourt();
    const caseId = await atPlaintiffEvidence(t);
    for (let i = 0; i < 10; i++) {
      await t.act(caseId, t.agents.apollo, {
        type: "SubmitEvidence",
        evidence: { kind: "DOCUMENT", title: `Doc ${i}`, content: "Content." },
      });
    }
    await expectCourtError(
      t.act(caseId, t.agents.apollo, {
        type: "SubmitEvidence",
        evidence: { kind: "DOCUMENT", title: "One more", content: "x" },
      }),
      "LIMIT_EXCEEDED",
    );
  });

  it("withdrawal is appended, keeps the original, and blocks later citation", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.maple, {
      type: "WithdrawEvidence",
      evidenceId: "ev_1",
      reason: "Wrong event.",
    });
    await expectCourtError(
      t.act(caseId, t.agents.maple, { type: "WithdrawEvidence", evidenceId: "ev_1", reason: "Again." }),
      "DUPLICATE",
    );
    const state = await driveToDeliberation(t, caseId);
    expect(state.evidence[0]).toMatchObject({ evidenceId: "ev_1", withdrawn: { reason: "Wrong event." } });
    await expectCourtError(
      t.act(caseId, t.agents.sol, {
        type: "IssueVerdict",
        finding: "NOT_LIABLE",
        reasoning: "x",
        citedEvidenceIds: ["ev_1"],
      }),
      "INVALID_EVIDENCE",
    );
  });

  it("only the submitting side can withdraw evidence, and court records cannot be withdrawn", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await expectCourtError(
      t.act(caseId, t.agents.nova, { type: "WithdrawEvidence", evidenceId: "ev_1", reason: "Not mine." }),
      "NOT_AUTHORIZED",
    );
    t.clock.advanceHours(48);
    await t.court.expireDeadline(caseId); // creates a court record of non-response
    const courtRecord = (await t.court.getCase(caseId))!.evidence.find(
      (e) => e.provenance === "COURT_GENERATED",
    )!;
    await expectCourtError(
      t.act(caseId, t.agents.nova, {
        type: "WithdrawEvidence",
        evidenceId: courtRecord.evidenceId,
        reason: "No.",
      }),
      "NOT_AUTHORIZED",
    );
  });

  it("statements may only cite evidence that is in the record", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await driveToTrial(t, caseId);
    await expectCourtError(
      t.act(caseId, t.agents.apollo, { type: "MakeStatement", text: "See ev_99.", evidenceIds: ["ev_99"] }),
      "INVALID_EVIDENCE",
    );
  });

  it("COURT_GENERATED evidence is only ever produced by the court itself", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    t.clock.advanceHours(48);
    const state = await t.court.expireDeadline(caseId);
    const record = state.evidence.find((e) => e.provenance === "COURT_GENERATED")!;
    expect(record.submittedBy).toEqual({ kind: "COURT" });
    const events = await t.court.getCaseEvents(caseId);
    const recorded = events.find(
      (e) => e.type === "EvidenceRecorded" && e.data.provenance === "COURT_GENERATED",
    )!;
    expect(recorded.actor).toEqual(SYSTEM);
  });
});
