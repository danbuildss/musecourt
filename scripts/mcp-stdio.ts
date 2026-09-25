import pg from "pg";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMuseCourtApp } from "@/api";
import { authenticateApiKey, type Principal } from "@/api/auth";
import { FixedWindowRateLimiter } from "@/api/rate-limit";
import { loadSkillMarkdown } from "@/api/skill";
import { FakeWorld } from "@/connectors/fake-world";
import { systemClock } from "@/core/clock";
import { randomIds } from "@/core/ids";
import { createMemoryBackend, createPostgresBackend } from "@/infra/backends";
import { migrate } from "@/infra/migrate";
import { createMcpServer } from "@/mcp/server";
import { seedJurisdiction } from "@/seed/seed-court";

/**
 * MuseCourt MCP server over stdio, for local agent hosts. The same court and tools as /mcp.
 *   DATABASE_URL        Postgres (otherwise in memory, like `npm run serve`)
 *   MUSECOURT_API_KEY   the agent's mc_… key; without it only public tools work
 * stdout carries the protocol, so logs go to stderr. Never commit real credentials.
 */
const url = process.env.DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url }) : null;
if (pool) await migrate(pool);
const backend = pool ? createPostgresBackend(pool) : createMemoryBackend();

const { court, deps } = createMuseCourtApp({
  backend,
  clock: systemClock,
  ids: randomIds,
  connectors: [new FakeWorld()],
  skillMarkdown: loadSkillMarkdown(),
  registrationLimiter: new FixedWindowRateLimiter(20, 60 * 60 * 1000),
  onInternalError: (error) => console.error("[musecourt] internal error", error),
});
await seedJurisdiction(court, {
  jurisdictionId: "fake",
  name: "Fake World",
  casePrefix: "FW",
  connectorId: "fake-world",
});

let principal: Principal | null = null;
const apiKey = process.env.MUSECOURT_API_KEY;
if (apiKey) {
  try {
    principal = await authenticateApiKey(apiKey, deps.credentials, systemClock.now(), async (agentId) =>
      Boolean(await deps.readModels.getAgent(agentId)),
    );
  } catch {
    console.error("[musecourt] MUSECOURT_API_KEY was not accepted; only public tools are available.");
  }
}

await createMcpServer(deps, { principal, clientIp: "stdio" }).connect(new StdioServerTransport());
console.error(`[musecourt] MCP server on stdio (${pool ? "postgres" : "in-memory"})`);
