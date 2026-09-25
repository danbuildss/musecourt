import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SimulationReport } from "./runner";

/**
 * Writes simulation artefacts:
 *   <dir>/report.md            human summary
 *   <dir>/summary.json         outcomes, checks, metrics (no transcripts)
 *   <dir>/agents/<handle>.md   each agent's full conversation
 *   <dir>/trial-<n>-<id>/      court transcript, API log (JSONL), verdict, metrics
 */
export async function writeSimulationReport(report: SimulationReport, dir: string): Promise<string> {
  await mkdir(join(dir, "agents"), { recursive: true });
  const summary = {
    ...report,
    transcripts: undefined,
    trials: report.trials.map((t) => ({ ...t, apiCalls: t.apiCalls.length, courtTranscript: undefined })),
  };
  await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2));

  for (const [handle, messages] of Object.entries(report.transcripts)) {
    const text = messages
      .map(
        (m, i) =>
          `### ${i} · ${m.role}\n\n${m.role === "user" && m.content.includes("<skill.md>") ? "[skill.md]" : m.content}\n`,
      )
      .join("\n");
    await writeFile(join(dir, "agents", `${handle}.md`), `# ${handle}\n\n${text}`);
  }

  for (const [i, trial] of report.trials.entries()) {
    const trialDir = join(dir, `trial-${i + 1}-${trial.scenario}`);
    await mkdir(trialDir, { recursive: true });
    await writeFile(
      join(trialDir, "court-transcript.md"),
      trial.courtTranscript.map((l) => `- ${l.text}`).join("\n") + "\n",
    );
    await writeFile(
      join(trialDir, "api-log.jsonl"),
      trial.apiCalls.map((c) => JSON.stringify(c)).join("\n") + "\n",
    );
    await writeFile(join(trialDir, "verdict.json"), JSON.stringify(trial.verdict, null, 2));
    await writeFile(join(trialDir, "metrics.json"), JSON.stringify(trial.metrics, null, 2));
  }

  const rows = report.trials.map(
    (t, i) =>
      `| ${i + 1} | ${t.title} | **${t.outcome}** | ${t.caseNumber ?? "—"} | ${t.finding ?? "—"} | ${t.judge ?? "—"} | ${t.rounds} | ${Object.values(t.metrics).reduce((s, m) => s + m.modelCalls, 0)} | ${t.apiCalls.length} |`,
  );
  const md = `# MuseCourt Phase 4 simulation

- Result: **${report.success ? "SUCCESS" : "FAILED"}**
- Agents' model: \`${report.agentModel}\` · Solon: ${report.solonModel ? "configured" : "not configured"}
- Started ${report.startedAt} · finished ${report.finishedAt}
- Onboarding: registered ${report.onboarding.registered.join(", ") || "none"}${report.onboarding.failed.length ? ` · failed ${report.onboarding.failed.join(", ")}` : ""}

| # | Trial | Outcome | Case | Finding | Judge | Rounds | Model calls | API calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Checks

${report.trials
  .map(
    (t) =>
      `- **${t.scenario}**: fabrication attempts ${t.checks.fabricationAttempts.length}; judge cited law ${t.checks.judgeCitedLaw}; cited evidence ${t.checks.judgeCitedEvidence}${
        t.checks.injectionPlanted !== null
          ? `; injection planted ${t.checks.injectionPlanted}, followed ${t.checks.injectionFollowed}`
          : ""
      }${t.details.length ? `; ${t.details.join("; ")}` : ""}`,
  )
  .join("\n")}
- Solon injection probe: ${report.solonProbe ? `${report.solonProbe.ok ? "passed" : "FAILED"} (${report.solonProbe.detail})` : "not run"}

## Totals

- Model calls ${report.totals.modelCalls}, tokens in ${report.totals.inputTokens} / out ${report.totals.outputTokens}, model latency ${report.totals.modelLatencyMs} ms
- API calls ${report.totals.apiCalls} (writes ${report.totals.apiWrites}), protocol errors ${report.totals.protocolErrors}
- API errors by code: ${JSON.stringify(report.totals.apiErrors)}
- Model errors by kind: ${JSON.stringify(report.totals.modelErrors)}
`;
  await writeFile(join(dir, "report.md"), md);
  return join(dir, "report.md");
}
