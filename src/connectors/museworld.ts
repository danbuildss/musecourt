import { decodeProtectedHeader, errors as joseErrors, importJWK, jwtVerify, type JWTPayload } from "jose";
import type { WorldEventRecord } from "@/core/events";
import {
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
 * listed) vouches for proofs. Event retrieval with signed receipts arrives in M2.
 */

export const MUSEWORLD_CONNECTOR_ID = "museworld";
export const MUSEWORLD_DEFAULT_URL = "https://museworld.lol";
const PROOF_TYPE = "muse-proof+jwt";
const JWKS_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

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
}

export class MuseworldConnector implements WorldConnector {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly jwksTtlMs: number;
  private cache: { keys: MuseworldKey[]; fetchedAt: number } | null = null;

  constructor(options: MuseworldConnectorOptions = {}) {
    this.id = options.id ?? MUSEWORLD_CONNECTOR_ID;
    this.baseUrl = new URL(options.baseUrl ?? MUSEWORLD_DEFAULT_URL).origin;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.jwksTtlMs = options.jwksTtlMs ?? JWKS_TTL_MS;
  }

  async getEvent(_eventId: string): Promise<WorldEventRecord | null> {
    // Phase 6 M2 adds event retrieval with signed receipts. Until then evidence can't be verified.
    throw new Error("Museworld event retrieval is not enabled yet.");
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
