import type { CaseState } from "@/core/case-state";
import type { RegistryState } from "@/core/registry";
import { agentRef, judgeView, type AgentRef, type JudgeView } from "./labels";

export interface CasebookEntry {
  caseId: string;
  caseNumber: string;
  jurisdictionId: string;
  title: string;
  plaintiff: AgentRef;
  defendant: AgentRef;
  charges: Array<{ lawId: string; article: number; title: string; version: number }>;
  outcome: NonNullable<CaseState["outcome"]>;
  finding: "LIABLE" | "NOT_LIABLE" | null;
  judge: JudgeView | null;
  summary: string;
  filedAt: string;
  closedAt: string;
}

/** The public Casebook: every closed case, oldest first. Derived entirely from the log. */
export function buildCasebook(
  cases: CaseState[],
  registry: RegistryState,
  jurisdictionId?: string,
): CasebookEntry[] {
  return cases
    .filter((c) => c.status === "CLOSED" && (!jurisdictionId || c.jurisdictionId === jurisdictionId))
    .sort((a, b) => a.closedAt!.localeCompare(b.closedAt!) || a.caseNumber.localeCompare(b.caseNumber))
    .map((c) => ({
      caseId: c.caseId,
      caseNumber: c.caseNumber,
      jurisdictionId: c.jurisdictionId,
      title: c.title,
      plaintiff: agentRef(registry, c.plaintiffId),
      defendant: agentRef(registry, c.defendantId),
      charges: c.charges.map(({ lawId, article, title, version }) => ({ lawId, article, title, version })),
      outcome: c.outcome!,
      finding: c.verdict?.finding ?? null,
      judge: c.verdict?.judge
        ? judgeView(registry, c.verdict.judge)
        : c.judge
          ? judgeView(registry, c.judge)
          : null,
      summary: summarise(c),
      filedAt: c.filedAt,
      closedAt: c.closedAt!,
    }));
}

function summarise(c: CaseState): string {
  switch (c.outcome) {
    case "VERDICT":
      return c.verdict!.finding === "LIABLE" ? "Found liable." : "Found not liable.";
    case "DEFAULT_JUDGMENT":
      return "Default judgment: the defendant did not respond.";
    case "SETTLED":
      return "Settled by agreement.";
    case "WITHDRAWN":
      return "Withdrawn by the plaintiff.";
    case "DISMISSED":
      return "Dismissed by the court.";
    default:
      return "";
  }
}
