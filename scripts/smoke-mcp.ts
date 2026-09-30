import { connectMcp } from "@/mcp/client";
import { MCP_PATH } from "@/mcp/server";

/**
 * Minimal smoke test of a deployed MuseCourt MCP endpoint. Read-only unless --register is passed.
 *   npm run smoke:mcp -- https://<deployment>
 *   MUSECOURT_API_KEY=mc_…   optional: also checks that a valid key authenticates (get_me)
 *   --register              optional: registers a throwaway agent (a write) to obtain a key to check with
 * Never prints API keys.
 */
const baseUrl = process.argv.slice(2).find((a) => a.startsWith("http"));
if (!baseUrl) {
  console.error("Usage: npm run smoke:mcp -- https://<deployment> [--register]");
  process.exit(2);
}
const register = process.argv.includes("--register");
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check} — ${detail}`);
};

async function step(check: string, fn: () => Promise<string>) {
  try {
    record(check, true, await fn());
  } catch (error) {
    record(check, false, (error as Error).message);
  }
}

const anon = await connectMcp(baseUrl).catch((error: Error) => {
  record("MCP initialize", false, error.message);
  process.exit(1);
});
record("MCP initialize", true, `connected to ${new URL(MCP_PATH, baseUrl).href}`);

await step("tool discovery (tools/list)", async () => {
  const tools = await anon.listTools();
  if (tools.length !== 30) throw new Error(`expected 30 tools, got ${tools.length}`);
  if (tools.some((t) => /admin|cron/.test(t.name))) throw new Error("an admin/cron tool is exposed");
  return `${tools.length} tools, no admin/cron tools`;
});

await step("skill.md resource (musecourt://skill.md)", async () => {
  const skill = await anon.readSkill();
  const version = /^version: (\d+)$/m.exec(skill)?.[1];
  if (!skill.includes("## 14. Using MCP")) throw new Error("resource is not skill.md v3");
  return `${skill.length} characters, version ${version}`;
});

await step("safe read (list_jurisdictions)", async () => {
  const r = await anon.call("list_jurisdictions", {});
  if (r.isError) throw new Error(r.text);
  const ids = (
    (r.structured as { jurisdictions: Array<{ jurisdictionId: string }> }).jurisdictions ?? []
  ).map((j) => j.jurisdictionId);
  return `jurisdictions: ${ids.join(", ") || "none"}`;
});

await step("auth: agent tool without a key is refused", async () => {
  const r = await anon.call("get_my_tasks", {});
  const code = (r.structured as { error?: { code?: string } } | null)?.error?.code;
  if (code !== "UNAUTHENTICATED") throw new Error(`expected UNAUTHENTICATED, got ${code ?? r.text}`);
  return "UNAUTHENTICATED";
});

await step("auth: an invalid key is rejected at HTTP level", async () => {
  const res = await fetch(new URL(MCP_PATH, baseUrl), {
    method: "POST",
    headers: {
      authorization: "Bearer mc_0000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  return "401";
});

let apiKey = process.env.MUSECOURT_API_KEY ?? null;
if (!apiKey && register) {
  await step("register_agent (throwaway)", async () => {
    const r = await anon.call("register_agent", { handle: `smoke-${Date.now().toString(36)}` });
    if (r.isError) throw new Error(r.text);
    apiKey = (r.structured as { credential: { apiKey: string } }).credential.apiKey;
    return `registered ${(r.structured as { agent: { handle: string } }).agent.handle}`;
  });
}
if (apiKey) {
  await step("auth: a valid key authenticates (get_me, get_my_tasks)", async () => {
    const me = await connectMcp(baseUrl, { apiKey });
    const r = await me.call("get_me", {});
    if (r.isError) throw new Error(r.text);
    const t = await me.call("get_my_tasks", {});
    if (t.isError) throw new Error(t.text);
    await me.close();
    return `authenticated as ${(r.structured as { agent: { handle: string } }).agent.handle}`;
  });
} else {
  record("auth: a valid key authenticates", true, "skipped (no MUSECOURT_API_KEY and no --register)");
}

await anon.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "SMOKE TEST PASSED" : `SMOKE TEST FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
