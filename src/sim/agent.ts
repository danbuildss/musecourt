import { randomUUID } from "node:crypto";
import { ERROR_CATALOGUE, type ApiErrorCode } from "@/api/errors";
import { connectMcp, type MuseCourtMcpClient } from "@/mcp/client";
import { extractJsonObject, ModelError, type ChatMessage, type ChatModel } from "@/model/chat";

/**
 * One autonomous agent. Its context holds only: its persona, what its
 * connection to MuseCourt shows it (skill.md, or the MCP server's tools and
 * skill resource), the responses it has received and its own briefs. The
 * client relays requests; it never suggests what to do next.
 *
 * Two connections, one agent loop:
 *  - "rest": the agent writes HTTP requests (Phase 4 baseline, unchanged);
 *  - "mcp": the agent names an MCP tool and its arguments, and a real MCP
 *    client (the official SDK) calls the real MuseCourt MCP server.
 */

export type Transport = "rest" | "mcp";

export const AGENT_PROTOCOL = `You act in the world through an HTTP client connected to the MuseCourt server.
Each turn, reply with ONLY one JSON object, either
  {"thought": "<brief private reasoning>", "request": {"method": "GET" | "POST", "path": "/...", "body": { ... }}}
or, when you have nothing more to do until you are woken again,
  {"thought": "<brief private reasoning>", "done": true}
About your HTTP client: it sends JSON; it adds a fresh Idempotency-Key to every POST (put "idempotencyKey": "<key>" inside "request" only to deliberately retry an earlier POST with the same key); once you have registered it stores your API key and sends it for you on every request.
Each response comes back as "HTTP <status>" followed by the JSON body.
Act only on what you actually know. Never invent facts, events or identifiers.`;

export const MCP_AGENT_PROTOCOL = `You act in the world through an MCP client connected to the MuseCourt MCP server.
Each turn, reply with ONLY one JSON object, either
  {"thought": "<brief private reasoning>", "tool": "<tool name>", "arguments": { ... }}
or, when you have nothing more to do until you are woken again,
  {"thought": "<brief private reasoning>", "done": true}
About your MCP client: it calls the tool you name with your arguments; for tools that change the court it adds a fresh idempotencyKey (put "idempotencyKey" inside "arguments" only to deliberately retry an earlier call with the same key); once you have registered it stores your API key and sends it for you on every call.
Each result comes back as "TOOL <name> → OK" or "TOOL <name> → ERROR" followed by the result.
Act only on what you actually know. Never invent facts, events or identifiers.`;

export interface ApiCall {
  agent: string;
  at: string;
  transport: Transport;
  /** REST: GET/POST. MCP: TOOL. */
  method: string;
  /** REST: the path. MCP: the tool name. */
  path: string;
  /** Whether the call asks the court to change something (POST / a non-read-only tool). */
  write: boolean;
  /** The court action requested, when there is one (e.g. ISSUE_VERDICT), whatever the transport. */
  action: string | null;
  body: unknown;
  /** The idempotency key the call carried (REST header or MCP argument). */
  idempotencyKey: string | null;
  /** The agent deliberately re-sent a key it had used before. */
  retry: boolean;
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
  /** HTTP requests or MCP tool calls. */
  apiCalls: number;
  apiWrites: number;
  apiErrors: Record<string, number>;
  /** MCP: calls naming a tool the server does not have. */
  invalidToolSelections: number;
  /** MCP: calls whose arguments failed the tool's input schema. */
  invalidArguments: number;
  /** Transport-level failures (the MCP client or HTTP request itself failed). */
  transportErrors: number;
  /** Deliberate retries (a previously used idempotency key sent again). */
  retries: number;
  /** USD cost the provider itself reported per response (only when it does). */
  reportedCostUsd: number;
  costReportedCalls: number;
}

export const emptyMetrics = (): AgentMetrics => ({
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
  invalidToolSelections: 0,
  invalidArguments: 0,
  transportErrors: 0,
  retries: 0,
  reportedCostUsd: 0,
  costReportedCalls: 0,
});

/** Thrown when an agent keeps failing: invalid replies or rejected requests, back to back. */
export class AgentStuck extends Error {
  constructor(
    readonly agent: string,
    readonly failures: string[],
  ) {
    super(`${agent} failed ${failures.length} actions in a row`);
  }
}

export interface WakeOptions {
  maxSteps: number;
  /** Consecutive invalid replies / rejected requests before the agent counts as stuck. */
  maxConsecutiveFailures?: number;
  /** Called before every model call; throws to stop (budget and time limits). */
  beforeModelCall?: () => void;
}

const MAX_RESPONSE_CHARS = 16000;
const HISTORY_WINDOW = 40;

export interface SimAgentOptions {
  handle: string;
  persona: string;
  skillMarkdown: string;
  model: ChatModel;
  baseUrl: string;
  now: () => Date;
  transport?: Transport;
  onApiCall?: (call: ApiCall) => void;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

interface Connection {
  protocol: string;
  /** The "installed" material the agent starts with. */
  introduction(): Promise<string>;
  parse(text: string): ParsedAction | null;
  execute(request: ParsedRequest): Promise<Omit<ApiCall, "agent" | "at" | "retry">>;
  render(call: ApiCall): string;
  readonly apiKey: string | null;
  close(): Promise<void>;
}

const CASE_ACTION_PATH = /^\/api\/v1\/cases\/[^/]+\/actions\/?$/;

class RestConnection implements Connection {
  readonly protocol = AGENT_PROTOCOL;
  apiKey: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly skillMarkdown: string,
  ) {}

  async introduction() {
    return `You have installed the MuseCourt skill. Its contents:\n\n<skill.md>\n${this.skillMarkdown}\n</skill.md>\n\nThe machine-readable discovery document is at GET /api/v1.`;
  }

  parse(text: string) {
    return parseAction(text);
  }

  async execute(request: ParsedRequest) {
    const r = request as HttpRequest;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let body: string | undefined;
    let idempotencyKey: string | null = null;
    if (r.method === "POST") {
      headers["content-type"] = "application/json";
      idempotencyKey = r.idempotencyKey ?? randomUUID();
      headers["idempotency-key"] = idempotencyKey;
      body = JSON.stringify(r.body ?? {});
    }
    let status = 0;
    let parsed: unknown;
    try {
      const res = await fetch(this.baseUrl + r.path, { method: r.method, headers, body });
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

    // The client keeps the credential; the model sees that it was stored, never the secret.
    const credential = (parsed as { credential?: { apiKey?: string | null } } | null)?.credential;
    if (
      r.method === "POST" &&
      r.path.replace(/\/+$/, "") === "/api/v1/agents" &&
      status === 201 &&
      credential?.apiKey
    ) {
      this.apiKey = credential.apiKey;
      parsed = {
        ...(parsed as object),
        credential: { ...credential, apiKey: "[stored by your HTTP client]" },
      };
    }
    const requested = (r.body as { action?: unknown } | undefined)?.action;
    const action =
      r.method !== "POST"
        ? null
        : CASE_ACTION_PATH.test(r.path)
          ? typeof requested === "string"
            ? requested
            : null
          : r.path.replace(/\/+$/, "") === "/api/v1/cases"
            ? "FILE_CASE"
            : null;
    return {
      transport: "rest" as const,
      method: r.method,
      path: r.path,
      write: r.method === "POST",
      action,
      body: r.body ?? null,
      idempotencyKey,
      status,
      errorCode,
      response: parsed,
    };
  }

  render(call: ApiCall) {
    return `HTTP ${call.status}\n${truncate(JSON.stringify(call.response))}`;
  }

  async close() {}
}

/** Which court action each MCP write tool requests (for transport-neutral checks and reports). */
const TOOL_ACTION: Record<string, string> = {
  file_case: "FILE_CASE",
  respond_to_complaint: "RESPOND",
  request_counsel: "REQUEST_COUNSEL",
  accept_counsel_request: "ACCEPT_REPRESENTATION",
  decline_counsel_request: "DECLINE_REPRESENTATION",
  declare_self_representation: "DECLARE_SELF_REPRESENTATION",
  withdraw_as_counsel: "WITHDRAW_AS_COUNSEL",
  volunteer_as_judge: "VOLUNTEER_AS_JUDGE",
  put_questions: "MAKE_STATEMENT",
  make_statement: "MAKE_STATEMENT",
  conclude_stage: "CONCLUDE_STAGE",
  submit_evidence: "SUBMIT_EVIDENCE",
  withdraw_evidence: "WITHDRAW_EVIDENCE",
  issue_verdict: "ISSUE_VERDICT",
  offer_settlement: "OFFER_SETTLEMENT",
  respond_to_settlement: "RESPOND_TO_SETTLEMENT",
  withdraw_settlement_offer: "WITHDRAW_SETTLEMENT_OFFER",
  withdraw_case: "WITHDRAW_CASE",
  dismiss_case: "DISMISS_CASE",
};

class McpConnection implements Connection {
  readonly protocol = MCP_AGENT_PROTOCOL;
  apiKey: string | null = null;
  private client: MuseCourtMcpClient | null = null;
  private writeTools = new Set<string>();

  constructor(private readonly baseUrl: string) {}

  private async connected(): Promise<MuseCourtMcpClient> {
    this.client ??= await connectMcp(this.baseUrl, { apiKey: this.apiKey });
    return this.client;
  }

  /** What an MCP host shows its model: the server's tools (name, description, input schema) and its skill resource. */
  async introduction() {
    const client = await this.connected();
    const tools = await client.listTools();
    this.writeTools = new Set(tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name));
    const listed = tools
      .map((t) => {
        const schema: Record<string, unknown> = { ...t.inputSchema };
        delete schema.$schema;
        return JSON.stringify({ name: t.name, description: t.description, inputSchema: schema });
      })
      .join("\n");
    const skill = await client.readSkill();
    return `You have connected the MuseCourt MCP server. Its tools (from tools/list):\n\n<tools>\n${listed}\n</tools>\n\nThe server's resource musecourt://skill.md:\n\n<skill.md>\n${skill}\n</skill.md>`;
  }

  parse(text: string) {
    return parseToolCall(text);
  }

  async execute(request: ParsedRequest) {
    const r = request as ToolRequest;
    const write = this.writeTools.has(r.tool);
    const args = { ...r.arguments };
    const supplied = typeof args.idempotencyKey === "string" ? (args.idempotencyKey as string) : null;
    if (write && !supplied) args.idempotencyKey = `sim_${randomUUID().replace(/-/g, "")}`;
    let status: number;
    let errorCode: string | null = null;
    let response: unknown;
    try {
      const client = await this.connected();
      const out = await client.call(r.tool, args);
      response = out.structured ?? out.text;
      if (!out.isError) status = 200;
      else if (out.structured && (out.structured as { error?: { code?: string } }).error?.code) {
        errorCode = (out.structured as { error: { code: string } }).error.code;
        status = ERROR_CATALOGUE[errorCode as ApiErrorCode]?.status ?? 400;
      } else if (/Tool .* not found/.test(out.text)) {
        errorCode = "UNKNOWN_TOOL";
        status = 404;
      } else if (/Input validation error/.test(out.text)) {
        errorCode = "INVALID_ARGUMENTS";
        status = 400;
      } else {
        errorCode = "TOOL_ERROR";
        status = 400;
      }
    } catch (error) {
      status = 0;
      errorCode = "MCP_ERROR";
      response = { error: { code: "MCP_ERROR", message: (error as Error).message } };
    }

    // The client keeps the credential and reconnects with it; the model never sees the secret.
    const credential = (response as { credential?: { apiKey?: string | null } } | null)?.credential;
    if (r.tool === "register_agent" && status === 200 && credential?.apiKey) {
      this.apiKey = credential.apiKey;
      await this.client?.close().catch(() => undefined);
      this.client = null;
      response = {
        ...(response as object),
        credential: { ...credential, apiKey: "[stored by your MCP client]" },
      };
    }
    return {
      transport: "mcp" as const,
      method: "TOOL",
      path: r.tool,
      write,
      action: TOOL_ACTION[r.tool] ?? null,
      body: r.arguments,
      idempotencyKey: (args.idempotencyKey as string | undefined) ?? null,
      status,
      errorCode,
      response,
    };
  }

  render(call: ApiCall) {
    const text = typeof call.response === "string" ? call.response : JSON.stringify(call.response);
    return `TOOL ${call.path} → ${call.status === 200 ? "OK" : "ERROR"}\n${truncate(text)}`;
  }

  async close() {
    await this.client?.close().catch(() => undefined);
    this.client = null;
  }
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

export class SimAgent {
  readonly metrics: AgentMetrics = emptyMetrics();
  /** Full, untruncated conversation (for transcripts). */
  readonly transcript: ChatMessage[] = [];
  private preamble: ChatMessage[] | null = null;
  private history: ChatMessage[] = [];
  private readonly connection: Connection;
  /** Idempotency keys this agent's calls have carried (to recognise deliberate retries). */
  private readonly usedKeys = new Set<string>();
  /** Consecutive failed actions (invalid replies or 4xx/5xx responses); reset by any success. */
  private failures: string[] = [];

  constructor(private readonly options: SimAgentOptions) {
    this.connection =
      options.transport === "mcp"
        ? new McpConnection(options.baseUrl)
        : new RestConnection(options.baseUrl, options.skillMarkdown);
  }

  get registered(): boolean {
    return this.connection.apiKey !== null;
  }

  /** Test/diagnostic hook: the credential this agent's client holds. */
  get credential(): string | null {
    return this.connection.apiKey;
  }

  private async ensurePreamble(): Promise<ChatMessage[]> {
    if (!this.preamble) {
      this.preamble = [
        { role: "system", content: `${this.options.persona}\n\n${this.connection.protocol}` },
        { role: "user", content: await this.connection.introduction() },
        { role: "assistant", content: '{"thought": "Understood. I will act when woken.", "done": true}' },
      ];
      this.transcript.unshift(...this.preamble);
    }
    return this.preamble;
  }

  /** Wakes the agent with a note; it acts until it says done or runs out of steps. Returns successful writes. */
  async wake(note: string, options: WakeOptions): Promise<number> {
    await this.ensurePreamble();
    this.metrics.wakes += 1;
    this.push({ role: "user", content: note });
    let writes = 0;
    let badReplies = 0;
    for (let step = 0; step < options.maxSteps; step++) {
      options.beforeModelCall?.();
      const reply = await this.think();
      const action = this.connection.parse(reply);
      if (!action) {
        this.metrics.protocolErrors += 1;
        this.fail(options, `invalid reply: ${reply.slice(0, 160)}`);
        if (++badReplies >= 2) break;
        this.push({
          role: "user",
          content:
            this.options.transport === "mcp"
              ? 'Your reply was not a valid JSON object with either "tool" and "arguments" or "done": true. Reply with one JSON object.'
              : 'Your reply was not a valid JSON object with either "request" or "done": true. Reply with one JSON object.',
        });
        continue;
      }
      badReplies = 0;
      if (action.done) break;
      const call = await this.perform(action.request);
      if (call.status >= 400 || call.status === 0) {
        this.fail(options, `${call.method} ${call.path} → ${call.status} ${call.errorCode ?? ""}`.trim());
      } else {
        this.failures = [];
      }
      if (call.write && call.status < 300 && call.status > 0) writes += 1;
      this.push({ role: "user", content: this.connection.render(call) });
    }
    return writes;
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  private async perform(request: ParsedRequest): Promise<ApiCall> {
    const executed = await this.connection.execute(request);
    const retry = executed.idempotencyKey !== null && this.usedKeys.has(executed.idempotencyKey);
    if (executed.idempotencyKey) this.usedKeys.add(executed.idempotencyKey);
    const call: ApiCall = {
      agent: this.options.handle,
      at: this.options.now().toISOString(),
      retry,
      ...executed,
    };
    this.metrics.apiCalls += 1;
    if (call.write) this.metrics.apiWrites += 1;
    if (retry) this.metrics.retries += 1;
    if (call.errorCode)
      this.metrics.apiErrors[call.errorCode] = (this.metrics.apiErrors[call.errorCode] ?? 0) + 1;
    if (call.errorCode === "UNKNOWN_TOOL") this.metrics.invalidToolSelections += 1;
    if (call.errorCode === "INVALID_ARGUMENTS") this.metrics.invalidArguments += 1;
    if (call.status === 0) this.metrics.transportErrors += 1;
    this.options.onApiCall?.(call);
    return call;
  }

  private fail(options: WakeOptions, description: string) {
    this.failures.push(description);
    if (options.maxConsecutiveFailures && this.failures.length >= options.maxConsecutiveFailures) {
      const failures = this.failures;
      this.failures = [];
      throw new AgentStuck(this.options.handle, failures);
    }
  }

  private async think(): Promise<string> {
    const started = Date.now();
    try {
      const response = await this.options.model.complete({
        messages: [...this.preamble!, ...this.history.slice(-HISTORY_WINDOW)],
        maxOutputTokens: 2000,
      });
      this.metrics.modelCalls += 1;
      this.metrics.inputTokens += response.usage.inputTokens;
      this.metrics.outputTokens += response.usage.outputTokens;
      if (typeof response.costUsd === "number") {
        this.metrics.reportedCostUsd += response.costUsd;
        this.metrics.costReportedCalls += 1;
      }
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
}

// ---------------------------------------------------------------------------
// Parsing the agent's reply
// ---------------------------------------------------------------------------

interface HttpRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

interface ToolRequest {
  tool: string;
  arguments: Record<string, unknown>;
}

type ParsedRequest = HttpRequest | ToolRequest;

type ParsedAction = { done: true } | { done: false; request: ParsedRequest };

export function parseAction(text: string): { done: true } | { done: false; request: HttpRequest } | null {
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

export function parseToolCall(text: string): { done: true } | { done: false; request: ToolRequest } | null {
  const json = extractJsonObject(text) as { done?: unknown; tool?: unknown; arguments?: unknown } | null;
  if (!json || typeof json !== "object") return null;
  if (json.done === true && json.tool === undefined) return { done: true };
  if (typeof json.tool !== "string" || json.tool.length === 0) return null;
  const args = json.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return { done: false, request: { tool: json.tool, arguments: args as Record<string, unknown> } };
}

function truncate(text: string): string {
  return text.length > MAX_RESPONSE_CHARS ? `${text.slice(0, MAX_RESPONSE_CHARS)}… [truncated]` : text;
}
