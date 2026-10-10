import { isCourtError } from "@/core/errors";
import type { Clock } from "@/core/clock";
import type { Court } from "./court";
import type { HouseJudgeService } from "./house-judge-service";
import type { ReadModels } from "./read-models/types";
import type { WorldEvidenceSweep, WorldRecheckSummary } from "./world-recheck";

/**
 * Best-effort mutual exclusion between overlapping clock runs. It only avoids
 * duplicate work (e.g. two model calls for one Solon case): correctness comes
 * from per-case optimistic concurrency and the core's deadline check.
 */
export interface ClockLease {
  /** Returns a release function, or null if another run holds the lease. */
  tryAcquire(): Promise<(() => Promise<void>) | null>;
}

/**
 * Operational memory of Solon's failed attempts, so a failing model is retried at most once per
 * retry interval instead of on every clock run (each attempt is a paid model call). Not court record.
 */
export interface SolonAttemptLog {
  lastFailed(caseIds: string[]): Promise<Map<string, string>>;
  markFailed(caseId: string, at: Date): Promise<void>;
}

/** How long Solon waits before retrying a case whose last attempt failed. */
export const SOLON_RETRY_MS = 60 * 60 * 1000;

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
  /** `deferred`: cases whose last attempt failed less than the retry interval ago. */
  solon: { pending: number; ruled: number; failed: number; deferred: number; awaitingModel: number };
  /** Takedown re-checks of admitted world evidence (absent when no sweep is configured). */
  worldRecheck?: WorldRecheckSummary;
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
  /** Re-checks admitted world evidence for takedowns, a few cases per run. */
  worldRecheck?: Pick<WorldEvidenceSweep, "run">;
  /** Without it, Solon retries a failing case on every run. */
  solonAttempts?: SolonAttemptLog;
  solonRetryMs?: number;
  /**
   * Hears each case the run could not move on, with the error itself, for the operator's log.
   * The summary carries codes only: it goes back to the scheduler that called the clock.
   */
  onFailure?: (failure: ClockFailure) => void;
}

export interface ClockFailure {
  caseId: string;
  step: "deadline" | "solon";
  code: string;
  error: unknown;
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
      solon: { pending: 0, ruled: 0, failed: 0, deferred: 0, awaitingModel: 0 },
      moreDue: false,
    };

    const release = this.deps.lease ? await this.deps.lease.tryAcquire() : null;
    if (this.deps.lease && !release) return { ...summary, lease: "BUSY" };
    try {
      await this.expireDue(now, summary);
      await this.runSolon(summary);
      if (this.deps.worldRecheck) {
        summary.worldRecheck = await this.deps.worldRecheck
          .run()
          .catch(() => ({ cases: 0, checked: 0, redacted: 0, failed: 1 }));
      }
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
          const code = isCourtError(error) ? error.code : "INTERNAL_ERROR";
          summary.failed += 1;
          summary.failures.push({ caseId, code });
          this.deps.onFailure?.({ caseId, step: "deadline", code, error });
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
    const attempts = this.deps.solonAttempts;
    // Pacing is best effort: if its memory can't be read, Solon simply tries.
    const lastFailed = attempts
      ? await attempts.lastFailed(waiting.map((c) => c.caseId)).catch(() => new Map<string, string>())
      : new Map<string, string>();
    const retryMs = this.deps.solonRetryMs ?? SOLON_RETRY_MS;
    for (const c of waiting) {
      const failedAt = lastFailed.get(c.caseId);
      if (failedAt && now - Date.parse(failedAt) < retryMs) {
        summary.solon.deferred += 1;
        continue;
      }
      try {
        await this.deps.houseJudge.deliberate(c.caseId);
        summary.solon.ruled += 1;
      } catch (error) {
        if (isCourtError(error) && RACE_CODES.has(error.code)) continue;
        const code = isCourtError(error) ? error.code : "MODEL_ERROR";
        summary.solon.failed += 1;
        summary.failures.push({ caseId: c.caseId, code });
        this.deps.onFailure?.({ caseId: c.caseId, step: "solon", code, error });
        await attempts?.markFailed(c.caseId, new Date(now)).catch(() => undefined);
      }
    }
  }
}
