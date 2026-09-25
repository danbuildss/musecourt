import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueCredential } from "@/api/auth";
import { REGISTRY_STREAM } from "@/core/events";
import { BACKENDS, closeSharedPool, startApi, type ApiHarness } from "./harness";

afterAll(closeSharedPool);

/**
 * Invariant: registration never leaves an agent without a usable initial
 * credential. Order is validate → store credential → append event; failures
 * roll the credential back, and an orphaned credential is inert.
 */
describe.each(BACKENDS)("registration atomicity (%s)", (backend) => {
  let h: ApiHarness;
  beforeEach(async () => {
    h = await startApi({ backend });
  });
  afterEach(() => h.close());

  /** Every registered agent must hold at least one working credential. */
  async function expectEveryAgentHasACredential(keys: Map<string, string>) {
    const registry = await h.court.getRegistry();
    for (const agent of registry.agents.values()) {
      const apiKey = keys.get(agent.agentId);
      expect(apiKey, `${agent.handle} has no issued key`).toBeDefined();
      expect((await h.get("/api/v1/agents/me", { apiKey })).status).toBe(200);
    }
  }

  it("if storing the credential fails, no agent is created and the handle stays free", async () => {
    const insert = h.backend.credentials.insert.bind(h.backend.credentials);
    h.backend.credentials.insert = async () => {
      throw new Error("credential store down");
    };
    const failed = await h.post("/api/v1/agents", { handle: "maple" });
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe("INTERNAL_ERROR");
    expect((await h.get("/api/v1/agents/maple")).status).toBe(404);
    expect((await h.court.getRegistry()).agents.size).toBe(0);

    h.backend.credentials.insert = insert;
    const ok = await h.post("/api/v1/agents", { handle: "maple" });
    expect(ok.status).toBe(201);
    await expectEveryAgentHasACredential(new Map([[ok.body.agent.agentId, ok.body.credential.apiKey]]));
  });

  it("if appending the registration event fails, the credential is rolled back", async () => {
    const append = h.backend.store.append.bind(h.backend.store);
    let keyId: string | null = null;
    const insert = h.backend.credentials.insert.bind(h.backend.credentials);
    h.backend.credentials.insert = async (record) => {
      keyId = record.keyId;
      return insert(record);
    };
    h.backend.store.append = async (batches, options) => {
      if (batches.some((b) => b.streamId === REGISTRY_STREAM)) throw new Error("event store down");
      return append(batches, options);
    };
    const failed = await h.post("/api/v1/agents", { handle: "maple" });
    expect(failed.status).toBe(500);
    expect(keyId).not.toBeNull();
    expect(await h.backend.credentials.findByKeyId(keyId!)).toBeNull();
    expect((await h.court.getRegistry()).agents.size).toBe(0);

    h.backend.store.append = append;
    const ok = await h.post("/api/v1/agents", { handle: "maple" });
    expect(ok.status).toBe(201);
  });

  it("a credential orphaned by a crash (event never written) can never authenticate", async () => {
    const orphan = issueCredential();
    await h.backend.credentials.insert({
      keyId: orphan.keyId,
      agentId: "agent_never_registered",
      secretHash: orphan.secretHash,
      createdAt: h.clock.now().toISOString(),
    });
    const res = await h.get("/api/v1/agents/me", { apiKey: orphan.apiKey });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("a rejected registration (duplicate handle) stores no credential", async () => {
    await h.register("maple");
    const inserted: string[] = [];
    const insert = h.backend.credentials.insert.bind(h.backend.credentials);
    h.backend.credentials.insert = async (record) => {
      inserted.push(record.keyId);
      return insert(record);
    };
    const dup = await h.post("/api/v1/agents", { handle: "MAPLE" });
    expect(dup.body.error.code).toBe("DUPLICATE");
    expect(inserted).toEqual([]); // validation happens before the credential is written
  });

  it("concurrent registrations (which contend on the registry) each end with exactly one working key", async () => {
    const handles = ["a1", "b2", "c3", "d4", "e5", "f6"];
    const results = await Promise.all(handles.map((handle) => h.post("/api/v1/agents", { handle })));
    expect(results.map((r) => r.status)).toEqual(handles.map(() => 201));
    const keys = new Map(
      results.map((r) => [r.body.agent.agentId as string, r.body.credential.apiKey as string]),
    );
    expect(keys.size).toBe(handles.length);
    await expectEveryAgentHasACredential(keys);
  });
});
