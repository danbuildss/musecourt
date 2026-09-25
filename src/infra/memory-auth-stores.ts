import type {
  BeginResult,
  CredentialRecord,
  CredentialStore,
  IdempotencyRecord,
  IdempotencyStore,
} from "@/api/stores";

export class MemoryCredentialStore implements CredentialStore {
  private readonly records = new Map<string, CredentialRecord>();

  async insert(record: Omit<CredentialRecord, "firstUsedAt" | "revokedAt">): Promise<void> {
    if (this.records.has(record.keyId)) throw new Error("Duplicate credential key id");
    this.records.set(record.keyId, { ...record, firstUsedAt: null, revokedAt: null });
  }

  async findByKeyId(keyId: string): Promise<CredentialRecord | null> {
    const found = this.records.get(keyId);
    return found ? { ...found } : null;
  }

  async markUsed(keyId: string, at: Date): Promise<void> {
    const found = this.records.get(keyId);
    if (found && !found.firstUsedAt) found.firstUsedAt = at.toISOString();
  }

  async revoke(keyId: string, at: Date): Promise<void> {
    const found = this.records.get(keyId);
    if (found && !found.revokedAt) found.revokedAt = at.toISOString();
  }

  async revokeAllForAgent(agentId: string, at: Date): Promise<void> {
    for (const record of this.records.values()) {
      if (record.agentId === agentId && !record.revokedAt) record.revokedAt = at.toISOString();
    }
  }

  /** Test helper: everything stored (to prove raw secrets are absent). */
  all(): CredentialRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  private id(principal: string, key: string) {
    return `${principal}\u0000${key}`;
  }

  async begin(
    principal: string,
    key: string,
    requestHash: string,
    now: Date,
    staleAfterMs: number,
  ): Promise<BeginResult> {
    const existing = this.records.get(this.id(principal, key));
    const stale =
      existing?.state === "IN_PROGRESS" && now.getTime() - Date.parse(existing.createdAt) > staleAfterMs;
    if (!existing || (stale && existing.requestHash === requestHash)) {
      this.records.set(this.id(principal, key), {
        principal,
        key,
        requestHash,
        state: "IN_PROGRESS",
        responseStatus: null,
        responseBody: null,
        createdAt: now.toISOString(),
      });
      return { kind: "STARTED" };
    }
    const record = structuredClone(existing);
    if (existing.requestHash !== requestHash) return { kind: "MISMATCH", record };
    return existing.state === "COMPLETED" ? { kind: "COMPLETED", record } : { kind: "IN_PROGRESS", record };
  }

  async complete(principal: string, key: string, status: number, body: unknown): Promise<void> {
    const record = this.records.get(this.id(principal, key));
    if (!record) return;
    record.state = "COMPLETED";
    record.responseStatus = status;
    record.responseBody = structuredClone(body);
  }

  async release(principal: string, key: string): Promise<void> {
    this.records.delete(this.id(principal, key));
  }

  async get(principal: string, key: string): Promise<IdempotencyRecord | null> {
    const record = this.records.get(this.id(principal, key));
    return record ? structuredClone(record) : null;
  }
}
