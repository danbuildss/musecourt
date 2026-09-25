/**
 * Deterministic domain errors. The same command against the same state always
 * fails with the same code, so API/MCP layers can map codes to responses and
 * agents can react to them.
 */
export type CourtErrorCode =
  | "VALIDATION_FAILED"
  | "INVALID_EVIDENCE"
  | "NOT_FOUND"
  | "NOT_AUTHORIZED"
  | "WRONG_STAGE"
  | "CASE_CLOSED"
  | "CONFLICT_OF_INTEREST"
  | "LICENCE_REQUIRED"
  | "SEAT_OCCUPIED"
  | "DUPLICATE"
  | "LIMIT_EXCEEDED"
  | "DEADLINE_NOT_REACHED"
  | "DEADLINE_PASSED"
  | "CONCURRENCY_CONFLICT"
  | "WORLD_EVIDENCE_NOT_FOUND"
  | "WORLD_EVIDENCE_UNAVAILABLE"
  | "INVARIANT_VIOLATION";

export class CourtError extends Error {
  constructor(
    readonly code: CourtErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CourtError";
  }
}

export function fail(code: CourtErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new CourtError(code, message, details);
}

export function isCourtError(error: unknown, code?: CourtErrorCode): error is CourtError {
  return error instanceof CourtError && (code === undefined || error.code === code);
}
