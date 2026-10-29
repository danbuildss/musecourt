import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { CourtError } from "@/core/errors";
import type { ApiDeps } from "./app";
import type { Principal } from "./auth";
import { ApiError } from "./errors";
import type { WalletChallengeRecord } from "./stores";

/**
 * Wallet sign-in, for agents that hold a wallet (Bankr agents do): instead of keeping a key, the
 * agent signs a one-time line from MuseCourt with `personal_sign` (EIP-191). Nothing is stored on
 * the agent's side, and nothing moves: a signature is not a transaction. Each line names one
 * wallet, expires in 10 minutes and works once, so a signature that ends up in a public reply is
 * useless to anyone else.
 */

export const WALLET_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const CHALLENGE_ID = /^wch_[A-Za-z0-9_-]{22}$/;

export function normalizeAddress(address: string): string {
  if (!ADDRESS.test(address)) {
    throw new CourtError("VALIDATION_FAILED", "address must be a 0x wallet address.", { field: "address" });
  }
  return address.toLowerCase();
}

/** The exact text the wallet signs. */
export function challengeMessage(
  c: Pick<WalletChallengeRecord, "challengeId" | "address" | "expiresAt">,
): string {
  return [
    "MuseCourt sign-in",
    `Wallet: ${c.address}`,
    `Challenge: ${c.challengeId}`,
    `Expires: ${c.expiresAt}`,
    "Signing this proves you control this wallet. It is not a transaction and moves nothing.",
  ].join("\n");
}

/** The address that made an EIP-191 personal_sign signature over `message`, or null. */
export function recoverSigner(message: string, signature: string): string | null {
  if (!SIGNATURE.test(signature)) return null;
  try {
    const bytes = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}`);
    const digest = keccak_256(new Uint8Array([...prefix, ...bytes]));
    const hex = signature.slice(2);
    let v = parseInt(hex.slice(128, 130), 16);
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    const sig = new secp256k1.Signature(
      BigInt(`0x${hex.slice(0, 64)}`),
      BigInt(`0x${hex.slice(64, 128)}`),
    ).addRecoveryBit(v);
    const publicKey = sig.recoverPublicKey(digest).toRawBytes(false).slice(1);
    return `0x${Buffer.from(keccak_256(publicKey).slice(-20)).toString("hex")}`;
  } catch {
    return null;
  }
}

export async function issueWalletChallenge(deps: ApiDeps, rawAddress: string, now: Date) {
  const address = normalizeAddress(rawAddress);
  if (deps.walletChallengeLimiter && !deps.walletChallengeLimiter.hit(`wallet:${address}`, now)) {
    throw new ApiError("RATE_LIMITED", "Too many sign-in lines for this wallet. Retry later.");
  }
  const record = {
    challengeId: `wch_${randomBytes(16).toString("base64url")}`,
    address,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + WALLET_CHALLENGE_TTL_MS).toISOString(),
  };
  await deps.walletChallenges.insert(record);
  return {
    challengeId: record.challengeId,
    message: challengeMessage(record),
    expiresAt: record.expiresAt,
    signWith: "personal_sign (EIP-191): sign `message` exactly as given.",
  };
}

/**
 * Checks a signed line and uses it up. Returns the wallet that signed it. The signature is checked
 * before the line is used, so a wrong signature never burns someone else's line.
 */
export async function useWalletSignature(
  deps: ApiDeps,
  challengeId: string,
  signature: string,
  now: Date,
): Promise<string | null> {
  if (!CHALLENGE_ID.test(challengeId)) return null;
  const record = await deps.walletChallenges.get(challengeId);
  if (!record || record.usedAt || Date.parse(record.expiresAt) <= now.getTime()) return null;
  if (recoverSigner(challengeMessage(record), signature) !== record.address) return null;
  return (await deps.walletChallenges.claim(challengeId, now)) ? record.address : null;
}

/** As useWalletSignature, but a failure is a validation error naming what to do. */
export async function requireWalletSignature(
  deps: ApiDeps,
  proof: { challengeId: string; signature: string },
  now: Date,
): Promise<string> {
  const address = await useWalletSignature(deps, proof.challengeId, proof.signature, now);
  if (!address) {
    throw new CourtError(
      "VALIDATION_FAILED",
      "The wallet signature is not valid: get a fresh line from POST /api/v1/auth/wallet/challenge, sign its message exactly with personal_sign, and send it within 10 minutes. Each line works once.",
      { field: "wallet" },
    );
  }
  return address;
}

/** `Authorization: Wallet <challengeId>:<signature>`, or null if the header is not a wallet one. */
export function walletAuthorization(
  header: string | null,
): { challengeId: string; signature: string } | null {
  const match = /^Wallet (wch_[A-Za-z0-9_-]+):(0x[0-9a-fA-F]+)$/.exec(header ?? "");
  return match ? { challengeId: match[1]!, signature: match[2]! } : null;
}

/** Signs an agent in by its wallet. Every failure looks identical to the caller. */
export async function authenticateWallet(
  deps: ApiDeps,
  proof: { challengeId: string; signature: string },
  now: Date,
): Promise<Principal> {
  const address = await useWalletSignature(deps, proof.challengeId, proof.signature, now);
  const agentId = address ? await deps.court.agentByWallet(address) : null;
  if (!agentId) {
    throw new ApiError(
      "UNAUTHENTICATED",
      "Missing or invalid credentials. Wallet sign-in: a fresh, correctly signed line from a wallet registered at MuseCourt.",
    );
  }
  return { kind: "agent", agentId, keyId: `wallet:${address}` };
}
