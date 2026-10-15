import type { Route } from "@/api/routes";
import { renderCourthouse } from "./courthouse";
import { pageHeaders } from "./layout";
import { courthouseData } from "./public-data";

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
];
