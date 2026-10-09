import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";

/**
 * TEST-ONLY stand-in for Museworld Verify's signing side: local Ed25519 keys, a key set served
 * through a fake fetch, and proofs, event answers and receipts shaped exactly like the island's
 * (verify.md, 2026-10-09). Tests never call the live island.
 */

/** A real public event's record, captured from the live island on 2026-10-09 (event 452053). */
export const CAPTURED_RECORD = {
  id: 452053,
  at: 1791533486165,
  kind: "work",
  text: "Tansy, Brindle, Rowan and 3 others brought back branches and moonflower pollen for the makers (9 trips).",
  place: "shore",
  placeName: "Sunthread Landing",
  actorId: "27df6210-1f95-41d5-a588-91bebd4e0329",
  actorIds: [
    "faa714d5-cb3e-4c82-90b7-c9d92cb81642",
    "8a2a264c-0e02-42fa-a88b-cd6e71abfb0c",
    "418f9810-6f6a-4918-b9a7-4b5f84e1cc39",
    "cba75a99-5a5f-46ab-9fd7-2a2f8c3de175",
    "resident-6",
    "27df6210-1f95-41d5-a588-91bebd4e0329",
  ],
  group: { key: "gather", count: 9 },
};
export const CAPTURED_MUSES = [
  { id: "27df6210-1f95-41d5-a588-91bebd4e0329", role: "actor", name: "Bob", username: "bob_explorer" },
  { id: "faa714d5-cb3e-4c82-90b7-c9d92cb81642", role: "with", name: "Tansy", username: "tansy" },
];

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
  let verifyCalls = 0;
  let reachable = true;
  /** Archived events by id: the exact record and the readable form. */
  const events = new Map<string, { record: Record<string, unknown>; event: Record<string, unknown> }>();
  /** Receipts whose words were taken down after they were issued (what /v1/verify reports). */
  const takenDown = new Set<string>();
  /** Scripted answers, consumed in order, for one event id. */
  const scripted = new Map<
    string,
    Array<{ status: number; body: unknown; headers?: Record<string, string> }>
  >();
  const issued = new Map<string, string>();

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  async function receiptFor(
    record: Record<string, unknown>,
    options: {
      key?: IslandKey;
      kid?: string;
      sub?: string;
      world?: string;
      island?: string;
      typ?: string;
    } = {},
  ): Promise<string> {
    const key = options.key ?? current;
    return new SignJWT({
      island: options.island ?? "moonwake",
      world: options.world ?? "moonwake-island",
      event: record,
    })
      .setProtectedHeader({
        alg: "EdDSA",
        typ: options.typ ?? "museworld-event+jwt",
        kid: options.kid ?? key.kid,
      })
      .setIssuer(ISLAND)
      .setSubject(options.sub ?? `moonwake-island/events/${String(record.id)}`)
      .setIssuedAt(Math.floor(now().getTime() / 1000))
      .sign(key.privateKey);
  }

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!reachable) throw new TypeError("fetch failed");
    if (url === `${ISLAND}/.well-known/jwks.json`) {
      jwksFetches += 1;
      return json(200, { keys: published.map((k) => k.jwk) });
    }
    const eventMatch = /^https:\/\/museworld\.lol\/v1\/events\/([^/?]+)$/.exec(url);
    if (eventMatch) {
      const id = eventMatch[1]!;
      const next = scripted.get(id)?.shift();
      if (next) return next.body instanceof Response ? next.body : json(next.status, next.body, next.headers);
      const found = events.get(id);
      if (!found) return json(404, { error: "No such event.", code: "EVENT_NOT_FOUND" });
      const receipt = await receiptFor(found.record);
      issued.set(receipt, id);
      return json(200, { event: found.event, record: found.record, receipt });
    }
    if (url === `${ISLAND}/v1/verify` && init?.method === "POST") {
      verifyCalls += 1;
      const { token } = JSON.parse(String(init.body)) as { token: string };
      const id = issued.get(token);
      if (!id) return json(200, { valid: false, reason: "bad_signature", error: "Unknown token." });
      return json(200, {
        valid: true,
        type: "event-receipt",
        claims: {},
        ...(takenDown.has(id) ? { redacted: true } : {}),
      });
    }
    return json(404, { error: "not found", code: "NOT_FOUND" });
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

  /** Archives an event; `record` is what the receipt signs, `event` the readable form. */
  function addEvent(record: Record<string, unknown>, event: Record<string, unknown> = {}) {
    const id = String(record.id);
    events.set(id, {
      record: structuredClone(record),
      event: { id: record.id, island: "moonwake", world: "moonwake-island", visibility: "public", ...event },
    });
  }

  /** The island's operators remove the event's words: new answers are redacted, old receipts report it. */
  function takedown(id: string) {
    const found = events.get(id)!;
    found.record = { ...found.record, text: "Removed by the island's operators." };
    found.event = { ...found.event, summary: "Removed by the island's operators.", redacted: true };
    takenDown.add(id);
  }

  return {
    fetch,
    prove,
    addEvent,
    takedown,
    receiptFor,
    /** Queue raw answers for an event id (served before the archive). */
    script(
      id: string,
      ...answers: Array<{ status: number; body: unknown; headers?: Record<string, string> }>
    ) {
      scripted.set(id, [...(scripted.get(id) ?? []), ...answers]);
    },
    get verifyCalls() {
      return verifyCalls;
    },
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
