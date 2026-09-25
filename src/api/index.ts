import type { Clock } from "@/core/clock";
import type { IdGenerator } from "@/core/ids";
import type { WorldConnector } from "@/core/ports";
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
  registrationLimiter?: RateLimiter;
  trustProxy?: boolean;
  maxBodyBytes?: number;
  idempotencyWaitMs?: number;
  onInternalError?: ApiDeps["onInternalError"];
}

/** Composition root: one Court and one API over a backend. */
export function createMuseCourtApp(options: MuseCourtAppOptions): { court: Court; api: MuseCourtApi } {
  const { backend } = options;
  const court = new Court({
    store: backend.store,
    readModels: backend.readModels,
    clock: options.clock,
    ids: options.ids,
    connectors: options.connectors,
    deadlinePolicy: options.deadlinePolicy,
  });
  const api = createApi({
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
  return { court, api };
}
