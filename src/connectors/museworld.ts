import { isDeepStrictEqual } from "node:util";
import { decodeProtectedHeader, errors as joseErrors, importJWK, jwtVerify, type JWTPayload } from "jose";
import type { WorldEventRecord } from "@/core/events";
import {
  WorldEventNotKept,
  WorldIdentityProofRejected,
  type VerifiedWorldIdentity,
  type WorldConnector,
  type WorldProofExpectation,
} from "@/core/ports";

/**
 * Museworld, through Museworld Verify (https://museworld.lol/verify.md).
 *
 * Identity (Phase 6, M1): a Muse asks the island for a proof naming MuseCourt's origin and a
 * one-time challenge; the proof is a compact JWS (EdDSA/Ed25519, typ `muse-proof+jwt`) signed by
 * the island. It is checked offline against the island's key set: only the current key (the first
 * listed) vouches for proofs.
 *
 * Evidence (Phase 6, M2): `GET /v1/events/<id>` returns the event, its exact record and a receipt
 * (a JWS, typ `museworld-event+jwt`) signing that record. The receipt is verified offline against
 * any published key (retired keys still vouch for receipts) and the admitted snapshot is built from
 * the signed record only. Takedowns are re-checked with `POST /v1/verify`, which works for any
 * receipt we hold, even after the island stops keeping the event.
 */

export const MUSEWORLD_CONNECTOR_ID = "museworld";
export const MUSEWORLD_DEFAULT_URL = "https://museworld.lol";
export const MUSEWORLD_DEFAULT_WORLD = "moonwake-island";
export const MUSEWORLD_DEFAULT_ISLAND = "moonwake";
const PROOF_TYPE = "muse-proof+jwt";
const RECEIPT_TYPE = "museworld-event+jwt";
const JWKS_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
/** Generous caps: a real event answer is a few kilobytes. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RECEIPT_LENGTH = 64 * 1024;
const PENDING_RETRY_MAX_MS = 5_000;
/** Kinds whose summary may quote words a Muse wrote (verify.md, "What a receipt proves"). */
const MUSE_WORDS_KINDS = new Set(["agency", "story", "notice", "note"]);
export const MUSE_WORDS_NOTE = "The island records that these words were written, not that they are true.";
/** Museworld event ids are positive integers. */
const EVENT_ID = /^[1-9][0-9]{0,15}$/;

interface MuseworldKey {
  kid: string;
  x: string;
}

export interface MuseworldConnectorOptions {
  /** The island's origin (default https://museworld.lol); also the proofs' issuer. */
  baseUrl?: string;
  /** Connector id (default `museworld`). */
  id?: string;
  fetch?: typeof fetch;
  /** Injected time, for expiry checks. */
  now?: () => Date;
  jwksTtlMs?: number;
  /** The world and island receipts must name (defaults: moonwake-island, moonwake). */
  world?: string;
  island?: string;
  /** Injected wait, for the one retry of a pending event. */
  sleep?: (ms: number) => Promise<void>;
}

export class MuseworldConnector implements WorldConnector {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly jwksTtlMs: number;
  private readonly world: string;
  private readonly island: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private cache: { keys: MuseworldKey[]; fetchedAt: number } | null = null;

  constructor(options: MuseworldConnectorOptions = {}) {
    this.id = options.id ?? MUSEWORLD_CONNECTOR_ID;
    this.baseUrl = new URL(options.baseUrl ?? MUSEWORLD_DEFAULT_URL).origin;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.jwksTtlMs = options.jwksTtlMs ?? JWKS_TTL_MS;
    this.world = options.world ?? MUSEWORLD_DEFAULT_WORLD;
    this.island = options.island ?? MUSEWORLD_DEFAULT_ISLAND;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * One public event, authenticated by its receipt. Null if the island has no such event; throws
   * WorldEventNotKept past retention; throws (unavailable) on outages, a missing receipt or a
   * receipt that does not verify. Unsigned evidence is never admitted.
   */
  async getEvent(eventId: string): Promise<WorldEventRecord | null> {
    if (!EVENT_ID.test(eventId)) return null;
    let res = await this.request(`/v1/events/${eventId}`);
    if (res.status === 404 && (await errorCode(res.clone())) === "EVENT_PENDING") {
      // Still being written to the island's journal: wait as asked, once.
      const retryAfter = Number(res.headers.get("retry-after"));
      await this.sleep(Math.min(PENDING_RETRY_MAX_MS, retryAfter > 0 ? retryAfter * 1000 : 2000));
      res = await this.request(`/v1/events/${eventId}`);
      if (res.status === 404 && (await errorCode(res.clone())) === "EVENT_PENDING") {
        throw new Error(`Museworld event ${eventId} is still being written.`);
      }
    }
    if (res.status === 404) return null;
    if (res.status === 410) throw new WorldEventNotKept(`Museworld no longer keeps event ${eventId}.`);
    if (!res.ok) throw new Error(`Museworld events answered ${res.status}.`);

    const body = (await readJson(res)) as { event?: unknown; record?: unknown; receipt?: unknown };
    const record = asObject(body.record);
    if (!record || String(record.id) !== eventId) throw new Error("Museworld returned a different event.");
    if (typeof body.receipt !== "string" || body.receipt.length > MAX_RECEIPT_LENGTH) {
      throw new Error(`Museworld event ${eventId} came without a usable receipt.`);
    }
    const { keyId } = await this.verifyReceipt(body.receipt, eventId, record);
    const readable = asObject(body.event) ?? {};
    return this.snapshot(eventId, record, readable, { format: "jws", token: body.receipt, keyId });
  }

  /** Has the island taken down this event's words since we admitted it? */
  async recheckEvent(record: WorldEventRecord): Promise<{ redacted: boolean }> {
    if (record.redacted) return { redacted: true };
    if (!record.proof) throw new Error("No receipt to re-check this event with.");
    const res = await this.request("/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token: record.proof.token }),
    });
    if (!res.ok) throw new Error(`Museworld verify answered ${res.status}.`);
    const body = (await readJson(res)) as { valid?: unknown; redacted?: unknown; reason?: unknown };
    if (body.valid !== true)
      throw new Error(`Museworld no longer verifies this receipt (${String(body.reason)}).`);
    return { redacted: body.redacted === true };
  }

  private async verifyReceipt(receipt: string, eventId: string, record: Record<string, unknown>) {
    let header;
    try {
      header = decodeProtectedHeader(receipt);
    } catch {
      throw new Error("The event receipt is not a well-formed token.");
    }
    if (header.alg !== "EdDSA" || header.typ !== RECEIPT_TYPE || typeof header.kid !== "string") {
      throw new Error("The event receipt is not a Museworld event receipt.");
    }
    let keys = await this.keys();
    if (!keys.some((k) => k.kid === header.kid)) keys = await this.keys(true);
    // Any published key vouches for receipts, retired ones included.
    const key = keys.find((k) => k.kid === header.kid);
    if (!key) throw new Error("The event receipt was signed with a key the island does not publish.");
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(
        receipt,
        await importJWK({ kty: "OKP", crv: "Ed25519", x: key.x }, "EdDSA"),
        {
          issuer: this.baseUrl,
          subject: `${this.world}/events/${eventId}`,
          typ: RECEIPT_TYPE,
          algorithms: ["EdDSA"],
          currentDate: this.now(),
        },
      ));
    } catch (error) {
      throw new Error(`The event receipt does not verify: ${(error as Error).message}`, { cause: error });
    }
    if (payload.world !== this.world || payload.island !== this.island) {
      throw new Error("The event receipt names a different world.");
    }
    if (!isDeepStrictEqual(payload.event, record)) {
      throw new Error("The event record does not match its receipt.");
    }
    return { keyId: key.kid };
  }

  /** The admitted snapshot: built from the signed record; only ids and roles come from the readable form. */
  private snapshot(
    eventId: string,
    record: Record<string, unknown>,
    readable: Record<string, unknown>,
    proof: NonNullable<WorldEventRecord["proof"]>,
  ): WorldEventRecord {
    const kind = typeof record.kind === "string" ? record.kind : "unknown";
    const text = typeof record.text === "string" ? record.text : "";
    const at = typeof record.at === "number" ? new Date(record.at) : new Date(NaN);
    const redacted = readable.redacted === true || record.redacted === true;
    const muses = Array.isArray(readable.muses)
      ? readable.muses.flatMap((m) => {
          const muse = asObject(m);
          return muse && typeof muse.id === "string" && typeof muse.role === "string"
            ? [{ id: muse.id, role: muse.role }]
            : [];
        })
      : [];
    return {
      eventId,
      type: kind,
      occurredAt: Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString(),
      actorWorldId: typeof record.actorId === "string" ? record.actorId : null,
      summary: !redacted && MUSE_WORDS_KINDS.has(kind) ? `${text} (${MUSE_WORDS_NOTE})` : text,
      data: { world: this.world, island: this.island, muses, record },
      proof,
      ...(redacted ? { redacted: true } : {}),
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchFn(`${this.baseUrl}${path}`, {
      headers: { accept: "application/json" },
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  identityProofInstructions({ audience, nonce }: WorldProofExpectation): string {
    return [
      `Ask your Muse's owner to have the Muse prove itself to MuseCourt: node agent-client.mjs prove ${audience} ${nonce}`,
      `(or POST ${this.baseUrl}/v1/me/proofs {"audience":"${audience}","nonce":"${nonce}"} with the Muse's usual request signature).`,
      "Then submit the proof with link_world_identity (REST: POST /api/v1/agents/me/world-identity) within 10 minutes.",
      "A proof never needs the Muse's private key or identity file: never share them with anyone.",
    ].join(" ");
  }

  async verifyIdentityProof(proof: string, expected: WorldProofExpectation): Promise<VerifiedWorldIdentity> {
    let header;
    try {
      header = decodeProtectedHeader(proof);
    } catch {
      throw reject("malformed", "The proof is not a well-formed token.");
    }
    if (header.alg !== "EdDSA") throw reject("wrong_algorithm", "The proof must be signed with EdDSA.");
    if (header.typ !== PROOF_TYPE)
      throw reject("unknown_type", `The token is not a Muse proof (${PROOF_TYPE}).`);
    if (typeof header.kid !== "string") throw reject("unknown_key", "The proof names no signing key.");

    let keys = await this.keys();
    if (!keys.some((k) => k.kid === header.kid)) keys = await this.keys(true);
    if (keys.length === 0) throw new Error("Museworld is not signing proofs right now (empty key set).");
    const current = keys[0]!;
    if (header.kid !== current.kid) {
      throw keys.some((k) => k.kid === header.kid)
        ? reject(
            "retired_key",
            "The proof was signed with a retired key; only the island's current key vouches for Muses.",
          )
        : reject("unknown_key", "The proof was signed with a key the island does not publish.");
    }

    let payload: JWTPayload;
    try {
      const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: current.x }, "EdDSA");
      ({ payload } = await jwtVerify(proof, key, {
        issuer: this.baseUrl,
        audience: expected.audience,
        typ: PROOF_TYPE,
        algorithms: ["EdDSA"],
        currentDate: this.now(),
        requiredClaims: ["sub", "exp", "jti"],
      }));
    } catch (error) {
      throw rejectionFor(error);
    }
    if (payload.nonce !== expected.nonce)
      throw reject("wrong_nonce", "The proof answers a different challenge.");

    const muse = (payload.muse ?? {}) as Record<string, unknown>;
    const sub = payload.sub!;
    if (typeof muse.id !== "string" || muse.id !== sub) {
      throw reject("malformed", "The proof's Muse record does not match its subject.");
    }
    const civic = (muse.civic ?? null) as { via?: unknown; handle?: unknown; citizen?: unknown } | null;
    const ownerRef =
      civic && typeof civic.via === "string" && typeof civic.handle === "string" && civic.handle
        ? `${civic.via}:${civic.handle.toLowerCase()}`
        : null;
    return {
      worldAgentId: sub,
      proofId: String(payload.jti),
      issuedAt: new Date((payload.iat ?? 0) * 1000).toISOString(),
      expiresAt: new Date(payload.exp! * 1000).toISOString(),
      ownerRef,
      attributes: pick({
        island: payload.island,
        username: muse.username,
        name: muse.name,
        standing: muse.standing,
        status: muse.status,
        citizen: civic?.citizen === true,
        publicKey: muse.publicKey,
        pageUrl: muse.pageUrl,
      }),
    };
  }

  /** The island's key set, cached briefly; `force` refetches (an unknown kid means rotation). */
  private async keys(force = false): Promise<MuseworldKey[]> {
    const fresh = this.cache && Date.now() - this.cache.fetchedAt < this.jwksTtlMs;
    if (fresh && !force) return this.cache!.keys;
    const res = await this.fetchFn(`${this.baseUrl}/.well-known/jwks.json`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Museworld key set answered ${res.status}.`);
    const body = (await res.json()) as { keys?: unknown };
    const keys = (Array.isArray(body.keys) ? body.keys : []).flatMap((k): MuseworldKey[] => {
      const key = k as Record<string, unknown>;
      return key.kty === "OKP" &&
        key.crv === "Ed25519" &&
        typeof key.x === "string" &&
        typeof key.kid === "string"
        ? [{ kid: key.kid, x: key.x }]
        : [];
    });
    this.cache = { keys, fetchedAt: Date.now() };
    return keys;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("Museworld's answer was unexpectedly large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Museworld's answer was not JSON.");
  }
}

async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = asObject(await readJson(res));
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

const reject = (reason: string, message: string) => new WorldIdentityProofRejected(reason, message);

function rejectionFor(error: unknown): WorldIdentityProofRejected {
  if (error instanceof joseErrors.JWTExpired)
    return reject("expired", "The proof has expired. Ask for a new one.");
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return reject("bad_signature", "The proof's signature does not verify.");
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    const reasons: Record<string, [string, string]> = {
      aud: ["wrong_audience", "The proof was issued for a different app."],
      iss: ["wrong_issuer", "The proof was not issued by Museworld."],
      typ: ["unknown_type", "The token is not a Muse proof."],
      nbf: ["not_yet_valid", "The proof is not valid yet."],
      iat: ["malformed", "The proof's issue time is invalid."],
    };
    const [reason, message] = reasons[error.claim] ?? [
      "malformed",
      `The proof's ${error.claim} claim is invalid.`,
    ];
    return reject(reason, message);
  }
  return reject("malformed", "The proof is not a valid Muse proof.");
}

/** Drops undefined fields so stored attributes stay clean. */
function pick(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

/** The connector as deployed: MUSEWORLD_URL, MUSEWORLD_WORLD and MUSEWORLD_ISLAND (all optional). */
export function museworldConnectorFromEnv(env: NodeJS.ProcessEnv = process.env): MuseworldConnector {
  return new MuseworldConnector({
    baseUrl: env.MUSEWORLD_URL || undefined,
    world: env.MUSEWORLD_WORLD || undefined,
    island: env.MUSEWORLD_ISLAND || undefined,
  });
}
