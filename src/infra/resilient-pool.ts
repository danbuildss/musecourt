import type pg from "pg";

/**
 * A database pool that rides out brief connection trouble (a busy pooler, a database restarting):
 * getting a connection is retried a few times with a short backoff. Only failures to *connect* are
 * retried. Once a query has been sent, an error is final, so a write can never run twice.
 */

/** Errors raised before any statement reached the database. */
export function isConnectError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;
  // too_many_connections, cannot_connect_now (starting up), refused or timed-out connections.
  if (e.code === "53300" || e.code === "57P03" || e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT")
    return true;
  return /timeout exceeded when trying to connect|Connection terminated due to connection timeout|remaining connection slots are reserved|too many clients/i.test(
    e.message ?? "",
  );
}

export interface RetryOptions {
  attempts?: number;
  /** Delay before retry n is baseDelayMs × 2^(n−1). */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function withRetry<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 150;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isConnectError(error)) throw error;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
}

/** Wraps `pool.connect` and `pool.query` (promise style) with connect-only retries. */
export function makeResilient<P extends Pick<pg.Pool, "connect" | "query">>(
  pool: P,
  options: RetryOptions = {},
): P {
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<pg.PoolClient>;
  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  // The pool's own query() calls connect(callback): pass those through untouched (query() retries).
  (pool as { connect: unknown }).connect = (...args: unknown[]) =>
    typeof args[0] === "function" ? connect(...args) : withRetry(() => connect(), options);
  (pool as { query: unknown }).query = (...args: unknown[]) => withRetry(() => query(...args), options);
  return pool;
}
