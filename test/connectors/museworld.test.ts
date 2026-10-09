import { describe, expect, it } from "vitest";
import { MuseworldConnector } from "@/connectors/museworld";
import { WorldIdentityProofRejected } from "@/core/ports";
import { ISLAND, MUSECOURT, fakeIsland } from "./fake-island";

const NONCE = "Qm9vdHN0cmFwLWNoYWxsZW5nZQ";
const expected = { audience: MUSECOURT, nonce: NONCE };

async function setup() {
  let now = new Date("2026-10-09T06:00:00.000Z");
  const island = await fakeIsland(() => now);
  const connector = new MuseworldConnector({ baseUrl: ISLAND, fetch: island.fetch, now: () => now });
  return {
    island,
    connector,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorldIdentityProofRejected) return error.reason;
    throw error;
  }
  throw new Error("expected the proof to be rejected");
}

describe("MuseworldConnector.verifyIdentityProof (Museworld Verify, offline)", () => {
  it("accepts a proof signed by the island's current key for our audience and nonce", async () => {
    const { island, connector } = await setup();
    const verified = await connector.verifyIdentityProof(await island.prove({ nonce: NONCE }), expected);
    expect(verified).toMatchObject({
      worldAgentId: "631ac74e-cff2-4098-9f63-37c5d3ca206b",
      proofId: "jti-1",
      ownerRef: "x:p0kadevil86",
      attributes: {
        island: "moonwake",
        username: "p0kadevil",
        standing: "citizen",
        status: "active",
        citizen: true,
      },
    });
    expect(verified.attributes).not.toHaveProperty("wallet");
    expect(Date.parse(verified.expiresAt) - Date.parse(verified.issuedAt)).toBe(600_000);
  });

  it("rejects a proof for another app, another challenge, another issuer or another token type", async () => {
    const { island, connector } = await setup();
    expect(
      await rejection(
        connector.verifyIdentityProof(
          await island.prove({ nonce: NONCE, audience: "https://other.app" }),
          expected,
        ),
      ),
    ).toBe("wrong_audience");
    expect(
      await rejection(
        connector.verifyIdentityProof(await island.prove({ nonce: "another-challenge-123" }), expected),
      ),
    ).toBe("wrong_nonce");
    expect(
      await rejection(
        connector.verifyIdentityProof(
          await island.prove({ nonce: NONCE, iss: "https://evil.example" }),
          expected,
        ),
      ),
    ).toBe("wrong_issuer");
    expect(
      await rejection(
        connector.verifyIdentityProof(
          await island.prove({ nonce: NONCE, typ: "museworld-event+jwt" }),
          expected,
        ),
      ),
    ).toBe("unknown_type");
  });

  it("rejects an expired proof", async () => {
    const { island, connector, advance } = await setup();
    const proof = await island.prove({ nonce: NONCE });
    advance(11 * 60 * 1000);
    expect(await rejection(connector.verifyIdentityProof(proof, expected))).toBe("expired");
  });

  it("only the current key vouches for Muses: a retired key is refused", async () => {
    const { island, connector } = await setup();
    const proof = await island.prove({ nonce: NONCE, key: island.keys.retired });
    expect(await rejection(connector.verifyIdentityProof(proof, expected))).toBe("retired_key");
  });

  it("refetches the key set on an unknown kid, so a rotation is picked up", async () => {
    const { island, connector } = await setup();
    await connector.verifyIdentityProof(await island.prove({ nonce: NONCE }), expected);
    expect(island.jwksFetches).toBe(1);
    const next = await island.rotate();
    const verified = await connector.verifyIdentityProof(
      await island.prove({ nonce: NONCE, key: next }),
      expected,
    );
    expect(verified.worldAgentId).toBeTruthy();
    expect(island.jwksFetches).toBe(2);
    // The previously current key is now retired: it no longer vouches.
    expect(
      await rejection(
        connector.verifyIdentityProof(
          await island.prove({ nonce: NONCE, key: island.keys.current }),
          expected,
        ),
      ),
    ).toBe("retired_key");
  });

  it("rejects an unpublished key and a forged signature", async () => {
    const { island, connector } = await setup();
    expect(
      await rejection(
        connector.verifyIdentityProof(
          await island.prove({ nonce: NONCE, key: island.keys.stranger }),
          expected,
        ),
      ),
    ).toBe("unknown_key");
    // Signed by a stranger but claiming the current kid.
    const forged = await island.prove({ nonce: NONCE, key: island.keys.stranger, kid: "mw-current" });
    expect(await rejection(connector.verifyIdentityProof(forged, expected))).toBe("bad_signature");
  });

  it("rejects malformed tokens and a Muse record that does not match the subject", async () => {
    const { island, connector } = await setup();
    expect(await rejection(connector.verifyIdentityProof("not-a-token", expected))).toBe("malformed");
    const mismatched = await island.prove({ nonce: NONCE, muse: { id: "someone-else" } });
    expect(await rejection(connector.verifyIdentityProof(mismatched, expected))).toBe("malformed");
  });

  it("has no owner reference when the owner hides the handle or has no civic record", async () => {
    const { island, connector } = await setup();
    const hidden = await island.prove({
      nonce: NONCE,
      muse: { civic: { citizen: true, via: "x", since: 1 } },
    });
    expect((await connector.verifyIdentityProof(hidden, expected)).ownerRef).toBeNull();
    const none = await island.prove({ nonce: NONCE, muse: { civic: null, standing: "resident" } });
    expect((await connector.verifyIdentityProof(none, expected)).ownerRef).toBeNull();
  });

  it("links paused Muses and records their status", async () => {
    const { island, connector } = await setup();
    const paused = await island.prove({ nonce: NONCE, muse: { status: "paused" } });
    expect((await connector.verifyIdentityProof(paused, expected)).attributes.status).toBe("paused");
  });

  it("an empty key set or an unreachable island is an outage, not a rejection", async () => {
    const { island, connector } = await setup();
    const proof = await island.prove({ nonce: NONCE });
    island.publish([]);
    await expect(connector.verifyIdentityProof(proof, expected)).rejects.not.toBeInstanceOf(
      WorldIdentityProofRejected,
    );
    island.setReachable(false);
    const fresh = new MuseworldConnector({ baseUrl: ISLAND, fetch: island.fetch });
    await expect(fresh.verifyIdentityProof(proof, expected)).rejects.toThrow(/fetch failed/);
  });

  it("explains how to make a proof without ever sharing the private key", async () => {
    const { connector } = await setup();
    const text = connector.identityProofInstructions(expected);
    expect(text).toContain(`node agent-client.mjs prove ${MUSECOURT} ${NONCE}`);
    expect(text).toMatch(/never share/);
  });

  it("event retrieval is not enabled before Phase 6 M2", async () => {
    const { connector } = await setup();
    await expect(connector.getEvent("452053")).rejects.toThrow(/not enabled yet/);
  });
});
