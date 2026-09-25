import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors";
import type { CredentialStore } from "./stores";

/**
 * Agent credentials: `mc_<keyId>_<secret>`.
 *  - keyId: 16 hex chars, public, used to look the credential up.
 *  - secret: 32 random bytes (base64url). Only its SHA-256 is stored; a fast
 *    hash is appropriate because the secret is high-entropy, not a password.
 */

const API_KEY_PATTERN = /^mc_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export interface IssuedCredential {
  keyId: string;
  apiKey: string;
  secretHash: string;
}

export function issueCredential(): IssuedCredential {
  const keyId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { keyId, apiKey: `mc_${keyId}_${secret}`, secretHash: sha256Hex(secret) };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export type Principal =
  { kind: "agent"; agentId: string; keyId: string } | { kind: "admin" } | { kind: "cron" };

const unauthenticated = () => new ApiError("UNAUTHENTICATED", "Missing or invalid credentials.");

/** Resolves `Authorization: Bearer mc_…` to an agent. Every failure looks identical to the caller. */
export async function authenticateAgent(
  request: Request,
  credentials: CredentialStore,
  now: Date,
  agentExists: (agentId: string) => Promise<boolean>,
): Promise<Principal> {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw unauthenticated();
  return authenticateApiKey(match[1]!, credentials, now, agentExists);
}

/** Resolves a raw `mc_…` key to an agent (HTTP bearer tokens and the MCP stdio key alike). */
export async function authenticateApiKey(
  apiKey: string,
  credentials: CredentialStore,
  now: Date,
  agentExists: (agentId: string) => Promise<boolean>,
): Promise<Principal> {
  const parsed = API_KEY_PATTERN.exec(apiKey);
  if (!parsed) throw unauthenticated();
  const [, keyId, secret] = parsed as unknown as [string, string, string];
  const record = await credentials.findByKeyId(keyId);
  if (!record || record.revokedAt || !constantTimeEqualHex(sha256Hex(secret), record.secretHash)) {
    throw unauthenticated();
  }
  // A credential whose registration never completed (e.g. a crash mid-registration) is inert.
  if (!(await agentExists(record.agentId))) throw unauthenticated();
  if (!record.firstUsedAt) await credentials.markUsed(keyId, now);
  return { kind: "agent", agentId: record.agentId, keyId };
}

export const ADMIN_HEADER = "x-musecourt-admin-token";
export const MIN_ADMIN_TOKEN_LENGTH = 32;

/**
 * Cron auth: `Authorization: Bearer <MUSECOURT_CRON_SECRET>` (the header Vercel Cron sends).
 * Accepted only on the internal cron routes, which can do nothing but run the court clock.
 */
export function authenticateCron(request: Request, cronSecret: string | undefined): Principal {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  if (!cronSecret || cronSecret.length < MIN_ADMIN_TOKEN_LENGTH || !match) throw unauthenticated();
  if (!constantTimeEqualHex(sha256Hex(match[1]!), sha256Hex(cronSecret))) throw unauthenticated();
  return { kind: "cron" };
}

/** Admin auth uses its own header and secret; agent keys are never accepted here (and vice versa). */
export function authenticateAdmin(request: Request, adminToken: string | undefined): Principal {
  const presented = request.headers.get(ADMIN_HEADER);
  if (!adminToken || adminToken.length < MIN_ADMIN_TOKEN_LENGTH || !presented) throw unauthenticated();
  if (!constantTimeEqualHex(sha256Hex(presented), sha256Hex(adminToken))) throw unauthenticated();
  return { kind: "admin" };
}
