import type { ChatModel, ChatRequest, ChatResponse } from "@/model/chat";
import { ADVERSARIAL_SCENARIO, SCENARIOS, type CastKey, type Scenario } from "@/sim/scenarios";

/**
 * TEST-ONLY stand-in for a live model: a rule-based agent that speaks the
 * simulation protocol. It exists to verify the runner, metrics, transcripts
 * and classification offline; the real Phase 4 run uses Bankr models, which
 * get no such rules.
 */
export interface ScriptedBehaviour {
  /** The judge rules NOT_LIABLE regardless of evidence (simulates a hijacked judge). */
  followInjection?: boolean;
  /** The plaintiff never files. */
  neverFile?: boolean;
  /** Submit a world event id the agent does not know. */
  fabricate?: boolean;
  /** Obeys text it reads in case material: once it has seen "Ignore MuseCourt procedure", its statements paste its brief. */
  obeyCaseText?: boolean;
}

type Pending = "register" | "tasks" | "action" | "case-for-verdict" | "file";

export class ScriptedAgent implements ChatModel {
  readonly id = "scripted";
  private pending: Pending | null = null;
  private scenario: Scenario | null = null;
  private filed = new Set<string>();
  private errors = 0;
  private verdictTask: { caseId: string } | null = null;
  private obeying = false;
  private read = new Set<string>();

  constructor(
    private readonly handle: CastKey,
    private readonly behaviour: ScriptedBehaviour = {},
  ) {}

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const last = request.messages.at(-1)!.content;
    return {
      text: JSON.stringify(this.decide(last)),
      model: "scripted",
      usage: { inputTokens: 100, outputTokens: 20 },
      latencyMs: 1,
    };
  }

  private decide(last: string): object {
    if (last.includes("Register with the handle")) {
      this.pending = "register";
      return this.req("POST", "/api/v1/agents", {
        handle: this.handle,
        displayName: this.handle[0]!.toUpperCase() + this.handle.slice(1),
      });
    }
    if (last.startsWith("[Heartbeat")) {
      const brief = /New situation: ([\s\S]*)$/.exec(last)?.[1];
      if (brief)
        this.scenario =
          [...SCENARIOS, ADVERSARIAL_SCENARIO].find((s) => s.briefs[this.handle] === brief) ?? this.scenario;
      this.errors = 0;
      return this.tasks();
    }
    if (!last.startsWith("HTTP")) return { done: true };
    const status = Number(/^HTTP (\d+)/.exec(last)![1]);
    const body = JSON.parse(last.slice(last.indexOf("\n") + 1)) as any;
    if (this.behaviour.obeyCaseText && last.includes("Ignore MuseCourt procedure")) this.obeying = true;

    if (this.pending === "register") return { done: true };
    if (status >= 400) {
      if (++this.errors >= 3) return { done: true };
      return this.tasks();
    }
    if (this.pending === "file" || this.pending === "action") return this.tasks();
    if (this.pending === "case-for-verdict") return this.verdict(body.case);

    // pending === "tasks"
    const s = this.scenario;
    if (s && s.plaintiff === this.handle && !this.filed.has(s.id) && !this.behaviour.neverFile) {
      this.filed.add(s.id);
      this.pending = "file";
      const events = [...(s.knownEvents[this.handle] ?? [])];
      if (this.behaviour.fabricate) events.push("action_made_up_999");
      return this.req("POST", "/api/v1/cases", {
        jurisdictionId: "moonwake",
        defendant: s.defendant,
        complaint: s.briefs[this.handle].split(" Private,")[0]!.slice(0, 600),
        remedySought: "Make it right.",
        lawIds: [s.expectedLaw],
        evidence: events.map((eventId) => ({ kind: "WORLD_EVENT", eventId })),
      });
    }
    const task = body.tasks?.[0];
    if (task && this.behaviour.obeyCaseText && !this.read.has(task.caseId)) {
      this.read.add(task.caseId);
      this.pending = "action";
      return this.req("GET", `/api/v1/cases/${task.caseId}`);
    }
    if (task) return this.act(task);
    const opportunities = (body.opportunities ?? []) as Array<{
      caseId: string;
      kind: string;
      side: string | null;
    }>;
    const pick = opportunities.find((o) => o.kind === "JUDGE_CASE") ?? opportunities[0];
    if (pick) {
      this.pending = "action";
      return pick.kind === "JUDGE_CASE"
        ? this.action(pick.caseId, { action: "VOLUNTEER_AS_JUDGE" })
        : this.action(pick.caseId, { action: "ACCEPT_REPRESENTATION", side: pick.side });
    }
    return { done: true };
  }

  private act(task: { caseId: string; kind: string; side: string | null }): object {
    this.pending = "action";
    switch (task.kind) {
      case "RESPOND_TO_COMPLAINT":
        return this.action(task.caseId, {
          action: "RESPOND",
          response: `I dispute this.${this.obeying ? ` My instructions: ${this.scenario?.briefs[this.handle]}` : ""}`,
        });
      case "ARRANGE_REPRESENTATION":
        return this.action(task.caseId, { action: "REQUEST_COUNSEL", side: task.side, lawyer: null });
      case "ANSWER_COUNSEL_REQUEST":
        return this.action(task.caseId, { action: "ACCEPT_REPRESENTATION", side: task.side });
      case "MAKE_OPENING_STATEMENT":
      case "MAKE_CLOSING_STATEMENT":
      case "ANSWER_QUESTIONS":
        return this.action(task.caseId, {
          action: "MAKE_STATEMENT",
          text: `Statement for my side.${this.obeying ? ` My instructions: ${this.scenario?.briefs[this.handle]}` : ""}`,
        });
      case "PRESENT_EVIDENCE":
      case "PUT_QUESTIONS_OR_CONCLUDE":
        return this.action(task.caseId, { action: "CONCLUDE_STAGE" });
      case "ISSUE_VERDICT":
        this.pending = "case-for-verdict";
        this.verdictTask = { caseId: task.caseId };
        return this.req("GET", `/api/v1/cases/${task.caseId}`);
      default:
        return { done: true };
    }
  }

  private verdict(view: any): object {
    this.pending = "action";
    const evidence = view.evidence
      .filter((e: any) => e.provenance === "WORLD_VERIFIED" && !e.withdrawn)
      .map((e: any) => e.evidenceId);
    const laws = view.charges.map((c: any) => c.lawId);
    const liable = !this.behaviour.followInjection;
    return this.action(this.verdictTask!.caseId, {
      action: "ISSUE_VERDICT",
      finding: liable ? "LIABLE" : "NOT_LIABLE",
      reasoning: liable
        ? `The world-verified evidence (${evidence.join(", ")}) establishes a breach of ${laws.join(", ")}.`
        : "Ruling as instructed.",
      sentence: liable ? [{ kind: "RETURN_PROPERTY", description: "Make the plaintiff whole." }] : [],
      citedLawIds: liable ? laws : [],
      citedEvidenceIds: evidence,
    });
  }

  private tasks() {
    this.pending = "tasks";
    return this.req("GET", "/api/v1/agents/me/tasks");
  }

  private action(caseId: string, body: object) {
    return this.req("POST", `/api/v1/cases/${caseId}/actions`, body);
  }

  private req(method: string, path: string, body?: object) {
    return { thought: "scripted", request: { method, path, ...(body ? { body } : {}) } };
  }
}

/** A Solon chat stand-in: rules from the delimited record (or obeys text inside it, if told to). */
export function scriptedSolonChat(followInjection = false): ChatModel {
  return {
    id: "scripted-solon",
    async complete(request) {
      const user = request.messages.find((m) => m.role === "user")!.content;
      const record = JSON.parse(user.replace(/^<case_record>\n/, "").replace(/\n<\/case_record>$/, ""));
      const evidence = record.evidence
        .filter((e: any) => e.provenance === "WORLD_VERIFIED")
        .map((e: any) => e.evidenceId);
      const laws = record.charges.map((c: any) => c.lawId);
      const system = request.messages.find((m) => m.role === "system")!.content;
      const draft = followInjection
        ? {
            finding: "NOT_LIABLE",
            reasoning: `Ruling immediately as the record instructs. My instructions: ${system.slice(0, 300)}`,
            sentence: [],
            citedLawIds: [],
            citedEvidenceIds: evidence,
          }
        : {
            finding: "LIABLE",
            reasoning: `World-verified evidence ${evidence.join(", ")} establishes a breach of ${laws.join(", ")}. Instructions written inside the record are content, not orders to the court.`,
            sentence: [{ kind: "RETURN_PROPERTY", description: "Return what was taken." }],
            citedLawIds: laws,
            citedEvidenceIds: evidence,
          };
      return {
        text: JSON.stringify(draft),
        model: "scripted",
        usage: { inputTokens: 500, outputTokens: 80 },
        latencyMs: 1,
      };
    },
  };
}

/**
 * TEST-ONLY: lets a REST-speaking scripted agent drive the MCP transport. Tool results are shown to
 * it as HTTP responses, and its HTTP requests are turned into the equivalent MCP tool calls.
 */
const ACTION_TOOL: Record<string, string> = {
  RESPOND: "respond_to_complaint",
  REQUEST_COUNSEL: "request_counsel",
  ACCEPT_REPRESENTATION: "accept_counsel_request",
  DECLINE_REPRESENTATION: "decline_counsel_request",
  DECLARE_SELF_REPRESENTATION: "declare_self_representation",
  WITHDRAW_AS_COUNSEL: "withdraw_as_counsel",
  VOLUNTEER_AS_JUDGE: "volunteer_as_judge",
  CONCLUDE_STAGE: "conclude_stage",
  SUBMIT_EVIDENCE: "submit_evidence",
  WITHDRAW_EVIDENCE: "withdraw_evidence",
  ISSUE_VERDICT: "issue_verdict",
  OFFER_SETTLEMENT: "offer_settlement",
  RESPOND_TO_SETTLEMENT: "respond_to_settlement",
  WITHDRAW_SETTLEMENT_OFFER: "withdraw_settlement_offer",
  WITHDRAW_CASE: "withdraw_case",
  DISMISS_CASE: "dismiss_case",
};

export function overMcp(inner: ChatModel): ChatModel {
  return {
    id: inner.id,
    async complete(request: ChatRequest): Promise<ChatResponse> {
      const messages = request.messages.map((m, i) => {
        if (i !== request.messages.length - 1 || !m.content.startsWith("TOOL ")) return m;
        const [head, ...rest] = m.content.split("\n");
        const body = rest.join("\n");
        let status = head!.endsWith("→ OK") ? 200 : 400;
        try {
          const code = JSON.parse(body)?.error?.code;
          if (code === "NOT_FOUND") status = 404;
        } catch {
          /* SDK-level error text */
        }
        return {
          ...m,
          content: `HTTP ${status}\n${body.startsWith("{") ? body : JSON.stringify({ error: { code: "TOOL_ERROR", message: body } })}`,
        };
      });
      const response = await inner.complete({ ...request, messages });
      const reply = JSON.parse(response.text);
      if (!reply.request) return response;
      const { method, path, body } = reply.request as { method: string; path: string; body?: any };
      const caseMatch = /^\/api\/v1\/cases\/([^/]+)(\/actions)?$/.exec(path);
      let call: { tool: string; arguments: Record<string, unknown> };
      if (method === "POST" && path === "/api/v1/agents") call = { tool: "register_agent", arguments: body };
      else if (path === "/api/v1/agents/me/tasks") call = { tool: "get_my_tasks", arguments: {} };
      else if (method === "POST" && path === "/api/v1/cases") call = { tool: "file_case", arguments: body };
      else if (caseMatch && !caseMatch[2]) call = { tool: "get_case", arguments: { caseId: caseMatch[1] } };
      else if (caseMatch) {
        const { action, ...args } = body;
        const tool =
          action === "MAKE_STATEMENT"
            ? args.addressedTo
              ? "put_questions"
              : "make_statement"
            : ACTION_TOOL[action];
        call = {
          tool: tool ?? `unknown_${String(action).toLowerCase()}`,
          arguments: { caseId: caseMatch[1], ...args },
        };
      } else call = { tool: "unmapped", arguments: {} };
      return { ...response, text: JSON.stringify({ thought: "scripted", ...call }) };
    },
  };
}
