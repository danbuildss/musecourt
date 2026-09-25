import type { Pool, PoolClient } from "pg";
import type { Actor } from "@/core/actor";
import { CourtError } from "@/core/errors";
import type { CourtEvent, StoredEvent } from "@/core/events";
import type { AppendBatch, AppendOptions, EventStore } from "@/core/ports";

interface EventRow {
  global_position: string;
  stream_id: string;
  stream_version: number;
  event_type: string;
  data: CourtEvent["data"];
  actor: Actor;
  occurred_at: Date;
}

const SELECT = `SELECT global_position, stream_id, stream_version, event_type, data, actor, occurred_at
                FROM musecourt.court_events`;

function toStored(row: EventRow): StoredEvent {
  return {
    type: row.event_type,
    data: row.data,
    globalPosition: Number(row.global_position),
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    actor: row.actor,
    occurredAt: row.occurred_at.toISOString(),
  } as StoredEvent;
}

const UNIQUE_VIOLATION = "23505";

/** Postgres event store. Optimistic concurrency per stream; multi-stream appends share one transaction. */
export class PostgresEventStore implements EventStore {
  constructor(private readonly pool: Pool) {}

  async readStream(streamId: string): Promise<StoredEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      `${SELECT} WHERE stream_id = $1 ORDER BY stream_version`,
      [streamId],
    );
    return rows.map(toStored);
  }

  async readAll(afterPosition = 0): Promise<StoredEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      `${SELECT} WHERE global_position > $1 ORDER BY global_position`,
      [afterPosition],
    );
    return rows.map(toStored);
  }

  async append(batches: AppendBatch[], options: AppendOptions): Promise<StoredEvent[]> {
    if (new Set(batches.map((b) => b.streamId)).size !== batches.length) {
      throw new CourtError("VALIDATION_FAILED", "A stream may appear only once per append.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One writer at a time: global positions then commit in order, so readers following
      // readAll(afterPosition) can never skip an event that commits late. Fine at V1 volume.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('musecourt_append'))");
      const written: StoredEvent[] = [];
      for (const batch of batches) {
        written.push(...(await this.appendBatch(client, batch, options)));
      }
      await client.query("COMMIT");
      return written.sort((a, b) => a.globalPosition - b.globalPosition);
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new CourtError("CONCURRENCY_CONFLICT", "Another command changed this record first. Retry.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async appendBatch(
    client: PoolClient,
    batch: AppendBatch,
    options: AppendOptions,
  ): Promise<StoredEvent[]> {
    const { rows } = await client.query<{ version: number }>(
      "SELECT COALESCE(MAX(stream_version), 0)::int AS version FROM musecourt.court_events WHERE stream_id = $1",
      [batch.streamId],
    );
    const current = rows[0]!.version;
    if (current !== batch.expectedVersion) {
      throw new CourtError(
        "CONCURRENCY_CONFLICT",
        `Stream ${batch.streamId} is at ${current}, expected ${batch.expectedVersion}.`,
        {
          streamId: batch.streamId,
        },
      );
    }
    const written: StoredEvent[] = [];
    let version = current;
    for (const e of batch.events) {
      version += 1;
      const result = await client.query<EventRow>(
        `INSERT INTO musecourt.court_events (stream_id, stream_version, event_type, data, actor, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING global_position, stream_id, stream_version, event_type, data, actor, occurred_at`,
        [
          batch.streamId,
          version,
          e.type,
          JSON.stringify(e.data),
          JSON.stringify(options.actor),
          options.occurredAt,
        ],
      );
      written.push(toStored(result.rows[0]!));
    }
    return written;
  }
}
