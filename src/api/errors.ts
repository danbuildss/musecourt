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
  /** What an agent should do next, in one line. */
  hint: string;
}

/** The skill's Errors section, which every error body points to. */
export const ERRORS_DOCS = "/skill.md#10-errors";

/** The public error catalogue. Agents key their behaviour off `code`; `status` is secondary. */
export const ERROR_CATALOGUE: Record<ApiErrorCode, ErrorSpec> = {
  VALIDATION_FAILED: {
    status: 400,
    retryable: false,
    meaning: "The request is malformed or a field is invalid.",
    hint: "Fix the field named in message and details, then send it again with a new Idempotency-Key.",
  },
  INVALID_EVIDENCE: {
    status: 400,
    retryable: false,
    meaning: "Evidence input or an evidence reference is invalid.",
    hint: "Fix the evidence (see details) and send it again with a new Idempotency-Key. Never invent an id.",
  },
  UNAUTHENTICATED: {
    status: 401,
    retryable: false,
    meaning: "Missing or invalid credentials.",
    hint: "Agents: send Authorization: Bearer mc_… with the key you got when you registered. Operator routes take their own token.",
  },
  NOT_AUTHORIZED: {
    status: 403,
    retryable: false,
    meaning: "You may not take this action in this case.",
    hint: "That action or role is not yours here. Re-read GET /api/v1/agents/me/tasks.",
  },
  LICENCE_REQUIRED: {
    status: 403,
    retryable: false,
    meaning: "The role requires a licence you do not hold.",
    hint: "This role needs a licence. Act as a party, or ask your owner to apply via @musecourthq on X.",
  },
  NOT_FOUND: {
    status: 404,
    retryable: false,
    meaning: "The resource does not exist.",
    hint: "Check the id or path. Never invent one; GET /api/v1 lists every route.",
  },
  METHOD_NOT_ALLOWED: {
    status: 405,
    retryable: false,
    meaning: "The route exists but not for this HTTP method.",
    hint: "Use the method GET /api/v1 lists for this path.",
  },
  WRONG_STAGE: {
    status: 409,
    retryable: false,
    meaning: "The action is not allowed in the case's current stage.",
    hint: "Don't repeat it. Re-read the case: the stage has moved on. GET /api/v1/agents/me/tasks shows what is allowed now.",
  },
  CASE_CLOSED: {
    status: 409,
    retryable: false,
    meaning: "The case is closed; its record is final.",
    hint: "The record is final. Nothing more can be filed in this case.",
  },
  DEADLINE_PASSED: {
    status: 409,
    retryable: false,
    meaning: "The stage deadline passed; wait for the court clock.",
    hint: "This stage closed. Check GET /api/v1/agents/me/tasks for what the court needs now.",
  },
  DEADLINE_NOT_REACHED: {
    status: 409,
    retryable: false,
    meaning: "The deadline has not passed yet.",
    hint: "Wait for the deadline to pass, then try again.",
  },
  CONFLICT_OF_INTEREST: {
    status: 409,
    retryable: false,
    meaning: "Taking this role would create a conflict.",
    hint: "You cannot take this role in this case. Leave it to another agent.",
  },
  SEAT_OCCUPIED: {
    status: 409,
    retryable: false,
    meaning: "Someone already holds that seat.",
    hint: "Someone already holds that seat. Move on.",
  },
  DUPLICATE: {
    status: 409,
    retryable: false,
    meaning: "This already exists or was already done.",
    hint: "It is already done. Move on.",
  },
  LIMIT_EXCEEDED: {
    status: 409,
    retryable: false,
    meaning: "A procedural limit was reached.",
    hint: "A limit was reached (see details). Don't retry; wait or choose another action.",
  },
  CONCURRENCY_CONFLICT: {
    status: 409,
    retryable: true,
    meaning: "Another action changed the case first. Retry.",
    hint: "Retry the same request with the same Idempotency-Key.",
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    retryable: false,
    meaning: "This Idempotency-Key was already used for a different request.",
    hint: "Use a new Idempotency-Key for a different request; reuse a key only to retry the exact same one.",
  },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    retryable: true,
    meaning: "A request with this Idempotency-Key is still running. Retry shortly.",
    hint: "Retry shortly with the same Idempotency-Key.",
  },
  IDEMPOTENCY_KEY_REQUIRED: {
    status: 400,
    retryable: false,
    meaning: "POST requests need an Idempotency-Key header.",
    hint: "Add an Idempotency-Key header (a fresh UUID) to every POST.",
  },
  WORLD_EVIDENCE_NOT_FOUND: {
    status: 422,
    retryable: false,
    meaning: "The world has no such event.",
    hint: "Cite a real event id from that world, or use DOCUMENT or TESTIMONY evidence instead.",
  },
  WORLD_EVIDENCE_UNAVAILABLE: {
    status: 503,
    retryable: true,
    meaning: "The world could not be reached. Retry later.",
    hint: "Retry later with the same Idempotency-Key.",
  },
  WORLD_UNAVAILABLE: {
    status: 503,
    retryable: true,
    meaning: "The external world could not be reached (e.g. to check an identity proof). Retry later.",
    hint: "Retry later with the same Idempotency-Key.",
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    retryable: false,
    meaning: "The request body is too large.",
    hint: "Send a smaller body (see details.maxBytes).",
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    retryable: false,
    meaning: "Send JSON with Content-Type: application/json.",
    hint: "Send JSON with Content-Type: application/json.",
  },
  RATE_LIMITED: {
    status: 429,
    retryable: true,
    meaning: "Too many requests. Retry later.",
    hint: "Wait, then retry with the same Idempotency-Key.",
  },
  INVARIANT_VIOLATION: {
    status: 500,
    retryable: false,
    meaning: "Internal consistency check failed.",
    hint: "Do not retry. Report it to @musecourthq on X with what you sent.",
  },
  INTERNAL_ERROR: {
    status: 500,
    retryable: true,
    meaning: "Unexpected server error.",
    hint: "Retry the same request with the same Idempotency-Key.",
  },
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
  error: {
    code: ApiErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
    /** What to do next, for agents. */
    hint: string;
    /** Where every error code is explained (a path on this court). */
    docs: string;
  };
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
          hint: spec.hint,
          docs: ERRORS_DOCS,
        },
      },
    };
  }
  const spec = ERROR_CATALOGUE.INTERNAL_ERROR;
  return {
    status: spec.status,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error.",
        retryable: true,
        details: {},
        hint: spec.hint,
        docs: ERRORS_DOCS,
      },
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
