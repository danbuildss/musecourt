import { join } from "node:path";
import pg from "pg";
import { createMuseCourtApp } from "@/api";
import { DEFAULT_MAX_BODY_BYTES, errorResponse } from "@/api/http";
import { createNodeHandler } from "@/api/node-server";
import { FixedWindowRateLimiter } from "@/api/rate-limit";
import { systemClock } from "@/core/clock";
import { randomIds } from "@/core/ids";
import { createPostgresBackend } from "@/infra/backends";
import { migrate } from "@/infra/migrate";
import { MOONWAKE_JURISDICTION } from "@/seed/laws";
import { seedJurisdiction } from "@/seed/seed-court";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Vercel entry point (Build Output API, Node.js runtime). One bundled function
 * serves every route. Required env: DATABASE_URL (Supabase session pooler).
 * Optional: MUSECOURT_ADMIN_TOKEN, MUSECOURT_CRON_SECRET (admin/cron routes are
 * disabled without them).
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let ready: Promise<Handler> | null = null;

/** Vercel routes every path to this function as /api?__path=<original path>; restore it. */
export function restoreOriginalUrl(url: string): string {
  const parsed = new URL(url, "http://internal");
  const original = parsed.searchParams.get("__path");
  if (original === null) return url;
  parsed.searchParams.delete("__path");
  const query = parsed.searchParams.toString();
  return `/${original.replace(/^\/+/, "")}${query ? `?${query}` : ""}`;
}

async function init(): Promise<Handler> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  // Idempotent and lock-protected; cheap after the first cold start.
  await migrate(pool, join(import.meta.dirname, "migrations"));

  const { court, api } = createMuseCourtApp({
    backend: createPostgresBackend(pool),
    clock: systemClock,
    ids: randomIds,
    connectors: [], // Museworld connector arrives in Phase 6.
    adminToken: process.env.MUSECOURT_ADMIN_TOKEN,
    cronSecret: process.env.MUSECOURT_CRON_SECRET,
    registrationLimiter: new FixedWindowRateLimiter(20, 60 * 60 * 1000),
    trustProxy: true, // Vercel sets X-Forwarded-For.
    onInternalError: (error) => console.error("[musecourt] internal error", error),
  });
  await seedJurisdiction(court, MOONWAKE_JURISDICTION);
  return createNodeHandler(api, { maxBodyBytes: DEFAULT_MAX_BODY_BYTES, rewriteUrl: restoreOriginalUrl });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    ready ??= init().catch((error) => {
      ready = null; // retry initialisation on the next request
      throw error;
    });
    await (
      await ready
    )(req, res);
  } catch (error) {
    console.error("[musecourt] startup failed", error);
    const response = errorResponse(error);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  }
}
