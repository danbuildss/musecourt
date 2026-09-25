import { isCourtError } from "@/core/errors";
import type { Clock } from "@/core/clock";
import type { Court } from "./court";
import type { HouseJudgeService } from "./house-judge-service";
import type { ReadModels } from "./read-models/types";

/**
 * Best-effort mutual exclusion between overlapping clock runs. It only avoids
 * duplicate work (e.g. two model calls for one Solon case): correctness comes
 * from per-case optimistic concurrency and the core's deadline check.
 */
export interface ClockLease {
  /** Returns a release function, or null if another run holds the lease. */
  tryAcquire(): Promise<(() => Promise<void>) | null>;
}

export interface TickSummary {
  ranAt: string;
  lease: "ACQUIRED" | "BUSY" | "NONE";
  /** Due cases looked at. */
  inspected: number;
  /** Cases whose timeout outcome was applied. */
  advanced: number;
  /** Due cases another run (or an agent) had already moved on, or that closed meanwhile. */
  skipped: number;
  failed: number;
  failures: Array<{ caseId: string; code: string }>;
  solon: { pending: number; ruled: number; failed: number; awaitingModel: number };
  /** True if more due cases remain than this run's batch size; run again. */
  moreDue: boolean;
}

export interface CourtClockDeps {
  court: Pick<Court, "expireDeadline">;
  readModels: ReadModels;
  clock: Clock;
  /** Absent until a model is configured (Phase 4); Solon cases then wait and retry at their deadline. */
  houseJudge?: Pick<HouseJudgeService, "deliberate">;
  lease?: ClockLease;
  batchSize?: number;
}

/** "Already moved on" outcomes of a race: not failures. */
const RACE_CODES = new Set(["DEADLINE_NOT_REACHED", "CASE_CLOSED", "CONCURRENCY_CONFLICT"]);

/**
 * The court clock: the only thing that advances time-dependent state.
 * Idempotent and safe to run concurrently; one failing case never blocks the rest.
 */
export class CourtClock {
  constructor(private readonly deps: CourtClockDeps) {}

  async tick(): Promise<TickSummary> {
    const now = this.deps.clock.now();
    const summary: TickSummary = {
      ranAt: now.toISOString(),
      lease: this.deps.lease ? "ACQUIRED" : "NONE",
      inspected: 0,
      advanced: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      solon: { pending: 0, ruled: 0, failed: 0, awaitingModel: 0 },
      moreDue: false,
    };

    const release = this.deps.lease ? await this.deps.lease.tryAcquire() : null;
    if (this.deps.lease && !release) return { ...summary, lease: "BUSY" };
    try {
      await this.expireDue(now, summary);
      await this.runSolon(summary);
    } finally {
      await release?.();
    }
    return summary;
  }

  private async expireDue(now: Date, summary: TickSummary): Promise<void> {
    const batch = this.deps.batchSize ?? 200;
    const due = await this.deps.readModels.dueCaseIds(now, batch + 1);
    summary.moreDue = due.length > batch;
    for (const caseId of due.slice(0, batch)) {
      summary.inspected += 1;
      try {
        await this.deps.court.expireDeadline(caseId);
        summary.advanced += 1;
      } catch (error) {
        if (isCourtError(error) && RACE_CODES.has(error.code)) {
          summary.skipped += 1;
        } else {
          summary.failed += 1;
          summary.failures.push({ caseId, code: isCourtError(error) ? error.code : "INTERNAL_ERROR" });
        }
      }
    }
  }

  /** Rules on cases where Solon presides over deliberation and whose deadline has not passed. */
  private async runSolon(summary: TickSummary): Promise<void> {
    const now = this.deps.clock.now().getTime();
    const waiting = (
      await this.deps.readModels.listCases({
        status: "OPEN",
        stage: "DELIBERATION",
        judgeKind: "HOUSE",
        limit: 100,
        offset: 0,
      })
    ).filter((c) => c.deadline && Date.parse(c.deadline) > now);
    summary.solon.pending = waiting.length;
    if (!this.deps.houseJudge) {
      summary.solon.awaitingModel = waiting.length;
      return;
    }
    for (const c of waiting) {
      try {
        await this.deps.houseJudge.deliberate(c.caseId);
        summary.solon.ruled += 1;
      } catch (error) {
        if (isCourtError(error) && RACE_CODES.has(error.code)) continue;
        summary.solon.failed += 1;
        summary.failures.push({ caseId: c.caseId, code: isCourtError(error) ? error.code : "MODEL_ERROR" });
      }
    }
  }
}
