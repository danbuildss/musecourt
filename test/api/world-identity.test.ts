import { afterAll, describe, expect, it } from "vitest";
import { MuseworldConnector } from "@/connectors/museworld";
import { REGISTRY_STREAM } from "@/core/events";
import { connectMcp } from "@/mcp/client";
import type { FakeClock } from "@/testing/fake-clock";
import { ISLAND, MUSECOURT, fakeIsland } from "../connectors/fake-island";
import { BACKENDS, closeSharedPool, startApi, type Agent } from "./harness";

afterAll(closeSharedPool);

const CHALLENGE = "/api/v1/agents/me/world-identity/challenge";
const LINK = "/api/v1/agents/me/world-identity";
const MUSE_A = "631ac74e-cff2-4098-9f63-37c5d3ca206b";
const MUSE_B = "4c07aa11-0000-4000-8000-000000000002";

describe.each(BACKENDS)("linking a Museworld identity (%s)", (backend) => {
  async function setup(options: { publicOrigin?: string | null } = {}) {
    let clock: FakeClock | undefined;
    const island = await fakeIsland(() => clock!.now());
    const h = await startApi({
      backend,
      publicOrigin: options.publicOrigin,
      connectors: (c) => {
        clock = c;
        return [new MuseworldConnector({ baseUrl: ISLAND, fetch: island.fetch, now: () => c.now() })];
      },
    });
    const challenge = async (agent: Agent, connectorId = "museworld") =>
      h.post(CHALLENGE, { connectorId }, { apiKey: agent.apiKey });
    const link = async (agent: Agent, proof: string) =>
      h.post(LINK, { connectorId: "museworld", proof }, { apiKey: agent.apiKey });
    const registryEvents = async () => h.backend.store.readStream(REGISTRY_STREAM);
    return { h, island, clock: () => clock!, challenge, link, registryEvents };
  }

  it("challenge → island proof → link: the stable Muse id is linked and the owner recorded", async () => {
    const { h, island, challenge, link, registryEvents } = await setup();
    try {
      const maple = await h.register("maple");
      const c = await challenge(maple);
      expect(c.status).toBe(201);
      expect(c.body.challenge).toMatchObject({ connectorId: "museworld", audience: MUSECOURT });
      expect(c.body.challenge.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(c.body.challenge.instructions).toContain(`prove ${MUSECOURT} ${c.body.challenge.nonce}`);

      const proof = await island.prove({ nonce: c.body.challenge.nonce, sub: MUSE_A });
      const res = await link(maple, proof);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.agent).toMatchObject({
        handle: "maple",
        ownerRef: "x:p0kadevil86",
        externalIdentities: [{ connectorId: "museworld", externalId: MUSE_A }],
      });
      // Public profile shows the link; the court record holds the fact, never the proof token.
      expect((await h.get("/api/v1/agents/maple")).body.agent.externalIdentities).toEqual([
        { connectorId: "museworld", externalId: MUSE_A },
      ]);
      const linked = (await registryEvents()).find((e) => e.type === "WorldIdentityLinked")!;
      expect(linked.actor).toEqual({ kind: "agent", agentId: maple.agentId });
      expect(linked.data).toMatchObject({
        agentId: maple.agentId,
        connectorId: "museworld",
        worldAgentId: MUSE_A,
        ownerRef: "x:p0kadevil86",
        attributes: { username: "p0kadevil", standing: "citizen", status: "active" },
      });
      expect(JSON.stringify(linked.data)).not.toContain(proof);
      // Read models rebuilt from the log agree.
      const before = await h.backend.dumpReadModels();
      await h.backend.rebuildReadModels();
      expect(await h.backend.dumpReadModels()).toEqual(before);
    } finally {
      await h.close();
    }
  });

  it("a challenge is single-use: a replayed proof is refused, and of two concurrent submissions exactly one wins", async () => {
    const { h, island, challenge, link } = await setup();
    try {
      const maple = await h.register("maple");
      const proof = await island.prove({ nonce: (await challenge(maple)).body.challenge.nonce });
      const results = await Promise.all([link(maple, proof), link(maple, proof)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      const loser = results.find((r) => r.status === 400)!;
      expect(loser.body.error).toMatchObject({
        code: "VALIDATION_FAILED",
        details: { reason: "challenge_used" },
      });
      const replay = await link(maple, proof);
      expect(replay.body.error.details.reason).toBe("challenge_used");
    } finally {
      await h.close();
    }
  });

  it("a proof only answers a challenge issued to the same agent, and only within ten minutes", async () => {
    const { h, island, challenge, link, clock } = await setup();
    try {
      const maple = await h.register("maple");
      const nova = await h.register("nova");
      const forMaple = (await challenge(maple)).body.challenge.nonce;
      // Nova presents a proof made for Maple's challenge: not its challenge.
      const stolen = await link(nova, await island.prove({ nonce: forMaple }));
      expect(stolen.body.error.details.reason).toBe("challenge_not_found");
      // Expired challenge.
      const late = (await challenge(maple)).body.challenge.nonce;
      const proof = await island.prove({ nonce: late });
      clock().advance(11 * 60 * 1000);
      expect((await link(maple, proof)).body.error.details.reason).toBe("challenge_expired");
      expect((await h.get("/api/v1/agents/maple")).body.agent.externalIdentities).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("refuses a proof for another app or from a retired key, and the challenge is spent", async () => {
    const { h, island, challenge, link } = await setup();
    try {
      const maple = await h.register("maple");
      const n1 = (await challenge(maple)).body.challenge.nonce;
      const wrongApp = await link(maple, await island.prove({ nonce: n1, audience: "https://other.app" }));
      expect(wrongApp.body.error).toMatchObject({
        code: "VALIDATION_FAILED",
        details: { reason: "wrong_audience" },
      });
      // The same challenge cannot be retried with a corrected proof.
      expect((await link(maple, await island.prove({ nonce: n1 }))).body.error.details.reason).toBe(
        "challenge_used",
      );
      const n2 = (await challenge(maple)).body.challenge.nonce;
      const retired = await link(maple, await island.prove({ nonce: n2, key: island.keys.retired }));
      expect(retired.body.error.details.reason).toBe("retired_key");
    } finally {
      await h.close();
    }
  });

  it("one world identity per agent, and one agent per world identity", async () => {
    const { h, island, challenge, link } = await setup();
    try {
      const maple = await h.register("maple");
      const nova = await h.register("nova");
      const ok = await link(
        maple,
        await island.prove({ nonce: (await challenge(maple)).body.challenge.nonce, sub: MUSE_A }),
      );
      expect(ok.status).toBe(200);
      const taken = await link(
        nova,
        await island.prove({ nonce: (await challenge(nova)).body.challenge.nonce, sub: MUSE_A }),
      );
      expect(taken.body.error.code).toBe("DUPLICATE");
      const second = await link(
        maple,
        await island.prove({ nonce: (await challenge(maple)).body.challenge.nonce, sub: MUSE_B }),
      );
      expect(second.body.error.code).toBe("DUPLICATE");
    } finally {
      await h.close();
    }
  });

  it("needs the agent's key, a world that verifies identities, and a configured public origin", async () => {
    const { h, challenge } = await setup();
    try {
      expect((await h.post(CHALLENGE, { connectorId: "museworld" })).status).toBe(401);
      const maple = await h.register("maple");
      const fake = await challenge(maple, "fake-world");
      expect(fake.body.error).toMatchObject({ code: "VALIDATION_FAILED", details: { field: "connectorId" } });
      expect((await challenge(maple, "nowhere")).body.error.code).toBe("VALIDATION_FAILED");
    } finally {
      await h.close();
    }
    const disabled = await setup({ publicOrigin: null });
    try {
      const maple = await disabled.h.register("maple");
      expect((await disabled.challenge(maple)).status).toBe(404);
    } finally {
      await disabled.h.close();
    }
  });

  it("an unreachable island is a retryable WORLD_UNAVAILABLE", async () => {
    const { h, island, challenge, link } = await setup();
    try {
      const maple = await h.register("maple");
      const proof = await island.prove({ nonce: (await challenge(maple)).body.challenge.nonce });
      island.setReachable(false);
      const res = await link(maple, proof);
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: "WORLD_UNAVAILABLE", retryable: true });
    } finally {
      await h.close();
    }
  });

  it("MCP gives the same result as REST (same events, same errors)", async () => {
    const { h, island, link, registryEvents } = await setup();
    try {
      const rest = await h.register("maple");
      const viaRest = await link(
        rest,
        await island.prove({
          nonce: (await h.post(CHALLENGE, { connectorId: "museworld" }, { apiKey: rest.apiKey })).body
            .challenge.nonce,
          sub: MUSE_A,
        }),
      );
      expect(viaRest.status).toBe(200);

      const anon = await connectMcp(h.baseUrl);
      const reg = await anon.call("register_agent", { handle: "nova" });
      const novaKey = (reg.structured as any).credential.apiKey as string;
      const nova = await connectMcp(h.baseUrl, { apiKey: novaKey });
      const c = await nova.call("get_world_identity_challenge", { connectorId: "museworld" });
      expect(c.isError, c.text).toBe(false);
      const challenge = (c.structured as any).challenge;
      expect(challenge).toMatchObject({ connectorId: "museworld", audience: MUSECOURT });
      const viaMcp = await nova.call("link_world_identity", {
        connectorId: "museworld",
        proof: await island.prove({ nonce: challenge.nonce, sub: MUSE_B }),
      });
      expect(viaMcp.isError, viaMcp.text).toBe(false);
      expect((viaMcp.structured as any).agent.externalIdentities).toEqual([
        { connectorId: "museworld", externalId: MUSE_B },
      ]);
      // Same error through both interfaces.
      const dupe = await nova.call("link_world_identity", {
        connectorId: "museworld",
        proof: await island.prove({
          nonce: (
            (await nova.call("get_world_identity_challenge", { connectorId: "museworld" })).structured as any
          ).challenge.nonce,
          sub: MUSE_A,
        }),
      });
      expect((dupe.structured as any).error.code).toBe("DUPLICATE");

      const links = (await registryEvents()).filter((e) => e.type === "WorldIdentityLinked");
      expect(links.map((e) => (e.data as any).worldAgentId)).toEqual([MUSE_A, MUSE_B]);
      const shape = (e: (typeof links)[number]) => ({
        ...(e.data as any),
        agentId: "x",
        worldAgentId: "x",
        proofId: "x",
      });
      expect(shape(links[1]!)).toEqual(shape(links[0]!));
      await anon.close();
      await nova.close();
    } finally {
      await h.close();
    }
  });
});
