import { CourtError, type CourtErrorCode } from "@/core/errors";

/** Errors that only exist at the HTTP boundary. */
export type ApiOnlyErrorCode =
  | "UNAUTHENTICATED"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "METHOD_NOT_ALLOWED"
  | "INTERNAL_ERROR";

export type ApiErrorCode = CourtErrorCode | ApiOnlyErrorCode;

interface ErrorSpec {
  status: number;
  retryable: boolean;
  meaning: string;
}

/** The public error catalogue. Agents key their behaviour off `code`; `status` is secondary. */
export const ERROR_CATALOGUE: Record<ApiErrorCode, ErrorSpec> = {
  VALIDATION_FAILED: {
    status: 400,
    retryable: false,
    meaning: "The request is malformed or a field is invalid.",
  },
  INVALID_EVIDENCE: {
    status: 400,
    retryable: false,
    meaning: "Evidence input or an evidence reference is invalid.",
  },
  UNAUTHENTICATED: { status: 401, retryable: false, meaning: "Missing or invalid credentials." },
  NOT_AUTHORIZED: { status: 403, retryable: false, meaning: "You may not take this action in this case." },
  LICENCE_REQUIRED: {
    status: 403,
    retryable: false,
    meaning: "The role requires a licence you do not hold.",
  },
  NOT_FOUND: { status: 404, retryable: false, meaning: "The resource does not exist." },
  METHOD_NOT_ALLOWED: {
    status: 405,
    retryable: false,
    meaning: "The route exists but not for this HTTP method.",
  },
  WRONG_STAGE: {
    status: 409,
    retryable: false,
    meaning: "The action is not allowed in the case's current stage.",
  },
  CASE_CLOSED: { status: 409, retryable: false, meaning: "The case is closed; its record is final." },
  DEADLINE_PASSED: {
    status: 409,
    retryable: false,
    meaning: "The stage deadline passed; wait for the court clock.",
  },
  DEADLINE_NOT_REACHED: { status: 409, retryable: false, meaning: "The deadline has not passed yet." },
  CONFLICT_OF_INTEREST: {
    status: 409,
    retryable: false,
    meaning: "Taking this role would create a conflict.",
  },
  SEAT_OCCUPIED: { status: 409, retryable: false, meaning: "Someone already holds that seat." },
  DUPLICATE: { status: 409, retryable: false, meaning: "This already exists or was already done." },
  LIMIT_EXCEEDED: { status: 409, retryable: false, meaning: "A procedural limit was reached." },
  CONCURRENCY_CONFLICT: {
    status: 409,
    retryable: true,
    meaning: "Another action changed the case first. Retry.",
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    retryable: false,
    meaning: "This Idempotency-Key was already used for a different request.",
  },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    retryable: true,
    meaning: "A request with this Idempotency-Key is still running. Retry shortly.",
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    status: 400,
    retryable: false,
    meaning: "POST requests need an Idempotency-Key header.",
  },
  WORLD_EVIDENCE_NOT_FOUND: { status: 422, retryable: false, meaning: "The world has no such event." },
  WORLD_EVIDENCE_UNAVAILABLE: {
    status: 503,
    retryable: true,
    meaning: "The world could not be reached. Retry later.",
  },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false, meaning: "The request body is too large." },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    retryable: false,
    meaning: "Send JSON with Content-Type: application/json.",
  },
  RATE_LIMITED: { status: 429, retryable: true, meaning: "Too many requests. Retry later." },
  INVARIANT_VIOLATION: { status: 500, retryable: false, meaning: "Internal consistency check failed." },
  INTERNAL_ERROR: { status: 500, retryable: true, meaning: "Unexpected server error." },
};

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ErrorBody {
  error: { code: ApiErrorCode; message: string; retryable: boolean; details: Record<string, unknown> };
}

/** Maps any thrown value to a stable error body. Unknown errors never leak their message or stack. */
export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof ApiError || error instanceof CourtError) {
    const spec = ERROR_CATALOGUE[error.code];
    const internal = error.code === "INVARIANT_VIOLATION";
    return {
      status: spec.status,
      body: {
        error: {
          code: error.code,
          message: internal ? "Internal consistency check failed." : error.message,
          retryable: spec.retryable,
          details: internal ? {} : sanitizeDetails(error.details),
        },
      },
    };
  }
  const spec = ERROR_CATALOGUE.INTERNAL_ERROR;
  return {
    status: spec.status,
    body: {
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error.", retryable: true, details: {} },
    },
  };
}

/** Details are small, JSON-safe hints. Anything else (e.g. a nested cause) is dropped. */
function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === "cause") continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) out[key] = value;
    else if (Array.isArray(value) && value.every((v) => ["string", "number"].includes(typeof v)))
      out[key] = value;
  }
  return out;
}
