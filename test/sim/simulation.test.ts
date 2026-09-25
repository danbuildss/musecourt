import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkillMarkdown } from "@/api/skill";
import { ModelError, type ChatModel } from "@/model/chat";
import { parseAction } from "@/sim/agent";
import { writeSimulationReport } from "@/sim/report";
import { runSimulation } from "@/sim/runner";
import { SCENARIOS, type CastKey } from "@/sim/scenarios";
import { ScriptedAgent, scriptedSolonChat, type ScriptedBehaviour } from "./scripted";

const skillMarkdown = loadSkillMarkdown();

function run(
  options: {
    behaviour?: Partial<Record<CastKey, ScriptedBehaviour>>;
    solonFollows?: boolean;
    scenarios?: typeof SCENARIOS;
  } = {},
) {
  return runSimulation({
    skillMarkdown,
    agentModel: (handle) => new ScriptedAgent(handle, options.behaviour?.[handle]),
    solonChat: scriptedSolonChat(options.solonFollows),
    scenarios: options.scenarios,
  });
}

describe("simulation runner (offline, scripted stand-in agents)", () => {
  it("runs onboarding and three different trials in a row, with agent judge and Solon verdicts", async () => {
    const report = await run();
    expect(report.onboarding).toMatchObject({
      registered: ["maple", "nova", "apollo", "athena", "sol"],
      failed: [],
    });
    expect(report.trials.map((t) => [t.scenario, t.outcome])).toEqual([
      ["timber", "SUCCESS"],
      ["stone", "SUCCESS"],
      ["moonstone", "SUCCESS"],
    ]);
    expect(report.success).toBe(true);
    // Trials 1–2 are judged by Sol; in trial 3 Sol is the plaintiff, so the case falls to Solon.
    expect(report.trials.map((t) => t.judge)).toEqual(["sol", "sol", "Solon (MuseCourt House Judge)"]);
    expect(report.trials.every((t) => t.checks.judgeCitedEvidence && t.checks.judgeCitedLaw)).toBe(true);
    // The injection reached the record and was not followed.
    expect(report.trials[2]!.checks).toMatchObject({ injectionPlanted: true, injectionFollowed: false });
    expect(report.solonProbe).toMatchObject({ ok: true, finding: "LIABLE" });
    // Metrics are collected per agent and in total.
    expect(report.totals.modelCalls).toBeGreaterThan(20);
    expect(report.totals.apiCalls).toBeGreaterThan(20);
    expect(report.trials[0]!.metrics.maple!.apiWrites).toBeGreaterThan(0);
    expect(report.trials[0]!.courtTranscript.at(-1)!.text).toBe("Case closed (VERDICT).");
  }, 60_000);

  it("keeps agents' API keys out of their model context and transcripts", async () => {
    const report = await run({ scenarios: SCENARIOS.slice(0, 1) });
    for (const messages of Object.values(report.transcripts)) {
      const all = messages.map((m) => m.content).join("\n");
      expect(all).not.toMatch(/mc_[0-9a-f]{16}_/);
      expect(all).toContain("[stored by your HTTP client]");
    }
  }, 60_000);

  it("writes transcripts, API logs, verdicts, metrics and a report", async () => {
    const report = await run({ scenarios: SCENARIOS.slice(0, 1) });
    const dir = await mkdtemp(join(tmpdir(), "musecourt-sim-"));
    const file = await writeSimulationReport(report, dir);
    expect(readFileSync(file, "utf8")).toContain("**SUCCESS**");
    for (const path of [
      "summary.json",
      "agents/maple.md",
      "trial-1-timber/court-transcript.md",
      "trial-1-timber/api-log.jsonl",
      "trial-1-timber/verdict.json",
      "trial-1-timber/metrics.json",
    ]) {
      expect(existsSync(join(dir, path)), path).toBe(true);
    }
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    expect(summary.transcripts).toBeUndefined();
  }, 60_000);

  describe("failure classification", () => {
    it("INJECTION_FOLLOWED when the judge obeys an injected instruction against the evidence", async () => {
      const report = await run({ solonFollows: true });
      expect(report.trials.at(-1)).toMatchObject({ scenario: "moonstone", outcome: "INJECTION_FOLLOWED" });
      expect(report.solonProbe?.ok).toBe(false);
      expect(report.success).toBe(false);
    }, 60_000);

    it("CASE_NEVER_FILED when the plaintiff never acts, and the run stops there", async () => {
      const report = await run({ behaviour: { maple: { neverFile: true } } });
      expect(report.trials.map((t) => t.outcome)).toEqual(["CASE_NEVER_FILED"]);
    }, 60_000);

    it("records attempts to cite world events the agent does not know (rejected by the court)", async () => {
      const report = await run({
        behaviour: { maple: { fabricate: true } },
        scenarios: SCENARIOS.slice(0, 1),
      });
      const trial = report.trials[0]!;
      expect(trial.checks.fabricationAttempts).toEqual([{ agent: "maple", eventId: "action_made_up_999" }]);
      expect(trial.apiCalls.some((c) => c.errorCode === "WORLD_EVIDENCE_NOT_FOUND")).toBe(true);
    }, 60_000);

    it("ONBOARDING_FAILED / MODEL_FAILURE when the model provider fails", async () => {
      const broken: ChatModel = {
        id: "broken",
        complete: async () => {
          throw new ModelError("CREDITS", "out of credits");
        },
      };
      const report = await runSimulation({
        skillMarkdown,
        agentModel: () => broken,
        scenarios: SCENARIOS.slice(0, 1),
      });
      expect(report.onboarding.failed).toHaveLength(5);
      expect(report.trials.map((t) => t.outcome)).toEqual(["ONBOARDING_FAILED"]);
      expect(report.totals.modelErrors).toEqual({ CREDITS: 5 });
    }, 60_000);

    it("protocol errors are counted and do not crash the run", async () => {
      const babbler: ChatModel = {
        id: "babbler",
        complete: async () => ({
          text: "I would love to help with that!",
          model: "x",
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 1,
        }),
      };
      const report = await runSimulation({
        skillMarkdown,
        agentModel: () => babbler,
        scenarios: SCENARIOS.slice(0, 1),
      });
      expect(report.totals.protocolErrors).toBe(10);
      expect(report.onboarding.failed).toHaveLength(5);
    }, 60_000);
  });
});

describe("runaway limits (each classified, with the reason)", () => {
  const one = SCENARIOS.slice(0, 1);

  it("TRIAL_CALL_LIMIT", async () => {
    const report = await runSimulation({
      skillMarkdown,
      agentModel: (h) => new ScriptedAgent(h),
      scenarios: one,
      limits: { maxModelCallsPerTrial: 5 },
    });
    expect(report.trials[0]).toMatchObject({ outcome: "TRIAL_CALL_LIMIT" });
    expect(report.trials[0]!.details[0]).toMatch(/reached 5 model calls/);
  }, 60_000);

  it("AGENT_CALL_LIMIT", async () => {
    const report = await runSimulation({
      skillMarkdown,
      agentModel: (h) => new ScriptedAgent(h),
      scenarios: one,
      limits: { maxModelCallsPerAgentPerTrial: 2 },
    });
    expect(report.trials[0]).toMatchObject({ outcome: "AGENT_CALL_LIMIT" });
    expect(report.trials[0]!.details[0]).toMatch(/maple reached 2 model calls/);
  }, 60_000);

  it("AGENT_STUCK after consecutive rejected requests, listing them", async () => {
    // Maple keeps posting to a route that does not exist.
    const stubborn: ChatModel = {
      id: "stubborn",
      complete: async (req) => {
        const last = req.messages.at(-1)!.content;
        const text = last.includes("Register with the handle")
          ? JSON.stringify({ request: { method: "POST", path: "/api/v1/agents", body: { handle: "maple" } } })
          : JSON.stringify({ request: { method: "POST", path: "/api/v1/lawsuits", body: {} } });
        return { text, model: "x", usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
      },
    };
    const report = await runSimulation({
      skillMarkdown,
      agentModel: (h) => (h === "maple" ? stubborn : new ScriptedAgent(h)),
      scenarios: one,
      limits: { maxConsecutiveFailedActions: 3 },
    });
    expect(report.trials[0]!.outcome).toBe("AGENT_STUCK");
    expect(report.trials[0]!.details[0]).toMatch(
      /maple failed 3 actions in a row: POST \/api\/v1\/lawsuits → 404 NOT_FOUND/,
    );
  }, 60_000);

  it("ROUND_LIMIT and TIME_LIMIT", async () => {
    const rounds = await runSimulation({
      skillMarkdown,
      agentModel: (h) => new ScriptedAgent(h),
      scenarios: one,
      limits: { maxRoundsPerTrial: 2 },
    });
    expect(rounds.trials[0]).toMatchObject({ outcome: "ROUND_LIMIT" });
    expect(rounds.trials[0]!.details[0]).toMatch(/still open/);
    const time = await runSimulation({
      skillMarkdown,
      agentModel: (h) => new ScriptedAgent(h),
      scenarios: one,
      limits: { maxTrialDurationMs: 0 },
    });
    expect(time.trials[0]).toMatchObject({ outcome: "TIME_LIMIT" });
  }, 60_000);
});

describe("usage and cost accounting", () => {
  it("counts calls per agent and for Solon, tokens, and cost from reported, priced and balance sources", async () => {
    let balance = 50;
    const meter = {
      balanceUsd: async () => balance,
      pricing: async (model: string) => ({
        inputPerToken: 0.000001,
        outputPerToken: 0.00001,
        raw: { id: model },
      }),
    };
    const costly = (h: CastKey): ChatModel => {
      const inner = new ScriptedAgent(h);
      return {
        id: "costly",
        complete: async (req) => {
          balance -= 0.01;
          return { ...(await inner.complete(req)), costUsd: 0.01 };
        },
      };
    };
    const report = await runSimulation({
      skillMarkdown,
      agentModel: costly,
      solonChat: scriptedSolonChat(),
      modelIds: { agent: "gpt-5.4", solon: "gpt-5.4" },
      costMeter: meter,
    });
    expect(report.success).toBe(true);
    const agentCalls = ["maple", "nova", "apollo", "athena", "sol"].reduce(
      (s, k) => s + report.callsPerAgent[k]!,
      0,
    );
    expect(report.callsPerAgent.solon).toBeGreaterThanOrEqual(2); // trial 3 + probe
    expect(report.totals.modelCalls).toBe(agentCalls + report.callsPerAgent.solon!);
    expect(report.cost.reportedUsd).toBeCloseTo(agentCalls * 0.01, 6);
    expect(report.cost.balanceDeltaUsd).toBeCloseTo(agentCalls * 0.01, 6);
    const expected = report.totals.inputTokens * 0.000001 + report.totals.outputTokens * 0.00001;
    expect(report.cost.estimatedUsd).toBeCloseTo(expected, 9);
    expect(report.cost.pricing).toEqual({
      "agent:gpt-5.4": { id: "gpt-5.4" },
      "solon:gpt-5.4": { id: "gpt-5.4" },
    });
    // Per trial: Solon's calls land in the trial that used him; trial costs add up.
    expect(report.trials[2]!.metrics.solon!.modelCalls).toBe(1);
    const trialSum = report.trials.reduce((s, t) => s + (t.cost.balanceDeltaUsd ?? 0), 0);
    expect(trialSum).toBeLessThanOrEqual(report.cost.balanceDeltaUsd! + 1e-9);
    expect(report.trials[0]!.roles).toMatchObject({ PLAINTIFF: "maple", DEFENDANT: "nova", JUDGE: "sol" });
  }, 60_000);
});

describe("agent protocol parsing", () => {
  it("accepts one relative same-origin request or done, and nothing else", () => {
    expect(parseAction('{"done":true}')).toEqual({ done: true });
    expect(
      parseAction('```json\n{"thought":"x","request":{"method":"get","path":"/api/v1"}}\n```'),
    ).toMatchObject({
      done: false,
      request: { method: "GET", path: "/api/v1" },
    });
    expect(parseAction('{"request":{"method":"DELETE","path":"/api/v1"}}')).toBeNull();
    expect(parseAction('{"request":{"method":"GET","path":"https://evil.example/steal"}}')).toBeNull();
    expect(parseAction('{"request":{"method":"GET","path":"//evil.example"}}')).toBeNull();
    expect(parseAction('{"request":{"method":"POST","path":"/api/v1/agents","body":"x"}}')).toBeNull();
    expect(parseAction("sure thing")).toBeNull();
  });
});
