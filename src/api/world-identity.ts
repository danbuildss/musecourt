import { randomBytes } from "node:crypto";
import { agentActor } from "@/core/actor";
import { CourtError } from "@/core/errors";
import type { ApiDeps } from "./app";
import { ApiError } from "./errors";
import { publicAgent } from "./services";

/**
 * Linking a MuseCourt agent to a world identity (Phase 6, R1), shared by REST and MCP:
 *   1. the agent asks for a one-time challenge (bound to it and to one world connector);
 *   2. its owner has the world issue a proof naming MuseCourt's origin and that challenge;
 *   3. the agent submits the proof; MuseCourt claims the challenge, the connector verifies the
 *      proof, and the core links the identity.
 * Challenges are operational state, never court record. No court rules live here.
 */

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** Generous cap on a proof token; real ones are a few hundred bytes. */
export const MAX_PROOF_LENGTH = 16_384;

function requireOrigin(deps: ApiDeps): string {
  const origin = deps.publicOrigin;
  if (!origin) {
    throw new ApiError(
      "NOT_FOUND",
      "World identity linking is not enabled on this server (no public origin).",
    );
  }
  return origin;
}

function requireIdentityConnector(deps: ApiDeps, connectorId: string): void {
  if (!deps.court.supportsWorldIdentity(connectorId)) {
    throw new CourtError("VALIDATION_FAILED", `World ${connectorId} cannot verify identities here.`, {
      field: "connectorId",
      connectorId,
    });
  }
}

export async function issueWorldIdentityChallenge(
  deps: ApiDeps,
  agentId: string,
  connectorId: string,
  now: Date,
) {
  const audience = requireOrigin(deps);
  requireIdentityConnector(deps, connectorId);
  // 128 random bits as base64url: 22 characters of [A-Za-z0-9_-], within every world's nonce rules so far.
  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
  await deps.worldChallenges.insert({
    nonce,
    agentId,
    connectorId,
    audience,
    createdAt: now.toISOString(),
    expiresAt,
  });
  return {
    challenge: {
      connectorId,
      audience,
      nonce,
      expiresAt,
      instructions:
        deps.court.worldIdentityInstructions(connectorId, { audience, nonce }) ??
        "Have your world issue an identity proof for this audience and nonce, then submit it.",
    },
  };
}

/** Reads the `nonce` claim of a compact JWS without trusting it: only to find the challenge. */
function peekNonce(proof: string): string {
  const malformed = () =>
    new CourtError("VALIDATION_FAILED", "The proof is not a well-formed token.", { field: "proof" });
  const parts = proof.split(".");
  if (parts.length !== 3) throw malformed();
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw malformed();
  }
  const nonce = (payload as { nonce?: unknown } | null)?.nonce;
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 256) throw malformed();
  return nonce;
}

export async function linkWorldIdentity(
  deps: ApiDeps,
  agentId: string,
  input: { connectorId: string; proof: string },
  now: Date,
) {
  requireOrigin(deps);
  requireIdentityConnector(deps, input.connectorId);
  if (input.proof.length > MAX_PROOF_LENGTH) {
    throw new CourtError("VALIDATION_FAILED", "The proof is too large.", { field: "proof" });
  }
  const nonce = peekNonce(input.proof);
  // Claim first, verify second: a challenge is single-use even if verification then fails, so
  // concurrent or repeated submissions of one proof can never both succeed.
  const claimed = await deps.worldChallenges.claim(nonce, agentId, input.connectorId, now);
  if (claimed.kind !== "CLAIMED") {
    const message = {
      NOT_FOUND:
        "This proof does not answer a challenge issued to you for this world. Ask for a new challenge.",
      USED: "That challenge was already used. Ask for a new challenge.",
      EXPIRED: "That challenge has expired. Ask for a new challenge.",
    }[claimed.kind];
    throw new CourtError("VALIDATION_FAILED", message, {
      field: "proof",
      reason: `challenge_${claimed.kind.toLowerCase()}`,
    });
  }
  const agent = await deps.court.linkWorldIdentity(agentActor(agentId), {
    connectorId: input.connectorId,
    proof: input.proof,
    audience: claimed.record.audience,
    nonce,
  });
  const row = (await deps.readModels.getAgent(agent.agentId))!;
  return { agent: { ...publicAgent(row), ownerRef: row.ownerRef } };
}

/** Validates MUSECOURT_ORIGIN: an exact origin such as https://musecourt.example (no path, no slash). */
export function publicOriginFrom(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new Error(`MUSECOURT_ORIGIN is not a valid URL: ${value}`);
  }
  if (origin !== value || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(
      `MUSECOURT_ORIGIN must be an exact origin like https://musecourt.example (got ${value}).`,
    );
  }
  return origin;
}
