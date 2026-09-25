import { ModelError, type ChatModel, type ChatRequest, type ChatResponse } from "./chat";

/**
 * Bankr LLM Gateway adapter. Implemented strictly against Bankr's documented
 * interface (BankrBot/skills, bankr/references/llm-gateway.md):
 *  - base URL https://llm.bankr.bot/v1, OpenAI-compatible POST /chat/completions
 *  - auth: Authorization: Bearer <key>; key from BANKR_LLM_KEY, else BANKR_API_KEY
 *  - errors: 401 auth, 402 credits/daily budget, 410 retired model, 422, 429
 * Tool calling and response_format are not documented there, so they are not used.
 */

export const BANKR_DEFAULT_BASE_URL = "https://llm.bankr.bot/v1";
/** A model id listed in Bankr's documented model table. Override with MUSECOURT_MODEL. */
export const BANKR_DEFAULT_MODEL = "gpt-5.4";

export interface BankrOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

interface CompletionBody {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string } | string;
}

export class BankrChatModel implements ChatModel {
  readonly id: string;
  private readonly baseUrl: string;

  constructor(private readonly options: BankrOptions) {
    if (!options.apiKey) throw new ModelError("AUTH", "No Bankr API key configured.");
    this.id = `bankr:${options.model}`;
    this.baseUrl = (options.baseUrl ?? BANKR_DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  /** Reads BANKR_LLM_KEY / BANKR_API_KEY, MUSECOURT_MODEL and MUSECOURT_LLM_BASE_URL. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, model = env.MUSECOURT_MODEL): BankrChatModel {
    return new BankrChatModel({
      apiKey: env.BANKR_LLM_KEY || env.BANKR_API_KEY || "",
      model: model || BANKR_DEFAULT_MODEL,
      baseUrl: env.MUSECOURT_LLM_BASE_URL,
    });
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const retries = this.options.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(request);
      } catch (error) {
        if (!(error instanceof ModelError) || !error.retryable || attempt >= retries) throw error;
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt) * (0.5 + Math.random())));
      }
    }
  }

  private async once(request: ChatRequest): Promise<ChatResponse> {
    const doFetch = this.options.fetch ?? fetch;
    const started = Date.now();
    let res: Response;
    try {
      res = await doFetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages,
          ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
    } catch (error) {
      throw new ModelError("UPSTREAM", `Bankr gateway unreachable: ${(error as Error).name}`);
    }
    const body = (await res.json().catch(() => ({}))) as CompletionBody;
    if (!res.ok) throw toModelError(res, body);
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string")
      throw new ModelError("BAD_RESPONSE", "Bankr response had no message content.", res.status);
    return {
      text,
      model: body.model ?? this.options.model,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
    };
  }
}

/** Maps documented gateway statuses to error kinds. Never includes the key or request body. */
function toModelError(res: Response, body: CompletionBody): ModelError {
  const detail = typeof body.error === "string" ? body.error : (body.error?.type ?? body.error?.code ?? "");
  const suffix = detail ? ` (${detail})` : "";
  switch (res.status) {
    case 401:
    case 403:
      return new ModelError("AUTH", `Bankr rejected the API key${suffix}.`, res.status);
    case 402:
      return new ModelError(
        "CREDITS",
        `Bankr: out of LLM credits or over the daily budget${suffix}.`,
        res.status,
      );
    case 404:
    case 410: {
      const replacement = res.headers.get("x-model-replacement");
      return new ModelError(
        "MODEL_UNAVAILABLE",
        `Bankr: model unavailable${replacement ? `; replacement is ${replacement}` : ""}${suffix}.`,
        res.status,
      );
    }
    case 429:
      return new ModelError("RATE_LIMITED", `Bankr rate limit${suffix}.`, res.status);
    default:
      return res.status >= 500
        ? new ModelError("UPSTREAM", `Bankr gateway error ${res.status}${suffix}.`, res.status)
        : new ModelError("BAD_REQUEST", `Bankr rejected the request (${res.status})${suffix}.`, res.status);
  }
}
