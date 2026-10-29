import { withoutThemeScript } from "./helpers";
import { afterAll, describe, expect, it } from "vitest";
import { MuseworldConnector } from "@/connectors/museworld";
import type { FakeClock } from "@/testing/fake-clock";
import { ISLAND, fakeIsland } from "../connectors/fake-island";
import { castOfFive, closeSharedPool, startApi, type Agent, type ApiHarness } from "../api/harness";

afterAll(closeSharedPool);

const html = async (h: ApiHarness, path: string) => String((await h.get(path)).body);

describe("the Roadmap (/roadmap)", () => {
  it("lists the finished phases with their dates and the future ones without any", async () => {
    const h = await startApi();
    try {
      const res = await h.get("/roadmap");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'sha256-");
      const page = String(res.body);
      expect(withoutThemeScript(page)).not.toMatch(/<script/i);
      for (const title of [
        "Foundations",
        "The agent skill",
        "Real-world integration",
        "Bar &amp; Bench",
        "More worlds",
      ]) {
        expect(page).toContain(title);
      }
      expect(page).toContain("25 Sep 2026");
      expect(page).toContain("10 Oct 2026 · ongoing");
      expect(page).toContain("The Open Court and real court time");
      expect(page).toContain("The court is open to any agent.");
      const ahead = page.slice(page.indexOf("Bar &amp; Bench"));
      expect(ahead).not.toMatch(/\d{1,2} [A-Z][a-z]{2} 20\d\d/); // no promised dates
      expect(page).toContain("Every record on this site is real, and practice cases say so.");
    } finally {
      await h.close();
    }
  });

  it("marks the first Muse-v-Muse proceeding as next until two world-linked agents have a case", async () => {
    const h = await startApi();
    try {
      const { maple, nova } = await castOfFive(h);
      const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
      const page = await html(h, "/roadmap");
      const milestone = page.slice(page.indexOf("First proceeding between two Museworld Muses"));
      expect(milestone.slice(0, 300)).toContain("Next");
      expect(page).toContain(`Latest proceeding: <a href="/casebook/${caseId}">`);
    } finally {
      await h.close();
    }
  });

  it("links the first case between two world-linked agents, with its live stamp", async () => {
    let clock: FakeClock | undefined;
    const island = await fakeIsland(() => clock!.now());
    const h = await startApi({
      connectors: (c) => {
        clock = c;
        return [new MuseworldConnector({ baseUrl: ISLAND, fetch: island.fetch, now: () => c.now() })];
      },
    });
    try {
      const link = async (agent: Agent, sub: string) => {
        const nonce = (
          await h.post(
            "/api/v1/agents/me/world-identity/challenge",
            { connectorId: "museworld" },
            { apiKey: agent.apiKey },
          )
        ).body.challenge.nonce;
        const proof = await island.prove({ nonce, sub, muse: { id: sub, civic: null } });
        const res = await h.post(
          "/api/v1/agents/me/world-identity",
          { connectorId: "museworld", proof },
          { apiKey: agent.apiKey },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      };
      const { maple, nova, sol } = await castOfFive(h);
      await h.fileCase(maple, sol); // only one side linked below: not the milestone
      await link(maple, "11111111-aaaa-4aaa-8aaa-111111111111");
      await link(nova, "22222222-bbbb-4bbb-8bbb-222222222222");
      const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
      const page = await html(h, "/roadmap");
      expect(page).toContain(
        `The first proceeding between two Museworld Muses is in session: <a href="/casebook/${caseId}">`,
      );
    } finally {
      await h.close();
    }
  });
});

describe("share image and crawler files", () => {
  it("serves the share image every page points to", async () => {
    const h = await startApi();
    try {
      const page = await html(h, "/");
      expect(page).toContain('<meta property="og:image" content="https://musecourt.test/og.png">');
      expect(page).toContain('<meta name="twitter:card" content="summary_large_image">');
      const res = await fetch(h.baseUrl + "/og.png");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG signature
    } finally {
      await h.close();
    }
  });

  it("robots.txt allows the site, keeps crawlers off internal routes, and names the sitemap", async () => {
    const h = await startApi();
    try {
      const robots = await html(h, "/robots.txt");
      expect(robots).toContain("Allow: /");
      expect(robots).toContain("Disallow: /api/v1/internal/");
      expect(robots).toContain("Sitemap: https://musecourt.test/sitemap.xml");
    } finally {
      await h.close();
    }
  });

  it("the sitemap lists the public pages and every case record", async () => {
    const h = await startApi();
    try {
      const { maple, nova } = await castOfFive(h);
      const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
      const res = await h.get("/sitemap.xml");
      expect(res.headers.get("content-type")).toContain("application/xml");
      const xml = String(res.body);
      for (const path of ["/", "/casebook", "/roadmap", "/guides/museworld", `/casebook/${caseId}`]) {
        expect(xml).toContain(`<loc>https://musecourt.test${path}</loc>`);
      }
    } finally {
      await h.close();
    }
  });

  it("the old debug page is gone", async () => {
    const h = await startApi();
    try {
      expect((await h.get("/debug/cases/case_1")).status).toBe(404);
    } finally {
      await h.close();
    }
  });
});

describe("the site icon and the page-not-found page", () => {
  it("serves the icon at /favicon.svg and /favicon.ico, and pages point at it", async () => {
    const h = await startApi();
    try {
      for (const path of ["/favicon.svg", "/favicon.ico"]) {
        const res = await h.get(path);
        expect(res.status, path).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/svg+xml");
        expect(String(res.body)).toMatch(/^<svg /);
      }
      expect(await html(h, "/")).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    } finally {
      await h.close();
    }
  });

  it("shows people a page for a mistyped address, and keeps the JSON error for agents and the API", async () => {
    const h = await startApi();
    try {
      const page = await h.request("GET", "/casebok", {
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      expect(page.status).toBe(404);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(String(page.body)).toContain("No page at this address.");
      expect(String(page.body)).toContain('<meta name="robots" content="noindex, nofollow">');
      const agent = await h.get("/casebok");
      expect(agent.status).toBe(404);
      expect(agent.body.error.code).toBe("NOT_FOUND");
      const api = await h.request("GET", "/api/v1/nope", { headers: { accept: "text/html" } });
      expect(api.body.error.code).toBe("NOT_FOUND");
    } finally {
      await h.close();
    }
  });
});
