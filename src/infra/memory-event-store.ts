import { CourtError } from "@/core/errors";
import type { StoredEvent } from "@/core/events";
import type { AppendBatch, AppendOptions, EventStore } from "@/core/ports";

export interface MemoryEventStoreOptions {
  /**
   * Runs after events are written and before the append returns, with a reader
   * that sees them (used for read-model projection). If it throws, the append
   * is undone, mirroring the Postgres transaction.
   */
  onAppend?: (written: StoredEvent[], reader: Pick<EventStore, "readStream">) => Promise<void>;
}

/** In-memory append-only store for tests and local simulations. Same contract as Postgres. */
export class MemoryEventStore implements EventStore {
  private readonly log: StoredEvent[] = [];
  private readonly streams = new Map<string, StoredEvent[]>();
  /** Serialises appends, like the global append lock in Postgres. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: MemoryEventStoreOptions = {}) {}

  async readStream(streamId: string): Promise<StoredEvent[]> {
    return structuredClone(this.streams.get(streamId) ?? []);
  }

  async readAll(afterPosition = 0): Promise<StoredEvent[]> {
    return structuredClone(this.log.slice(afterPosition));
  }

  append(batches: AppendBatch[], options: AppendOptions): Promise<StoredEvent[]> {
    const run = this.tail.then(() => this.appendNow(batches, options));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async appendNow(batches: AppendBatch[], options: AppendOptions): Promise<StoredEvent[]> {
    if (new Set(batches.map((b) => b.streamId)).size !== batches.length) {
      throw new CourtError("VALIDATION_FAILED", "A stream may appear only once per append.");
    }
    // Validate every batch before writing anything, so the append is atomic.
    for (const batch of batches) {
      const current = this.streams.get(batch.streamId)?.length ?? 0;
      if (current !== batch.expectedVersion) {
        throw new CourtError(
          "CONCURRENCY_CONFLICT",
          `Stream ${batch.streamId} is at ${current}, expected ${batch.expectedVersion}.`,
          { streamId: batch.streamId },
        );
      }
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
    try {
      await this.options.onAppend?.(structuredClone(written), this);
    } catch (error) {
      this.undo(written);
      throw error;
    }
    return structuredClone(written);
  }

  private undo(written: StoredEvent[]): void {
    this.log.splice(this.log.length - written.length, written.length);
    for (const e of written) {
      const stream = this.streams.get(e.streamId)!;
      stream.pop();
      if (stream.length === 0) this.streams.delete(e.streamId);
    }
  }
}
