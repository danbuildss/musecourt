import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";

/**
 * TEST-ONLY stand-in for Museworld Verify's signing side: local Ed25519 keys, a key set served
 * through a fake fetch, and proofs shaped exactly like the island's (verify.md, 2026-10-09).
 * Tests never call the live island.
 */

export const ISLAND = "https://museworld.lol";
export const MUSECOURT = "https://musecourt.test";

interface IslandKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: Record<string, unknown>;
}

async function newKey(kid: string): Promise<IslandKey> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" };
  return { kid, privateKey, jwk };
}

export interface ProveOptions {
  nonce: string;
  audience?: string;
  sub?: string;
  /** Seconds since epoch. */
  iat?: number;
  exp?: number;
  jti?: string;
  iss?: string;
  typ?: string;
  /** Sign with this key (default: the current key). */
  key?: IslandKey;
  /** Put this kid in the header (default: the signing key's). */
  kid?: string;
  muse?: Record<string, unknown>;
}

export async function fakeIsland(now: () => Date = () => new Date()) {
  const current = await newKey("mw-current");
  const retired = await newKey("mw-retired");
  const stranger = await newKey("mw-stranger");
  let published: IslandKey[] = [current, retired];
  let jwksFetches = 0;
  let reachable = true;

  const fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!reachable) throw new TypeError("fetch failed");
    if (url === `${ISLAND}/.well-known/jwks.json`) {
      jwksFetches += 1;
      return new Response(JSON.stringify({ keys: published.map((k) => k.jwk) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not found", code: "NOT_FOUND" }), { status: 404 });
  }) as typeof globalThis.fetch;

  let counter = 0;
  async function prove(options: ProveOptions): Promise<string> {
    const key = options.key ?? current;
    const sub = options.sub ?? "631ac74e-cff2-4098-9f63-37c5d3ca206b";
    const iat = options.iat ?? Math.floor(now().getTime() / 1000);
    const muse = {
      id: sub,
      username: "p0kadevil",
      name: "p0kadevil",
      standing: "citizen",
      civic: { citizen: true, via: "x", handle: "P0kadevil86", since: 1790617380278 },
      publicKey: "A".repeat(43),
      status: "active",
      pageUrl: "https://museworld.lol/m/p0kadevil",
      ...options.muse,
    };
    return new SignJWT({ nonce: options.nonce, island: "moonwake", muse })
      .setProtectedHeader({ alg: "EdDSA", typ: options.typ ?? "muse-proof+jwt", kid: options.kid ?? key.kid })
      .setIssuer(options.iss ?? ISLAND)
      .setSubject(sub)
      .setAudience(options.audience ?? MUSECOURT)
      .setIssuedAt(iat)
      .setExpirationTime(options.exp ?? iat + 600)
      .setJti(options.jti ?? `jti-${++counter}`)
      .sign(key.privateKey);
  }

  return {
    fetch,
    prove,
    keys: { current, retired, stranger },
    /** Publishes a new current key, keeping the old one as retired (a rotation). */
    async rotate(): Promise<IslandKey> {
      const next = await newKey(`mw-next-${Date.now()}`);
      published = [next, ...published];
      return next;
    },
    publish(keys: IslandKey[]) {
      published = keys;
    },
    setReachable(value: boolean) {
      reachable = value;
    },
    get jwksFetches() {
      return jwksFetches;
    },
  };
}
