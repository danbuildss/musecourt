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
  /** USD cost of this call, only if the provider reports it in the response. */
  costUsd?: number;
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

/** Wraps a ChatModel and records calls, tokens, latency, reported cost and errors. */
export class MeteredChatModel implements ChatModel {
  readonly usage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    reportedCostUsd: 0,
    costReportedCalls: 0,
    errors: {} as Record<string, number>,
  };

  constructor(private readonly inner: ChatModel) {}

  get id() {
    return this.inner.id;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    try {
      const response = await this.inner.complete(request);
      this.usage.calls += 1;
      this.usage.inputTokens += response.usage.inputTokens;
      this.usage.outputTokens += response.usage.outputTokens;
      this.usage.latencyMs += response.latencyMs;
      if (typeof response.costUsd === "number") {
        this.usage.reportedCostUsd += response.costUsd;
        this.usage.costReportedCalls += 1;
      }
      return response;
    } catch (error) {
      const kind = error instanceof ModelError ? error.kind : "UNKNOWN";
      this.usage.errors[kind] = (this.usage.errors[kind] ?? 0) + 1;
      throw error;
    }
  }
}

/** Provider-neutral view of spend, for reports. Every method may return null when the provider doesn't expose it. */
export interface CostMeter {
  /** Current spendable balance in USD. */
  balanceUsd(): Promise<number | null>;
  /**
   * Per-token USD prices for a model, plus the provider's raw pricing entry so
   * a human can verify the interpretation.
   */
  pricing(
    model: string,
  ): Promise<{ inputPerToken: number | null; outputPerToken: number | null; raw: unknown } | null>;
}
