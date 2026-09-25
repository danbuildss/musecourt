import type { Clock } from "@/core/clock";
import type { Court } from "@/court/court";
import type { ReadModels } from "@/court/read-models/types";
import type { CourtClock } from "@/court/court-clock";
import { authenticateAdmin, authenticateAgent, authenticateCron, type Principal } from "./auth";
import { ApiError, toErrorBody } from "./errors";
import { DEFAULT_MAX_BODY_BYTES, errorResponse, json, readJsonBody, requestFingerprint } from "./http";
import type { RateLimiter } from "./rate-limit";
import { routes, type Route, type RouteResult } from "./routes";
import { MCP_PATH, handleMcpHttp } from "@/mcp/server";
import { assertIdempotencyKey, runIdempotent } from "./services";
import type { CredentialStore, IdempotencyRecord, IdempotencyStore } from "./stores";

export interface ApiDeps {
  court: Court;
  readModels: ReadModels;
  credentials: CredentialStore;
  idempotency: IdempotencyStore;
  clock: Clock;
  rebuildReadModels: () => Promise<void>;
  /** The court clock, run by the internal cron route and the admin tick. */
  courtClock: CourtClock;
  /** The agent skill document served at /skill.md. */
  skillMarkdown?: string;
  /** Secret for the internal cron route only (≥ 32 chars). Never the admin token. */
  cronSecret?: string;
  /** Secret for admin endpoints (≥ 32 chars). Admin routes are disabled without it. */
  adminToken?: string;
  /** Applied to public registration, keyed by client IP. */
  registrationLimiter?: RateLimiter;
  /** Use the first X-Forwarded-For address as the client IP (only behind a trusted proxy). */
  trustProxy?: boolean;
  maxBodyBytes?: number;
  /** How long a duplicate request waits for the original to finish. */
  idempotencyWaitMs?: number;
  /** An IN_PROGRESS claim older than this is considered abandoned. */
  idempotencyStaleMs?: number;
  /** Receives unexpected errors (never sent to clients). */
  onInternalError?: (error: unknown) => void;
}

export interface RequestInfo {
  clientIp?: string;
}

export interface MuseCourtApi {
  fetch(request: Request, info?: RequestInfo): Promise<Response>;
}

export { IDEMPOTENCY_KEY_PATTERN } from "./services";

interface Match {
  route: Route;
  params: Record<string, string>;
}

function match(method: string, pathname: string): Match | "METHOD_NOT_ALLOWED" | null {
  const segments = pathname.replace(/\/+$/, "").split("/");
  let methodMismatch = false;
  for (const route of routes) {
    const pattern = route.path.split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const p = pattern[i]!;
      const s = segments[i]!;
      if (p.startsWith(":")) {
        try {
          params[p.slice(1)] = decodeURIComponent(s);
        } catch {
          ok = false;
        }
      } else if (p !== s) ok = false;
      if (!ok) break;
    }
    if (!ok) continue;
    if (route.method !== method) {
      methodMismatch = true;
      continue;
    }
    return { route, params };
  }
  return methodMismatch ? "METHOD_NOT_ALLOWED" : null;
}

export function createApi(deps: ApiDeps): MuseCourtApi {
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const clientIpOf = (request: Request, info?: RequestInfo) => {
    if (deps.trustProxy) {
      const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    return info?.clientIp ?? "unknown";
  };

  const toResponse = (result: RouteResult | Response): Response =>
    result instanceof Response ? result : json(result.status, result.body, result.headers);

  async function execute(route: Route, ctx: Parameters<Route["handle"]>[0]) {
    try {
      const result = await route.handle(ctx);
      if (result instanceof Response)
        return { response: result, status: result.status, body: null, code: undefined };
      return { response: toResponse(result), status: result.status, body: result.body, code: undefined };
    } catch (error) {
      const { status, body } = toErrorBody(error);
      if (body.error.code === "INTERNAL_ERROR" || body.error.code === "INVARIANT_VIOLATION")
        deps.onInternalError?.(error);
      return { response: errorResponse(error), status, body, code: body.error.code };
    }
  }

  const replay = (record: IdempotencyRecord) =>
    json(record.responseStatus!, record.responseBody, { "idempotent-replayed": "true" });

  return {
    async fetch(request, info) {
      try {
        const url = new URL(request.url);
        if (url.pathname.replace(/\/+$/, "") === MCP_PATH) {
          return await handleMcpHttp(deps, request, clientIpOf(request, info), maxBodyBytes);
        }
        const found = match(request.method, url.pathname);
        if (found === "METHOD_NOT_ALLOWED")
          throw new ApiError("METHOD_NOT_ALLOWED", `${request.method} is not allowed here.`);
        if (!found) throw new ApiError("NOT_FOUND", `No route for ${url.pathname}.`);
        const { route, params } = found;
        const now = deps.clock.now();
        const clientIp = clientIpOf(request, info);

        let principal: Principal | null = null;
        if (route.auth === "agent") {
          principal = await authenticateAgent(request, deps.credentials, now, async (agentId) =>
            Boolean(await deps.readModels.getAgent(agentId)),
          );
        }
        if (route.auth === "admin") principal = authenticateAdmin(request, deps.adminToken);
        if (route.auth === "cron") principal = authenticateCron(request, deps.cronSecret);

        if (
          route.rateLimited &&
          deps.registrationLimiter &&
          !deps.registrationLimiter.hit(`register:${clientIp}`, now)
        ) {
          throw new ApiError("RATE_LIMITED", "Too many registrations from this address. Retry later.");
        }

        const body =
          route.method === "POST" && !route.bodyless ? await readJsonBody(request, maxBodyBytes) : undefined;
        const ctx = { request, url, params, body, principal, deps, now, clientIp };

        // Reads, and the self-idempotent clock, skip the Idempotency-Key machinery.
        if (route.method !== "POST" || route.selfIdempotent) return toResponse(await route.handle(ctx));

        // ---- Idempotent write ----
        const key = request.headers.get("idempotency-key");
        if (!key)
          throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", "POST requests need an Idempotency-Key header.");
        assertIdempotencyKey(key, "Idempotency-Key");
        const scope =
          principal?.kind === "agent" ? `agent:${principal.agentId}` : (principal?.kind ?? "public");
        return await runIdempotent(deps, {
          scope,
          key,
          fingerprint: requestFingerprint(request.method, url.pathname, body),
          now,
          execute: async () => {
            const outcome = await execute(route, ctx);
            const stored = route.redactForStorage ? route.redactForStorage(outcome.body) : outcome.body;
            return { result: outcome.response, status: outcome.status, body: stored, code: outcome.code };
          },
          replay: async (record) => (await route.onReplay?.(ctx, record, scope)) ?? replay(record),
        });
      } catch (error) {
        const { body } = toErrorBody(error);
        if (body.error.code === "INTERNAL_ERROR") deps.onInternalError?.(error);
        return errorResponse(error);
      }
    },
  };
}
