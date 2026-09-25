import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkillMarkdown } from "@/api/skill";
import { ModelError, type ChatModel } from "@/model/chat";
import { LlmCourtModel } from "@/model/llm-court-model";
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
    solonModel: new LlmCourtModel(scriptedSolonChat(options.solonFollows)),
    scenarios: options.scenarios,
  });
}

describe("simulation runner (offline, scripted stand-in agents)", () => {
  it("runs onboarding and three different trials in a row, with agent judge and Solon verdicts", async () => {
    const report = await run();
    expect(report.onboarding).toEqual({
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
