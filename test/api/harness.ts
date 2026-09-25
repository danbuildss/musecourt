import type { AddressInfo } from "node:net";
import pg from "pg";
import { createMuseCourtApp } from "@/api";
import { DEFAULT_MAX_BODY_BYTES } from "@/api/http";
import { createNodeServer } from "@/api/node-server";
import { loadSkillMarkdown } from "@/api/skill";
import type { RateLimiter } from "@/api/rate-limit";
import { FakeWorld } from "@/connectors/fake-world";
import type { CourtModel } from "@/core/ports";
import type { DeadlinePolicy } from "@/core/procedure";
import { createMemoryBackend, createPostgresBackend, type Backend } from "@/infra/backends";
import { migrate } from "@/infra/migrate";
import { seedJurisdiction } from "@/seed/seed-court";
import { FakeClock } from "@/testing/fake-clock";
import { SequentialIds } from "@/testing/sequential-ids";

export const ADMIN_TOKEN = "test-admin-token-0123456789abcdef-0123456789";
export const CRON_SECRET = "test-cron-secret-fedcba9876543210-fedcba9876543210";
export const JURISDICTION = "fake";

const pgUrl = process.env.TEST_DATABASE_URL;
let sharedPool: pg.Pool | null = null;

/** Backends to run API suites against: always memory, plus Postgres when TEST_DATABASE_URL is set. */
export const BACKENDS: Array<"memory" | "postgres"> = pgUrl ? ["memory", "postgres"] : ["memory"];

async function freshPostgres(): Promise<Backend> {
  sharedPool ??= new pg.Pool({ connectionString: pgUrl, max: 10 });
  await sharedPool.query("DROP SCHEMA IF EXISTS musecourt CASCADE");
  await migrate(sharedPool);
  return createPostgresBackend(sharedPool);
}

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  apiKey?: string;
  admin?: boolean | string;
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
}

export interface Agent {
  agentId: string;
  handle: string;
  apiKey: string;
}

export async function startApi(
  options: {
    backend?: "memory" | "postgres";
    policy?: DeadlinePolicy;
    registrationLimiter?: RateLimiter;
    maxBodyBytes?: number;
    world?: FakeWorld;
    breakReadModels?: boolean;
    model?: CourtModel;
    cronSecret?: string | null;
  } = {},
) {
  const backend = options.backend === "postgres" ? await freshPostgres() : createMemoryBackend();
  if (options.breakReadModels) {
    backend.readModels.listJurisdictions = async () => {
      throw new Error("secret internal detail: connection string postgres://user:pw@host");
    };
  }
  const clock = new FakeClock();
  const world = options.world ?? new FakeWorld();
  const internalErrors: unknown[] = [];
  const { court, api } = createMuseCourtApp({
    backend,
    clock,
    ids: new SequentialIds(),
    connectors: [world],
    deadlinePolicy: options.policy,
    adminToken: ADMIN_TOKEN,
    cronSecret: options.cronSecret === null ? undefined : (options.cronSecret ?? CRON_SECRET),
    model: options.model,
    skillMarkdown: loadSkillMarkdown(),
    registrationLimiter: options.registrationLimiter,
    maxBodyBytes: options.maxBodyBytes,
    idempotencyWaitMs: 3000,
    onInternalError: (e) => internalErrors.push(e),
  });
  await seedJurisdiction(court, {
    jurisdictionId: JURISDICTION,
    name: "Fake World",
    casePrefix: "FW",
    connectorId: world.id,
  });

  const server = createNodeServer(api, { maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function request<T = any>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    if (opts.admin)
      headers["x-musecourt-admin-token"] = typeof opts.admin === "string" ? opts.admin : ADMIN_TOKEN;
    let body: string | undefined;
    if (opts.rawBody !== undefined) body = opts.rawBody;
    else if (opts.body !== undefined) body = JSON.stringify(opts.body);
    if (body !== undefined && !("content-type" in headers)) headers["content-type"] = "application/json";
    if (method === "POST" && opts.idempotencyKey !== null) {
      headers["idempotency-key"] = opts.idempotencyKey ?? crypto.randomUUID();
    }
    const res = await fetch(baseUrl + path, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* HTML or empty */
    }
    return { status: res.status, headers: res.headers, body: parsed as T };
  }

  const get = <T = any>(path: string, opts?: RequestOptions) => request<T>("GET", path, opts);
  const post = <T = any>(path: string, body: unknown, opts?: RequestOptions) =>
    request<T>("POST", path, { ...opts, body });

  async function register(handle: string, displayName?: string): Promise<Agent> {
    const res = await post("/api/v1/agents", { handle, ...(displayName ? { displayName } : {}) });
    if (res.status !== 201) throw new Error(`register ${handle} failed: ${JSON.stringify(res.body)}`);
    return {
      agentId: res.body.agent.agentId,
      handle: res.body.agent.handle,
      apiKey: res.body.credential.apiKey,
    };
  }

  async function grant(agent: Agent, licence: "LAWYER" | "JUDGE") {
    const res = await post("/api/v1/admin/licences", { agent: agent.handle, licence }, { admin: true });
    if (res.status !== 201) throw new Error(`grant failed: ${JSON.stringify(res.body)}`);
  }

  const act = <T = any>(
    agent: Agent,
    caseId: string,
    action: Record<string, unknown>,
    opts: RequestOptions = {},
  ) => post<T>(`/api/v1/cases/${caseId}/actions`, action, { apiKey: agent.apiKey, ...opts });

  const tasks = async (agent: Agent) =>
    (await get("/api/v1/agents/me/tasks", { apiKey: agent.apiKey })).body as {
      tasks: any[];
      opportunities: any[];
    };

  const fileCase = (plaintiff: Agent, defendant: Agent, extra: Record<string, unknown> = {}) =>
    post(
      "/api/v1/cases",
      {
        jurisdictionId: JURISDICTION,
        defendant: defendant.handle,
        complaint: "Nova harvested timber from my plot without permission.",
        remedySought: "Return 5 timber.",
        lawIds: ["property"],
        ...extra,
      },
      { apiKey: plaintiff.apiKey },
    );

  const tick = () => post("/api/v1/admin/tick", {}, { admin: true });
  const cronTick = (method: "GET" | "POST" = "POST", secret: string = CRON_SECRET) =>
    request(method, "/api/v1/internal/cron/tick", {
      headers: { authorization: `Bearer ${secret}` },
      idempotencyKey: null,
    });

  return {
    baseUrl,
    backend,
    court,
    clock,
    world,
    internalErrors,
    request,
    get,
    post,
    register,
    grant,
    act,
    tasks,
    fileCase,
    tick,
    cronTick,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type ApiHarness = Awaited<ReturnType<typeof startApi>>;

/** The five-agent cast: two parties, two lawyers, one judge (licences seeded by the admin API). */
export async function castOfFive(h: ApiHarness) {
  const maple = await h.register("maple", "Maple");
  const nova = await h.register("nova", "Nova");
  const apollo = await h.register("apollo", "Apollo");
  const athena = await h.register("athena", "Athena");
  const sol = await h.register("sol", "Sol");
  await h.grant(apollo, "LAWYER");
  await h.grant(athena, "LAWYER");
  await h.grant(sol, "LAWYER");
  await h.grant(sol, "JUDGE");
  return { maple, nova, apollo, athena, sol };
}

export async function closeSharedPool() {
  await sharedPool?.end();
  sharedPool = null;
}
