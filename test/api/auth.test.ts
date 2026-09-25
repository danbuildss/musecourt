import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/api/auth";
import { FixedWindowRateLimiter } from "@/api/rate-limit";
import type { MemoryCredentialStore } from "@/infra/memory-auth-stores";
import { BACKENDS, castOfFive, closeSharedPool, startApi, type ApiHarness } from "./harness";

afterAll(closeSharedPool);

describe.each(BACKENDS)("registration and authentication (%s)", (backend) => {
  let h: ApiHarness;
  beforeEach(async () => {
    h = await startApi({ backend });
  });
  afterEach(() => h.close());

  describe("registration", () => {
    it("creates a plain agent and returns a one-time API key", async () => {
      const res = await h.post("/api/v1/agents", { handle: "Maple", displayName: "Maple of Moonwake" });
      expect(res.status).toBe(201);
      expect(res.body.agent).toMatchObject({
        handle: "maple",
        displayName: "Maple of Moonwake",
        licences: {},
      });
      expect(res.body.agent.agentId).toMatch(/^agent_/);
      expect(res.body.credential.apiKey).toMatch(/^mc_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
      expect(res.body.credential.keyId).toBe(res.body.credential.apiKey.slice(3, 19));
    });

    it("never grants roles or licences at registration", async () => {
      for (const extra of [
        { licences: ["JUDGE"] },
        { role: "JUDGE" },
        { agentId: "agent_x" },
        { ownerRef: "me" },
      ]) {
        const res = await h.post("/api/v1/agents", { handle: "sneaky", ...extra });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_FAILED");
        expect(res.body.error.message).toMatch(/Unknown field/);
      }
      const agent = await h.register("honest");
      const me = await h.get("/api/v1/agents/me", { apiKey: agent.apiKey });
      expect(me.body.agent.licences).toEqual({});
      expect((await h.get("/api/v1/lawyers")).body.lawyers).toEqual([]);
    });

    it("normalises handles and keeps them unique", async () => {
      await h.register("Nova");
      for (const handle of ["nova", "NOVA", "  Nova ", "ｎｏｖａ" /* full-width, NFKC → nova */]) {
        const res = await h.post("/api/v1/agents", { handle });
        expect(res.status, handle).toBe(409);
        expect(res.body.error.code).toBe("DUPLICATE");
      }
    });

    it("rejects reserved, malformed and invisible-character names deterministically", async () => {
      const cases: Array<[unknown, string]> = [
        [{ handle: "solon" }, "VALIDATION_FAILED"],
        [{ handle: "MuseCourt" }, "VALIDATION_FAILED"],
        [{ handle: "has space" }, "VALIDATION_FAILED"],
        [{ handle: "x" }, "VALIDATION_FAILED"],
        [{ handle: "-leading" }, "VALIDATION_FAILED"],
        [{ handle: "a".repeat(33) }, "VALIDATION_FAILED"],
        [{ handle: 42 }, "VALIDATION_FAILED"],
        [{ handle: "ok-name", displayName: "Evil‮man" }, "VALIDATION_FAILED"],
        [{}, "VALIDATION_FAILED"],
      ];
      for (const [body, code] of cases) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await h.post("/api/v1/agents", body);
          expect(res.status, JSON.stringify(body)).toBe(400);
          expect(res.body.error.code).toBe(code);
        }
      }
    });

    it("stores only a hash of the secret", async () => {
      if (backend !== "memory") return;
      const agent = await h.register("maple");
      const secret = agent.apiKey.split("_").slice(2).join("_");
      const stored = (h.backend.credentials as MemoryCredentialStore).all();
      expect(stored).toHaveLength(1);
      expect(stored[0]!.secretHash).toBe(sha256Hex(secret));
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(JSON.stringify(await h.backend.store.readAll())).not.toContain(secret);
    });
  });

  describe("authentication", () => {
    it("rejects missing, malformed, unknown and wrong credentials with one generic error", async () => {
      const agent = await h.register("maple");
      const [, keyId] = agent.apiKey.split("_");
      const bad = [
        undefined,
        "not-a-key",
        `mc_${keyId}_${"A".repeat(43)}`, // right key id, wrong secret
        `mc_${"0".repeat(16)}_${"A".repeat(43)}`, // unknown key id
        agent.apiKey + "x",
      ];
      for (const apiKey of bad) {
        const res = await h.get("/api/v1/agents/me", apiKey ? { apiKey } : {});
        expect(res.status).toBe(401);
        expect(res.body.error).toMatchObject({
          code: "UNAUTHENTICATED",
          message: "Missing or invalid credentials.",
        });
        expect(res.headers.get("www-authenticate")).toContain("Bearer");
      }
    });

    it("each agent authenticates independently", async () => {
      const a = await h.register("alpha");
      const b = await h.register("beta");
      expect((await h.get("/api/v1/agents/me", { apiKey: a.apiKey })).body.agent.handle).toBe("alpha");
      expect((await h.get("/api/v1/agents/me", { apiKey: b.apiKey })).body.agent.handle).toBe("beta");
    });

    it("a rotated credential stops working; the new one works", async () => {
      const agent = await h.register("maple");
      const rotated = await h.post(`/api/v1/admin/agents/${agent.handle}/credentials`, {}, { admin: true });
      expect(rotated.status).toBe(201);
      expect((await h.get("/api/v1/agents/me", { apiKey: agent.apiKey })).status).toBe(401);
      expect((await h.get("/api/v1/agents/me", { apiKey: rotated.body.credential.apiKey })).status).toBe(200);
    });

    it("admin and agent credentials are not interchangeable", async () => {
      const agent = await h.register("maple");
      const asAgent = await h.post("/api/v1/admin/tick", {}, { apiKey: agent.apiKey });
      expect(asAgent.status).toBe(401);
      const wrongAdmin = await h.post(
        "/api/v1/admin/tick",
        {},
        { admin: "wrong-token-wrong-token-wrong-token-123" },
      );
      expect(wrongAdmin.status).toBe(401);
      const adminOnAgentRoute = await h.get("/api/v1/agents/me", { admin: true });
      expect(adminOnAgentRoute.status).toBe(401);
      // The admin token in the Bearer slot is not an agent key either.
      const bearerAdmin = await h.get("/api/v1/agents/me", {
        headers: { authorization: `Bearer ${"x".repeat(40)}` },
      });
      expect(bearerAdmin.status).toBe(401);
    });
  });

  describe("impersonation", () => {
    it("a request body cannot name a different acting agent", async () => {
      const { maple, nova } = await castOfFive(h);
      const filed = await h.fileCase(maple, nova);
      const caseId = filed.body.case.caseId;
      // Maple tries to answer the complaint "as" Nova.
      for (const smuggled of [{ agentId: nova.agentId }, { actor: nova.agentId }, { as: "nova" }]) {
        const res = await h.act(maple, caseId, { action: "RESPOND", response: "I admit it.", ...smuggled });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_FAILED");
      }
      // Without the smuggled field, Maple is simply not the defendant.
      const res = await h.act(maple, caseId, { action: "RESPOND", response: "I admit it." });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("NOT_AUTHORIZED");
      const events = await h.get(`/api/v1/cases/${caseId}/events`);
      expect(events.body.events.map((e: any) => e.type)).not.toContain("ComplaintAnswered");
    });

    it("an agent cannot file a case on another agent's behalf", async () => {
      const { maple, nova } = await castOfFive(h);
      const res = await h.post(
        "/api/v1/cases",
        {
          jurisdictionId: "fake",
          defendant: "nova",
          plaintiff: "sol",
          complaint: "Nova took timber without asking me.",
          lawIds: ["property"],
        },
        { apiKey: maple.apiKey },
      );
      expect(res.status).toBe(400);
      const ok = await h.fileCase(maple, nova);
      expect(ok.body.case.parties.plaintiff.handle).toBe("maple");
    });

    it("a lawyer cannot accept a request made to another lawyer, and cannot act as the judge", async () => {
      const { maple, nova, athena, sol } = await castOfFive(h);
      const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
      await h.act(maple, caseId, { action: "REQUEST_COUNSEL", side: "PLAINTIFF", lawyer: "apollo" });
      const stolen = await h.act(athena, caseId, { action: "ACCEPT_REPRESENTATION", side: "PLAINTIFF" });
      expect(stolen.body.error.code).toBe("NOT_AUTHORIZED");
      await h.act(sol, caseId, { action: "VOLUNTEER_AS_JUDGE" });
      const dismiss = await h.act(athena, caseId, { action: "DISMISS_CASE", reason: "I say so." });
      expect(dismiss.body.error.code).toBe("NOT_AUTHORIZED");
    });

    it("the house judge cannot be claimed by registration", async () => {
      const res = await h.post("/api/v1/agents", { handle: "solon", displayName: "Solon" });
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });
  });
});

describe("registration rate limiting", () => {
  it("limits registrations per client address", async () => {
    const h = await startApi({ registrationLimiter: new FixedWindowRateLimiter(2, 60_000) });
    try {
      expect((await h.post("/api/v1/agents", { handle: "one" })).status).toBe(201);
      expect((await h.post("/api/v1/agents", { handle: "two" })).status).toBe(201);
      const third = await h.post("/api/v1/agents", { handle: "three" });
      expect(third.status).toBe(429);
      expect(third.body.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
      h.clock.advance(60_000);
      expect((await h.post("/api/v1/agents", { handle: "three" })).status).toBe(201);
    } finally {
      await h.close();
    }
  });
});
