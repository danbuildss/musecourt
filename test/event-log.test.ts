import { describe, expect, it } from "vitest";
import { agentActor } from "@/core/actor";
import { buildCase } from "@/core/case-state";
import { isCourtError } from "@/core/errors";
import { eventStoreContract } from "./event-store-contract";
import { MemoryEventStore } from "@/infra/memory-event-store";
import { createTestCourt, driveToDeliberation, expectCourtError, fileStandardCase } from "./helpers";

eventStoreContract("MemoryEventStore", async () => new MemoryEventStore());

describe("court event log", () => {
  it("has no update or delete operation", () => {
    const store = new MemoryEventStore() as unknown as Record<string, unknown>;
    for (const name of ["update", "delete", "remove", "replace", "truncate"])
      expect(store[name]).toBeUndefined();
  });

  it("corrections are appended as new events; the original entry is unchanged", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    const before = await t.court.getCaseEvents(caseId);
    const state = await t.court.act(caseId, t.admin, {
      type: "CorrectRecord",
      targetStreamVersion: 1,
      note: "Complaint originally mis-stated the plot number.",
    });
    const after = await t.court.getCaseEvents(caseId);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ type: "RecordCorrected", data: { targetStreamVersion: 1 } });
    expect(state.corrections).toHaveLength(1);
    await expectCourtError(
      t.court.act(caseId, t.admin, { type: "CorrectRecord", targetStreamVersion: 99, note: "x" }),
      "VALIDATION_FAILED",
    );
  });

  it("corrections remain possible after a case closes (history is never frozen, only appended)", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.maple, { type: "WithdrawCase", reason: "Resolved." });
    const state = await t.court.act(caseId, t.admin, {
      type: "CorrectRecord",
      targetStreamVersion: 1,
      note: "Typo.",
    });
    expect(state.status).toBe("CLOSED");
    expect(state.corrections).toHaveLength(1);
  });

  it("state is a pure projection: rebuilding from the log gives the same result every time", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    const live = await driveToDeliberation(t, caseId);
    const events = await t.court.getCaseEvents(caseId);
    expect(buildCase(events)).toEqual(live);
    expect(buildCase(structuredClone(events))).toEqual(buildCase(events));
  });

  it("every event records who acted and when", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.nova, { type: "RespondToComplaint", response: "Denied." });
    const events = await t.court.getCaseEvents(caseId);
    const answer = events.find((e) => e.type === "ComplaintAnswered")!;
    expect(answer.actor).toEqual(agentActor(t.agents.nova));
    expect(answer.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(events.map((e) => e.streamVersion)).toEqual(events.map((_, i) => i + 1));
  });

  it("retries a command that lost a race, re-validating against fresh state", async () => {
    const t = await createTestCourt();
    const { caseId } = await fileStandardCase(t);
    await t.act(caseId, t.agents.nova, { type: "RespondToComplaint", response: "Denied." });
    // Two judges volunteer at once: one is seated, the other is refused after re-validation.
    const results = await Promise.allSettled([
      t.act(caseId, t.agents.sol, { type: "VolunteerAsJudge" }),
      t.act(caseId, t.agents.iris, { type: "VolunteerAsJudge" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(isCourtError(rejected.reason, "SEAT_OCCUPIED")).toBe(true);
    const events = await t.court.getCaseEvents(caseId);
    expect(events.filter((e) => e.type === "JudgeAssigned")).toHaveLength(1);
  });

  it("two cases filed at once get distinct case numbers", async () => {
    const t = await createTestCourt();
    const [a, b] = await Promise.all([
      fileStandardCase(t, { evidence: [] }),
      fileStandardCase(t, { evidence: [] }),
    ]);
    expect(new Set([a.caseNumber, b.caseNumber])).toEqual(new Set(["FW-0001", "FW-0002"]));
  });
});
