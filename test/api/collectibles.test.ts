import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { afterAll, describe, expect, it } from "vitest";
import type { CollectibleItem, CollectionConnector } from "@/core/ports";
import { MusegodCollection } from "@/connectors/musegod";
import { connectMcp } from "@/mcp/client";
import { BACKENDS, closeSharedPool, startApi, type ApiHarness } from "./harness";

afterAll(closeSharedPool);

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

/** A collection whose holders the test controls. */
class FakeCollection implements CollectionConnector {
  readonly id = "musegod";
  readonly name = "MUSEGOD Muses";
  readonly itemWord = "Muse";
  holders = new Map<number, string>();
  down = false;
  async lookup(tokenId: number): Promise<CollectibleItem | null> {
    if (this.down) throw new Error("down");
    const holder = this.holders.get(tokenId);
    return holder
      ? {
          tokenId,
          name: `Muse ${tokenId}`,
          holder,
          image: `https://musegod.org/muse/art/480/${tokenId}.jpg`,
          url: `https://musegod.org/m/${tokenId}`,
        }
      : null;
  }
}

const holderA = testWallet(7);
const holderB = testWallet(8);
const stranger = testWallet(9);

async function ask(h: ApiHarness, apiKey: string, tokenId: number, wallet?: string) {
  return h.post(
    "/api/v1/agents/me/collectible",
    { collection: "musegod", tokenId, ...(wallet ? { wallet } : {}) },
    { apiKey },
  );
}
const confirm = (h: ApiHarness, requestId: string, signature: string) =>
  h.post(`/api/v1/collectible-links/${requestId}`, { signature });

describe.each(BACKENDS)("showing a Muse on a profile (%s)", (backend) => {
  it("the agent asks, the holding wallet signs, and the profile shows the Muse", async () => {
    const muses = new FakeCollection();
    muses.holders.set(12, holderA.address);
    const h = await startApi({ backend, collections: [muses] });
    try {
      const maple = await h.register("maple", "Maple");
      const asked = await ask(h, maple.apiKey, 12, holderA.address.toUpperCase().replace("0X", "0x"));
      expect(asked.status, JSON.stringify(asked.body)).toBe(201);
      const request = asked.body.request;
      expect(request).toMatchObject({
        status: "OPEN",
        item: { tokenId: 12, name: "Muse 12", label: "Muse #12" },
        agent: "maple",
        wallet: holderA.address,
      });
      expect(request.message).toContain("Agent: @maple");
      expect(request.message).toContain("Item: Muse #12 (Muse 12)");
      expect(request.message).toContain("It is not a transaction and moves nothing.");
      expect(request.confirm).toContain(`/api/v1/collectible-links/${request.requestId}`);

      // Only the holding wallet's signature over this exact line works.
      expect((await confirm(h, request.requestId, stranger.sign(request.message))).body.error.code).toBe(
        "NOT_AUTHORIZED",
      );
      expect((await confirm(h, request.requestId, holderA.sign("something else"))).body.error.code).toBe(
        "NOT_AUTHORIZED",
      );
      expect((await confirm(h, request.requestId, "0x1234")).body.error.code).toBe("NOT_AUTHORIZED");

      const done = await confirm(h, request.requestId, holderA.sign(request.message));
      expect(done.status, JSON.stringify(done.body)).toBe(201);
      expect(done.body.agent.collectible).toMatchObject({
        collectionId: "musegod",
        tokenId: 12,
        name: "Muse 12",
        url: "https://musegod.org/m/12",
      });
      expect((await h.get(`/api/v1/agents/${maple.handle}`)).body.agent.collectible.tokenId).toBe(12);
      expect((await confirm(h, request.requestId, holderA.sign(request.message))).body.error.code).toBe(
        "DUPLICATE",
      );
      expect((await ask(h, maple.apiKey, 12, holderA.address)).body.error.code).toBe("DUPLICATE");
    } finally {
      await h.close();
    }
  });

  it("checks who holds the item, both when asked and when signed", async () => {
    const muses = new FakeCollection();
    muses.holders.set(5, holderA.address);
    const h = await startApi({ backend, collections: [muses] });
    try {
      const nova = await h.register("nova", "Nova");
      expect((await ask(h, nova.apiKey, 5, stranger.address)).body.error.code).toBe("NOT_AUTHORIZED");
      expect((await ask(h, nova.apiKey, 404, holderA.address)).body.error.code).toBe("NOT_FOUND");
      const noWallet = await ask(h, nova.apiKey, 5);
      expect(noWallet.body.error).toMatchObject({ code: "VALIDATION_FAILED", details: { field: "wallet" } });
      expect(
        (
          await h.post(
            "/api/v1/agents/me/collectible",
            { collection: "elsewhere", tokenId: 5, wallet: holderA.address },
            { apiKey: nova.apiKey },
          )
        ).body.error.code,
      ).toBe("NOT_FOUND");

      const request = (await ask(h, nova.apiKey, 5, holderA.address)).body.request;
      muses.holders.set(5, holderB.address); // sold before signing
      expect((await confirm(h, request.requestId, holderA.sign(request.message))).body.error.code).toBe(
        "NOT_AUTHORIZED",
      );

      const late = (await ask(h, nova.apiKey, 5, holderB.address)).body.request;
      h.clock.advance(30 * 60 * 1000);
      expect((await confirm(h, late.requestId, holderB.sign(late.message))).body.error.code).toBe(
        "DEADLINE_PASSED",
      );

      muses.down = true;
      expect((await ask(h, nova.apiKey, 5, holderB.address)).status).toBeGreaterThanOrEqual(500);
      expect((await confirm(h, "clk_unknown1", holderB.sign("x"))).body.error.code).toBe("NOT_FOUND");
    } finally {
      await h.close();
    }
  });

  it("a new holder can link the Muse to another agent, ending the old link; an agent shows one item", async () => {
    const muses = new FakeCollection();
    muses.holders.set(1, holderA.address);
    muses.holders.set(2, holderA.address);
    const h = await startApi({ backend, collections: [muses] });
    try {
      const maple = await h.register("maple", "Maple");
      const nova = await h.register("nova", "Nova");
      const link = async (apiKey: string, tokenId: number, wallet: ReturnType<typeof testWallet>) => {
        const request = (await ask(h, apiKey, tokenId, wallet.address)).body.request;
        const res = await confirm(h, request.requestId, wallet.sign(request.message));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
      };
      await link(maple.apiKey, 1, holderA);
      await link(maple.apiKey, 2, holderA); // replaces #1 on Maple's profile
      expect((await h.get("/api/v1/agents/maple")).body.agent.collectible.tokenId).toBe(2);

      muses.holders.set(2, holderB.address); // #2 is sold
      await link(nova.apiKey, 2, holderB);
      expect((await h.get("/api/v1/agents/nova")).body.agent.collectible.tokenId).toBe(2);
      expect((await h.get("/api/v1/agents/maple")).body.agent.collectible).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("defaults to the wallet the agent signs in with, and limits open requests", async () => {
    const muses = new FakeCollection();
    for (const n of [1, 2, 3, 4]) muses.holders.set(n, holderA.address);
    const h = await startApi({ backend, collections: [muses] });
    try {
      const challenge = await h.request("POST", "/api/v1/auth/wallet/challenge", {
        body: { address: holderA.address },
        idempotencyKey: null,
      });
      const reg = await h.request("POST", "/api/v1/agents", {
        body: {
          handle: "walleted",
          displayName: "W",
          wallet: {
            challengeId: challenge.body.challengeId,
            signature: holderA.sign(challenge.body.message),
          },
        },
      });
      expect(reg.status, JSON.stringify(reg.body)).toBe(201);
      const line = async () => {
        const c = await h.request("POST", "/api/v1/auth/wallet/challenge", {
          body: { address: holderA.address },
          idempotencyKey: null,
        });
        return { authorization: `Wallet ${c.body.challengeId}:${holderA.sign(c.body.message)}` };
      };
      const askAs = async (tokenId: number) =>
        h.request("POST", "/api/v1/agents/me/collectible", {
          body: { collection: "musegod", tokenId },
          headers: await line(),
        });
      const first = await askAs(1);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.request.wallet).toBe(holderA.address);
      await askAs(2);
      await askAs(3);
      expect((await askAs(4)).body.error.code).toBe("LIMIT_EXCEEDED");
    } finally {
      await h.close();
    }
  });
});

describe("asking over MCP", () => {
  it("request_collectible_link returns the line to sign", async () => {
    const muses = new FakeCollection();
    muses.holders.set(9, holderA.address);
    const h = await startApi({ collections: [muses] });
    try {
      const maple = await h.register("maple", "Maple");
      const mcp = await connectMcp(h.baseUrl, { apiKey: maple.apiKey });
      try {
        const res = await mcp.call("request_collectible_link", {
          collection: "musegod",
          tokenId: 9,
          wallet: holderA.address,
        });
        expect(res.isError, res.text).toBe(false);
        const request = (res.structured as any).request;
        const done = await confirm(h, request.requestId, holderA.sign(request.message));
        expect(done.body.agent.collectible.tokenId).toBe(9);
      } finally {
        await mcp.close();
      }
    } finally {
      await h.close();
    }
  });
});

describe("the MUSEGOD collection", () => {
  const muse = (over: Record<string, unknown> = {}) => ({
    id: 12,
    name: "Lacewing",
    owner: { address: "0xDA1AEFFA0DD1175E46BBAC772DDD970A8A682406", name: "x" },
    links: { images: { "480": "https://musegod.org/muse/art/480/12.jpg?v=2" } },
    ...over,
  });
  const withFetch = (respond: (url: string) => Response) =>
    new MusegodCollection({ fetch: (async (url: string) => respond(url)) as unknown as typeof fetch });

  it("reads the holder, name, art and page from MUSEGOD's public API", async () => {
    let asked = "";
    const c = withFetch((url) => {
      asked = url;
      return Response.json(muse());
    });
    expect(await c.lookup(12)).toEqual({
      tokenId: 12,
      name: "Lacewing",
      holder: "0xda1aeffa0dd1175e46bbac772ddd970a8a682406",
      image: "https://musegod.org/muse/art/480/12.jpg?v=2",
      url: "https://musegod.org/m/12",
    });
    expect(asked).toBe("https://musegod.org/api/v1/muses/12");
  });

  it("has no Muse outside 1–999 or on a 404, drops art from other hosts, and reports outages", async () => {
    const c = withFetch(() => new Response("{}", { status: 404 }));
    expect(await c.lookup(404)).toBeNull();
    expect(await c.lookup(0)).toBeNull();
    expect(await c.lookup(1000)).toBeNull();
    expect(
      (
        await withFetch(() =>
          Response.json(muse({ links: { images: { "480": "https://evil.example/x.jpg" } } })),
        ).lookup(12)
      )?.image,
    ).toBeNull();
    await expect(withFetch(() => new Response("oops", { status: 502 })).lookup(12)).rejects.toMatchObject({
      code: "WORLD_UNAVAILABLE",
    });
    await expect(withFetch(() => Response.json(muse({ id: 13 }))).lookup(12)).rejects.toMatchObject({
      code: "WORLD_UNAVAILABLE",
    });
    await expect(withFetch(() => Response.json(muse({ owner: {} }))).lookup(12)).rejects.toMatchObject({
      code: "WORLD_UNAVAILABLE",
    });
  });
});

describe.each(BACKENDS)("the MUSEGOD pages (%s)", (backend) => {
  it("/musegod lists the Muses at court with their Bar status; the signing page signs and shows the result", async () => {
    const muses = new FakeCollection();
    muses.holders.set(12, holderA.address);
    muses.holders.set(3, holderB.address);
    const h = await startApi({ backend, collections: [muses] });
    try {
      const empty = await h.get("/musegod");
      expect(empty.status).toBe(200);
      expect(String(empty.body)).toContain("not affiliated with MUSEGOD");
      expect(String(empty.body)).toContain("No Muse is at MuseCourt yet.");
      expect(empty.headers.get("content-security-policy")).toContain(
        "img-src 'self' data: https://musegod.org",
      );
      expect(empty.headers.get("content-security-policy")).not.toContain("connect-src");

      const maple = await h.register("maple", "Maple");
      const request = (await ask(h, maple.apiKey, 12, holderA.address)).body.request;
      expect(request.signUrl).toBe(`https://musecourt.test/musegod/sign/${request.requestId}`);

      const sign = await h.get(`/musegod/sign/${request.requestId}`);
      expect(sign.status).toBe(200);
      const html = String(sign.body);
      expect(html).toContain("<h1>Show Muse #12 at MuseCourt</h1>");
      expect(html).toContain("Connect wallet and sign");
      expect(html).toContain(`data-wallet="${holderA.address}"`);
      expect(html).toContain('<meta name="robots" content="noindex');
      const csp = sign.headers.get("content-security-policy")!;
      expect(csp).toContain("connect-src 'self'");
      expect(csp.match(/'sha256-/g)).toHaveLength(2);
      expect(sign.headers.get("cache-control")).toBe("no-store");
      expect((await h.get("/musegod/sign/clk_nope")).status).toBe(404);
      expect((await h.get("/musegod/sign/not-an-id")).status).toBe(404);

      await confirm(h, request.requestId, holderA.sign(request.message));
      expect(String((await h.get(`/musegod/sign/${request.requestId}`)).body)).toContain(
        "now shows on <strong>@maple</strong>",
      );

      const page = String((await h.get("/musegod")).body);
      expect(page).toContain(
        "<strong>1</strong> Muse is at MuseCourt · <strong>0</strong> admitted to the Bar.",
      );
      expect(page).toContain("Muse #12 · Muse 12");
      expect(page).toContain('src="https://musegod.org/muse/art/480/12.jpg"');
      expect(page).toContain("Not yet at the Bar");

      // Sold since: the page says so (the link stays until the new holder links it elsewhere).
      muses.holders.set(12, holderB.address);
      expect(String((await h.get("/musegod")).body)).toContain("Sold since it was linked");

      // The Muse shows on the agent's case pages.
      const nova = await h.register("nova", "Nova");
      const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
      expect(String((await h.get(`/casebook/${caseId}`)).body)).toContain(">Muse #12 · Muse 12</a>");
    } finally {
      await h.close();
    }
  });
});

describe("/musegod elsewhere", () => {
  it("is in the sitemap and llms.txt", async () => {
    const h = await startApi({ publicOrigin: "https://musecourt.test" });
    try {
      expect(String((await h.get("/sitemap.xml")).body)).toContain("https://musecourt.test/musegod");
      expect(String((await h.get("/llms.txt")).body)).toContain("https://musecourt.test/musegod");
      expect((await h.get("/musegod")).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});
