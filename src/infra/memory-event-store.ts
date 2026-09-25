import { CourtError } from "@/core/errors";
import type { StoredEvent } from "@/core/events";
import type { AppendBatch, AppendOptions, EventStore } from "@/core/ports";

/** In-memory append-only store for tests and local simulations. Same contract as Postgres. */
export class MemoryEventStore implements EventStore {
  private readonly log: StoredEvent[] = [];
  private readonly streams = new Map<string, StoredEvent[]>();

  async readStream(streamId: string): Promise<StoredEvent[]> {
    return structuredClone(this.streams.get(streamId) ?? []);
  }

  async readAll(afterPosition = 0): Promise<StoredEvent[]> {
    return structuredClone(this.log.slice(afterPosition));
  }

  async append(batches: AppendBatch[], options: AppendOptions): Promise<StoredEvent[]> {
    // Validate every batch before writing anything, so the append is atomic.
    for (const batch of batches) {
      const current = this.streams.get(batch.streamId)?.length ?? 0;
      if (current !== batch.expectedVersion) {
        throw new CourtError(
          "CONCURRENCY_CONFLICT",
          `Stream ${batch.streamId} is at ${current}, expected ${batch.expectedVersion}.`,
          {
            streamId: batch.streamId,
          },
        );
      }
    }
    if (new Set(batches.map((b) => b.streamId)).size !== batches.length) {
      throw new CourtError("VALIDATION_FAILED", "A stream may appear only once per append.");
    }
    const written: StoredEvent[] = [];
    for (const batch of batches) {
      const stream = this.streams.get(batch.streamId) ?? [];
      for (const e of batch.events) {
        const stored = {
          ...structuredClone(e),
          globalPosition: this.log.length + 1,
          streamId: batch.streamId,
          streamVersion: stream.length + 1,
          actor: options.actor,
          occurredAt: options.occurredAt.toISOString(),
        } as StoredEvent;
        stream.push(stored);
        this.log.push(stored);
        written.push(stored);
      }
      this.streams.set(batch.streamId, stream);
    }
    return structuredClone(written);
  }
}
