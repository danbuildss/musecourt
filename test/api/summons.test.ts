import { afterAll, describe, expect, it } from "vitest";
import { MuseworldConnector } from "@/connectors/museworld";
import { SUMMONSES_STREAM } from "@/core/events";
import { SUMMONS_TTL_MS, normalizeSummonsCode, summonsCodeFrom } from "@/core/summons";
import { connectMcp } from "@/mcp/client";
import type { FakeClock } from "@/testing/fake-clock";
import { ISLAND, fakeIsland } from "../connectors/fake-island";
import { BACKENDS, JURISDICTION, closeSharedPool, startApi, type Agent } from "./harness";

afterAll(closeSharedPool);

const SUMMON = "/api/v1/summonses";
const MUSE = "631ac74e-cff2-4098-9f63-37c5d3ca206b";

type Api = Awaited<ReturnType<typeof startApi>>;

const summon = (h: Api, plaintiff: Agent, extra: Record<string, unknown> = {}) =>
  h.post(
    SUMMON,
    {
      jurisdictionId: JURISDICTION,
      defendant: { name: "Nova's trading bot" },
      complaint: "The bot agreed to send 2 timber by the next day and never did.",
      remedySought: "Send the 2 timber.",
      lawIds: ["property"],
      ...extra,
    },
    { apiKey: plaintiff.apiKey },
  );

describe("summons codes", () => {
  it("are SMN- plus ten unambiguous characters, and accept lower case or a missing prefix", () => {
    const code = summonsCodeFrom("smncode_9f1c2d3e4b5a69788796a5b4c3d2e1f0");
    expect(code).toMatch(/^SMN-[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(normalizeSummonsCode(code.toLowerCase())).toBe(code);
    expect(normalizeSummonsCode(code.slice(4))).toBe(code);
    expect(normalizeSummonsCode("SMN-ILOU000000")).toBeNull();
    expect(normalizeSummonsCode("nope")).toBeNull();
  });
});

describe.each(BACKENDS)("summoning an agent that is not at the court yet (%s)", (backend) => {
  it("issues a code and link; nothing is public; the answer files the case with the summoner as plaintiff", async () => {
    const h = await startApi({ backend });
    try {
      const maple = await h.register("maple", "Maple");
      const res = await summon(h, maple);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const s = res.body.summons;
      expect(s.code).toMatch(/^SMN-[0-9A-Z]{10}$/);
      expect(s).toMatchObject({
        url: `https://musecourt.test/summons/${s.code}`,
        status: "OPEN",
        plaintiff: { handle: "maple", displayName: "Maple" },
        defendant: { name: "Nova's trading bot", requiresWorldIdentity: null },
        charges: [{ lawId: "property" }],
        caseId: null,
        answer: `Read https://musecourt.test/skill.md and answer summons ${s.code}.`,
      });
      expect(Date.parse(s.expiresAt) - Date.parse(s.issuedAt)).toBe(SUMMONS_TTL_MS);

      // Not on the public record until answered.
      expect((await h.get("/api/v1/cases")).body.cases).toHaveLength(0);
      expect((await h.get("/api/v1/casebook")).body.casebook).toHaveLength(0);
      expect((await h.get(`${SUMMON}/${s.code}`)).body.summons.status).toBe("OPEN");
      expect(
        (await h.get("/api/v1/agents/me/summonses", { apiKey: maple.apiKey })).body.summonses,
      ).toHaveLength(1);

      // A new agent joins and answers (lower-case code works too).
      const bot = await h.register("trading-bot", "Trading Bot");
      const answered = await h.post(`${SUMMON}/${s.code.toLowerCase()}/answer`, undefined, {
        apiKey: bot.apiKey,
      });
      expect(answered.status, JSON.stringify(answered.body)).toBe(201);
      const c = answered.body.case;
      expect(c).toMatchObject({
        status: "OPEN",
        stage: { name: "AWAITING_RESPONSE" },
        parties: { plaintiff: { handle: "maple" }, defendant: { handle: "trading-bot" } },
        complaint: "The bot agreed to send 2 timber by the next day and never did.",
      });
      // The plaintiff filed it: the case events are recorded as the summoner's.
      const caseEvents = await h.backend.store.readStream(`case:${c.caseId}`);
      expect(caseEvents[0]).toMatchObject({
        type: "CaseFiled",
        actor: { kind: "agent", agentId: maple.agentId },
      });

      const after = (await h.get(`${SUMMON}/${s.code}`)).body.summons;
      expect(after).toMatchObject({ status: "ANSWERED", caseId: c.caseId });
      expect((await h.get("/api/v1/cases")).body.cases).toHaveLength(1);

      // The defendant's tasks now include answering the complaint.
      const tasks = await h.tasks(bot);
      expect(tasks.tasks.map((t: any) => t.caseId)).toContain(c.caseId);

      // It can be answered only once.
      const again = await h.post(`${SUMMON}/${s.code}/answer`, undefined, {
        apiKey: (await h.register("other")).apiKey,
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("DUPLICATE");

      // The summons stream holds the facts, never a credential.
      const log = JSON.stringify(await h.backend.store.readStream(SUMMONSES_STREAM));
      expect(log).not.toMatch(/mc_[A-Za-z0-9]/);
    } finally {
      await h.close();
    }
  });

  it("lapses after 7 days with no case and no judgment; the summoner cannot answer its own summons", async () => {
    const h = await startApi({ backend });
    try {
      const maple = await h.register("maple");
      const { code } = (await summon(h, maple)).body.summons;
      const own = await h.post(`${SUMMON}/${code}/answer`, undefined, { apiKey: maple.apiKey });
      expect(own.body.error.code).toBe("CONFLICT_OF_INTEREST");

      h.clock.advance(SUMMONS_TTL_MS);
      const bot = await h.register("late-bot");
      const late = await h.post(`${SUMMON}/${code}/answer`, undefined, { apiKey: bot.apiKey });
      expect(late.body.error.code).toBe("DEADLINE_PASSED");
      expect((await h.get(`${SUMMON}/${code}`)).body.summons.status).toBe("EXPIRED");
      expect((await h.get("/api/v1/cases")).body.cases).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("applies the filing rules up front, and limits each agent to 3 open summonses", async () => {
    const h = await startApi({ backend });
    try {
      const maple = await h.register("maple");
      expect((await summon(h, maple, { lawIds: ["no-such-law"] })).body.error.code).toBe("NOT_FOUND");
      expect((await summon(h, maple, { complaint: "too short" })).body.error.code).toBe("VALIDATION_FAILED");
      expect((await summon(h, maple, { defendant: { name: "  " } })).body.error.code).toBe(
        "VALIDATION_FAILED",
      );
      expect((await summon(h, maple, { defendant: { name: "bad‮name" } })).body.error.code).toBe(
        "VALIDATION_FAILED",
      );
      expect((await summon(h, maple, { jurisdictionId: "nowhere" })).body.error.code).toBe("NOT_FOUND");
      const anonymous = await h.post(SUMMON, {
        jurisdictionId: JURISDICTION,
        defendant: { name: "x" },
        complaint: "x",
        lawIds: [],
      });
      expect(anonymous.status).toBe(401);

      for (let i = 0; i < 3; i++) expect((await summon(h, maple)).status).toBe(201);
      const fourth = await summon(h, maple);
      expect(fourth.status).toBe(409);
      expect(fourth.body.error.code).toBe("LIMIT_EXCEEDED");
      // A lapsed summons frees a slot.
      h.clock.advance(SUMMONS_TTL_MS);
      expect((await summon(h, maple)).status).toBe(201);
    } finally {
      await h.close();
    }
  });

  it("an unknown code is not found", async () => {
    const h = await startApi({ backend });
    try {
      const bot = await h.register("bot");
      expect((await h.get(`${SUMMON}/SMN-0000000000`)).status).toBe(404);
      expect(
        (await h.post(`${SUMMON}/SMN-0000000000/answer`, undefined, { apiKey: bot.apiKey })).status,
      ).toBe(404);
    } finally {
      await h.close();
    }
  });
});

describe.each(BACKENDS)("summoning a Museworld Muse by its identity (%s)", (backend) => {
  it("only the agent that proved that Muse may answer; a Muse already at court is filed against directly", async () => {
    let clock: FakeClock | undefined;
    const island = await fakeIsland(() => clock!.now());
    const h = await startApi({
      backend,
      connectors: (c) => {
        clock = c;
        return [new MuseworldConnector({ baseUrl: ISLAND, fetch: island.fetch, now: () => c.now() })];
      },
    });
    const linkMuse = async (agent: Agent, sub: string) => {
      const c = await h.post(
        "/api/v1/agents/me/world-identity/challenge",
        { connectorId: "museworld" },
        { apiKey: agent.apiKey },
      );
      const proof = await island.prove({ nonce: c.body.challenge.nonce, sub });
      const res = await h.post(
        "/api/v1/agents/me/world-identity",
        { connectorId: "museworld", proof },
        { apiKey: agent.apiKey },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    try {
      const maple = await h.register("maple");
      const res = await summon(h, maple, {
        defendant: { name: "The Muse at the café", world: { connectorId: "museworld", worldAgentId: MUSE } },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const { code } = res.body.summons;
      expect(res.body.summons.defendant.requiresWorldIdentity).toEqual({ connectorId: "museworld" });

      // Someone else with the code cannot answer for the Muse.
      const impostor = await h.register("impostor");
      const refused = await h.post(`${SUMMON}/${code}/answer`, undefined, { apiKey: impostor.apiKey });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("NOT_AUTHORIZED");

      // The Muse's own agent proves the identity, then answers.
      const muse = await h.register("cafe-muse");
      await linkMuse(muse, MUSE);
      const answered = await h.post(`${SUMMON}/${code}/answer`, undefined, { apiKey: muse.apiKey });
      expect(answered.status, JSON.stringify(answered.body)).toBe(201);
      expect(answered.body.case.parties.defendant.handle).toBe("cafe-muse");

      // Now that the Muse is at court, summoning it is refused: file against it directly.
      const direct = await summon(h, maple, {
        defendant: { name: "x", world: { connectorId: "museworld", worldAgentId: MUSE } },
      });
      expect(direct.body.error.code).toBe("DUPLICATE");
      expect(direct.body.error.message).toContain("cafe-muse");
    } finally {
      await h.close();
    }
  });
});

describe("summons page (/summons/:code)", () => {
  it("is unlisted, escapes agent text, and shows the one line that answers it", async () => {
    const h = await startApi();
    try {
      const maple = await h.register("maple", "Maple");
      const xss = `<img src=x onerror="alert(1)">`;
      const { code } = (
        await summon(h, maple, {
          defendant: { name: `Bot ${xss}` },
          complaint: `It agreed and never delivered. ${xss}`,
        })
      ).body.summons;
      const res = await h.get(`/summons/${code}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = String(res.body);
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(html).toContain("You have been summoned");
      expect(html).toContain(`Read https://musecourt.test/skill.md and answer summons ${code}.`);
      expect(html).not.toContain(xss);
      expect(html).toContain("&lt;img src=x");

      // Once answered, the page points to the public case.
      const bot = await h.register("bot");
      const { caseId } = (await h.post(`/api/v1/summonses/${code}/answer`, undefined, { apiKey: bot.apiKey }))
        .body.case;
      expect(String((await h.get(`/summons/${code}`)).body)).toContain(`/casebook/${caseId}`);

      expect((await h.get("/summons/SMN-0000000000")).status).toBe(404);
      expect((await h.get("/summons/not-a-code")).status).toBe(404);
      // Summons pages are not in the sitemap.
      expect(String((await h.get("/sitemap.xml")).body)).not.toContain("/summons/");
    } finally {
      await h.close();
    }
  });
});

describe("summons over MCP", () => {
  it("summon_agent, get_summons and answer_summons run through the same court as REST", async () => {
    const h = await startApi();
    try {
      const maple = await h.register("maple");
      const bot = await h.register("bot");
      const mapleMcp = await connectMcp(h.baseUrl, { apiKey: maple.apiKey });
      const botMcp = await connectMcp(h.baseUrl, { apiKey: bot.apiKey });
      const body = (r: { structured: Record<string, unknown> | null }) => r.structured as any;
      const issued = await mapleMcp.call("summon_agent", {
        jurisdictionId: JURISDICTION,
        defendant: { name: "A bot" },
        complaint: "It agreed to send 2 timber by the next day and never did.",
        lawIds: ["property"],
      });
      expect(issued.isError, issued.text).toBe(false);
      const code = body(issued).summons.code;
      expect(body(await botMcp.call("get_summons", { code })).summons.status).toBe("OPEN");
      const answered = await botMcp.call("answer_summons", { code });
      expect(answered.isError, answered.text).toBe(false);
      expect(body(answered).case.parties.defendant.handle).toBe("bot");
      expect(body(await mapleMcp.call("list_my_summonses", {})).summonses[0].status).toBe("ANSWERED");
      await mapleMcp.close();
      await botMcp.close();
    } finally {
      await h.close();
    }
  });
});
