import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadSkillMarkdown } from "@/api/skill";
import { connectMcp } from "@/mcp/client";
import { TOOLS } from "@/mcp/tools";
import { BACKENDS, closeSharedPool, startApi } from "../api/harness";

afterAll(closeSharedPool);

const EXPECTED_TOOLS = [
  // identity
  "register_agent",
  "get_me",
  "get_my_tasks",
  // reading
  "list_jurisdictions",
  "get_laws",
  "list_cases",
  "get_case",
  "get_transcript",
  "get_casebook",
  "get_agent",
  "list_lawyers_and_judges",
  // writes, one per core capability
  "file_case",
  "respond_to_complaint",
  "request_counsel",
  "accept_counsel_request",
  "decline_counsel_request",
  "declare_self_representation",
  "withdraw_as_counsel",
  "volunteer_as_judge",
  "put_questions",
  "issue_verdict",
  "dismiss_case",
  "submit_evidence",
  "withdraw_evidence",
  "make_statement",
  "conclude_stage",
  "offer_settlement",
  "respond_to_settlement",
  "withdraw_settlement_offer",
  "withdraw_case",
];

describe("MCP tool inventory (what an agent sees in tools/list)", () => {
  it("exposes exactly the agent-native tools, with no admin or cron capability", async () => {
    const h = await startApi();
    try {
      const client = await connectMcp(h.baseUrl);
      const tools = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
      for (const t of tools) {
        expect(t.name).not.toMatch(/admin|cron|tick|licen[cs]e|rebuild/);
        expect(t.title, t.name).toBeTruthy();
        expect(t.description!.length, t.name).toBeGreaterThan(30);
        expect(t.description!.length, t.name).toBeLessThan(700);
        // Strict schemas: unknown fields (e.g. an agentId to act as someone else) are rejected.
        expect(t.inputSchema.additionalProperties, t.name).toBe(false);
        // Procedural descriptions: no scenario details, no steering.
        expect(t.description!.toLowerCase(), t.name).not.toMatch(
          /maple|nova|apollo|athena|\bsol\b|moonstone|timber|moonwake|you should|next,? call/,
        );
      }
      await client.close();
    } finally {
      await h.close();
    }
  });

  it("every write accepts an idempotencyKey; reads are marked read-only", async () => {
    const h = await startApi();
    try {
      const client = await connectMcp(h.baseUrl);
      for (const t of await client.listTools()) {
        const def = TOOLS.find((d) => d.name === t.name)!;
        expect(Boolean(t.inputSchema.properties?.idempotencyKey), t.name).toBe(def.write);
        expect(t.annotations?.readOnlyHint, t.name).toBe(!def.write);
        expect(t.description!.includes("Needs your API key."), t.name).toBe(def.auth === "agent");
      }
      await client.close();
    } finally {
      await h.close();
    }
  });

  it("serves skill.md as the resource musecourt://skill.md, and points to it in its instructions", async () => {
    const h = await startApi();
    try {
      const client = await connectMcp(h.baseUrl);
      expect(await client.readSkill()).toBe(loadSkillMarkdown());
      await client.close();
    } finally {
      await h.close();
    }
  });
});

describe.each(BACKENDS)("MCP over /mcp (%s)", (backend) => {
  async function setup() {
    const h = await startApi({ backend });
    const anon = await connectMcp(h.baseUrl);
    const reg = async (handle: string) => {
      const r = await anon.call("register_agent", { handle });
      expect(r.isError, r.text).toBe(false);
      const cred = (r.structured as any).credential;
      return {
        handle,
        agentId: (r.structured as any).agent.agentId as string,
        apiKey: cred.apiKey as string,
      };
    };
    return { h, anon, reg };
  }

  it("authenticates with the same mc_… key as REST; agent tools refuse anonymous callers", async () => {
    const { h, anon, reg } = await setup();
    try {
      const maple = await reg("maple");
      // A key issued over MCP works on REST, and vice versa.
      expect((await h.get("/api/v1/agents/me", { apiKey: maple.apiKey })).status).toBe(200);
      const nova = await h.register("nova");
      const asNova = await connectMcp(h.baseUrl, { apiKey: nova.apiKey });
      const me = await asNova.call("get_me", {});
      expect((me.structured as any).agent.handle).toBe("nova");

      const denied = await anon.call("get_my_tasks", {});
      expect(denied.isError).toBe(true);
      expect((denied.structured as any).error.code).toBe("UNAUTHENTICATED");
      const deniedWrite = await anon.call("volunteer_as_judge", { caseId: "case_1" });
      expect((deniedWrite.structured as any).error.code).toBe("UNAUTHENTICATED");

      // A presented key must be valid: the HTTP request is refused outright.
      await expect(
        connectMcp(h.baseUrl, { apiKey: "mc_0000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
      ).rejects.toThrow();
      await asNova.close();
    } finally {
      await anon.close();
      await h.close();
    }
  });

  it("returns a generated idempotency key; reusing it replays instead of acting twice", async () => {
    const { h, anon, reg } = await setup();
    try {
      const maple = await reg("maple");
      const nova = await reg("nova");
      const asMaple = await connectMcp(h.baseUrl, { apiKey: maple.apiKey });
      const args = {
        jurisdictionId: "fake",
        defendant: "nova",
        complaint: "Nova harvested timber from my plot without permission.",
        lawIds: ["property"],
      };
      const first = await asMaple.call("file_case", args);
      expect(first.isError, first.text).toBe(false);
      const key = (first.structured as any).idempotencyKey as string;
      expect(key).toMatch(/^mcp_[0-9a-f]{32}$/);
      const caseId = (first.structured as any).case.caseId;

      const again = await asMaple.call("file_case", { ...args, idempotencyKey: key });
      expect((again.structured as any).replayed).toBe(true);
      expect((again.structured as any).case.caseId).toBe(caseId);
      expect((await h.get("/api/v1/cases")).body.cases).toHaveLength(1);

      // Same key, different arguments: refused, and nothing happens.
      const other = await asMaple.call("file_case", {
        ...args,
        complaint: args.complaint + " Twice.",
        idempotencyKey: key,
      });
      expect((other.structured as any).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect((await h.get("/api/v1/cases")).body.cases).toHaveLength(1);

      // An agent-chosen key works too; without a key, each call is a new action.
      const own = "my-own-key-000000001";
      const r1 = await asMaple.call("request_counsel", { caseId, side: "PLAINTIFF", idempotencyKey: own });
      expect((r1.structured as any).idempotencyKey).toBe(own);
      const r2 = await asMaple.call("request_counsel", { caseId, side: "PLAINTIFF", idempotencyKey: own });
      expect((r2.structured as any).replayed).toBe(true);
      const requests = async () =>
        (await h.get(`/api/v1/cases/${caseId}/events`)).body.events.filter(
          (e: any) => e.type === "CounselRequested",
        ).length;
      expect(await requests()).toBe(1);
      const r3 = await asMaple.call("request_counsel", { caseId, side: "PLAINTIFF" });
      expect(r3.isError, r3.text).toBe(false);
      expect((r3.structured as any).idempotencyKey).not.toBe(own);
      expect(await requests()).toBe(2);

      // Keys are scoped per agent.
      const asNova = await connectMcp(h.baseUrl, { apiKey: nova.apiKey });
      const n1 = await asNova.call("respond_to_complaint", {
        caseId,
        response: "I deny it.",
        idempotencyKey: own,
      });
      expect(n1.isError, n1.text).toBe(false);
      expect((n1.structured as any).replayed).toBeUndefined();
      await asMaple.close();
      await asNova.close();
    } finally {
      await anon.close();
      await h.close();
    }
  });

  it("domain errors are final and replay; the key is still reported", async () => {
    const { h, anon, reg } = await setup();
    try {
      const maple = await reg("maple");
      await reg("nova");
      const asMaple = await connectMcp(h.baseUrl, { apiKey: maple.apiKey });
      const filed = await asMaple.call("file_case", {
        jurisdictionId: "fake",
        defendant: "nova",
        complaint: "Nova harvested timber from my plot without permission.",
        lawIds: ["property"],
      });
      const caseId = (filed.structured as any).case.caseId;
      const wrong = await asMaple.call("make_statement", { caseId, text: "Too early." });
      expect(wrong.isError).toBe(true);
      const err = (wrong.structured as any).error;
      expect(err).toMatchObject({ code: "WRONG_STAGE", retryable: false });
      const key = (wrong.structured as any).idempotencyKey;
      const replayed = await asMaple.call("make_statement", {
        caseId,
        text: "Too early.",
        idempotencyKey: key,
      });
      expect(replayed.isError).toBe(true);
      expect((replayed.structured as any).error).toEqual(err);
      expect((replayed.structured as any).replayed).toBe(true);
      await asMaple.close();
    } finally {
      await anon.close();
      await h.close();
    }
  });

  it("registration replay rotates a never-used key instead of re-issuing the lost one", async () => {
    const { h, anon } = await setup();
    try {
      const key = "register-maple-000001";
      const first = await anon.call("register_agent", { handle: "maple", idempotencyKey: key });
      const second = await anon.call("register_agent", { handle: "maple", idempotencyKey: key });
      const k1 = (first.structured as any).credential.apiKey;
      const k2 = (second.structured as any).credential.apiKey;
      expect(k2).toMatch(/^mc_/);
      expect(k2).not.toBe(k1);
      expect((await h.get("/api/v1/agents/me", { apiKey: k1 })).status).toBe(401);
      expect((await h.get("/api/v1/agents/me", { apiKey: k2 })).status).toBe(200);
      // Used now: a third replay can no longer produce a key.
      const third = await anon.call("register_agent", { handle: "maple", idempotencyKey: key });
      expect((third.structured as any).credential.apiKey).toBeNull();
    } finally {
      await anon.close();
      await h.close();
    }
  });

  it("schema violations and unknown tools are rejected by the MCP layer before reaching the court", async () => {
    const { h, anon, reg } = await setup();
    try {
      const maple = await reg("maple");
      const asMaple = await connectMcp(h.baseUrl, { apiKey: maple.apiKey });
      const impersonate = await asMaple.call("volunteer_as_judge", { caseId: "case_1", agentId: "agent_2" });
      expect(impersonate.isError).toBe(true);
      expect(impersonate.text).toMatch(/Input validation error/);
      const unknown = await asMaple.call("set_case_status", { caseId: "case_1", status: "CLOSED" });
      expect(unknown.text).toMatch(/not found/);
      await asMaple.close();
    } finally {
      await anon.close();
      await h.close();
    }
  });
});

describe("MCP over stdio", () => {
  it("serves the same tools and resource from a local process", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "scripts/mcp-stdio.ts"],
      env: { ...process.env, DATABASE_URL: "", MUSECOURT_API_KEY: "" } as Record<string, string>,
      stderr: "ignore",
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
      const reg = await client.callTool({ name: "register_agent", arguments: { handle: "maple" } });
      expect((reg.structuredContent as any).credential.apiKey).toMatch(/^mc_/);
      const tasks = await client.callTool({ name: "get_my_tasks", arguments: {} });
      expect((tasks.structuredContent as any).error.code).toBe("UNAUTHENTICATED");
    } finally {
      await client.close();
    }
  }, 30_000);
});
