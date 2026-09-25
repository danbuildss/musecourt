import { randomUUID } from "node:crypto";
import { extractJsonObject, ModelError, type ChatMessage, type ChatModel } from "@/model/chat";

/**
 * One autonomous agent. Its context holds only: its persona, the MuseCourt
 * skill.md, the HTTP responses it has received and its own briefs. The HTTP
 * client relays requests; it never suggests what to do next.
 */

export const AGENT_PROTOCOL = `You act in the world through an HTTP client connected to the MuseCourt server.
Each turn, reply with ONLY one JSON object, either
  {"thought": "<brief private reasoning>", "request": {"method": "GET" | "POST", "path": "/...", "body": { ... }}}
or, when you have nothing more to do until you are woken again,
  {"thought": "<brief private reasoning>", "done": true}
About your HTTP client: it sends JSON; it adds a fresh Idempotency-Key to every POST (put "idempotencyKey": "<key>" inside "request" only to deliberately retry an earlier POST with the same key); once you have registered it stores your API key and sends it for you on every request.
Each response comes back as "HTTP <status>" followed by the JSON body.
Act only on what you actually know. Never invent facts, events or identifiers.`;

export interface ApiCall {
  agent: string;
  at: string;
  method: string;
  path: string;
  body: unknown;
  status: number;
  errorCode: string | null;
  response: unknown;
}

export interface AgentMetrics {
  wakes: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  modelLatencyMs: number;
  modelErrors: Record<string, number>;
  protocolErrors: number;
  apiCalls: number;
  apiWrites: number;
  apiErrors: Record<string, number>;
}

const emptyMetrics = (): AgentMetrics => ({
  wakes: 0,
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  modelLatencyMs: 0,
  modelErrors: {},
  protocolErrors: 0,
  apiCalls: 0,
  apiWrites: 0,
  apiErrors: {},
});

const MAX_RESPONSE_CHARS = 16000;
const HISTORY_WINDOW = 40;

export interface SimAgentOptions {
  handle: string;
  persona: string;
  skillMarkdown: string;
  model: ChatModel;
  baseUrl: string;
  now: () => Date;
  onApiCall?: (call: ApiCall) => void;
}

export class SimAgent {
  readonly metrics: AgentMetrics = emptyMetrics();
  /** Full, untruncated conversation (for transcripts). */
  readonly transcript: ChatMessage[] = [];
  private readonly preamble: ChatMessage[];
  private history: ChatMessage[] = [];
  private apiKey: string | null = null;

  constructor(private readonly options: SimAgentOptions) {
    this.preamble = [
      { role: "system", content: `${options.persona}\n\n${AGENT_PROTOCOL}` },
      {
        role: "user",
        content: `You have installed the MuseCourt skill. Its contents:\n\n<skill.md>\n${options.skillMarkdown}\n</skill.md>\n\nThe machine-readable discovery document is at GET /api/v1.`,
      },
      { role: "assistant", content: '{"thought": "Understood. I will act when woken.", "done": true}' },
    ];
    this.transcript.push(...this.preamble);
  }

  get registered(): boolean {
    return this.apiKey !== null;
  }

  /** Test/diagnostic hook: the credential this agent's client holds. */
  get credential(): string | null {
    return this.apiKey;
  }

  /** Wakes the agent with a note; it acts until it says done or runs out of steps. Returns successful writes. */
  async wake(note: string, maxSteps: number): Promise<number> {
    this.metrics.wakes += 1;
    this.push({ role: "user", content: note });
    let writes = 0;
    let badReplies = 0;
    for (let step = 0; step < maxSteps; step++) {
      const reply = await this.think();
      const action = parseAction(reply);
      if (!action) {
        this.metrics.protocolErrors += 1;
        if (++badReplies >= 2) break;
        this.push({
          role: "user",
          content:
            'Your reply was not a valid JSON object with either "request" or "done": true. Reply with one JSON object.',
        });
        continue;
      }
      badReplies = 0;
      if (action.done) break;
      const call = await this.http(action.request);
      if (call.method === "POST" && call.status < 300) writes += 1;
      this.push({ role: "user", content: renderResponse(call) });
    }
    return writes;
  }

  private async think(): Promise<string> {
    const started = Date.now();
    try {
      const response = await this.options.model.complete({
        messages: [...this.preamble, ...this.history.slice(-HISTORY_WINDOW)],
        maxOutputTokens: 2000,
      });
      this.metrics.modelCalls += 1;
      this.metrics.inputTokens += response.usage.inputTokens;
      this.metrics.outputTokens += response.usage.outputTokens;
      this.metrics.modelLatencyMs += response.latencyMs || Date.now() - started;
      this.push({ role: "assistant", content: response.text });
      return response.text;
    } catch (error) {
      const kind = error instanceof ModelError ? error.kind : "UNKNOWN";
      this.metrics.modelErrors[kind] = (this.metrics.modelErrors[kind] ?? 0) + 1;
      throw error;
    }
  }

  private push(message: ChatMessage) {
    this.history.push(message);
    this.transcript.push(message);
  }

  private async http(request: ParsedRequest): Promise<ApiCall> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let body: string | undefined;
    if (request.method === "POST") {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = request.idempotencyKey ?? randomUUID();
      body = JSON.stringify(request.body ?? {});
    }
    this.metrics.apiCalls += 1;
    if (request.method === "POST") this.metrics.apiWrites += 1;
    let status = 0;
    let parsed: unknown;
    try {
      const res = await fetch(this.options.baseUrl + request.path, { method: request.method, headers, body });
      status = res.status;
      const text = await res.text();
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text.length > MAX_RESPONSE_CHARS ? text.slice(0, MAX_RESPONSE_CHARS) : text;
      }
    } catch (error) {
      parsed = { error: { code: "CLIENT_ERROR", message: (error as Error).message } };
    }
    const errorCode = (parsed as { error?: { code?: string } } | null)?.error?.code ?? null;
    if (errorCode) this.metrics.apiErrors[errorCode] = (this.metrics.apiErrors[errorCode] ?? 0) + 1;

    // The client keeps the credential; the model sees that it was stored, never the secret.
    const credential = (parsed as { credential?: { apiKey?: string | null } } | null)?.credential;
    if (
      request.method === "POST" &&
      request.path.replace(/\/+$/, "") === "/api/v1/agents" &&
      status === 201 &&
      credential?.apiKey
    ) {
      this.apiKey = credential.apiKey;
      parsed = {
        ...(parsed as object),
        credential: { ...credential, apiKey: "[stored by your HTTP client]" },
      };
    }
    const call: ApiCall = {
      agent: this.options.handle,
      at: this.options.now().toISOString(),
      method: request.method,
      path: request.path,
      body: request.body ?? null,
      status,
      errorCode,
      response: parsed,
    };
    this.options.onApiCall?.(call);
    return call;
  }
}

interface ParsedRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

type ParsedAction = { done: true } | { done: false; request: ParsedRequest };

export function parseAction(text: string): ParsedAction | null {
  const json = extractJsonObject(text) as { done?: unknown; request?: Record<string, unknown> } | null;
  if (!json || typeof json !== "object") return null;
  if (json.done === true && !json.request) return { done: true };
  const r = json.request;
  if (!r || typeof r !== "object") return null;
  const method = typeof r.method === "string" ? r.method.toUpperCase() : "";
  const path = typeof r.path === "string" ? r.path : "";
  // Same-origin relative paths only: the client never leaves the MuseCourt server.
  if ((method !== "GET" && method !== "POST") || !path.startsWith("/") || path.startsWith("//")) return null;
  const body = r.body;
  if (
    method === "POST" &&
    body !== undefined &&
    (typeof body !== "object" || body === null || Array.isArray(body))
  )
    return null;
  return {
    done: false,
    request: {
      method,
      path,
      body,
      idempotencyKey: typeof r.idempotencyKey === "string" ? r.idempotencyKey : undefined,
    },
  };
}

function renderResponse(call: ApiCall): string {
  let text = JSON.stringify(call.response);
  if (text.length > MAX_RESPONSE_CHARS) text = `${text.slice(0, MAX_RESPONSE_CHARS)}… [truncated]`;
  return `HTTP ${call.status}\n${text}`;
}
