import { SYSTEM } from "@/core/actor";
import { CourtError } from "@/core/errors";
import { normalizeHandle } from "@/core/registry";
import type { AgentRow } from "@/court/read-models/types";
import type { ApiDeps } from "./app";
import { issueCredential } from "./auth";
import { ApiError, ERROR_CATALOGUE, type ApiErrorCode } from "./errors";
import { ID_PATTERN } from "./schemas";
import type { IdempotencyRecord } from "./stores";

/**
 * Plumbing shared by the REST routes and the MCP tools: translation between
 * the outside world and the Court service. No court rules live here; the core
 * decides every action.
 */

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * Reads never advance the case. If a deadline has passed but the court clock
 * has not processed it yet, the view says so (`overdue: true`) instead.
 */
export const isOverdue = (deadline: string | null | undefined, now: Date) =>
  !!deadline && Date.parse(deadline) <= now.getTime();

export async function caseView(deps: ApiDeps, caseId: string, now: Date) {
  const view = await deps.readModels.getCaseView(caseId);
  if (!view) throw new CourtError("NOT_FOUND", `Case ${caseId} not found.`);
  return {
    ...view,
    stage: view.stage ? { ...view.stage, overdue: isOverdue(view.stage.deadline, now) } : null,
  };
}

export function publicAgent(row: AgentRow) {
  return {
    agentId: row.agentId,
    handle: row.handle,
    displayName: row.displayName,
    registeredAt: row.registeredAt,
    licences: row.licences,
    externalIdentities: row.externalIdentities,
  };
}

/** An agent by handle or agent ID. */
export async function resolveAgent(deps: ApiDeps, ref: string): Promise<AgentRow> {
  const byId = ID_PATTERN.test(ref) && ref.startsWith("agent_") ? await deps.readModels.getAgent(ref) : null;
  const found = byId ?? (await deps.readModels.findAgentByHandle(normalizeHandle(ref)));
  if (!found) throw new CourtError("NOT_FOUND", `No agent ${ref}.`, { agent: ref });
  return found;
}

export async function tasksAndOpportunities(deps: ApiDeps, agentId: string, now: Date) {
  const [tasks, opportunities] = await Promise.all([
    deps.readModels.tasksFor(agentId),
    deps.court.findOpportunities(agentId),
  ]);
  return { tasks: tasks.map((t) => ({ ...t, overdue: isOverdue(t.deadline, now) })), opportunities };
}

// ---------------------------------------------------------------------------
// Registration (one-time key)
// ---------------------------------------------------------------------------

export const CREDENTIAL_NOTE =
  "Store this API key now. MuseCourt keeps only a hash and cannot show it again.";
const REGISTRATION_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CredentialBody {
  agent: ReturnType<typeof publicAgent>;
  credential: { keyId: string; apiKey: string | null; note: string };
}

/** Registers an agent and its first credential atomically (credential first, event second). */
export async function registerWithCredential(
  deps: ApiDeps,
  input: { handle: string; displayName?: string },
  now: Date,
): Promise<CredentialBody> {
  const credential = issueCredential();
  let stored = false;
  let agent;
  try {
    agent = await deps.court.registerAgent({ handle: input.handle, displayName: input.displayName }, SYSTEM, {
      beforeAppend: async (agentId) => {
        if (stored) return;
        await deps.credentials.insert({
          keyId: credential.keyId,
          agentId,
          secretHash: credential.secretHash,
          createdAt: now.toISOString(),
        });
        stored = true;
      },
    });
  } catch (error) {
    // Roll back the credential; if even that fails it stays inert (its agent does not exist).
    if (stored) await deps.credentials.delete(credential.keyId).catch(() => undefined);
    throw error;
  }
  const row = (await deps.readModels.getAgent(agent.agentId))!;
  return {
    agent: publicAgent(row),
    credential: { keyId: credential.keyId, apiKey: credential.apiKey, note: CREDENTIAL_NOTE },
  };
}

/** What is kept for idempotent replay: never the secret. */
export function redactCredential(body: unknown): unknown {
  const b = body as CredentialBody | null;
  if (!b?.credential) return body;
  return {
    ...b,
    credential: { ...b.credential, apiKey: null, note: "The API key is shown only once and was not stored." },
  };
}

/**
 * Replaying a registration cannot return the original secret (it was never
 * stored). If the credential has never been used, the court rotates it and
 * returns a fresh key, so an agent whose first response was lost is not
 * locked out. Otherwise null: the stored, redacted response is replayed.
 */
export async function rotateUnusedRegistration(
  deps: ApiDeps,
  record: IdempotencyRecord,
  scope: string,
  key: string,
  now: Date,
): Promise<CredentialBody | null> {
  if (record.responseStatus !== 201) return null;
  const stored = record.responseBody as CredentialBody;
  const current = await deps.credentials.findByKeyId(stored.credential.keyId);
  const fresh =
    current &&
    !current.firstUsedAt &&
    !current.revokedAt &&
    now.getTime() - Date.parse(current.createdAt) < REGISTRATION_REPLAY_WINDOW_MS;
  if (!current || !fresh) return null;
  await deps.credentials.revoke(current.keyId, now);
  const next = issueCredential();
  await deps.credentials.insert({
    keyId: next.keyId,
    agentId: current.agentId,
    secretHash: next.secretHash,
    createdAt: now.toISOString(),
  });
  const body: CredentialBody = {
    agent: stored.agent,
    credential: { keyId: next.keyId, apiKey: next.apiKey, note: CREDENTIAL_NOTE },
  };
  await deps.idempotency.complete(scope, key, 201, redactCredential(body), now);
  return body;
}

// ---------------------------------------------------------------------------
// Idempotency (same guarantees for every interface)
// ---------------------------------------------------------------------------

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function assertIdempotencyKey(key: string, field: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("VALIDATION_FAILED", `${field} must be 16–128 characters of [A-Za-z0-9_-].`, {
      field,
    });
  }
}

export interface Executed<R> {
  result: R;
  status: number;
  /** What would be stored for replay (already redacted if needed). */
  body: unknown;
  code?: ApiErrorCode;
}

function isStorable(status: number, code: ApiErrorCode | undefined): boolean {
  if (status >= 500) return false;
  return !(code && ERROR_CATALOGUE[code].retryable);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a write at most once per (scope, key):
 *  - same key + same request → the original result is replayed;
 *  - same key + different request → IDEMPOTENCY_KEY_REUSED;
 *  - a concurrent duplicate waits for the original;
 *  - retryable failures release the key so it can succeed later.
 */
export async function runIdempotent<R>(
  deps: ApiDeps,
  args: {
    scope: string;
    key: string;
    fingerprint: string;
    now: Date;
    execute: () => Promise<Executed<R>>;
    replay: (record: IdempotencyRecord) => Promise<R>;
  },
): Promise<R> {
  const waitMs = deps.idempotencyWaitMs ?? 5000;
  const staleMs = deps.idempotencyStaleMs ?? 60_000;
  const { scope, key } = args;
  const begun = await deps.idempotency.begin(scope, key, args.fingerprint, args.now, staleMs);
  if (begun.kind === "MISMATCH") {
    throw new ApiError(
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used for a different request.",
    );
  }
  if (begun.kind === "COMPLETED") return args.replay(begun.record);
  if (begun.kind === "IN_PROGRESS") {
    for (let waited = 0; waited < waitMs; waited += 25) {
      await sleep(25);
      const record = await deps.idempotency.get(scope, key);
      if (!record) break;
      if (record.state === "COMPLETED") return args.replay(record);
    }
    throw new ApiError("IDEMPOTENCY_IN_PROGRESS", "A request with this Idempotency-Key is still running.");
  }
  const outcome = await args.execute();
  if (isStorable(outcome.status, outcome.code)) {
    await deps.idempotency.complete(scope, key, outcome.status, outcome.body, deps.clock.now());
  } else {
    await deps.idempotency.release(scope, key);
  }
  return outcome.result;
}
