import type { Clock } from "@/core/clock";
import type { IdGenerator } from "@/core/ids";
import type { CourtModel, WorldConnector } from "@/core/ports";
import { CourtClock } from "@/court/court-clock";
import { HouseJudgeService } from "@/court/house-judge-service";
import type { DeadlinePolicy } from "@/core/procedure";
import { Court } from "@/court/court";
import type { Backend } from "@/infra/backends";
import { createApi, type ApiDeps, type MuseCourtApi } from "./app";
import type { RateLimiter } from "./rate-limit";

export interface MuseCourtAppOptions {
  backend: Backend;
  clock: Clock;
  ids: IdGenerator;
  connectors?: WorldConnector[];
  deadlinePolicy?: DeadlinePolicy;
  adminToken?: string;
  cronSecret?: string;
  /** Model behind Solon's drafts. Without one, Solon cases wait (Phase 4 adds the Bankr adapter). */
  model?: CourtModel;
  registrationLimiter?: RateLimiter;
  trustProxy?: boolean;
  maxBodyBytes?: number;
  idempotencyWaitMs?: number;
  onInternalError?: ApiDeps["onInternalError"];
}

/** Composition root: one Court and one API over a backend. */
export function createMuseCourtApp(options: MuseCourtAppOptions): {
  court: Court;
  api: MuseCourtApi;
  courtClock: CourtClock;
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
  });
  const api = createApi({
    courtClock,
    cronSecret: options.cronSecret,
    court,
    readModels: backend.readModels,
    credentials: backend.credentials,
    idempotency: backend.idempotency,
    clock: options.clock,
    rebuildReadModels: () => backend.rebuildReadModels(),
    adminToken: options.adminToken,
    registrationLimiter: options.registrationLimiter,
    trustProxy: options.trustProxy,
    maxBodyBytes: options.maxBodyBytes,
    idempotencyWaitMs: options.idempotencyWaitMs,
    onInternalError: options.onInternalError,
  });
  return { court, api, courtClock };
}
