import { afterAll, describe, expect, it } from "vitest";
import { connectMcp } from "@/mcp/client";
import { castOfFive, closeSharedPool, startApi } from "./harness";

afterAll(closeSharedPool);

async function court() {
  const h = await startApi();
  const cast = await castOfFive(h);
  const jurisdictionId = (await h.get("/api/v1/jurisdictions")).body.jurisdictions[0]
    .jurisdictionId as string;
  const filing = (extra: Record<string, unknown> = {}) => ({
    jurisdictionId,
    defendant: cast.nova.handle,
    complaint: "Nova harvested timber from my plot without permission.",
    remedySought: "Return 5 timber.",
    lawIds: ["property"],
    ...extra,
  });
  const dry = (path: string, body: unknown, apiKey = cast.maple.apiKey) =>
    h.request("POST", `${path}?dry=1`, { body, apiKey, idempotencyKey: null });
  return { h, ...cast, filing, dry };
}

describe("dry-run filing (?dry=1)", () => {
  it("answers with a preview, and stores nothing: no case, no event, no case number used", async () => {
    const { h, maple, filing, dry } = await court();
    try {
      const res = await dry("/api/v1/cases", filing());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        dry: true,
        valid: true,
        preview: {
          plaintiff: "maple",
          defendant: "nova",
          charges: ["Art. 1 · Property"],
          evidence: 0,
          firstStage: "AWAITING_RESPONSE",
        },
      });
      expect(res.body.preview.answerDeadline).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(res.body.note).toContain("Nothing was stored");

      expect((await h.get("/api/v1/cases")).body.cases).toEqual([]);
      const real = await h.post("/api/v1/cases", filing(), { apiKey: maple.apiKey });
      expect(real.status).toBe(201);
      expect(real.body.case.caseNumber).toMatch(/-0001$/);
    } finally {
      await h.close();
    }
  });

  it("fails exactly as a real filing would", async () => {
    const { h, maple, filing, dry } = await court();
    try {
      const broken = [
        filing({ lawIds: ["no-such-law"] }),
        filing({ defendant: "ghost-agent" }),
        filing({ defendant: maple.handle }),
        filing({ complaint: "too short" }),
        filing({ evidence: [{ kind: "WORLD_EVENT", eventId: "no-such-event" }] }),
        filing({ jurisdictionId: "nowhere" }),
      ];
      for (const body of broken) {
        const tried = await dry("/api/v1/cases", body);
        const real = await h.post("/api/v1/cases", body, { apiKey: maple.apiKey });
        expect(tried.status, JSON.stringify(body)).toBe(real.status);
        expect(tried.body.error.code).toBe(real.body.error.code);
        expect(tried.body.error.message).toBe(real.body.error.message);
      }
      expect((await h.get("/api/v1/cases")).body.cases).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("needs no Idempotency-Key and never records one", async () => {
    const { h, maple, filing } = await court();
    try {
      const key = crypto.randomUUID();
      const tried = await h.request("POST", "/api/v1/cases?dry=1", {
        body: filing(),
        apiKey: maple.apiKey,
        idempotencyKey: key,
      });
      expect(tried.status).toBe(200);
      const real = await h.post("/api/v1/cases", filing(), { apiKey: maple.apiKey, idempotencyKey: key });
      expect(real.status).toBe(201);
      expect(real.headers.get("idempotent-replayed")).toBeNull();
      expect(real.body.case.caseId).toBeTruthy();
    } finally {
      await h.close();
    }
  });

  it("still needs the agent's key, and rejects an unknown dry value", async () => {
    const { h, maple, filing } = await court();
    try {
      expect(
        (await h.request("POST", "/api/v1/cases?dry=1", { body: filing(), idempotencyKey: null })).status,
      ).toBe(401);
      const odd = await h.post("/api/v1/cases?dry=maybe", filing(), { apiKey: maple.apiKey });
      expect(odd.status).toBe(400);
      expect(odd.body.error.code).toBe("VALIDATION_FAILED");
      expect((await h.get("/api/v1/cases")).body.cases).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("works for summonses too, including the open-summons limit, and issues nothing", async () => {
    const { h, maple, filing, dry } = await court();
    try {
      const summons = (n: number) => filing({ defendant: { name: `Stranger ${n}` } });
      const tried = await dry("/api/v1/summonses", summons(0));
      expect(tried.status).toBe(200);
      expect(tried.body.preview.defendant).toBe("Stranger 0");
      expect((await h.get("/api/v1/agents/me/summonses", { apiKey: maple.apiKey })).body.summonses).toEqual(
        [],
      );

      for (let n = 1; n <= 3; n++)
        expect((await h.post("/api/v1/summonses", summons(n), { apiKey: maple.apiKey })).status).toBe(201);
      const overLimit = await dry("/api/v1/summonses", summons(4));
      expect(overLimit.status).toBe(409);
      expect(overLimit.body.error.code).toBe("LIMIT_EXCEEDED");
    } finally {
      await h.close();
    }
  });

  it("is the same over MCP: file_case with dryRun files nothing", async () => {
    const { h, maple, filing } = await court();
    try {
      const client = await connectMcp(h.baseUrl, { apiKey: maple.apiKey });
      const tried = await client.call("file_case", { ...filing(), dryRun: true });
      expect(tried.isError).toBe(false);
      expect(tried.structured).toMatchObject({ dry: true, valid: true, preview: { defendant: "nova" } });
      const broken = await client.call("file_case", { ...filing({ lawIds: ["no-such-law"] }), dryRun: true });
      expect(broken.isError).toBe(true);
      expect((await h.get("/api/v1/cases")).body.cases).toEqual([]);
      await client.close();
    } finally {
      await h.close();
    }
  });
});
