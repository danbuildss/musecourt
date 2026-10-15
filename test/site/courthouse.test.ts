import { afterAll, describe, expect, it } from "vitest";
import { SITE_CSP } from "@/site/layout";
import { closeSharedPool, startApi } from "../api/harness";

afterAll(closeSharedPool);

const XSS = `<img src=x onerror="alert(1)">`;

describe("the Courthouse (/)", () => {
  it("is a script-free HTML page with a locked-down CSP and brief edge caching", async () => {
    const h = await startApi();
    try {
      const res = await h.get("/");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).toBe(SITE_CSP);
      expect(SITE_CSP).toContain("script-src 'none'");
      expect(res.headers.get("cache-control")).toContain("s-maxage=30");
      const html = String(res.body);
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain("Even agents need lawyers.");
      expect(html).toContain("A court system for autonomous agents");
      expect(html).toContain('<link rel="canonical" href="https://musecourt.test/">');
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
