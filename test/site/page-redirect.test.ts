import { describe, expect, it } from "vitest";
import { createMuseCourtApp } from "@/api";
import { loadMuseworldGuide } from "@/api/guides";
import { loadSkillMarkdown } from "@/api/skill";
import { createMemoryBackend } from "@/infra/backends";
import { FakeClock } from "@/testing/fake-clock";
import { SequentialIds } from "@/testing/sequential-ids";

const ORIGIN = "https://www.musecourt.example";
const OLD = "https://musecourt.vercel.example";
const CRON_SECRET = "test-cron-secret-fedcba9876543210-fedcba9876543210";

function app(redirectPagesToOrigin: boolean) {
  return createMuseCourtApp({
    backend: createMemoryBackend(),
    clock: new FakeClock(),
    ids: new SequentialIds(),
    publicOrigin: ORIGIN,
    redirectPagesToOrigin,
    cronSecret: CRON_SECRET,
    skillMarkdown: loadSkillMarkdown(),
    museworldGuide: loadMuseworldGuide(),
  }).api;
}

describe("page visits on another host", () => {
  it("are sent to the same page on the public origin, keeping the query", async () => {
    const api = app(true);
    for (const path of [
      "/",
      "/casebook?status=open&page=2",
      "/casebook/case_123",
      "/roadmap",
      "/join",
      "/stats",
      "/guides/museworld",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await api.fetch(new Request(OLD + path, { method }));
        expect(res.status, `${method} ${path}`).toBe(308);
        expect(res.headers.get("location")).toBe(ORIGIN + path);
      }
    }
  });

  it("never redirect agents: the API, MCP, skill.md, the clock and assets answer on any host", async () => {
    const api = app(true);
    for (const path of [
      "/api/v1",
      "/api/v1/casebook",
      "/skill.md",
      "/robots.txt",
      "/sitemap.xml",
      "/v.gif?p=home",
    ]) {
      const res = await api.fetch(new Request(OLD + path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
    const mcp = await api.fetch(
      new Request(`${OLD}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(mcp.status).not.toBe(308);
    const tick = await api.fetch(
      new Request(`${OLD}/api/v1/internal/cron/tick`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    expect(tick.status).toBe(200);
  });

  it("are served as usual on the public origin itself", async () => {
    const res = await app(true).fetch(new Request(`${ORIGIN}/casebook`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>The Casebook</h1>");
  });

  it("are served as usual when redirecting is off (previews, local servers)", async () => {
    const res = await app(false).fetch(new Request(`${OLD}/casebook`));
    expect(res.status).toBe(200);
  });
});
