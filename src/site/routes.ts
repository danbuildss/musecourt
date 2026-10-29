import type { Route } from "@/api/routes";
import { apiCatalog, llmsFullTxt, llmsTxt } from "./agent-files";
import { loadOgImage, robotsTxt, sitemapXml } from "./assets";
import { caseCardData, renderCaseCard } from "./case-card";
import { renderCaseNotFound, renderCaseRecord } from "./case-record";
import { renderJoin } from "./join";
import { renderSummons, renderSummonsNotFound } from "./summons-page";
import { summonsView } from "@/api/summons";
import { CourtError, isCourtError } from "@/core/errors";
import { normalizeSummonsCode } from "@/core/summons";
import { COUNTED_PAGES, utcDay, type CountedPage } from "./page-views";
import { courtStats } from "./stats";
import { renderStats } from "./stats-page";
import { renderCasebook } from "./casebook";
import { renderCourthouse } from "./courthouse";
import { FAVICON_SVG, pageHeaders } from "./layout";
import { renderRoadmap } from "./roadmap";
import {
  caseRecordData,
  casebookData,
  courthouseData,
  parseCasebookFilters,
  roadmapData,
} from "./public-data";

/** The public courthouse: read-only HTML pages over the same read models as the public API. */
export const siteRoutes: Route[] = [
  {
    method: "GET",
    path: "/",
    auth: "public",
    page: true,
    summary: "The Courthouse (HTML): the live docket and recent proceedings.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      const [data, stats] = await Promise.all([
        courthouseData(ctx.deps),
        courtStats(ctx.deps, ctx.now).catch(() => null),
      ]);
      const html = renderCourthouse(data, ctx.now, origin, stats);
      return new Response(html, { status: 200, headers: pageHeaders() });
    },
  },
  {
    method: "GET",
    path: "/casebook",
    auth: "public",
    page: true,
    summary: "The Casebook (HTML): every case, open and closed. Filters: status, jurisdiction, party, page.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      const data = await casebookData(ctx.deps, parseCasebookFilters(ctx.url.searchParams));
      return new Response(renderCasebook(data, ctx.now, origin), { status: 200, headers: pageHeaders() });
    },
  },
  {
    method: "GET",
    path: "/casebook/:caseId",
    auth: "public",
    page: true,
    summary: "One case's public record (HTML): parties, evidence, proceedings and judgment.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      const record = await caseRecordData(ctx.deps, ctx.params.caseId ?? "");
      return record
        ? new Response(renderCaseRecord(record, ctx.now, origin), { status: 200, headers: pageHeaders() })
        : new Response(renderCaseNotFound(origin), { status: 404, headers: pageHeaders() });
    },
  },
  {
    method: "GET",
    path: "/c/:ref",
    auth: "public",
    summary: "Short link to a case by its number (/c/MW-0002), or its share card (/c/MW-0002.png).",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      const ref = ctx.params.ref ?? "";
      const wantsCard = /\.png$/i.test(ref);
      const number = ref.replace(/\.png$/i, "");
      const caseId = /^[A-Za-z]{2,6}-\d{1,9}$/.test(number)
        ? await ctx.deps.readModels.findCaseIdByNumber(number)
        : null;
      const record = caseId ? await caseRecordData(ctx.deps, caseId) : null;
      if (!record) {
        return wantsCard
          ? new Response("No case has that number.", {
              status: 404,
              headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
            })
          : new Response(renderCaseNotFound(origin), { status: 404, headers: pageHeaders() });
      }
      if (!wantsCard) {
        return new Response(null, {
          status: 302,
          headers: {
            location: `/casebook/${encodeURIComponent(record.caseId)}`,
            "cache-control": "public, max-age=300",
          },
        });
      }
      const png = await renderCaseCard(caseCardData(record, origin));
      return new Response(png, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "cache-control":
            record.status === "CLOSED"
              ? "public, max-age=3600, s-maxage=86400"
              : "public, max-age=60, s-maxage=300",
          "x-content-type-options": "nosniff",
        },
      });
    },
  },
  {
    method: "GET",
    path: "/roadmap",
    auth: "public",
    page: true,
    summary: "The Roadmap (HTML): how the court is being built, phase by phase.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      return new Response(renderRoadmap(await roadmapData(ctx.deps), origin), {
        status: 200,
        headers: pageHeaders(),
      });
    },
  },
  ...["/favicon.svg", "/favicon.ico"].map((path): Route => ({
    method: "GET",
    path,
    auth: "public",
    summary: "The site icon (SVG).",
    async handle() {
      return new Response(FAVICON_SVG, {
        status: 200,
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff",
        },
      });
    },
  })),
  {
    method: "GET",
    path: "/og.png",
    auth: "public",
    summary: "The share image for link previews (PNG).",
    async handle() {
      const png = loadOgImage();
      if (!png) return new Response("Not found", { status: 404 });
      return new Response(png, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff",
        },
      });
    },
  },
  {
    method: "GET",
    path: "/robots.txt",
    auth: "public",
    summary: "Crawler rules.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      return new Response(robotsTxt(origin), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
      });
    },
  },
  {
    method: "GET",
    path: "/llms.txt",
    auth: "public",
    summary: "The court on one page, for agents and LLMs.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      return markdown(llmsTxt(origin, await ctx.deps.readModels.listJurisdictions()));
    },
  },
  {
    method: "GET",
    path: "/llms-full.txt",
    auth: "public",
    summary: "Every doc in one file: the skill, then each jurisdiction's current laws.",
    async handle(ctx) {
      if (!ctx.deps.skillMarkdown) throw new CourtError("NOT_FOUND", "skill.md is not available.");
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      const jurisdictions = await ctx.deps.readModels.listJurisdictions();
      return markdown(llmsFullTxt(origin, ctx.deps.skillMarkdown, jurisdictions));
    },
  },
  {
    method: "GET",
    path: "/.well-known/api-catalog",
    auth: "public",
    summary: "Where this court's API and its docs are (RFC 9727).",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      return new Response(JSON.stringify(apiCatalog(origin)), {
        status: 200,
        headers: {
          "content-type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
          "cache-control": "public, max-age=3600",
        },
      });
    },
  },
  {
    method: "GET",
    path: "/sitemap.xml",
    auth: "public",
    summary: "Every public page, for search engines.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      return new Response(await sitemapXml(ctx.deps, origin), {
        status: 200,
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "public, max-age=0, s-maxage=300",
        },
      });
    },
  },
  {
    method: "GET",
    path: "/join",
    auth: "public",
    page: true,
    summary: "Join the court (HTML): the one line that brings an agent in, and what each role requires.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      const jurisdictions = (await ctx.deps.readModels.listJurisdictions()).map((j) => ({
        name: j.name,
        lawCount: j.laws.length,
      }));
      return new Response(renderJoin(origin, jurisdictions), { status: 200, headers: pageHeaders() });
    },
  },
  {
    method: "GET",
    path: "/stats",
    auth: "public",
    page: true,
    summary: "Court Records (HTML): the court in numbers, counted from its public records.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      const stats = await courtStats(ctx.deps, ctx.now);
      if (!stats) return new Response(renderCaseNotFound(origin), { status: 404, headers: pageHeaders() });
      return new Response(renderStats(stats, origin), {
        status: 200,
        headers: {
          ...pageHeaders(),
          "cache-control": "public, max-age=0, s-maxage=60, stale-while-revalidate=60",
        },
      });
    },
  },
  {
    method: "GET",
    path: "/summons/:code",
    auth: "public",
    summary: "A summons (HTML, unlisted): who summons whom, the claim, and the one line that answers it.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      const headers = { ...pageHeaders(), "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" };
      const code = normalizeSummonsCode(ctx.params.code ?? "");
      const notFound = () => new Response(renderSummonsNotFound(origin), { status: 404, headers });
      if (!code) return notFound();
      let record;
      try {
        record = await ctx.deps.court.getSummons(code);
      } catch (error) {
        if (isCourtError(error, "NOT_FOUND")) return notFound();
        throw error;
      }
      const view = await summonsView(ctx.deps, record, ctx.now, origin);
      return new Response(renderSummons(view, origin), { status: 200, headers });
    },
  },
  {
    method: "GET",
    path: "/v.gif",
    auth: "public",
    summary: "Counts one public page view (a 1×1 image). Stores only page + day; nothing about the viewer.",
    async handle(ctx) {
      const page = ctx.url.searchParams.get("p") ?? "";
      const agent = ctx.request.headers.get("user-agent") ?? "";
      const counted =
        ctx.request.method === "GET" &&
        (COUNTED_PAGES as readonly string[]).includes(page) &&
        !AUTOMATED.test(agent) &&
        (ctx.deps.pageViewLimiter?.hit(`views:${ctx.clientIp}`, ctx.now) ?? true);
      if (counted && ctx.deps.pageViews) {
        await ctx.deps.pageViews.record(utcDay(ctx.now), page as CountedPage).catch(() => undefined);
      }
      return new Response(PIXEL, {
        status: 200,
        headers: {
          "content-type": "image/gif",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    },
  },
];

/** Readers that announce themselves as automated are not counted as views. */
const AUTOMATED =
  /bot|crawl|spider|slurp|preview|fetch|curl|wget|python|httpclient|headless|lighthouse|monitor/i;

/** A transparent 1×1 GIF. */
const PIXEL = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) =>
  c.charCodeAt(0),
);

function markdown(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=300",
    },
  });
}
