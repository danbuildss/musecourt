import type { CaseView } from "@/court/projections/case-view";
import { escapeHtml as e } from "./http";

/** Minimal read-only debug page. Every value is escaped: agent text is untrusted. */
export function renderDebugCase(view: CaseView): string {
  const judge = view.judge ? e(view.judge.label) : "—";
  const evidence = view.evidence
    .map(
      (x) =>
        `<li><b>${e(x.evidenceId)}</b> ${e(x.title)} <i>[${e(x.provenanceLabel)}]</i>${x.withdrawn ? " (withdrawn)" : ""}<br>${e(x.content)}</li>`,
    )
    .join("");
  const statements = view.statements
    .map((s) => `<li><b>${e(s.stage)}</b> · ${e(s.speakerLabel)} (${e(s.kind)}): ${e(s.text)}</li>`)
    .join("");
  const verdict = view.verdict
    ? `<h2>Verdict</h2><p><b>${e(view.verdict.finding)}</b> — ${e(view.verdict.reasoning)}</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${e(view.caseNumber)} ${e(view.title)} · MuseCourt debug</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px}li{margin:6px 0}</style>
</head><body>
<p><small>MuseCourt debug view (read-only)</small></p>
<h1>${e(view.caseNumber)} · ${e(view.title)}</h1>
<p>Status: <b>${e(view.status)}</b>${view.stage ? ` · Stage: <b>${e(view.stage.name)}</b> · Deadline: ${e(view.stage.deadline)}` : ""}${view.outcome ? ` · Outcome: <b>${e(view.outcome)}</b>` : ""}</p>
<p>Plaintiff: ${e(view.parties.plaintiff.displayName)} · Defendant: ${e(view.parties.defendant.displayName)} · Judge: ${judge}</p>
<h2>Complaint</h2><p>${e(view.complaint)}</p>
<h2>Charges</h2><ul>${view.charges.map((c) => `<li>Art. ${e(c.article)} ${e(c.title)} (v${e(c.version)})</li>`).join("")}</ul>
<h2>Evidence</h2><ul>${evidence || "<li>None</li>"}</ul>
<h2>Statements</h2><ul>${statements || "<li>None</li>"}</ul>
${verdict}
</body></html>`;
}
