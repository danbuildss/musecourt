import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { afterAll, describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "@/api/rate-limit";
import { recoverSigner } from "@/api/wallet";
import { BACKENDS, castOfFive, closeSharedPool, startApi, type ApiHarness } from "./harness";

afterAll(closeSharedPool);

/** A test wallet that signs like Bankr does: personal_sign (EIP-191). */
function testWallet(seed: number) {
  const privateKey = new Uint8Array(32).fill(seed);
  const publicKey = secp256k1.getPublicKey(privateKey, false).slice(1);
  const address = `0x${Buffer.from(keccak_256(publicKey).slice(-20)).toString("hex")}`;
  const sign = (message: string) => {
    const bytes = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}`);
    const sig = secp256k1.sign(keccak_256(new Uint8Array([...prefix, ...bytes])), privateKey);
    return `0x${sig.toCompactHex()}${(27 + sig.recovery).toString(16)}`;
  };
  return { address, sign };
}

type Wallet = ReturnType<typeof testWallet>;

/** A fresh signed line for this wallet. */
async function signedLine(h: ApiHarness, wallet: Wallet) {
  const res = await h.request("POST", "/api/v1/auth/wallet/challenge", {
    body: { address: wallet.address },
    idempotencyKey: null,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { challengeId: res.body.challengeId as string, signature: wallet.sign(res.body.message) };
}

const walletHeader = (line: { challengeId: string; signature: string }) => ({
  authorization: `Wallet ${line.challengeId}:${line.signature}`,
});

async function registerByWallet(h: ApiHarness, wallet: Wallet, handle: string) {
  return h.request("POST", "/api/v1/agents", {
    body: { handle, displayName: handle, wallet: await signedLine(h, wallet) },
  });
}

describe("wallet signatures", () => {
  it("recovers the wallet from a real Bankr signature posted on X", () => {
    const signature =
      "0x8e72adfd225c2e2e00b290a1743a403703edc3a3242a3d995ea22edd57ce7ff251f7f6bb684e07f9f0afb2574a19584e5935775e11e806ebaa9427af194d2e951b";
    expect(recoverSigner("MuseCourt test 123", signature)).toBe("0xb98f0de777eea8c481b64e33d3e0066cea38fa91");
    expect(recoverSigner("MuseCourt test 124", signature)).not.toBe(
      "0xb98f0de777eea8c481b64e33d3e0066cea38fa91",
    );
    expect(recoverSigner("x", "0xnot-a-signature")).toBeNull();
  });
});

describe.each(BACKENDS)("wallet sign-in (%s)", (backend) => {
  it("registers with a signed line and no key, then acts with a fresh line each time", async () => {
    const h = await startApi({ backend });
    try {
      const wallet = testWallet(7);
      const challenge = await h.request("POST", "/api/v1/auth/wallet/challenge", {
        body: { address: wallet.address.toUpperCase().replace("0X", "0x") },
        idempotencyKey: null,
      });
      expect(challenge.body.message).toContain(`Wallet: ${wallet.address}`);
      expect(challenge.body.message).toContain("It is not a transaction and moves nothing.");

      const res = await registerByWallet(h, wallet, "danbuildss");
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.credential).toBeNull();
      expect(res.body.signIn).toMatchObject({ kind: "wallet", wallet: wallet.address });
      expect(JSON.stringify(res.body)).not.toContain("mc_");

      const me = await h.request("GET", "/api/v1/agents/me", {
        headers: walletHeader(await signedLine(h, wallet)),
      });
      expect(me.status).toBe(200);
      expect(me.body.agent.handle).toBe("danbuildss");

      // A real write, signed in by wallet.
      const { nova } = await castOfFive(h);
      const jurisdictionId = (await h.get("/api/v1/jurisdictions")).body.jurisdictions[0].jurisdictionId;
      const filed = await h.request("POST", "/api/v1/cases", {
        headers: walletHeader(await signedLine(h, wallet)),
        body: {
          jurisdictionId,
          defendant: nova.handle,
          complaint: "Practice case. Nova promised 1 USDC by 18:00 UTC and never paid.",
          lawIds: ["agreements"],
        },
      });
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      expect(filed.body.case.parties.plaintiff.handle).toBe("danbuildss");
    } finally {
      await h.close();
    }
  });

  it("a line works once, for its own wallet, within 10 minutes; a bad signature doesn't use it up", async () => {
    const h = await startApi({ backend });
    try {
      const wallet = testWallet(7);
      const stranger = testWallet(9);
      expect((await registerByWallet(h, wallet, "danbuildss")).status).toBe(201);

      const line = await signedLine(h, wallet);
      const forged = { challengeId: line.challengeId, signature: stranger.sign("anything") };
      expect((await h.request("GET", "/api/v1/agents/me", { headers: walletHeader(forged) })).status).toBe(
        401,
      );
      expect((await h.request("GET", "/api/v1/agents/me", { headers: walletHeader(line) })).status).toBe(200);
      // Seen in a public reply, the same signature is now useless.
      const replayed = await h.request("GET", "/api/v1/agents/me", { headers: walletHeader(line) });
      expect(replayed.status).toBe(401);
      expect(replayed.body.error.code).toBe("UNAUTHENTICATED");

      const late = await signedLine(h, wallet);
      h.clock.advance(10 * 60 * 1000);
      expect((await h.request("GET", "/api/v1/agents/me", { headers: walletHeader(late) })).status).toBe(401);

      // A wallet no agent signs in with gets nowhere.
      const unknown = await signedLine(h, stranger);
      expect((await h.request("GET", "/api/v1/agents/me", { headers: walletHeader(unknown) })).status).toBe(
        401,
      );
    } finally {
      await h.close();
    }
  });

  it("an agent with a key links its wallet once; a wallet belongs to one agent", async () => {
    const h = await startApi({ backend });
    try {
      const { maple, nova } = await castOfFive(h);
      const wallet = testWallet(5);
      const linked = await h.post("/api/v1/agents/me/wallet", await signedLine(h, wallet), {
        apiKey: maple.apiKey,
      });
      expect(linked.status, JSON.stringify(linked.body)).toBe(200);
      expect(linked.body.signIn.wallet).toBe(wallet.address);
      const me = await h.request("GET", "/api/v1/agents/me", {
        headers: walletHeader(await signedLine(h, wallet)),
      });
      expect(me.body.agent.handle).toBe(maple.handle);
      // The key still works too.
      expect((await h.get("/api/v1/agents/me", { apiKey: maple.apiKey })).status).toBe(200);

      const again = await h.post("/api/v1/agents/me/wallet", await signedLine(h, testWallet(6)), {
        apiKey: maple.apiKey,
      });
      expect(again.body.error.code).toBe("DUPLICATE");
      const taken = await h.post("/api/v1/agents/me/wallet", await signedLine(h, wallet), {
        apiKey: nova.apiKey,
      });
      expect(taken.body.error.code).toBe("DUPLICATE");
      expect((await registerByWallet(h, wallet, "someone-else")).body.error.code).toBe("DUPLICATE");

      const unsigned = await h.post(
        "/api/v1/agents/me/wallet",
        { challengeId: (await signedLine(h, testWallet(8))).challengeId, signature: "0x00" },
        { apiKey: nova.apiKey },
      );
      expect(unsigned.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it("finds an agent by the wallet it signs in with, without showing the wallet", async () => {
    const h = await startApi({ backend });
    try {
      const { maple } = await castOfFive(h);
      const wallet = testWallet(7);
      expect((await registerByWallet(h, wallet, "jake")).status).toBe(201);

      for (const ref of [wallet.address, wallet.address.toUpperCase().replace("0X", "0x")]) {
        const found = await h.get(`/api/v1/agents/${ref}`);
        expect(found.status, JSON.stringify(found.body)).toBe(200);
        expect(found.body.agent.handle).toBe("jake");
        expect(JSON.stringify(found.body)).not.toContain(wallet.address.slice(2));
      }
      const unknown = await h.get(`/api/v1/agents/${testWallet(9).address}`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe("NOT_FOUND");

      // A case names its defendant by wallet just as well, and lands on the handle.
      const jurisdictionId = (await h.get("/api/v1/jurisdictions")).body.jurisdictions[0].jurisdictionId;
      const filed = await h.post(
        "/api/v1/cases",
        {
          jurisdictionId,
          defendant: wallet.address,
          complaint: "Practice case. Jake promised 1 USDC by 13:00 UTC and never paid.",
          lawIds: ["agreements"],
        },
        { apiKey: maple.apiKey },
      );
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      expect(filed.body.case.parties.defendant.handle).toBe("jake");
    } finally {
      await h.close();
    }
  });

  it("wallet registrations are limited per wallet, not per server address (Bankr agents share one)", async () => {
    const h = await startApi({ backend, registrationLimiter: new FixedWindowRateLimiter(1, 60 * 60 * 1000) });
    try {
      expect((await h.post("/api/v1/agents", { handle: "keyed-one" })).status).toBe(201);
      expect((await h.post("/api/v1/agents", { handle: "keyed-two" })).status).toBe(429);
      for (let i = 1; i <= 3; i++) {
        expect((await registerByWallet(h, testWallet(10 + i), `bankr-user-${i}`)).status).toBe(201);
      }
      const bad = await h.request("POST", "/api/v1/auth/wallet/challenge", {
        body: { address: "0x123" },
        idempotencyKey: null,
      });
      expect(bad.status).toBe(400);
    } finally {
      await h.close();
    }
  });
});
