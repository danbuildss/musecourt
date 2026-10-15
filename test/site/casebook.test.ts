import { withoutThemeScript } from "./helpers";
import { afterAll, describe, expect, it } from "vitest";
import { CASEBOOK_PAGE_SIZE, parseCasebookFilters } from "@/site/public-data";
import { closeSharedPool, startApi, type ApiHarness, type Agent } from "../api/harness";

afterAll(closeSharedPool);

async function twoCases(h: ApiHarness) {
  const maple = await h.register("maple", "Maple");
  const nova = await h.register("nova", "Nova");
  const birch = await h.register("birch", "Birch");
  const open = (await h.fileCase(maple, nova)).body.case;
  const closed = (await h.fileCase(birch, nova)).body.case;
  await h.post(
    `/api/v1/cases/${closed.caseId}/actions`,
    { action: "WITHDRAW_CASE", reason: "No longer pursued." },
    { apiKey: birch.apiKey },
  );
  return { maple, nova, birch, open, closed };
}
const html = async (h: ApiHarness, path: string) => String((await h.get(path)).body);

describe("the Casebook (/casebook)", () => {
  it("lists every case, open and closed, each with its own stamp and a link to its record", async () => {
    const h = await startApi();
    try {
      const { open, closed } = await twoCases(h);
      const res = await h.get("/casebook");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'sha256-");
      const page = String(res.body);
      expect(withoutThemeScript(page)).not.toMatch(/<script/i);
      expect(page).toContain(`/casebook/${open.caseId}`);
      expect(page).toContain(`/casebook/${closed.caseId}`);
      expect(page).toContain("Withdrawn by the plaintiff.");
      expect(page).toContain("Art. 1 Property");
      // Newest first.
      expect(page.indexOf(closed.caseId)).toBeLessThan(page.indexOf(open.caseId));
    } finally {
      await h.close();
    }
  });

  it("filters by status, party and jurisdiction, and says when a party is unknown", async () => {
    const h = await startApi();
    try {
      const { open, closed } = await twoCases(h);
      const openOnly = await html(h, "/casebook?status=open");
      expect(openOnly).toContain(open.caseId);
      expect(openOnly).not.toContain(closed.caseId);
      expect(openOnly).toContain("Clear filters");
      const closedOnly = await html(h, "/casebook?status=closed");
      expect(closedOnly).toContain(closed.caseId);
      expect(closedOnly).not.toContain(open.caseId);
      const maples = await html(h, "/casebook?party=%40Maple");
      expect(maples).toContain(open.caseId);
      expect(maples).not.toContain(closed.caseId);
      expect(await html(h, "/casebook?party=ghost")).toContain("No agent has the handle ghost.");
      expect(await html(h, "/casebook?jurisdiction=nowhere")).toContain(open.caseId); // unknown: not applied
    } finally {
      await h.close();
    }
  });

  it("pages through older cases", async () => {
    const h = await startApi();
    try {
      const a = await h.register("maple", "Maple");
      const b = await h.register("nova", "Nova");
      for (let i = 0; i <= CASEBOOK_PAGE_SIZE; i++) await h.fileCase(a, b as Agent);
      const first = await html(h, "/casebook");
      expect(first).toContain('href="/casebook?page=2" rel="next"');
      const second = await html(h, "/casebook?page=2");
      expect(second).toContain('rel="prev"');
      expect(second.match(/class="casebook-row"/g)).toHaveLength(1);
      expect(await html(h, "/casebook?page=3")).toContain("There are no older cases.");
    } finally {
      await h.close();
    }
  });

  it("never echoes hostile filter input", () => {
    const f = parseCasebookFilters(
      new URLSearchParams({ party: '"><img src=x onerror=alert(1)>', page: "-4", status: "everything" }),
    );
    expect(f).toEqual({ status: null, jurisdictionId: null, party: null, page: 1 });
  });

  it("escapes jurisdiction values it echoes back", async () => {
    const h = await startApi();
    try {
      const page = await html(h, `/casebook?jurisdiction=${encodeURIComponent('"><b>x</b>')}`);
      expect(page).not.toContain("<b>x</b>");
    } finally {
      await h.close();
    }
  });
});
