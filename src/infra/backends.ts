import type { Pool } from "pg";
import type { CredentialStore, IdempotencyStore } from "@/api/stores";
import type { EventStore } from "@/core/ports";
import type { ClockLease } from "@/court/court-clock";
import { projectEvents, rebuildFromLog } from "@/court/read-models/projector";
import type { ReadModels } from "@/court/read-models/types";
import { MemoryCredentialStore, MemoryIdempotencyStore } from "./memory-auth-stores";
import { MemoryEventStore } from "./memory-event-store";
import { MemoryReadModels } from "./memory-read-models";
import { PostgresCredentialStore, PostgresIdempotencyStore } from "./postgres-auth-stores";
import { PostgresEventStore, readStreamWith } from "./postgres-event-store";
import { PostgresReadModelWriter, PostgresReadModels } from "./postgres-read-models";

/** Everything the court and API persist, wired so read models update with every append. */
export interface Backend {
  store: EventStore;
  readModels: ReadModels;
  credentials: CredentialStore;
  idempotency: IdempotencyStore;
  /** Best-effort lease so overlapping clock runs don't duplicate work. */
  clockLease: ClockLease;
  /** Drops all read models and rebuilds them from the event log. */
  rebuildReadModels(): Promise<void>;
  /** Snapshot of all read-model rows (consistency tests). */
  dumpReadModels(): Promise<unknown>;
}

export function createMemoryBackend(): Backend & { credentials: MemoryCredentialStore } {
  const readModels = new MemoryReadModels();
  const store = new MemoryEventStore({
    onAppend: (written, reader) => projectEvents(written, reader, readModels),
  });
  return {
    store,
    readModels,
    credentials: new MemoryCredentialStore(),
    idempotency: new MemoryIdempotencyStore(),
    clockLease: memoryLease(),
    rebuildReadModels: async () => rebuildFromLog(await store.readAll(), readModels),
    dumpReadModels: async () => readModels.dump(),
  };
}

export function createPostgresBackend(pool: Pool): Backend {
  const store = new PostgresEventStore(pool, {
    onAppend: (written, client) =>
      projectEvents(
        written,
        { readStream: (id) => readStreamWith(client, id) },
        new PostgresReadModelWriter(client),
      ),
  });
  const readModels = new PostgresReadModels(pool);
  return {
    store,
    readModels,
    credentials: new PostgresCredentialStore(pool),
    idempotency: new PostgresIdempotencyStore(pool),
    clockLease: postgresLease(pool),
    async rebuildReadModels() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Block appends while rebuilding so the result matches the log exactly.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('musecourt_append'))");
        const all = await store.readAll();
        await rebuildFromLog(all, new PostgresReadModelWriter(client));
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    dumpReadModels: () => readModels.dump(),
  };
}

function memoryLease(): ClockLease {
  let held = false;
  return {
    async tryAcquire() {
      if (held) return null;
      held = true;
      return async () => {
        held = false;
      };
    },
  };
}

/** Session advisory lock on a dedicated connection; released explicitly or when the connection dies. */
function postgresLease(pool: Pool): ClockLease {
  return {
    async tryAcquire() {
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ ok: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext('musecourt_clock')) AS ok",
        );
        if (!rows[0]?.ok) {
          client.release();
          return null;
        }
      } catch (error) {
        client.release();
        throw error;
      }
      return async () => {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtext('musecourt_clock'))");
        } finally {
          client.release();
        }
      };
    },
  };
}
