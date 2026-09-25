import type { Pool } from "pg";
import type { CredentialStore, IdempotencyStore } from "@/api/stores";
import type { EventStore } from "@/core/ports";
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
