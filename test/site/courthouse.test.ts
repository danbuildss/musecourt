import { withoutThemeScript } from "./helpers";
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { SITE_CSP, THEME_SCRIPT } from "@/site/layout";
import { CRON_SECRET, closeSharedPool, startApi } from "../api/harness";

afterAll(closeSharedPool);

const XSS = `<img src=x onerror="alert(1)">`;

describe("the Courthouse (/)", () => {
  it("is an HTML page whose only script is the theme toggle, allowed by hash, with brief edge caching", async () => {
    const h = await startApi();
    try {
      const res = await h.get("/");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).toBe(SITE_CSP);
      expect(SITE_CSP).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
      // The theme script is the only one, and the policy allows exactly it.
      const hash = createHash("sha256").update(THEME_SCRIPT).digest("base64");
      expect(SITE_CSP).toContain(`script-src 'sha256-${hash}'`);
      expect(res.headers.get("cache-control")).toContain("s-maxage=30");
      const html = String(res.body);
      expect(html).toContain('<button id="theme-toggle"');
      expect(withoutThemeScript(html)).not.toMatch(/<script/i);
      expect(html).toContain("Even agents need lawyers.");
      expect(html).toContain("A court system for autonomous agents");
      expect(html).toContain('<link rel="canonical" href="https://musecourt.test/">');
    } finally {
      await h.close();
    }
  });

  it("credits its builder in the footer of every page, opening in a new tab", async () => {
    const h = await startApi();
    try {
      for (const path of ["/", "/casebook", "/join", "/roadmap", "/stats"]) {
        const html = String((await h.get(path)).body);
        expect(html, path).toContain(
          'Built by <a href="https://somehowinternet.app" target="_blank" rel="noopener">SOMEHOW</a>',
        );
      }
    } finally {
      await h.close();
    }
  });

  it("names the official site and accounts in the footer of every page", async () => {
    const h = await startApi();
    try {
      for (const path of ["/", "/casebook", "/join", "/roadmap", "/stats"]) {
        const html = String((await h.get(path)).body);
        expect(html, path).toContain(
          '<p class="footer-official">Official: <a href="/">musecourt.xyz</a> · ' +
            '<a href="https://x.com/musecourthq" target="_blank" rel="noopener">@musecourthq</a> · ' +
            '<a href="https://x.com/danbuildss" target="_blank" rel="noopener">@danbuildss</a> (creator, SOMEHOW) on X. ' +
            'Token news comes only from these, and the one contract address lives at <a href="/token">musecourt.xyz/token</a>. ' +
            "We never DM first.</p>",
        );
      }
    } finally {
      await h.close();
    }
  });

  it("shows only real records: empty states when nothing exists", async () => {
    const h = await startApi();
    try {
      const html = String((await h.get("/")).body);
      expect(html).toContain("No proceedings are in session. The docket is clear.");
      expect(html).toContain("No case has closed yet.");
    } finally {
      await h.close();
    }
  });

  it("lists open cases on the docket and closed ones as recent proceedings, with the right stamps", async () => {
    const h = await startApi();
    try {
      const maple = await h.register("maple", "Maple");
      const nova = await h.register("nova", "Nova");
      const open = (await h.fileCase(maple, nova)).body.case;
      const withdrawn = (await h.fileCase(maple, nova)).body.case;
      await h.post(
        `/api/v1/cases/${withdrawn.caseId}/actions`,
        { action: "WITHDRAW_CASE", reason: "Settled privately." },
        { apiKey: maple.apiKey },
      );
      const html = String((await h.get("/")).body);
      const docket = html.slice(html.indexOf("The Docket"), html.indexOf("Recent proceedings"));
      const recent = html.slice(html.indexOf("Recent proceedings"), html.indexOf("How the court works"));
      expect(docket).toContain(`/casebook/${open.caseId}`);
      expect(docket).toContain("In session");
      expect(docket).toContain("Awaiting the defendant&#39;s answer");
      expect(docket).not.toContain(withdrawn.caseId);
      expect(recent).toContain(`/casebook/${withdrawn.caseId}`);
      expect(recent).toContain("Withdrawn");
      expect(recent).not.toContain("Judgment entered");
    } finally {
      await h.close();
    }
  });

  it("escapes agent-written names: they are shown, never run", async () => {
    const h = await startApi();
    try {
      const evil = await h.register("evil", XSS);
      const nova = await h.register("nova", "Nova");
      expect((await h.fileCase(evil, nova)).status).toBe(201);
      const html = String((await h.get("/")).body);
      expect(html).not.toContain(XSS);
      expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    } finally {
      await h.close();
    }
  });

  it("answers HEAD on public pages, but never lets HEAD reach a route that acts", async () => {
    const h = await startApi();
    try {
      const page = await fetch(h.baseUrl + "/", { method: "HEAD" });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toBe("");
      const cron = await fetch(h.baseUrl + "/api/v1/internal/cron/tick", {
        method: "HEAD",
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });
      expect(cron.status).toBe(405);
    } finally {
      await h.close();
    }
  });

  it("keeps the API, guide and skill routes as they were", async () => {
    const h = await startApi();
    try {
      expect((await h.get("/api/v1")).body.name).toBe("MuseCourt");
      expect((await h.get("/skill.md")).status).toBe(200);
      expect((await h.get("/guides/museworld")).status).toBe(200);
      expect((await h.get("/nope")).status).toBe(404);
    } finally {
      await h.close();
    }
  });
});
