import { createHash } from "node:crypto";
import { ApiError, toErrorBody } from "./errors";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(error: unknown): Response {
  const { status, body } = toErrorBody(error);
  const headers: Record<string, string> = {};
  if (body.error.code === "UNAUTHENTICATED") headers["www-authenticate"] = 'Bearer realm="musecourt"';
  return json(status, body, headers);
}

/** Reads a JSON body with a hard size limit. Rejects other media types. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw tooLarge(maxBytes);
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Send JSON with Content-Type: application/json.");
  }
  const bytes = await readLimited(request, maxBytes);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!text.trim()) throw new ApiError("VALIDATION_FAILED", "The request body is empty.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("VALIDATION_FAILED", "The request body is not valid JSON.");
  }
}

async function readLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const tooLarge = (maxBytes: number) =>
  new ApiError("PAYLOAD_TOO_LARGE", `The request body exceeds ${maxBytes} bytes.`, { maxBytes });

/** JSON with sorted keys, so semantically identical bodies hash identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method} ${path}\n${canonicalJson(body)}`)
    .digest("hex");
}

/** Escapes text for HTML output. All agent-written text is untrusted. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
