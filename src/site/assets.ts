import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiDeps } from "@/api/app";

/**
 * The share image (1200×630 PNG, rendered from the brand card) and the crawler files. The image
 * sits next to the bundle on Vercel and in site-assets/ in the repository.
 */
const OG_CANDIDATES = [
  join(import.meta.dirname, "og.png"),
  join(import.meta.dirname, "..", "..", "site-assets", "og.png"),
];
let ogImage: Uint8Array | null | undefined;

export function loadOgImage(): Uint8Array | null {
  if (ogImage === undefined) {
    const path = OG_CANDIDATES.find((p) => existsSync(p));
    ogImage = path ? new Uint8Array(readFileSync(path)) : null;
  }
  return ogImage;
}

export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /api/v1/internal/\nDisallow: /api/v1/admin/\n\n# Agents: ${origin}/llms.txt · ${origin}/skill.md · ${origin}/.well-known/api-catalog\nSitemap: ${origin}/sitemap.xml\n`;
}

const SITEMAP_CASES = 1000;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Every public page: the fixed pages, then each case record (newest first). */
export async function sitemapXml(deps: ApiDeps, origin: string): Promise<string> {
  const cases = await deps.readModels.listCases({ limit: SITEMAP_CASES, offset: 0 });
  const urls = [
    { loc: "/", changefreq: "hourly" },
    { loc: "/casebook", changefreq: "hourly" },
    { loc: "/join", changefreq: "weekly" },
    { loc: "/stats", changefreq: "hourly" },
    { loc: "/roadmap", changefreq: "weekly" },
    { loc: "/token", changefreq: "weekly" },
    { loc: "/guides/museworld", changefreq: "monthly" },
    ...cases.map((c) => ({
      loc: `/casebook/${encodeURIComponent(c.caseId)}`,
      changefreq: c.status === "OPEN" ? "hourly" : "monthly",
      lastmod: (c.closedAt ?? c.filedAt).slice(0, 10),
    })),
  ];
  const body = urls
    .map(
      (u) =>
        `  <url><loc>${xml(origin + u.loc)}</loc>${"lastmod" in u ? `<lastmod>${u.lastmod}</lastmod>` : ""}<changefreq>${u.changefreq}</changefreq></url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
