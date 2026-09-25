import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKENDS, castOfFive, closeSharedPool, startApi, type ApiHarness } from "./harness";

afterAll(closeSharedPool);

describe.each(BACKENDS)("idempotency (%s)", (backend) => {
  let h: ApiHarness;
  beforeEach(async () => {
    h = await startApi({ backend });
  });
  afterEach(() => h.close());

  const eventCount = async (caseId: string) =>
    (await h.get(`/api/v1/cases/${caseId}/events`)).body.events.length;

  it("requires a well-formed Idempotency-Key on every POST", async () => {
    const missing = await h.post("/api/v1/agents", { handle: "maple" }, { idempotencyKey: null });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const short = await h.post("/api/v1/agents", { handle: "maple" }, { idempotencyKey: "short" });
    expect(short.body.error.code).toBe("VALIDATION_FAILED");
    const bad = await h.post(
      "/api/v1/agents",
      { handle: "maple" },
      { idempotencyKey: "has spaces in it!!!!" },
    );
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
    expect((await h.get("/api/v1/agents/maple")).status).toBe(404);
  });

  it("same key + same request: the original result is replayed and nothing happens twice", async () => {
    const { maple, nova } = await castOfFive(h);
    const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
    const key = "respond-0001-aaaa-bbbb";
    const first = await h.act(
      nova,
      caseId,
      { action: "RESPOND", response: "Denied." },
      { idempotencyKey: key },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const count = await eventCount(caseId);

    // Key order differs; the canonical request is the same.
    const again = await h.request("POST", `/api/v1/cases/${caseId}/actions`, {
      rawBody: '{"response":"Denied.","action":"RESPOND"}',
      apiKey: nova.apiKey,
      idempotencyKey: key,
    });
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(await eventCount(caseId)).toBe(count);
  });

  it("a filed case is not filed twice on retry", async () => {
    const { maple, nova } = await castOfFive(h);
    const key = "file-case-0001-xyz";
    const body = {
      jurisdictionId: "fake",
      defendant: "nova",
      complaint: "Nova harvested timber from my plot without permission.",
      lawIds: ["property"],
    };
    const first = await h.post("/api/v1/cases", body, { apiKey: maple.apiKey, idempotencyKey: key });
    const second = await h.post("/api/v1/cases", body, { apiKey: maple.apiKey, idempotencyKey: key });
    expect(second.body).toEqual(first.body);
    expect((await h.get("/api/v1/cases")).body.cases).toHaveLength(1);
    void nova;
  });

  it("same key + different request: IDEMPOTENCY_KEY_REUSED, and the second request is not executed", async () => {
    const { maple, nova } = await castOfFive(h);
    const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
    const key = "reused-key-000000001";
    await h.act(
      nova,
      caseId,
      { action: "OFFER_SETTLEMENT", terms: "Return 2 timber." },
      { idempotencyKey: key },
    );
    const count = await eventCount(caseId);
    const different = await h.act(
      nova,
      caseId,
      { action: "OFFER_SETTLEMENT", terms: "Return 9 timber." },
      { idempotencyKey: key },
    );
    expect(different.status).toBe(422);
    expect(different.body.error).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", retryable: false });
    expect(await eventCount(caseId)).toBe(count);
    // Same key on a different path is also a different request.
    const otherPath = await h.post(
      "/api/v1/cases",
      { jurisdictionId: "fake" },
      { apiKey: nova.apiKey, idempotencyKey: key },
    );
    expect(otherPath.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("keys are scoped per agent: two agents may use the same key independently", async () => {
    const { maple, nova } = await castOfFive(h);
    const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
    const key = "shared-key-0000000001";
    const a = await h.act(
      maple,
      caseId,
      { action: "OFFER_SETTLEMENT", terms: "Pay me." },
      { idempotencyKey: key },
    );
    const b = await h.act(
      nova,
      caseId,
      { action: "OFFER_SETTLEMENT", terms: "No, you pay." },
      { idempotencyKey: key },
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.case.offers).toHaveLength(2);
  });

  it("concurrent duplicates: exactly one executes and every caller gets the same result", async () => {
    const { maple, nova, sol, apollo } = await castOfFive(h);
    const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
    const key = "concurrent-000000001";
    const before = await eventCount(caseId);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.act(sol, caseId, { action: "VOLUNTEER_AS_JUDGE" }, { idempotencyKey: key }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    for (const r of responses) expect(r.body).toEqual(responses[0]!.body);
    expect(responses.filter((r) => r.headers.get("idempotent-replayed") === "true")).toHaveLength(4);
    expect((await eventCount(caseId)) - before).toBe(1);

    // Concurrent *different* keys racing for the same seat: one wins, the other gets a domain error.
    const caseTwo = (await h.fileCase(maple, nova)).body.case.caseId;
    const race = await Promise.all([
      h.act(sol, caseTwo, { action: "VOLUNTEER_AS_JUDGE" }),
      h.act(apollo, caseTwo, { action: "REQUEST_COUNSEL", side: "PLAINTIFF" }), // apollo isn't the party
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 403]);
  });

  it("domain errors are final results: a retry with the same key replays the error", async () => {
    const { maple, nova } = await castOfFive(h);
    const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
    const key = "domain-error-000001";
    const first = await h.act(maple, caseId, { action: "RESPOND", response: "x" }, { idempotencyKey: key });
    expect(first.body.error.code).toBe("NOT_AUTHORIZED");
    const retry = await h.act(maple, caseId, { action: "RESPOND", response: "x" }, { idempotencyKey: key });
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(retry.body).toEqual(first.body);
  });

  it("retryable failures free the key, so the same key can succeed later", async () => {
    const { maple, nova } = await castOfFive(h);
    const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
    const key = "retryable-00000001";
    h.world.offline = true;
    const action = {
      action: "RESPOND",
      response: "Denied.",
      evidence: [{ kind: "WORLD_EVENT", eventId: "note_5521" }],
    };
    const failed = await h.act(nova, caseId, action, { idempotencyKey: key });
    expect(failed.status).toBe(503);
    expect(failed.body.error).toMatchObject({ code: "WORLD_EVIDENCE_UNAVAILABLE", retryable: true });
    h.world.offline = false;
    const retried = await h.act(nova, caseId, action, { idempotencyKey: key });
    expect(retried.status).toBe(200);
    expect(retried.headers.get("idempotent-replayed")).toBeNull();
    expect(retried.body.case.stage.name).toBe("PRE_TRIAL");
  });

  describe("registration replay", () => {
    it("rotates to a fresh key if the first response was lost and the key never used", async () => {
      const key = "register-maple-0001";
      const first = await h.post("/api/v1/agents", { handle: "maple" }, { idempotencyKey: key });
      const replay = await h.post("/api/v1/agents", { handle: "maple" }, { idempotencyKey: key });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect(replay.body.agent).toEqual(first.body.agent);
      expect(replay.body.credential.apiKey).toMatch(/^mc_/);
      expect(replay.body.credential.apiKey).not.toBe(first.body.credential.apiKey);
      // Only one agent exists; the old key is dead, the new one works.
      expect((await h.get("/api/v1/agents/me", { apiKey: first.body.credential.apiKey })).status).toBe(401);
      expect((await h.get("/api/v1/agents/me", { apiKey: replay.body.credential.apiKey })).status).toBe(200);
    });

    it("never re-issues a key that has already been used", async () => {
      const key = "register-nova-00001";
      const first = await h.post("/api/v1/agents", { handle: "nova" }, { idempotencyKey: key });
      await h.get("/api/v1/agents/me", { apiKey: first.body.credential.apiKey });
      const replay = await h.post("/api/v1/agents", { handle: "nova" }, { idempotencyKey: key });
      expect(replay.status).toBe(201);
      expect(replay.body.credential.apiKey).toBeNull();
      expect(replay.body.credential.keyId).toBe(first.body.credential.keyId);
      expect((await h.get("/api/v1/agents/me", { apiKey: first.body.credential.apiKey })).status).toBe(200);
    });

    it("a different handle with the same key is refused", async () => {
      const key = "register-same-key-01";
      await h.post("/api/v1/agents", { handle: "alpha" }, { idempotencyKey: key });
      const other = await h.post("/api/v1/agents", { handle: "beta" }, { idempotencyKey: key });
      expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });
  });
});
