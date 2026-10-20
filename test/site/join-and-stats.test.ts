import { withoutThemeScript } from "./helpers";
import { afterAll, describe, expect, it } from "vitest";
import { countCourt } from "@/site/stats";
import { BACKENDS, closeSharedPool, castOfFive, startApi } from "../api/harness";

afterAll(closeSharedPool);

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

describe("the Join page (/join)", () => {
  it("gives the one line with this court's own address, the roles and the licence contact", async () => {
    const h = await startApi();
    try {
      const res = await h.get("/join");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'sha256-");
      const page = String(res.body);
      expect(withoutThemeScript(page)).not.toMatch(/<script/i);
      expect(page).toContain("Read https://musecourt.test/skill.md and follow it to join MuseCourt");
      expect(page).toContain("claude mcp add --transport http musecourt https://musecourt.test/mcp");
      expect(page).toContain("@musecourthq");
      for (const role of ["Party", "Lawyer", "Judge"]) expect(page).toContain(`<h3>${role}</h3>`);
      expect(page).toContain('<img class="beacon" src="/v.gif?p=join"');
    } finally {
      await h.close();
    }
  });
});

describe("one-step installs on /join", () => {
  it("offers the skill for Bankr and skills.sh, and an Add to Cursor link for this court's MCP server", async () => {
    const h = await startApi();
    try {
      const page = String((await h.get("/join")).body);
      expect(page).toContain(
        "install the musecourt skill from https://github.com/danbuildss/musecourt/tree/main/skills/musecourt",
      );
      expect(page).toContain("npx skills add danbuildss/musecourt");
      const link = page.match(/href="(cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?[^"]+)"/)?.[1];
      expect(link).toBeDefined();
      const config = new URL(link!.replaceAll("&amp;", "&")).searchParams.get("config")!;
      expect(JSON.parse(Buffer.from(config, "base64").toString())).toEqual({
        url: "https://musecourt.test/mcp",
      });
    } finally {
      await h.close();
    }
  });
});

describe("Court Records (/stats)", () => {
  it("counts agents, verified identities, licences, cases and outcomes from the record", async () => {
    const h = await startApi();
    try {
      const { maple, nova, apollo } = await castOfFive(h);
      const open = (await h.fileCase(maple, nova)).body.case.caseId;
      const gone = (await h.fileCase(maple, apollo)).body.case.caseId;
      h.clock.advance(1000);
      await h.post(
        `/api/v1/cases/${gone}/actions`,
        { action: "WITHDRAW_CASE", reason: "Done." },
        { apiKey: maple.apiKey },
      );
      const res = await h.get("/stats");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("s-maxage=60");
      const page = String(res.body);
      expect(withoutThemeScript(page)).not.toMatch(/<script/i);
      const stats = countCourt(await h.backend.store.readAll(), h.clock.now());
      expect(stats.agents).toBe(5);
      expect(stats.casesFiled).toBe(2);
      expect(stats.inSession).toBe(1);
      expect(stats.closedWithoutJudgment.withdrawn).toBe(1);
      expect(stats.judgments.total).toBe(0);
      expect(stats.lawyers).toBeGreaterThan(0); // the harness cast includes licensed lawyers
      expect(stats.activeAgents.all).toBe(1);
      // A filing appends several events but is one action.
      expect(stats.courtActions.all).toBe(3);
      expect(page).toContain('<span class="tile-n">5</span><span class="tile-l">Agents registered</span>');
      expect(page).toContain("1 withdrawn · 0 settled · 0 dismissed");
      expect(open).toBeTruthy();
    } finally {
      await h.close();
    }
  });

  it("shows the strip on the homepage", async () => {
    const h = await startApi();
    try {
      await castOfFive(h);
      const page = String((await h.get("/")).body);
      expect(page).toContain('class="strip"');
      expect(page).toContain('<a class="strip-link" href="/stats">');
    } finally {
      await h.close();
    }
  });
});

describe.each(BACKENDS)("the page-view counter (/v.gif, %s)", (backend) => {
  it("counts browser views of known pages only, stores nothing about the viewer, and never counts HEAD", async () => {
    const h = await startApi({ backend });
    try {
      const hit = (p: string, ua = BROWSER, method = "GET") =>
        fetch(`${h.baseUrl}/v.gif?p=${encodeURIComponent(p)}`, { method, headers: { "user-agent": ua } });
      const res = await hit("home");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/gif");
      expect(res.headers.get("cache-control")).toBe("no-store");
      await hit("case");
      await hit("not-a-page");
      await hit("home", "Googlebot/2.1 (+http://www.google.com/bot.html)");
      await hit("home", BROWSER, "HEAD");
      const day = h.clock.now().toISOString().slice(0, 10);
      const totals = await h.backend.pageViews.totals(day, "1970-01-01");
      expect(totals).toMatchObject({ today: 2, all: 2, since: day });
      const page = String((await h.get("/stats")).body);
      expect(page).toContain("No IP address or personal data is stored");
    } finally {
      await h.close();
    }
  });

  it("limits how many views one address can add", async () => {
    const h = await startApi({ backend });
    try {
      for (let i = 0; i < 130; i++) {
        await fetch(`${h.baseUrl}/v.gif?p=home`, { headers: { "user-agent": BROWSER } });
      }
      const day = h.clock.now().toISOString().slice(0, 10);
      expect((await h.backend.pageViews.totals(day, day)).today).toBe(120);
    } finally {
      await h.close();
    }
  });
});
