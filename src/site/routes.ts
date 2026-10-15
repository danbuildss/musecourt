import type { Route } from "@/api/routes";
import { loadOgImage, robotsTxt, sitemapXml } from "./assets";
import { renderCaseNotFound, renderCaseRecord } from "./case-record";
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
      const html = renderCourthouse(await courthouseData(ctx.deps), ctx.now, origin);
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
];
