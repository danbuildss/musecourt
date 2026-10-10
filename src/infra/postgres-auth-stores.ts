import type { Pool } from "pg";
import type {
  BeginResult,
  CredentialRecord,
  CredentialStore,
  IdempotencyRecord,
  IdempotencyStore,
  ClaimResult,
  WorldChallengeRecord,
  WorldChallengeStore,
} from "@/api/stores";
import type { SolonAttemptLog } from "@/court/court-clock";
import type { WorldRecheckLog } from "@/court/world-recheck";

interface CredentialRow {
  key_id: string;
  agent_id: string;
  secret_hash: string;
  created_at: Date;
  first_used_at: Date | null;
  revoked_at: Date | null;
}

export class PostgresCredentialStore implements CredentialStore {
  constructor(private readonly pool: Pool) {}

  async delete(keyId: string): Promise<void> {
    await this.pool.query("DELETE FROM musecourt.agent_credentials WHERE key_id = $1", [keyId]);
  }

  async insert(record: Omit<CredentialRecord, "firstUsedAt" | "revokedAt">): Promise<void> {
    await this.pool.query(
      "INSERT INTO musecourt.agent_credentials (key_id, agent_id, secret_hash, created_at) VALUES ($1, $2, $3, $4)",
      [record.keyId, record.agentId, record.secretHash, record.createdAt],
    );
  }

  async findByKeyId(keyId: string): Promise<CredentialRecord | null> {
    const { rows } = await this.pool.query<CredentialRow>(
      "SELECT key_id, agent_id, secret_hash, created_at, first_used_at, revoked_at FROM musecourt.agent_credentials WHERE key_id = $1",
      [keyId],
    );
    const r = rows[0];
    return r
      ? {
          keyId: r.key_id,
          agentId: r.agent_id,
          secretHash: r.secret_hash,
          createdAt: r.created_at.toISOString(),
          firstUsedAt: r.first_used_at?.toISOString() ?? null,
          revokedAt: r.revoked_at?.toISOString() ?? null,
        }
      : null;
  }

  async markUsed(keyId: string, at: Date): Promise<void> {
    await this.pool.query(
      "UPDATE musecourt.agent_credentials SET first_used_at = $2 WHERE key_id = $1 AND first_used_at IS NULL",
      [keyId, at],
    );
  }

  async revoke(keyId: string, at: Date): Promise<void> {
    await this.pool.query(
      "UPDATE musecourt.agent_credentials SET revoked_at = $2 WHERE key_id = $1 AND revoked_at IS NULL",
      [keyId, at],
    );
  }

  async revokeAllForAgent(agentId: string, at: Date): Promise<void> {
    await this.pool.query(
      "UPDATE musecourt.agent_credentials SET revoked_at = $2 WHERE agent_id = $1 AND revoked_at IS NULL",
      [agentId, at],
    );
  }
}

interface IdempotencyRow {
  principal: string;
  idempotency_key: string;
  request_hash: string;
  state: "IN_PROGRESS" | "COMPLETED";
  response_status: number | null;
  response_body: unknown;
  created_at: Date;
}

const toRecord = (r: IdempotencyRow): IdempotencyRecord => ({
  principal: r.principal,
  key: r.idempotency_key,
  requestHash: r.request_hash,
  state: r.state,
  responseStatus: r.response_status,
  responseBody: r.response_body,
  createdAt: r.created_at.toISOString(),
});

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async begin(
    principal: string,
    key: string,
    requestHash: string,
    now: Date,
    staleAfterMs: number,
  ): Promise<BeginResult> {
    // The primary key makes the claim atomic: exactly one concurrent request inserts.
    const inserted = await this.pool.query(
      `INSERT INTO musecourt.idempotency_keys (principal, idempotency_key, request_hash, state, created_at)
       VALUES ($1, $2, $3, 'IN_PROGRESS', $4) ON CONFLICT DO NOTHING`,
      [principal, key, requestHash, now],
    );
    if (inserted.rowCount === 1) return { kind: "STARTED" };

    // Take over a claim abandoned by a crashed request (same request only).
    const takeover = await this.pool.query(
      `UPDATE musecourt.idempotency_keys SET created_at = $4
       WHERE principal = $1 AND idempotency_key = $2 AND request_hash = $3
         AND state = 'IN_PROGRESS' AND created_at < $4::timestamptz - make_interval(secs => $5::double precision / 1000)`,
      [principal, key, requestHash, now, staleAfterMs],
    );
    if (takeover.rowCount === 1) return { kind: "STARTED" };

    const record = (await this.get(principal, key))!;
    if (record.requestHash !== requestHash) return { kind: "MISMATCH", record };
    return record.state === "COMPLETED" ? { kind: "COMPLETED", record } : { kind: "IN_PROGRESS", record };
  }

  async complete(principal: string, key: string, status: number, body: unknown, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE musecourt.idempotency_keys SET state = 'COMPLETED', response_status = $3, response_body = $4, completed_at = $5
       WHERE principal = $1 AND idempotency_key = $2`,
      [principal, key, status, JSON.stringify(body), now],
    );
  }

  async release(principal: string, key: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM musecourt.idempotency_keys WHERE principal = $1 AND idempotency_key = $2 AND state = 'IN_PROGRESS'",
      [principal, key],
    );
  }

  async get(principal: string, key: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.pool.query<IdempotencyRow>(
      `SELECT principal, idempotency_key, request_hash, state, response_status, response_body, created_at
       FROM musecourt.idempotency_keys WHERE principal = $1 AND idempotency_key = $2`,
      [principal, key],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

interface ChallengeRow {
  nonce: string;
  agent_id: string;
  connector_id: string;
  audience: string;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
}

const toChallenge = (r: ChallengeRow): WorldChallengeRecord => ({
  nonce: r.nonce,
  agentId: r.agent_id,
  connectorId: r.connector_id,
  audience: r.audience,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  usedAt: r.used_at ? r.used_at.toISOString() : null,
});

export class PostgresWorldChallengeStore implements WorldChallengeStore {
  constructor(private readonly pool: Pool) {}

  async insert(record: Omit<WorldChallengeRecord, "usedAt">): Promise<void> {
    // Housekeeping: challenges are useless a day after they expire.
    await this.pool.query(
      "DELETE FROM musecourt.world_identity_challenges WHERE expires_at < $1::timestamptz - interval '1 day'",
      [record.createdAt],
    );
    await this.pool.query(
      `INSERT INTO musecourt.world_identity_challenges (nonce, agent_id, connector_id, audience, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [record.nonce, record.agentId, record.connectorId, record.audience, record.createdAt, record.expiresAt],
    );
  }

  async claim(nonce: string, agentId: string, connectorId: string, now: Date): Promise<ClaimResult> {
    const claimed = await this.pool.query<ChallengeRow>(
      `UPDATE musecourt.world_identity_challenges SET used_at = $4
       WHERE nonce = $1 AND agent_id = $2 AND connector_id = $3 AND used_at IS NULL AND expires_at > $4
       RETURNING *`,
      [nonce, agentId, connectorId, now.toISOString()],
    );
    if (claimed.rows[0]) return { kind: "CLAIMED", record: toChallenge(claimed.rows[0]) };
    const existing = await this.pool.query<ChallengeRow>(
      "SELECT * FROM musecourt.world_identity_challenges WHERE nonce = $1 AND agent_id = $2 AND connector_id = $3",
      [nonce, agentId, connectorId],
    );
    const row = existing.rows[0];
    if (!row) return { kind: "NOT_FOUND" };
    return { kind: row.used_at ? "USED" : "EXPIRED" };
  }
}

export class PostgresWorldRecheckLog implements WorldRecheckLog {
  constructor(private readonly pool: Pool) {}

  async lastChecked(caseIds: string[]): Promise<Map<string, string>> {
    if (caseIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{ case_id: string; checked_at: Date }>(
      "SELECT case_id, checked_at FROM musecourt.world_evidence_checks WHERE case_id = ANY($1)",
      [caseIds],
    );
    return new Map(rows.map((r) => [r.case_id, r.checked_at.toISOString()]));
  }

  async markChecked(caseId: string, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO musecourt.world_evidence_checks (case_id, checked_at) VALUES ($1, $2)
       ON CONFLICT (case_id) DO UPDATE SET checked_at = EXCLUDED.checked_at`,
      [caseId, at],
    );
  }
}

export class PostgresSolonAttemptLog implements SolonAttemptLog {
  constructor(private readonly pool: Pool) {}

  async lastFailed(caseIds: string[]): Promise<Map<string, string>> {
    if (caseIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{ case_id: string; failed_at: Date }>(
      "SELECT case_id, failed_at FROM musecourt.solon_attempts WHERE case_id = ANY($1)",
      [caseIds],
    );
    return new Map(rows.map((r) => [r.case_id, r.failed_at.toISOString()]));
  }

  async markFailed(caseId: string, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO musecourt.solon_attempts (case_id, failed_at) VALUES ($1, $2)
       ON CONFLICT (case_id) DO UPDATE SET failed_at = EXCLUDED.failed_at`,
      [caseId, at],
    );
  }
}
