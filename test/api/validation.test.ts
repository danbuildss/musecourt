import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ERROR_CATALOGUE } from "@/api/errors";
import { BACKENDS, castOfFive, closeSharedPool, startApi, type ApiHarness } from "./harness";

afterAll(closeSharedPool);

describe.each(BACKENDS)("request validation and errors (%s)", (backend) => {
  let h: ApiHarness;
  beforeEach(async () => {
    h = await startApi({ backend });
  });
  afterEach(() => h.close());

  const expectError = (res: { status: number; body: any }, code: string) => {
    expect(res.body.error?.code, JSON.stringify(res.body)).toBe(code);
    expect(res.status).toBe(ERROR_CATALOGUE[code as keyof typeof ERROR_CATALOGUE].status);
    expect(typeof res.body.error.message).toBe("string");
    expect(typeof res.body.error.retryable).toBe("boolean");
  };

  describe("malformed requests", () => {
    it("rejects invalid JSON, empty bodies and non-JSON media types", async () => {
      expectError(await h.request("POST", "/api/v1/agents", { rawBody: "{not json" }), "VALIDATION_FAILED");
      expectError(await h.request("POST", "/api/v1/agents", { rawBody: "" }), "VALIDATION_FAILED");
      expectError(
        await h.request("POST", "/api/v1/agents", {
          rawBody: "handle=maple",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        "UNSUPPORTED_MEDIA_TYPE",
      );
      expectError(await h.request("POST", "/api/v1/agents", { rawBody: "[1,2]" }), "VALIDATION_FAILED");
    });

    it("rejects unknown routes, wrong methods and bad path/query parameters", async () => {
      expectError(await h.get("/api/v1/nope"), "NOT_FOUND");
      expectError(await h.request("DELETE", "/api/v1/cases"), "METHOD_NOT_ALLOWED");
      expectError(await h.get("/api/v1/cases/not an id"), "VALIDATION_FAILED");
      expectError(await h.get("/api/v1/cases/case_999"), "NOT_FOUND");
      expectError(await h.get("/api/v1/cases?status=MAYBE"), "VALIDATION_FAILED");
      expectError(await h.get("/api/v1/cases?limit=1000"), "VALIDATION_FAILED");
      expectError(await h.get("/api/v1/cases?limit=-1"), "VALIDATION_FAILED");
      expectError(await h.get("/api/v1/cases?limit=1&limit=2"), "VALIDATION_FAILED");
      expectError(await h.get("/api/v1/cases?sql=1;drop"), "VALIDATION_FAILED");
      expectError(await h.get("/api/v1/jurisdictions/BAD_ID/laws"), "VALIDATION_FAILED");
    });

    it("validates actions strictly: unknown actions, wrong enums, wrong types", async () => {
      const { maple, nova } = await castOfFive(h);
      const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
      expectError(await h.act(nova, caseId, { action: "BRIBE_JUDGE" }), "VALIDATION_FAILED");
      expectError(
        await h.act(nova, caseId, { action: "DECLARE_SELF_REPRESENTATION", side: "JURY" }),
        "VALIDATION_FAILED",
      );
      expectError(await h.act(nova, caseId, { action: "RESPOND", response: 12 }), "VALIDATION_FAILED");
      expectError(await h.act(nova, caseId, { response: "no action" }), "VALIDATION_FAILED");
      expectError(
        await h.act(nova, caseId, { action: "RESPOND", response: "x", evidence: [{ kind: "FORGED" }] }),
        "INVALID_EVIDENCE",
      );
      expectError(
        await h.act(nova, caseId, {
          action: "RESPOND",
          response: "x",
          evidence: [{ kind: "WORLD_EVENT", eventId: "x", provenance: "WORLD_VERIFIED" }],
        }),
        "INVALID_EVIDENCE",
      );
      expectError(
        await h.act(nova, caseId, { action: "WITHDRAW_EVIDENCE", evidenceId: "../../etc", reason: "x" }),
        "VALIDATION_FAILED",
      );
    });
  });

  describe("size limits", () => {
    it("rejects bodies over the limit with 413", async () => {
      const agent = await h.register("maple");
      const huge = { handle: "x".repeat(70 * 1024) };
      const res = await h.post("/api/v1/agents", huge);
      expectError(res, "PAYLOAD_TOO_LARGE");
      const alsoHuge = await h.post(
        "/api/v1/cases",
        { complaint: "y".repeat(100_000) },
        { apiKey: agent.apiKey },
      );
      expectError(alsoHuge, "PAYLOAD_TOO_LARGE");
    });

    it("enforces the court's text limits on complaints, testimony, arguments, terms and reasoning", async () => {
      const { maple, nova, sol } = await castOfFive(h);
      const long = "z".repeat(4001);
      expectError(await h.fileCase(maple, nova, { complaint: long }), "VALIDATION_FAILED");
      expectError(await h.fileCase(maple, nova, { complaint: "too short" }), "VALIDATION_FAILED");
      const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
      expectError(await h.act(nova, caseId, { action: "RESPOND", response: long }), "VALIDATION_FAILED");
      expectError(
        await h.act(nova, caseId, { action: "OFFER_SETTLEMENT", terms: "t".repeat(2001) }),
        "VALIDATION_FAILED",
      );
      expectError(
        await h.act(nova, caseId, {
          action: "RESPOND",
          response: "ok",
          evidence: [{ kind: "TESTIMONY", content: long }],
        }),
        "VALIDATION_FAILED",
      );
      const doc = { kind: "DOCUMENT", title: "t".repeat(201), content: "c" };
      expectError(
        await h.act(nova, caseId, { action: "RESPOND", response: "ok", evidence: [doc] }),
        "VALIDATION_FAILED",
      );
      void sol;
    });
  });

  describe("domain errors through HTTP", () => {
    it("maps court errors to stable codes and statuses", async () => {
      const { maple, nova, apollo, athena, sol } = await castOfFive(h);
      const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
      expectError(
        await h.act(sol, caseId, { action: "ISSUE_VERDICT", finding: "LIABLE", reasoning: "x" }),
        "WRONG_STAGE",
      );
      expectError(await h.act(apollo, caseId, { action: "VOLUNTEER_AS_JUDGE" }), "LICENCE_REQUIRED");
      await h.act(sol, caseId, { action: "VOLUNTEER_AS_JUDGE" });
      expectError(
        await h.act(maple, caseId, { action: "REQUEST_COUNSEL", side: "PLAINTIFF", lawyer: "sol" }),
        "CONFLICT_OF_INTEREST",
      );
      expectError(
        await h.act(maple, caseId, { action: "REQUEST_COUNSEL", side: "PLAINTIFF", lawyer: "ghost" }),
        "NOT_FOUND",
      );
      expectError(await h.act(athena, caseId, { action: "VOLUNTEER_AS_JUDGE" }), "LICENCE_REQUIRED");
      expectError(await h.fileCase(maple, maple), "CONFLICT_OF_INTEREST");
      expectError(await h.fileCase(maple, nova, { lawIds: ["theft"] }), "NOT_FOUND");
      expectError(
        await h.fileCase(maple, nova, { evidence: [{ kind: "WORLD_EVENT", eventId: "nope" }] }),
        "WORLD_EVIDENCE_NOT_FOUND",
      );
      await h.act(nova, caseId, { action: "RESPOND", response: "Denied." });
      expectError(
        await h.act(maple, caseId, { action: "DECLARE_SELF_REPRESENTATION", side: "DEFENCE" }),
        "NOT_AUTHORIZED",
      );
      await h.act(maple, caseId, { action: "WITHDRAW_CASE", reason: "Resolved privately." });
      expectError(await h.act(nova, caseId, { action: "OFFER_SETTLEMENT", terms: "x" }), "CASE_CLOSED");
    });

    it("never leaks internal details or stack traces", async () => {
      const broken = await startApi({ backend, breakReadModels: true });
      try {
        const res = await broken.get("/api/v1/jurisdictions");
        expect(res.status).toBe(500);
        expect(res.body).toEqual({
          error: {
            code: "INTERNAL_ERROR",
            message: "Unexpected server error.",
            retryable: true,
            details: {},
          },
        });
        expect(JSON.stringify(res.body)).not.toMatch(/postgres:|stack|at .*\.ts/);
        expect(broken.internalErrors).toHaveLength(1);
      } finally {
        await broken.close();
      }
    });
  });

  describe("untrusted text", () => {
    it("is stored verbatim as data and escaped in the debug view", async () => {
      const { maple, nova } = await castOfFive(h);
      const nasty = `Robert'); DROP TABLE musecourt.court_events;-- <script>alert(1)</script>`;
      const caseId = (await h.fileCase(maple, nova, { complaint: nasty })).body.case.caseId;
      const view = await h.get(`/api/v1/cases/${caseId}`);
      expect(view.body.case.complaint).toBe(nasty);
      const html = await h.get(`/debug/cases/${caseId}`);
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toContain("text/html");
      expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(html.body).not.toContain("<script>");
      expect(html.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      // The event log is intact.
      expect((await h.get(`/api/v1/cases/${caseId}/events`)).body.events.length).toBeGreaterThan(0);
    });
  });

  describe("discovery", () => {
    it("describes version, auth, endpoints, errors and idempotency", async () => {
      const res = await h.get("/api/v1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "MuseCourt", apiVersion: "v1", basePath: "/api/v1" });
      expect(res.body.authentication.agent.scheme).toContain("Bearer mc_");
      expect(res.body.idempotency.header).toBe("Idempotency-Key");
      expect(res.body.errors.codes.map((c: any) => c.code)).toEqual(
        expect.arrayContaining(["WRONG_STAGE", "DEADLINE_PASSED", "INVALID_EVIDENCE", "NOT_AUTHORIZED"]),
      );
      const paths = res.body.endpoints.map((e: any) => `${e.method} ${e.path}`);
      expect(paths).toEqual(
        expect.arrayContaining([
          "POST /api/v1/agents",
          "POST /api/v1/cases/:caseId/actions",
          "GET /api/v1/agents/me/tasks",
        ]),
      );
      expect(Object.keys(res.body.actions.parameters)).toHaveLength(17);
      expect(res.body.procedure).toHaveLength(11);
    });
  });
});
