/**
 * Storage the HTTP layer needs beyond the court itself. Neither credentials nor
 * idempotency records are court facts, so they live outside the event log.
 */

export interface CredentialRecord {
  keyId: string;
  agentId: string;
  /** Hex SHA-256 of the secret. The raw secret is never stored. */
  secretHash: string;
  createdAt: string;
  firstUsedAt: string | null;
  revokedAt: string | null;
}

export interface CredentialStore {
  insert(record: Omit<CredentialRecord, "firstUsedAt" | "revokedAt">): Promise<void>;
  findByKeyId(keyId: string): Promise<CredentialRecord | null>;
  /** Records the first successful use (no-op afterwards). */
  markUsed(keyId: string, at: Date): Promise<void>;
  revoke(keyId: string, at: Date): Promise<void>;
  revokeAllForAgent(agentId: string, at: Date): Promise<void>;
  /** Removes a credential outright (only used to roll back a failed registration). */
  delete(keyId: string): Promise<void>;
}

export interface IdempotencyRecord {
  principal: string;
  key: string;
  requestHash: string;
  state: "IN_PROGRESS" | "COMPLETED";
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: string;
}

export type BeginResult =
  | { kind: "STARTED" }
  | { kind: "COMPLETED"; record: IdempotencyRecord }
  | { kind: "IN_PROGRESS"; record: IdempotencyRecord }
  | { kind: "MISMATCH"; record: IdempotencyRecord };

export interface IdempotencyStore {
  /**
   * Atomically claims (principal, key) for a request. An IN_PROGRESS claim older
   * than `staleAfterMs` (a crashed request) is taken over.
   */
  begin(
    principal: string,
    key: string,
    requestHash: string,
    now: Date,
    staleAfterMs: number,
  ): Promise<BeginResult>;
  complete(principal: string, key: string, status: number, body: unknown, now: Date): Promise<void>;
  /** Frees a claim so a retry runs again (used for retryable failures). */
  release(principal: string, key: string): Promise<void>;
  get(principal: string, key: string): Promise<IdempotencyRecord | null>;
}

/**
 * One-time challenges for linking a world identity (Phase 6). Operational state, like idempotency
 * keys: a challenge attempt is not a court fact, so it never goes into the event log.
 */
export interface WorldChallengeRecord {
  nonce: string;
  agentId: string;
  connectorId: string;
  /** The exact origin the proof must name. */
  audience: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export type ClaimResult =
  { kind: "CLAIMED"; record: WorldChallengeRecord } | { kind: "USED" | "EXPIRED" | "NOT_FOUND" };

export interface WorldChallengeStore {
  insert(record: Omit<WorldChallengeRecord, "usedAt">): Promise<void>;
  /**
   * Atomically marks the challenge used, if it was issued to this agent for this connector, is
   * unused and has not expired. Concurrent claims of one challenge: exactly one succeeds.
   * A challenge issued to another agent answers NOT_FOUND.
   */
  claim(nonce: string, agentId: string, connectorId: string, now: Date): Promise<ClaimResult>;
}
