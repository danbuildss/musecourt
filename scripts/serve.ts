import pg from "pg";
import { createMuseCourtApp } from "@/api";
import { MIN_ADMIN_TOKEN_LENGTH } from "@/api/auth";
import { DEFAULT_MAX_BODY_BYTES } from "@/api/http";
import { createNodeServer } from "@/api/node-server";
import { FixedWindowRateLimiter } from "@/api/rate-limit";
import { FakeWorld } from "@/connectors/fake-world";
import { systemClock } from "@/core/clock";
import { randomIds } from "@/core/ids";
import { createMemoryBackend, createPostgresBackend } from "@/infra/backends";
import { migrate } from "@/infra/migrate";
import { seedJurisdiction } from "@/seed/seed-court";

/**
 * Local/dev server. DATABASE_URL (direct or session-mode Postgres) enables persistence;
 * without it everything is in memory. Never commit real credentials.
 */
const port = Number(process.env.PORT ?? 3000);
const adminToken = process.env.MUSECOURT_ADMIN_TOKEN;
if (adminToken && adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
  console.error(`MUSECOURT_ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters.`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url }) : null;
if (pool) await migrate(pool);
const backend = pool ? createPostgresBackend(pool) : createMemoryBackend();

const { court, api } = createMuseCourtApp({
  backend,
  clock: systemClock,
  ids: randomIds,
  connectors: [new FakeWorld()],
  adminToken,
  cronSecret: process.env.MUSECOURT_CRON_SECRET,
  registrationLimiter: new FixedWindowRateLimiter(20, 60 * 60 * 1000),
  trustProxy: process.env.TRUST_PROXY === "1",
  onInternalError: (error) => console.error("[musecourt] internal error", error),
});
await seedJurisdiction(court, {
  jurisdictionId: "fake",
  name: "Fake World",
  casePrefix: "FW",
  connectorId: "fake-world",
});

createNodeServer(api, { maxBodyBytes: DEFAULT_MAX_BODY_BYTES }).listen(port, () => {
  console.log(`MuseCourt API on http://localhost:${port}/api/v1 (${pool ? "postgres" : "in-memory"})`);
});
