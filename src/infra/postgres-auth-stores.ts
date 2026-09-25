import type { Pool } from "pg";
import type {
  BeginResult,
  CredentialRecord,
  CredentialStore,
  IdempotencyRecord,
  IdempotencyStore,
} from "@/api/stores";

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
