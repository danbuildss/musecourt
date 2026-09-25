/**
 * Provider-neutral chat model port. Adapters (e.g. src/model/bankr.ts) implement
 * it; nothing outside src/model knows which provider is behind it.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export type ModelErrorKind =
  | "AUTH" // bad or missing key
  | "CREDITS" // out of credits or over the daily budget
  | "MODEL_UNAVAILABLE" // unknown or retired model
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "UPSTREAM" // 5xx, network failure, timeout
  | "BAD_RESPONSE"; // unparseable provider response

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ModelError";
  }

  get retryable(): boolean {
    return this.kind === "RATE_LIMITED" || this.kind === "UPSTREAM";
  }
}

export interface ChatModel {
  readonly id: string;
  complete(request: ChatRequest): Promise<ChatResponse>;
}

/**
 * Extracts the first JSON object from model text (tolerates code fences and
 * surrounding prose). Returns null if there is none. Never evaluates anything.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
