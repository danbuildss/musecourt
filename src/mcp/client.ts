import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_PATH, SKILL_RESOURCE_URI } from "./server";

/**
 * A thin wrapper over the official MCP SDK client, connected to a MuseCourt
 * server over Streamable HTTP. Used by tests and by the simulation harness;
 * it adds nothing to the protocol.
 */

export interface ToolCallOutcome {
  /** True for tool errors (court errors, validation errors, unknown tools). */
  isError: boolean;
  /** The structured result, or null when the server returned text only (e.g. SDK-level validation errors). */
  structured: Record<string, unknown> | null;
  text: string;
}

export interface MuseCourtMcpClient {
  listTools(): Promise<Tool[]>;
  readSkill(): Promise<string>;
  call(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  close(): Promise<void>;
}

export async function connectMcp(
  baseUrl: string,
  options: { apiKey?: string | null; fetch?: typeof fetch } = {},
): Promise<MuseCourtMcpClient> {
  const headers: Record<string, string> = {};
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  const transport = new StreamableHTTPClientTransport(new URL(MCP_PATH, baseUrl), {
    requestInit: { headers },
    fetch: options.fetch,
  });
  const client = new Client({ name: "musecourt-client", version: "1.0.0" });
  await client.connect(transport);
  return {
    async listTools() {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async readSkill() {
      const result = await client.readResource({ uri: SKILL_RESOURCE_URI });
      const first = result.contents[0];
      return first && "text" in first ? String(first.text) : "";
    },
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return {
        isError: Boolean(result.isError),
        structured: (result.structuredContent as Record<string, unknown> | undefined) ?? null,
        text,
      };
    },
    close: () => client.close(),
  };
}
