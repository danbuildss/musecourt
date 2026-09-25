import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel } from "@/model/fake-model";
import {
  ADMIN_TOKEN,
  BACKENDS,
  CRON_SECRET,
  castOfFive,
  closeSharedPool,
  startApi,
  type ApiHarness,
} from "./harness";

afterAll(closeSharedPool);

describe.each(BACKENDS)("internal court-clock endpoint (%s)", (backend) => {
  let h: ApiHarness;
  beforeEach(async () => {
    h = await startApi({ backend });
  });
  afterEach(() => h.close());

  describe("authentication", () => {
    it("accepts only the cron secret, as a Bearer token", async () => {
      const agent = await h.register("maple");
      const attempts = [
        h.request("POST", "/api/v1/internal/cron/tick", { idempotencyKey: null }),
        h.cronTick("POST", "wrong-secret-wrong-secret-wrong-secret-00"),
        h.cronTick("POST", ADMIN_TOKEN),
        h.request("POST", "/api/v1/internal/cron/tick", { admin: true, idempotencyKey: null }),
        h.request("POST", "/api/v1/internal/cron/tick", { apiKey: agent.apiKey, idempotencyKey: null }),
        h.cronTick("GET", ADMIN_TOKEN),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe("UNAUTHENTICATED");
      }
    });

    it("the cron secret grants nothing else", async () => {
      const cronHeaders = { headers: { authorization: `Bearer ${CRON_SECRET}` } };
      expect((await h.post("/api/v1/admin/tick", {}, cronHeaders)).status).toBe(401);
      expect((await h.post("/api/v1/admin/read-models/rebuild", {}, cronHeaders)).status).toBe(401);
      expect(
        (await h.post("/api/v1/admin/licences", { agent: "x", licence: "JUDGE" }, cronHeaders)).status,
      ).toBe(401);
      expect((await h.get("/api/v1/agents/me", cronHeaders)).status).toBe(401);
    });

    it("is disabled when no cron secret is configured", async () => {
      const unconfigured = await startApi({ backend, cronSecret: null });
      try {
        expect((await unconfigured.cronTick()).status).toBe(401);
      } finally {
        await unconfigured.close();
      }
    });
  });

  it("POST and GET (Vercel Cron) run the clock without an Idempotency-Key and return a summary", async () => {
    const { maple, nova } = await castOfFive(h);
    await h.fileCase(maple, nova);
    await h.fileCase(maple, nova);
    h.clock.advanceHours(48);
    const post = await h.cronTick("POST");
    expect(post.status).toBe(200);
    expect(post.body).toEqual({
      ranAt: h.clock.now().toISOString(),
      lease: "ACQUIRED",
      inspected: 2,
      advanced: 2,
      skipped: 0,
      failed: 0,
      failures: [],
      solon: { pending: 0, ruled: 0, failed: 0, awaitingModel: 0 },
      moreDue: false,
    });
    const get = await h.cronTick("GET");
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ inspected: 0, advanced: 0 });
  });

  it("reads observe but never advance: an overdue stage is flagged, not processed", async () => {
    const { maple, nova } = await castOfFive(h);
    const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
    const before = (await h.get(`/api/v1/cases/${caseId}/events`)).body.events.length;
    expect((await h.get(`/api/v1/cases/${caseId}`)).body.case.stage).toMatchObject({
      name: "AWAITING_RESPONSE",
      overdue: false,
    });

    h.clock.advanceHours(48);
    for (let i = 0; i < 3; i++) {
      const view = (await h.get(`/api/v1/cases/${caseId}`)).body.case;
      expect(view.stage).toMatchObject({ name: "AWAITING_RESPONSE", overdue: true });
      expect((await h.get("/api/v1/cases")).body.cases[0]).toMatchObject({ caseId, overdue: true });
      expect((await h.tasks(nova)).tasks).toEqual([
        expect.objectContaining({ kind: "RESPOND_TO_COMPLAINT", overdue: true }),
      ]);
      await h.get(`/api/v1/cases/${caseId}/transcript`);
      await h.get("/api/v1/casebook");
    }
    expect((await h.get(`/api/v1/cases/${caseId}/events`)).body.events.length).toBe(before);

    await h.cronTick();
    expect((await h.get(`/api/v1/cases/${caseId}`)).body.case.stage).toMatchObject({
      name: "PRE_TRIAL",
      overdue: false,
    });
  });

  it("overlapping cron invocations never double-apply a deadline", async () => {
    const { maple, nova } = await castOfFive(h);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await h.fileCase(maple, nova)).body.case.caseId);
    h.clock.advanceHours(48);
    const runs = await Promise.all([h.cronTick(), h.cronTick("GET"), h.cronTick(), h.tick()]);
    expect(runs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(runs.reduce((sum, r) => sum + r.body.advanced, 0)).toBe(3);
    for (const caseId of ids) {
      const types = (await h.get(`/api/v1/cases/${caseId}/events`)).body.events.map((e: any) => e.type);
      expect(types.filter((t: string) => t === "DeadlineExpired")).toHaveLength(1);
    }
  });

  it("drives an abandoned case to Solon's verdict with nothing but cron calls", async () => {
    const model = new FakeModel({
      judgment: () => ({
        finding: "NOT_LIABLE",
        reasoning: "Nothing in the record establishes the claim.",
        sentence: [],
        citedLawIds: [],
        citedEvidenceIds: [],
      }),
    });
    const judged = await startApi({ backend, model });
    try {
      const { maple, nova } = await castOfFive(judged);
      const caseId = (await judged.fileCase(maple, nova)).body.case.caseId;
      let view = (await judged.get(`/api/v1/cases/${caseId}`)).body.case;
      for (let i = 0; i < 15 && view.status === "OPEN"; i++) {
        judged.clock.set(view.stage.deadline);
        await judged.cronTick();
        view = (await judged.get(`/api/v1/cases/${caseId}`)).body.case;
      }
      expect(view).toMatchObject({
        status: "CLOSED",
        outcome: "VERDICT",
        verdict: { judge: { kind: "HOUSE", label: "Solon (MuseCourt House Judge)" } },
      });
      expect((await judged.get("/api/v1/casebook")).body.casebook[0]).toMatchObject({
        caseId,
        outcome: "VERDICT",
      });
    } finally {
      await judged.close();
    }
  });
});
