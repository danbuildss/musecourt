import type { ClockFailure, TickSummary } from "@/court/court-clock";
import type { Principal } from "./auth";
import type { ErrorBody } from "./errors";

/**
 * Operational warnings: things an operator should look at during a live case (a rejected identity
 * proof, rejected world evidence, a clock run with failures). One line each in the server log.
 * Never carries keys, proofs or receipts: only codes, reasons, ids and error messages.
 */
export interface OpsWarning {
  event:
    | "identity_proof_rejected"
    | "world_unavailable"
    | "world_evidence_rejected"
    | "world_evidence_unavailable"
    | "clock_failures"
    | "clock_case_failed";
  [field: string]: unknown;
}

const EVIDENCE_EVENTS: Partial<Record<string, OpsWarning["event"]>> = {
  WORLD_EVIDENCE_NOT_FOUND: "world_evidence_rejected",
  WORLD_EVIDENCE_UNAVAILABLE: "world_evidence_unavailable",
  WORLD_UNAVAILABLE: "world_unavailable",
};

/** The warning for a request that failed, if it is one an operator should see. */
export function warningForError(
  error: ErrorBody["error"],
  where: string,
  principal: Principal | null,
): OpsWarning | null {
  const details = error.details as Record<string, unknown>;
  const event: OpsWarning["event"] | undefined =
    EVIDENCE_EVENTS[error.code] ??
    (error.code === "VALIDATION_FAILED" && details.field === "proof" ? "identity_proof_rejected" : undefined);
  if (!event) return null;
  return {
    event,
    where,
    agentId: principal?.kind === "agent" ? principal.agentId : null,
    code: error.code,
    reason: details.reason ?? null,
    eventId: details.eventId ?? null,
    message: error.message,
    ...(details.cause ? { cause: details.cause } : {}),
  };
}

/** The warning for a clock run that left something undone, if any. */
export function warningForTick(summary: TickSummary): OpsWarning | null {
  const recheckFailed = summary.worldRecheck?.failed ?? 0;
  if (summary.failed === 0 && summary.solon.failed === 0 && recheckFailed === 0) return null;
  return {
    event: "clock_failures",
    ranAt: summary.ranAt,
    deadlinesFailed: summary.failed,
    solonFailed: summary.solon.failed,
    worldRecheckFailed: recheckFailed,
    failures: summary.failures,
  };
}

/** One case the clock could not move on, with the error's message (for the server log only). */
export function warningForClockFailure(failure: ClockFailure): OpsWarning {
  const error = failure.error;
  return {
    event: "clock_case_failed",
    caseId: failure.caseId,
    step: failure.step,
    code: failure.code,
    // Model and world adapters never put keys in their errors (see their tests).
    message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
}
