import type { Route } from "@/api/routes";
import { loadOgImage, robotsTxt, sitemapXml } from "./assets";
import { renderCaseNotFound, renderCaseRecord } from "./case-record";
import { renderJoin } from "./join";
import { COUNTED_PAGES, utcDay, type CountedPage } from "./page-views";
import { courtStats } from "./stats";
import { renderStats } from "./stats-page";
import { renderCasebook } from "./casebook";
import { renderCourthouse } from "./courthouse";
import { pageHeaders } from "./layout";
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
    path: "/roadmap",
    auth: "public",
    summary: "The Roadmap (HTML): how the court is being built, phase by phase.",
    async handle(ctx) {
      const origin = ctx.deps.publicOrigin ?? ctx.url.origin;
      return new Response(renderRoadmap(await roadmapData(ctx.deps), origin), {
        status: 200,
        headers: pageHeaders(),
      });
    },
  },
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
