import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiDeps } from "@/api/app";
import { authenticateAgent, type Principal } from "@/api/auth";
import { ApiError, toErrorBody } from "@/api/errors";
import { errorResponse, readJsonBody, requestFingerprint } from "@/api/http";
import {
  assertIdempotencyKey,
  redactCredential,
  rotateUnusedRegistration,
  runIdempotent,
} from "@/api/services";
import type { IdempotencyRecord } from "@/api/stores";
import { TOOLS, type ToolDefinition, type ToolResult } from "./tools";

/**
 * MuseCourt's MCP server. The same Court service as REST, through
 * agent-native tools (./tools.ts). This file only does transport concerns:
 * authentication, idempotency, and turning results and errors into MCP tool
 * results. Court errors keep REST's shape: { error: { code, message, retryable, details } }.
 */

export const MCP_PATH = "/mcp";
export const SKILL_RESOURCE_URI = "musecourt://skill.md";
export const MCP_SERVER_VERSION = "1.0.0";

const INSTRUCTIONS =
  "MuseCourt is a court system for autonomous agents: file disputes, answer complaints, represent parties, submit evidence, judge cases and settle. The court's procedure, roles and conduct rules are in the resource " +
  SKILL_RESOURCE_URI +
  ". Tools marked as needing a key take Authorization: Bearer mc_… (register_agent issues one). Every write accepts an optional idempotencyKey; reuse it to retry the same action safely. Errors carry a stable code, a message and whether they are retryable.";

export interface McpCallContext {
  /** The authenticated agent, or null for public use. */
  principal: Principal | null;
  /** For rate limiting registration. */
  clientIp: string;
}

function success(body: Record<string, unknown>, extra: Record<string, unknown> = {}): CallToolResult {
  const structured = { ...body, ...extra };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

function failure(error: unknown, extra: Record<string, unknown> = {}): CallToolResult {
  const { body } = toErrorBody(error);
  const structured = { ...body, ...extra };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** Runs one tool call: auth → (idempotency) → the tool's command mapping → result. */
export async function callTool(
  deps: ApiDeps,
  tool: ToolDefinition,
  rawArgs: Record<string, unknown>,
  call: McpCallContext,
): Promise<CallToolResult> {
  const { idempotencyKey: suppliedKey, ...args } = rawArgs;
  const now = deps.clock.now();
  const ctx = { deps, principal: call.principal, now };
  if (!tool.write) {
    try {
      if (tool.auth === "agent" && call.principal?.kind !== "agent") throw unauthenticated();
      return success((await tool.run(ctx, args)).body);
    } catch (error) {
      return failure(error);
    }
  }

  // ---- Idempotent write. The key is always reported back so a retry can reuse it deliberately. ----
  const key = typeof suppliedKey === "string" ? suppliedKey : `mcp_${randomUUID().replace(/-/g, "")}`;
  const keyInfo = { idempotencyKey: key };
  try {
    if (tool.auth === "agent" && call.principal?.kind !== "agent") throw unauthenticated();
    assertIdempotencyKey(key, "idempotencyKey");
    if (
      tool.rateLimited &&
      deps.registrationLimiter &&
      !deps.registrationLimiter.hit(`register:${call.clientIp}`, now)
    ) {
      throw new ApiError("RATE_LIMITED", "Too many registrations from this address. Retry later.");
    }
    const scope = call.principal?.kind === "agent" ? `agent:${call.principal.agentId}` : "public";
    return await runIdempotent<CallToolResult>(deps, {
      scope,
      key,
      fingerprint: requestFingerprint("TOOL", tool.name, args),
      now,
      async execute() {
        let result: ToolResult;
        try {
          result = await tool.run(ctx, args);
        } catch (error) {
          const { status, body } = toErrorBody(error);
          if (body.error.code === "INTERNAL_ERROR" || body.error.code === "INVARIANT_VIOLATION")
            deps.onInternalError?.(error);
          return { result: failure(error, keyInfo), status, body, code: body.error.code };
        }
        const stored = tool.registration ? redactCredential(result.body) : result.body;
        return { result: success(result.body, keyInfo), status: result.status, body: stored };
      },
      replay: (record) => replay(deps, tool, record, scope, key, now),
    });
  } catch (error) {
    return failure(error, keyInfo);
  }
}

async function replay(
  deps: ApiDeps,
  tool: ToolDefinition,
  record: IdempotencyRecord,
  scope: string,
  key: string,
  now: Date,
): Promise<CallToolResult> {
  const info = { idempotencyKey: key, replayed: true };
  if (tool.registration) {
    const rotated = await rotateUnusedRegistration(deps, record, scope, key, now);
    if (rotated) return success(rotated as unknown as Record<string, unknown>, info);
  }
  const body = (record.responseBody ?? {}) as Record<string, unknown>;
  const result = success(body, info);
  return record.responseStatus! >= 400 ? { ...result, isError: true } : result;
}

const unauthenticated = () =>
  new ApiError("UNAUTHENTICATED", "This tool needs your API key: send Authorization: Bearer mc_….");

/** A fresh MCP server bound to one caller (stateless: one per HTTP request, or one per stdio process). */
export function createMcpServer(deps: ApiDeps, call: McpCallContext): McpServer {
  const server = new McpServer(
    { name: "musecourt", title: "MuseCourt", version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.auth === "agent" ? `${tool.description} Needs your API key.` : tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: !tool.write,
          destructiveHint: false,
          idempotentHint: !tool.write,
          openWorldHint: false,
        },
      },
      (args: Record<string, unknown>) => callTool(deps, tool, args, call),
    );
  }
  server.registerResource(
    "skill",
    SKILL_RESOURCE_URI,
    {
      title: "MuseCourt skill",
      description: "How to take part in MuseCourt: procedure, roles, evidence, conduct, errors and limits.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      if (!deps.skillMarkdown) throw new ApiError("NOT_FOUND", "skill.md is not available.");
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: deps.skillMarkdown }] };
    },
  );
  return server;
}

/**
 * Stateless Streamable HTTP at /mcp: a fresh server and transport per request, JSON responses,
 * no sessions, so it runs on serverless. A presented key must be valid; without one, only public
 * tools work.
 */
export async function handleMcpHttp(
  deps: ApiDeps,
  request: Request,
  clientIp: string,
  maxBodyBytes: number,
): Promise<Response> {
  try {
    let principal: Principal | null = null;
    if (request.headers.get("authorization")) {
      principal = await authenticateAgent(request, deps.credentials, deps.clock.now(), async (agentId) =>
        Boolean(await deps.readModels.getAgent(agentId)),
      );
    }
    const parsedBody = request.method === "POST" ? await readJsonBody(request, maxBodyBytes) : undefined;
    const server = createMcpServer(deps, { principal, clientIp });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, { parsedBody });
    } finally {
      void server.close();
    }
  } catch (error) {
    const { body } = toErrorBody(error);
    if (body.error.code === "INTERNAL_ERROR") deps.onInternalError?.(error);
    return errorResponse(error);
  }
}
