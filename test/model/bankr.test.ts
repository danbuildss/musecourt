import { describe, expect, it } from "vitest";
import { BankrChatModel, BANKR_DEFAULT_BASE_URL, BANKR_DEFAULT_MODEL } from "@/model/bankr";
import { ModelError, extractJsonObject } from "@/model/chat";

const KEY = "bk_test_secret_key_do_not_leak";

function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = {
  status: 200,
  body: {
    model: "gpt-5.4",
    choices: [{ message: { content: '{"done":true}' } }],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  },
};

describe("Bankr LLM Gateway adapter (documented interface)", () => {
  it("sends an OpenAI-compatible chat completion to the documented endpoint with Bearer auth", async () => {
    const { fn, calls } = mockFetch([ok]);
    const model = new BankrChatModel({ apiKey: KEY, model: "gpt-5.4", fetch: fn });
    const res = await model.complete({
      messages: [{ role: "user", content: "Hello" }],
      maxOutputTokens: 100,
      temperature: 0,
    });
    expect(calls[0]!.url).toBe("https://llm.bankr.bot/v1/chat/completions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      temperature: 0,
    });
    expect(res).toMatchObject({
      text: '{"done":true}',
      model: "gpt-5.4",
      usage: { inputTokens: 12, outputTokens: 5 },
    });
  });

  it("reads configuration from the environment: BANKR_LLM_KEY first, then BANKR_API_KEY; model from MUSECOURT_MODEL", () => {
    expect(BANKR_DEFAULT_BASE_URL).toBe("https://llm.bankr.bot/v1");
    expect(BANKR_DEFAULT_MODEL).toBe("gpt-5.4");
    expect(BankrChatModel.fromEnv({ BANKR_API_KEY: "a" } as NodeJS.ProcessEnv).id).toBe("bankr:gpt-5.4");
    expect(
      BankrChatModel.fromEnv({ BANKR_API_KEY: "a", MUSECOURT_MODEL: "gpt-5.4-mini" } as NodeJS.ProcessEnv).id,
    ).toBe("bankr:gpt-5.4-mini");
    expect(() => BankrChatModel.fromEnv({} as NodeJS.ProcessEnv)).toThrow(ModelError);
  });

  it("maps documented error statuses to error kinds, without leaking the key", async () => {
    const cases: Array<[number, unknown, string, Record<string, string>?]> = [
      [401, { error: { type: "invalid_api_key" } }, "AUTH"],
      [402, { error: { type: "insufficient_credits" } }, "CREDITS"],
      [402, { error: { type: "daily_budget_exceeded" } }, "CREDITS"],
      [410, {}, "MODEL_UNAVAILABLE", { "x-model-replacement": "gpt-5.5" }],
      [400, { error: { type: "invalid_privacy" } }, "BAD_REQUEST"],
      [422, { error: { code: "zdr_unavailable" } }, "BAD_REQUEST"],
    ];
    for (const [status, body, kind, headers] of cases) {
      const { fn } = mockFetch([{ status, body, headers }]);
      const model = new BankrChatModel({ apiKey: KEY, model: "gpt-5.4", fetch: fn, maxRetries: 0 });
      const error = await model.complete({ messages: [] }).catch((e: unknown) => e);
      expect(error, `${status}`).toBeInstanceOf(ModelError);
      expect((error as ModelError).kind).toBe(kind);
      expect((error as ModelError).message).not.toContain(KEY);
      if (status === 410) expect((error as ModelError).message).toContain("gpt-5.5");
    }
  });

  it("retries rate limits and 5xx, but not auth or credit errors", async () => {
    const retried = mockFetch([{ status: 429, body: {} }, { status: 503, body: {} }, ok]);
    const model = new BankrChatModel({ apiKey: KEY, model: "gpt-5.4", fetch: retried.fn, maxRetries: 3 });
    await expect(model.complete({ messages: [] })).resolves.toMatchObject({ text: '{"done":true}' });
    expect(retried.calls).toHaveLength(3);

    const credits = mockFetch([{ status: 402, body: {} }, ok]);
    const noRetry = new BankrChatModel({ apiKey: KEY, model: "gpt-5.4", fetch: credits.fn, maxRetries: 3 });
    await expect(noRetry.complete({ messages: [] })).rejects.toMatchObject({ kind: "CREDITS" });
    expect(credits.calls).toHaveLength(1);
  }, 20_000);

  it("rejects a response without message content", async () => {
    const { fn } = mockFetch([{ status: 200, body: { choices: [] } }]);
    const model = new BankrChatModel({ apiKey: KEY, model: "gpt-5.4", fetch: fn });
    await expect(model.complete({ messages: [] })).rejects.toMatchObject({ kind: "BAD_RESPONSE" });
  });
});

describe("extractJsonObject", () => {
  it("finds the first JSON object in prose or code fences, and never evaluates code", () => {
    expect(extractJsonObject('Sure! ```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('prefix {"a":{"b":"}"}} suffix')).toEqual({ a: { b: "}" } });
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("{not: valid}")).toBeNull();
  });
});
