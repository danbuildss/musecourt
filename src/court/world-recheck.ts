import type { CaseState } from "@/core/case-state";
import type { Clock } from "@/core/clock";
import type { Court } from "./court";
import type { ReadModels } from "./read-models/types";

/**
 * Takedown propagation, the slow schedule. Worlds can take down an event's words after MuseCourt
 * admitted it. The court re-checks at verdict time; this sweep also re-checks every case holding
 * unredacted world evidence about once a day while the event is within the window, so removed
 * words stop being shown even in closed cases. Operators can always redact by hand afterwards.
 */

/** How long after an event MuseCourt keeps re-checking it (the longest world retention we know). */
export const WORLD_RECHECK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BUDGET = 10;
const CANDIDATE_LIMIT = 1000;

/** Until when this case's world evidence should be re-checked (null: nothing to re-check). */
export function worldRecheckUntil(state: CaseState): string | null {
  let until = 0;
  for (const item of state.evidence) {
    if (!item.world || item.redaction) continue;
    const occurred = Date.parse(item.world.snapshot.occurredAt);
    const base = Number.isNaN(occurred) || occurred <= 0 ? Date.parse(item.world.retrievedAt) : occurred;
    until = Math.max(until, base + WORLD_RECHECK_WINDOW_MS);
  }
  return until > 0 ? new Date(until).toISOString() : null;
}

/** Operational memory of when each case was last re-checked. Not court record. */
export interface WorldRecheckLog {
  lastChecked(caseIds: string[]): Promise<Map<string, string>>;
  markChecked(caseId: string, at: Date): Promise<void>;
}

export interface WorldRecheckSummary {
  cases: number;
  checked: number;
  redacted: number;
  failed: number;
}

export class WorldEvidenceSweep {
  constructor(
    private readonly deps: {
      court: Pick<Court, "recheckWorldEvidence">;
      readModels: ReadModels;
      log: WorldRecheckLog;
      clock: Clock;
      intervalMs?: number;
      budget?: number;
    },
  ) {}

  async run(): Promise<WorldRecheckSummary> {
    const summary: WorldRecheckSummary = { cases: 0, checked: 0, redacted: 0, failed: 0 };
    const now = this.deps.clock.now();
    const candidates = await this.deps.readModels.worldRecheckCandidates(now, CANDIDATE_LIMIT);
    if (candidates.length === 0) return summary;
    const last = await this.deps.log.lastChecked(candidates);
    const interval = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    const due = candidates
      .filter((id) => {
        const at = last.get(id);
        return !at || now.getTime() - Date.parse(at) >= interval;
      })
      .sort((a, b) => (last.get(a) ?? "").localeCompare(last.get(b) ?? "") || a.localeCompare(b))
      .slice(0, this.deps.budget ?? DEFAULT_BUDGET);
    for (const caseId of due) {
      summary.cases += 1;
      try {
        const r = await this.deps.court.recheckWorldEvidence(caseId);
        summary.checked += r.checked;
        summary.redacted += r.redacted;
        summary.failed += r.failed;
        // A world that could not answer is tried again on the next run, not tomorrow.
        if (r.failed === 0) await this.deps.log.markChecked(caseId, now);
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  }
}
