import { afterAll, describe, expect, it } from "vitest";
import { connectMcp, type MuseCourtMcpClient } from "@/mcp/client";
import { BACKENDS, closeSharedPool, startApi } from "../api/harness";

afterAll(closeSharedPool);

/**
 * Domain parity: REST and MCP have different surfaces but one court. The same
 * scenario (successes, refusals and retries) runs once through REST and once
 * through MCP on two fresh courts; the commands reaching the court, the events
 * it emits, the resulting case state, the returned views and every error must
 * be identical.
 */

type Handle = "maple" | "nova" | "apollo" | "athena" | "sol";
interface Ctx {
  cases: string[];
  view: any;
}
interface Op {
  as: Handle;
  tool: string;
  args: (ctx: Ctx) => Record<string, unknown>;
  /** Re-send with the same idempotency key (a deliberate retry). */
  retry?: boolean;
  /** Re-send the same key with different arguments. */
  misuse?: Record<string, unknown>;
}
interface Outcome {
  ok: boolean;
  error?: { code: string; message: string; retryable: boolean; details: unknown };
  view?: unknown;
  replayed?: boolean;
}

/** The REST equivalent of each MCP write tool: the route's action name, plus field renames. */
const REST_ACTION: Record<string, string> = {
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

const c0 = (c: Ctx) => c.cases[0]!;
const c1 = (c: Ctx) => c.cases[1]!;
const c2 = (c: Ctx) => c.cases[2]!;
const c3 = (c: Ctx) => c.cases[3]!;
const file = (plaintiff: Handle, defendant: Handle, evidence?: unknown[]): Op => ({
  as: plaintiff,
  tool: "file_case",
  args: () => ({
    jurisdictionId: "fake",
    defendant,
    complaint: `${defendant} harvested timber from my plot without permission.`,
    remedySought: "Return 5 timber.",
    lawIds: ["property"],
    ...(evidence ? { evidence } : {}),
  }),
});
const act = (
  as: Handle,
  tool: string,
  args: (c: Ctx) => Record<string, unknown>,
  extra: Partial<Op> = {},
): Op => ({
  as,
  tool,
  args,
  ...extra,
});

const SCENARIO: Op[] = [
  // ---- Case 1: a full trial, with refusals along the way ----
  file("maple", "nova", [{ kind: "WORLD_EVENT", eventId: "action_72882" }]),
  file("maple", "nova", [{ kind: "WORLD_EVENT", eventId: "action_made_up" }]), // unknown world event
  act("nova", "make_statement", (c) => ({ caseId: c0(c), text: "Too early." })), // WRONG_STAGE
  act("apollo", "respond_to_complaint", (c) => ({ caseId: c0(c), response: "Not my case." })), // NOT_AUTHORIZED
  act("nova", "respond_to_complaint", (c) => ({ caseId: c0(c), response: "I had permission." }), {
    retry: true,
  }),
  act("maple", "request_counsel", (c) => ({ caseId: c0(c), side: "PLAINTIFF", lawyer: "apollo" })),
  act("apollo", "decline_counsel_request", (c) => ({ caseId: c0(c), side: "PLAINTIFF" })),
  act("maple", "request_counsel", (c) => ({ caseId: c0(c), side: "PLAINTIFF", lawyer: null })),
  act("apollo", "accept_counsel_request", (c) => ({ caseId: c0(c), side: "PLAINTIFF" })),
  act("nova", "request_counsel", (c) => ({ caseId: c0(c), side: "DEFENCE" })),
  act("apollo", "accept_counsel_request", (c) => ({ caseId: c0(c), side: "DEFENCE" })), // one role per case
  act("maple", "volunteer_as_judge", (c) => ({ caseId: c0(c) })), // not a judge
  act("athena", "accept_counsel_request", (c) => ({ caseId: c0(c), side: "DEFENCE" })),
  act("sol", "volunteer_as_judge", (c) => ({ caseId: c0(c) })),
  act("apollo", "put_questions", (c) => ({ caseId: c0(c), text: "Q?", addressedTo: ["DEFENCE"] })), // not questions
  act("apollo", "make_statement", (c) => ({ caseId: c0(c), text: "Nova took the timber." }), {
    retry: true,
    misuse: { text: "A different opening." },
  }),
  act("athena", "conclude_stage", (c) => ({ caseId: c0(c) })),
  act("apollo", "submit_evidence", (c) => ({
    caseId: c0(c),
    evidence: { kind: "DOCUMENT", title: "Plot map", content: "Plot 17 belongs to Maple." },
  })),
  act("apollo", "submit_evidence", (c) => ({
    caseId: c0(c),
    evidence: { kind: "TESTIMONY", content: "I saw it." },
  })), // counsel cannot testify
  act("maple", "submit_evidence", (c) => ({
    caseId: c0(c),
    evidence: { kind: "TESTIMONY", content: "I never agreed." },
  })),
  act("apollo", "withdraw_evidence", (c) => ({
    caseId: c0(c),
    evidenceId: c.view.evidence.find((e: any) => e.title === "Plot map").evidenceId,
    reason: "Duplicated by the world record.",
  })),
  act("apollo", "make_statement", (c) => ({ caseId: c0(c), text: "The record shows the harvest." })),
  act("apollo", "conclude_stage", (c) => ({ caseId: c0(c) })),
  act("athena", "conclude_stage", (c) => ({ caseId: c0(c) })),
  act("sol", "put_questions", (c) => ({
    caseId: c0(c),
    text: "Was permission recorded?",
    addressedTo: ["DEFENCE"],
  })),
  act("athena", "make_statement", (c) => ({ caseId: c0(c), text: "It was given verbally." })),
  act("apollo", "make_statement", (c) => ({ caseId: c0(c), text: "Closing: no permission." })),
  act("athena", "make_statement", (c) => ({ caseId: c0(c), text: "Closing: consent unproven." })),
  act("apollo", "issue_verdict", (c) => ({ caseId: c0(c), finding: "LIABLE", reasoning: "Mine to decide?" })), // not the judge
  act("sol", "issue_verdict", (c) => ({
    caseId: c0(c),
    finding: "LIABLE",
    reasoning: "No reasoning without law.",
  })), // LIABLE needs law + sentence
  act("sol", "issue_verdict", (c) => ({
    caseId: c0(c),
    finding: "LIABLE",
    reasoning: "The world-verified harvest shows a taking without permission.",
    sentence: [{ kind: "RETURN_PROPERTY", description: "Return 5 timber." }],
    citedLawIds: ["property"],
    citedEvidenceIds: c.view.evidence
      .filter((e: any) => e.provenance === "WORLD_VERIFIED")
      .map((e: any) => e.evidenceId),
  })),
  act("sol", "issue_verdict", (c) => ({ caseId: c0(c), finding: "NOT_LIABLE", reasoning: "Again." })), // CASE_CLOSED

  // ---- Case 2: settlement ----
  file("nova", "maple"),
  act("maple", "offer_settlement", (c) => ({ caseId: c1(c), terms: "I return 2 timber." })),
  act("nova", "respond_to_settlement", (c) => ({
    caseId: c1(c),
    offerId: c.view.offers.at(-1).offerId,
    decision: "REJECT",
  })),
  act("maple", "offer_settlement", (c) => ({ caseId: c1(c), terms: "I return 3 timber." })),
  act("maple", "withdraw_settlement_offer", (c) => ({
    caseId: c1(c),
    offerId: c.view.offers.at(-1).offerId,
  })),
  act("nova", "offer_settlement", (c) => ({ caseId: c1(c), terms: "Return 4 timber and we are done." })),
  act("maple", "respond_to_settlement", (c) => ({
    caseId: c1(c),
    offerId: c.view.offers.at(-1).offerId,
    decision: "ACCEPT",
  })),

  // ---- Case 3: withdrawn by the plaintiff ----
  file("maple", "nova"),
  act("nova", "withdraw_case", (c) => ({ caseId: c2(c), reason: "Not mine to withdraw." })), // defendant cannot
  act("maple", "withdraw_case", (c) => ({ caseId: c2(c), reason: "We sorted it out ourselves." })),

  // ---- Case 4: counsel withdraws, self-representation, dismissal ----
  file("nova", "maple"),
  act("maple", "respond_to_complaint", (c) => ({ caseId: c3(c), response: "Denied." })),
  act("nova", "request_counsel", (c) => ({ caseId: c3(c), side: "PLAINTIFF", lawyer: "athena" })),
  act("athena", "accept_counsel_request", (c) => ({ caseId: c3(c), side: "PLAINTIFF" })),
  act("athena", "withdraw_as_counsel", (c) => ({ caseId: c3(c), reason: "A conflict arose." })),
  act("maple", "declare_self_representation", (c) => ({ caseId: c3(c), side: "DEFENCE" })),
  act("maple", "declare_self_representation", (c) => ({ caseId: c3(c), side: "DEFENCE" })), // DUPLICATE
  act("sol", "volunteer_as_judge", (c) => ({ caseId: c3(c) })),
  act("sol", "dismiss_case", (c) => ({ caseId: c3(c), reason: "Frivolous." })),
];

interface Run {
  outcomes: Outcome[];
  commands: unknown[];
  events: unknown[];
  states: unknown[];
  views: unknown[];
}

async function runScenario(backend: "memory" | "postgres", via: "rest" | "mcp"): Promise<Run> {
  const h = await startApi({ backend });
  const commands: unknown[] = [];
  const act0 = h.court.act.bind(h.court);
  const file0 = h.court.fileCase.bind(h.court);
  h.court.act = (caseId, actor, command) => {
    commands.push({ caseId, actor, command });
    return act0(caseId, actor, command);
  };
  h.court.fileCase = (actor, input) => {
    commands.push({ actor, fileCase: input });
    return file0(actor, input);
  };
  const clients: Partial<Record<Handle, MuseCourtMcpClient>> = {};
  try {
    const keys: Partial<Record<Handle, string>> = {};
    const anon = via === "mcp" ? await connectMcp(h.baseUrl) : null;
    for (const handle of ["maple", "nova", "apollo", "athena", "sol"] as Handle[]) {
      if (anon) {
        const r = await anon.call("register_agent", { handle });
        keys[handle] = (r.structured as any).credential.apiKey;
        clients[handle] = await connectMcp(h.baseUrl, { apiKey: keys[handle] });
      } else {
        keys[handle] = (await h.register(handle)).apiKey;
      }
    }
    await anon?.close();
    for (const lawyer of ["apollo", "athena", "sol"] as const)
      await h.grant({ handle: lawyer, agentId: "", apiKey: "" }, "LAWYER");
    await h.grant({ handle: "sol", agentId: "", apiKey: "" }, "JUDGE");

    const send = async (op: Op, args: Record<string, unknown>, key: string): Promise<Outcome> => {
      if (via === "mcp") {
        const r = await clients[op.as]!.call(op.tool, { ...args, idempotencyKey: key });
        const s = r.structured as any;
        return r.isError
          ? { ok: false, error: s.error, replayed: s.replayed }
          : { ok: true, view: s.case, replayed: s.replayed };
      }
      const { caseId, ...rest } = args;
      const res =
        op.tool === "file_case"
          ? await h.post("/api/v1/cases", args, { apiKey: keys[op.as], idempotencyKey: key })
          : await h.post(
              `/api/v1/cases/${caseId as string}/actions`,
              { action: REST_ACTION[op.tool], ...rest },
              { apiKey: keys[op.as], idempotencyKey: key },
            );
      const replayed = res.headers.get("idempotent-replayed") === "true" ? true : undefined;
      return res.status < 300
        ? { ok: true, view: res.body.case, replayed }
        : { ok: false, error: res.body.error, replayed };
    };

    const ctx: Ctx = { cases: [], view: null };
    const outcomes: Outcome[] = [];
    let n = 0;
    for (const op of SCENARIO) {
      const args = op.args(ctx);
      const key = `parity-key-${String(++n).padStart(8, "0")}`;
      const out = await send(op, args, key);
      outcomes.push(out);
      if (op.retry) outcomes.push(await send(op, args, key));
      if (op.misuse) outcomes.push(await send(op, { ...args, ...op.misuse }, key));
      if (out.ok) {
        ctx.view = out.view;
        if (op.tool === "file_case") ctx.cases.push((out.view as any).caseId);
      }
    }
    const events = [];
    const states = [];
    const views = [];
    for (const caseId of ctx.cases) {
      events.push(await h.court.getCaseEvents(caseId));
      states.push(await h.court.getCase(caseId));
      views.push((await h.get(`/api/v1/cases/${caseId}`)).body.case);
    }
    return { outcomes, commands, events, states, views };
  } finally {
    for (const c of Object.values(clients)) await c!.close();
    await h.close();
  }
}

describe.each(BACKENDS)("REST/MCP domain parity (%s)", (backend) => {
  it("the same scenario yields the same commands, events, state, views, errors and retries", async () => {
    const rest = await runScenario(backend, "rest");
    const mcp = await runScenario(backend, "mcp");

    // The scenario really exercised the court: four cases, successes, refusals and replays.
    expect(rest.states.map((s: any) => s.outcome)).toEqual(["VERDICT", "SETTLED", "WITHDRAWN", "DISMISSED"]);
    const codes = rest.outcomes.filter((o) => !o.ok).map((o) => o.error!.code);
    expect(new Set(codes)).toEqual(
      new Set([
        "WORLD_EVIDENCE_NOT_FOUND",
        "WRONG_STAGE",
        "NOT_AUTHORIZED",
        "CONFLICT_OF_INTEREST",
        "LICENCE_REQUIRED",
        "VALIDATION_FAILED",
        "IDEMPOTENCY_KEY_REUSED",
        "CASE_CLOSED",
        "DUPLICATE",
      ]),
    );
    expect(rest.outcomes.filter((o) => o.replayed)).toHaveLength(2);
    expect(rest.commands.length).toBeGreaterThan(40);
    expect(rest.events.flat().length).toBeGreaterThan(50);

    expect(mcp.commands).toEqual(rest.commands);
    expect(mcp.outcomes).toEqual(rest.outcomes);
    expect(mcp.events).toEqual(rest.events);
    expect(mcp.states).toEqual(rest.states);
    expect(mcp.views).toEqual(rest.views);
  }, 60_000);
});
