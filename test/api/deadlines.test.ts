import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DEADLINE_POLICY } from "@/core/procedure";
import { BACKENDS, castOfFive, closeSharedPool, startApi, type ApiHarness } from "./harness";

afterAll(closeSharedPool);

describe.each(BACKENDS)("deadlines through HTTP (%s)", (backend) => {
  let h: ApiHarness;
  beforeEach(async () => {
    h = await startApi({ backend });
  });
  afterEach(() => h.close());

  const passDeadline = async (caseId: string) => {
    const view = (await h.get(`/api/v1/cases/${caseId}`)).body.case;
    h.clock.set(view.stage.deadline);
  };

  it("a late action fails with DEADLINE_PASSED until the court clock applies the timeout", async () => {
    const { maple, nova } = await castOfFive(h);
    const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
    await passDeadline(caseId);

    const late = await h.act(nova, caseId, { action: "RESPOND", response: "Sorry I'm late." });
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({
      code: "DEADLINE_PASSED",
      details: { stage: "AWAITING_RESPONSE" },
    });

    const tick = await h.tick();
    expect(tick.body.processed).toEqual([{ caseId, result: "EXPIRED" }]);
    const view = (await h.get(`/api/v1/cases/${caseId}`)).body.case;
    // Silent defendant: no default win. The case proceeds with a court record of non-response.
    expect(view.status).toBe("OPEN");
    expect(view.stage.name).toBe("PRE_TRIAL");
    expect(view.evidence.at(-1)).toMatchObject({
      provenance: "COURT_GENERATED",
      provenanceLabel: "Court record",
      title: "Record of non-response",
    });
    expect((await h.tick()).body.processed).toEqual([]);
  });

  it("the tick only touches overdue cases", async () => {
    const { maple, nova } = await castOfFive(h);
    const first = (await h.fileCase(maple, nova)).body.case.caseId;
    h.clock.advanceHours(24);
    const second = (await h.fileCase(maple, nova)).body.case.caseId;
    h.clock.advanceHours(24);
    expect((await h.tick()).body.processed).toEqual([{ caseId: first, result: "EXPIRED" }]);
    expect((await h.get(`/api/v1/cases/${second}`)).body.case.stage.name).toBe("AWAITING_RESPONSE");
  });

  it("with no judge by the pre-trial deadline, Solon is seated and clearly labelled", async () => {
    const { maple, nova } = await castOfFive(h);
    const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
    await h.act(nova, caseId, { action: "RESPOND", response: "Denied." });
    await passDeadline(caseId);
    await h.tick();
    const view = (await h.get(`/api/v1/cases/${caseId}`)).body.case;
    expect(view.stage.name).toBe("OPENING_PLAINTIFF");
    expect(view.judge).toEqual({ kind: "HOUSE", name: "Solon", label: "Solon (MuseCourt House Judge)" });
    expect(view.representation.PLAINTIFF.mode).toBe("SELF");
    expect((await h.tasks(maple)).tasks.map((t) => t.kind)).toEqual(["MAKE_OPENING_STATEMENT"]);
  });

  it("tasks follow the clock: a missed stage moves the task to the next actor", async () => {
    const { maple, nova, sol } = await castOfFive(h);
    const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
    await h.act(nova, caseId, { action: "RESPOND", response: "Denied." });
    await h.act(maple, caseId, { action: "DECLARE_SELF_REPRESENTATION", side: "PLAINTIFF" });
    await h.act(nova, caseId, { action: "DECLARE_SELF_REPRESENTATION", side: "DEFENCE" });
    await h.act(sol, caseId, { action: "VOLUNTEER_AS_JUDGE" });
    expect((await h.tasks(maple)).tasks.map((t) => t.kind)).toEqual(["MAKE_OPENING_STATEMENT"]);
    await passDeadline(caseId);
    await h.tick();
    expect((await h.tasks(maple)).tasks).toEqual([]);
    expect((await h.tasks(nova)).tasks.map((t) => t.kind)).toEqual(["MAKE_OPENING_STATEMENT"]);
  });

  it("the DEFAULT_JUDGMENT policy remains available but is not the default", async () => {
    expect(DEFAULT_DEADLINE_POLICY.stages.AWAITING_RESPONSE.onTimeout).toBe("PROCEED_WITHOUT_RESPONSE");
    const policy = structuredClone(DEFAULT_DEADLINE_POLICY);
    policy.stages.AWAITING_RESPONSE.onTimeout = "DEFAULT_JUDGMENT";
    const strict = await startApi({ backend, policy });
    try {
      const { maple, nova } = await castOfFive(strict);
      const caseId = (await strict.fileCase(maple, nova)).body.case.caseId;
      strict.clock.advanceHours(48);
      await strict.tick();
      expect((await strict.get(`/api/v1/cases/${caseId}`)).body.case.outcome).toBe("DEFAULT_JUDGMENT");
    } finally {
      await strict.close();
    }
  });
});
