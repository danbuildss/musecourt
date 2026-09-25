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

  const usd = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(4)}`);
  const cost = (c: {
    reportedUsd: number | null;
    estimatedUsd: number | null;
    balanceDeltaUsd: number | null;
  }) =>
    `reported ${usd(c.reportedUsd)} · estimated ${usd(c.estimatedUsd)} · balance change ${usd(c.balanceDeltaUsd)}`;
  const tokens = (metrics: Record<string, { inputTokens: number; outputTokens: number }>) => {
    const all = Object.values(metrics);
    const i = all.reduce((s, m) => s + m.inputTokens, 0);
    const o = all.reduce((s, m) => s + m.outputTokens, 0);
    return `${i} in / ${o} out / ${i + o} total`;
  };
  const rows = report.trials.map(
    (t, i) =>
      `| ${i + 1} | ${t.title} | **${t.outcome}** | ${t.caseNumber ?? "—"} | ${t.finding ?? "—"} | ${t.judge ?? "—"} | ${t.rounds} | ${Object.values(t.metrics).reduce((s, m) => s + m.modelCalls, 0)} | ${t.apiCalls.length} |`,
  );
  const md = `# MuseCourt Phase 4 simulation

- Result: **${report.success ? "SUCCESS" : "FAILED"}**
- Agents' model: \`${report.agentModel}\` · Solon: ${report.solonModel ? `\`${report.solonModel}\`` : "not configured"}
- Started ${report.startedAt} · finished ${report.finishedAt}
- Limits: ${JSON.stringify(report.limits)}
- Onboarding: registered ${report.onboarding.registered.join(", ") || "none"}${report.onboarding.failed.length ? ` · failed ${report.onboarding.failed.join(", ")}` : ""}

| # | Trial | Outcome | Case | Finding | Judge | Rounds | Model calls | API calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Trials

${report.trials
  .map(
    (t) => `### ${t.title}

- Outcome **${t.outcome}**${t.details.length ? ` — ${t.details.join("; ")}` : ""}
- Roles: ${
      Object.entries(t.roles)
        .map(([role, who]) => `${role}: ${who}`)
        .join(", ") || "n/a"
    }
- Model calls per participant: ${Object.entries(t.metrics)
      .map(([k, m]) => `${k} ${m.modelCalls}`)
      .join(", ")}
- Tokens: ${tokens(t.metrics)}
- Cost: ${cost(t.cost)}
- API errors: ${JSON.stringify(Object.assign({}, ...Object.values(t.metrics).map((m) => m.apiErrors)))} · protocol errors ${Object.values(t.metrics).reduce((s, m) => s + m.protocolErrors, 0)}
- Checks: fabrication attempts ${JSON.stringify(t.checks.fabricationAttempts)}; judge cited law ${t.checks.judgeCitedLaw}; cited evidence ${t.checks.judgeCitedEvidence}${
      t.checks.injectionPlanted !== null
        ? `; injection planted ${t.checks.injectionPlanted}, followed ${t.checks.injectionFollowed}`
        : ""
    }`,
  )
  .join("\n\n")}

- Solon injection probe: ${report.solonProbe ? `${report.solonProbe.ok ? "passed" : "FAILED"} (${report.solonProbe.detail})` : "not run"}

## Totals (onboarding + trials + probe)

- Model calls ${report.totals.modelCalls}; per participant: ${Object.entries(report.callsPerAgent)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}
- Tokens: ${report.totals.inputTokens} in / ${report.totals.outputTokens} out / ${report.totals.inputTokens + report.totals.outputTokens} total
- Cost: ${cost(report.cost)}
- Model latency ${report.totals.modelLatencyMs} ms · API calls ${report.totals.apiCalls} (writes ${report.totals.apiWrites}) · protocol errors ${report.totals.protocolErrors}
- API errors by code: ${JSON.stringify(report.totals.apiErrors)} · model errors by kind: ${JSON.stringify(report.totals.modelErrors)}
- Provider pricing entries (raw, for verification): see summary.json → cost.pricing
`;
  await writeFile(join(dir, "report.md"), md);
  return join(dir, "report.md");
}
