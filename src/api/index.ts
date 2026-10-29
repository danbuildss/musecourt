import type { Clock } from "@/core/clock";
import type { IdGenerator } from "@/core/ids";
import type { CourtModel, WorldConnector } from "@/core/ports";
import { CourtClock } from "@/court/court-clock";
import { HouseJudgeService } from "@/court/house-judge-service";
import { WorldEvidenceSweep } from "@/court/world-recheck";
import type { DeadlinePolicy } from "@/core/procedure";
import { Court } from "@/court/court";
import type { Backend } from "@/infra/backends";
import { createApi, type ApiDeps, type MuseCourtApi } from "./app";
import type { GuideName } from "./guides";
import { warningForClockFailure } from "./ops";
import { FixedWindowRateLimiter, type RateLimiter } from "./rate-limit";

export interface MuseCourtAppOptions {
  backend: Backend;
  clock: Clock;
  ids: IdGenerator;
  connectors?: WorldConnector[];
  deadlinePolicy?: DeadlinePolicy;
  adminToken?: string;
  cronSecret?: string;
  skillMarkdown?: string;
  guides?: Partial<Record<GuideName, string>>;
  /** Model behind Solon's drafts. Without one, Solon cases wait (Phase 4 adds the Bankr adapter). */
  model?: CourtModel;
  registrationLimiter?: RateLimiter;
  trustProxy?: boolean;
  maxBodyBytes?: number;
  idempotencyWaitMs?: number;
  onInternalError?: ApiDeps["onInternalError"];
  onWarning?: ApiDeps["onWarning"];
  /** MuseCourt's exact public origin; required to link world identities. */
  publicOrigin?: string;
  /** Send page visits on other hosts to `publicOrigin` (production only). */
  redirectPagesToOrigin?: boolean;
}

/** Composition root: one Court and one API over a backend. */
export function createMuseCourtApp(options: MuseCourtAppOptions): {
  court: Court;
  api: MuseCourtApi;
  courtClock: CourtClock;
  /** The dependencies behind both interfaces (REST routes and MCP tools). */
  deps: ApiDeps;
} {
  const { backend } = options;
  const court = new Court({
    store: backend.store,
    readModels: backend.readModels,
    clock: options.clock,
    ids: options.ids,
    connectors: options.connectors,
    deadlinePolicy: options.deadlinePolicy,
  });
  const courtClock = new CourtClock({
    court,
    readModels: backend.readModels,
    clock: options.clock,
    houseJudge: options.model ? new HouseJudgeService(court, options.model, backend.readModels) : undefined,
    lease: backend.clockLease,
    solonAttempts: backend.solonAttempts,
    onFailure: (failure) => options.onWarning?.(warningForClockFailure(failure)),
    worldRecheck: new WorldEvidenceSweep({
      court,
      readModels: backend.readModels,
      log: backend.worldRechecks,
      clock: options.clock,
    }),
  });
  const deps: ApiDeps = {
    courtClock,
    cronSecret: options.cronSecret,
    skillMarkdown: options.skillMarkdown,
    guides: options.guides,
    court,
    readModels: backend.readModels,
    credentials: backend.credentials,
    idempotency: backend.idempotency,
    worldChallenges: backend.worldChallenges,
    walletChallenges: backend.walletChallenges,
    walletChallengeLimiter: new FixedWindowRateLimiter(120, 60 * 60 * 1000),
    publicOrigin: options.publicOrigin,
    redirectPagesToOrigin: options.redirectPagesToOrigin,
    clock: options.clock,
    rebuildReadModels: () => backend.rebuildReadModels(),
    adminToken: options.adminToken,
    registrationLimiter: options.registrationLimiter,
    trustProxy: options.trustProxy,
    maxBodyBytes: options.maxBodyBytes,
    idempotencyWaitMs: options.idempotencyWaitMs,
    onInternalError: options.onInternalError,
    onWarning: options.onWarning,
    eventLog: backend.store,
    pageViews: backend.pageViews,
    pageViewLimiter: new FixedWindowRateLimiter(120, 60 * 60 * 1000),
  };
  return { court, api: createApi(deps), courtClock, deps };
}
