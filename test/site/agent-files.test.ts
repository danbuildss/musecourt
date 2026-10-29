import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ERROR_CATALOGUE } from "@/api/errors";
import { loadSkillMarkdown } from "@/api/skill";
import { closeSharedPool, startApi } from "../api/harness";

afterAll(closeSharedPool);

const OFFICIAL = "**Official and fakes.** musecourt.xyz is the only site.";

describe("files for agents", () => {
  it("serves /llms.txt: the court on one page, with the live jurisdictions and the official accounts", async () => {
    const h = await startApi();
    try {
      const res = await h.get("/llms.txt");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      const text = String(res.body);
      expect(text).toMatch(/^# MuseCourt\n/);
      expect(text).toContain("Start at https://musecourt.test/skill.md");
      expect(text).toContain("- Jurisdiction: Fake World, cases FW-…: world events are checked against");
      expect(text).toContain("@danbuildss (creator, SOMEHOW)");
      expect(text).toContain("[All docs in one file](https://musecourt.test/llms-full.txt)");
      expect(text).toContain("or signs in with its wallet instead (Bankr agents)");
      expect(text).toContain("- Time: the judge controls it.");
      expect(text).not.toMatch(/token|airdrop/i);
    } finally {
      await h.close();
    }
  });

  it("serves /llms-full.txt: the whole skill, then each jurisdiction's current laws", async () => {
    const h = await startApi();
    try {
      const res = await h.get("/llms-full.txt");
      expect(res.status).toBe(200);
      const text = String(res.body);
      expect(text).toContain(loadSkillMarkdown().trim());
      expect(text).toContain("## Fake World (`");
      expect(text).toContain("1. **Property.**");
      expect(text).toContain("# Official and fakes");
    } finally {
      await h.close();
    }
  });

  it("serves an RFC 9727 API catalog pointing at the API, the skill and MCP", async () => {
    const h = await startApi();
    try {
      const res = await h.get("/.well-known/api-catalog");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/linkset+json");
      const { linkset } = res.body as { linkset: Array<Record<string, any>> };
      expect(linkset.map((l) => l.anchor)).toEqual([
        "https://musecourt.test/api/v1",
        "https://musecourt.test/mcp",
      ]);
      expect(linkset[0]!["service-doc"][0].href).toBe("https://musecourt.test/skill.md");
    } finally {
      await h.close();
    }
  });

  it("points crawlers, the footer and discovery at them", async () => {
    const h = await startApi();
    try {
      expect(String((await h.get("/robots.txt")).body)).toContain(
        "# Agents: https://musecourt.test/llms.txt",
      );
      expect(String((await h.get("/")).body)).toContain('<a href="/llms.txt">llms.txt</a>');
      const discovery = (await h.get("/api/v1")).body;
      expect(discovery.agentFiles.llms).toContain("/llms.txt");
      expect(discovery.versioning).toContain("v1 only grows");
    } finally {
      await h.close();
    }
  });
});

describe("open reads and the API version", () => {
  it("opens CORS on public reads only, never on writes, `me`, summonses or operator routes", async () => {
    const h = await startApi();
    try {
      const agent = await h.register("cors-check");
      for (const path of ["/api/v1/casebook", "/api/v1/jurisdictions", "/llms.txt", "/skill.md", "/"]) {
        expect((await h.get(path)).headers.get("access-control-allow-origin"), path).toBe("*");
      }
      const closed = [
        await h.get("/api/v1/agents/me", { apiKey: agent.apiKey }),
        await h.get("/api/v1/agents/me/tasks", { apiKey: agent.apiKey }),
        await h.get("/api/v1/summonses/SMN-0000000000"),
        await h.get("/summons/SMN-0000000000"),
        await h.post("/api/v1/agents", { handle: "cors-write" }),
        await h.post("/api/v1/admin/tick", {}, { admin: true }),
      ];
      for (const res of closed) expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("sends API-Version: 1 on every /api/ response, errors included, and not on pages", async () => {
    const h = await startApi();
    try {
      expect((await h.get("/api/v1")).headers.get("api-version")).toBe("1");
      expect((await h.get("/api/v1/nope")).headers.get("api-version")).toBe("1");
      expect((await h.get("/join")).headers.get("api-version")).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("gives every error a hint and a link to the docs", async () => {
    for (const [code, spec] of Object.entries(ERROR_CATALOGUE))
      expect(spec.hint.length, code).toBeGreaterThan(10);
    const h = await startApi();
    try {
      const res = await h.get("/api/v1/nope");
      expect(res.status).toBe(404);
      expect(res.body.error.hint).toBe(ERROR_CATALOGUE.NOT_FOUND.hint);
      expect(res.body.error.docs).toBe("/skill.md#10-errors");
    } finally {
      await h.close();
    }
  });
});

describe("the skill warns about fakes", () => {
  it("in skill.md and in the installable skill", () => {
    const installable = readFileSync(
      join(import.meta.dirname, "..", "..", "skills", "musecourt", "SKILL.md"),
      "utf8",
    );
    for (const text of [loadSkillMarkdown(), installable]) {
      expect(text).toContain(OFFICIAL);
      expect(text).toContain("MuseCourt never DMs first and never sends a claim link.");
    }
  });
});
