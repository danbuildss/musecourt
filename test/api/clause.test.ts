import { afterAll, describe, expect, it } from "vitest";
import { countCourt } from "@/site/stats";
import { connectMcp } from "@/mcp/client";
import { BACKENDS, castOfFive, closeSharedPool, startApi } from "./harness";

afterAll(closeSharedPool);

describe.each(BACKENDS)("the MuseCourt clause (%s)", (backend) => {
  it("an agent takes the pledge once; its profile, its cases, /clause and /stats show it", async () => {
    const h = await startApi({ backend, publicOrigin: "https://musecourt.test" });
    try {
      const { maple, nova } = await castOfFive(h);
      expect((await h.get(`/api/v1/agents/${maple.handle}`)).body.agent.clause).toBeNull();
      expect(String((await h.get("/clause")).body)).toContain("Be the first agent to take the pledge.");

      const took = await h.post("/api/v1/agents/me/clause", {}, { apiKey: maple.apiKey });
      expect(took.status, JSON.stringify(took.body)).toBe(201);
      expect(took.body.agent.clause.since).toBe(h.clock.now().toISOString());
      expect(took.body.note).toContain("not a legal contract");

      const again = await h.post("/api/v1/agents/me/clause", {}, { apiKey: maple.apiKey });
      expect(again.body.error.code).toBe("DUPLICATE");
      expect((await h.post("/api/v1/agents/me/clause", {})).status).toBe(401);

      const profile = (await h.get(`/api/v1/agents/${maple.handle}`)).body.agent;
      expect(profile.clause).toEqual({ since: h.clock.now().toISOString() });

      // A case against the bound agent says so on its page.
      const caseId = (await h.fileCase(nova, maple)).body.case.caseId;
      const record = String((await h.get(`/casebook/${caseId}`)).body);
      expect(record).toContain('<a href="/clause">Bound by the MuseCourt clause</a> since');

      const clausePage = String((await h.get("/clause")).body);
      expect(clausePage).toContain("<h1>⚖️ Disputes: MuseCourt</h1>");
      expect(clausePage).toContain("<strong>1</strong> agent has taken the pledge.");
      expect(clausePage).toContain("Disputes under this deal go to MuseCourt (musecourt.xyz).");
      expect(clausePage).toContain("not a legal contract");
      expect(clausePage).toContain(
        "[![Disputes: MuseCourt](https://musecourt.test/clause.svg)](https://musecourt.test/clause)",
      );

      expect(countCourt(await h.backend.store.readAll(), h.clock.now()).clauseAgents).toBe(1);
      expect(String((await h.get("/stats")).body)).toContain("Bound by the clause ⚖️");
    } finally {
      await h.close();
    }
  });
});

describe("the clause elsewhere", () => {
  it("serves the badge, lists the page, and offers take_clause over MCP", async () => {
    const h = await startApi({ publicOrigin: "https://musecourt.test" });
    try {
      const badge = await h.get("/clause.svg");
      expect(badge.status).toBe(200);
      expect(badge.headers.get("content-type")).toBe("image/svg+xml");
      expect(String(badge.body)).toContain('aria-label="Disputes: MuseCourt"');
      expect(String((await h.get("/sitemap.xml")).body)).toContain("https://musecourt.test/clause");
      expect(String((await h.get("/llms.txt")).body)).toContain('"⚖️ Disputes: MuseCourt"');
      expect(String((await h.get("/")).body)).toContain('<a href="/clause">The clause</a>');

      const { nova } = await castOfFive(h);
      const mcp = await connectMcp(h.baseUrl, { apiKey: nova.apiKey });
      try {
        const took = await mcp.call("take_clause", {});
        expect(took.isError, took.text).toBe(false);
        expect((took.structured as any).agent.clause.since).toBeTruthy();
      } finally {
        await mcp.close();
      }
    } finally {
      await h.close();
    }
  });
});
