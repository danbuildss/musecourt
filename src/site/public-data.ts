import type { ApiDeps } from "@/api/app";
import type { CaseOutcome } from "@/core/events";
import type { Stage } from "@/core/procedure";

/**
 * The public read layer for the courthouse site. It reads the same read models as the public API
 * and copies only the fields a page shows, so nothing else (proofs, receipts, internal fields) can
 * reach the HTML by accident. Every string here may be agent-written: pages escape all of it.
 */

export interface PublicCaseLine {
  caseId: string;
  caseNumber: string;
  title: string;
  jurisdiction: string;
  charges: Array<{ article: number; title: string }>;
  status: "OPEN" | "CLOSED";
  stage: Stage | null;
  deadline: string | null;
  judge: string | null;
  outcome: CaseOutcome | null;
  finding: "LIABLE" | "NOT_LIABLE" | null;
  summary: string | null;
  filedAt: string;
  closedAt: string | null;
}

export interface CourthouseData {
  docket: PublicCaseLine[];
  recent: PublicCaseLine[];
  jurisdictions: Array<{ name: string; lawCount: number; world: string | null }>;
}

const DOCKET_LIMIT = 20;
const RECENT_LIMIT = 5;

export async function courthouseData(deps: ApiDeps): Promise<CourthouseData> {
  const [open, closed, jurisdictions] = await Promise.all([
    deps.readModels.listCases({ status: "OPEN", limit: DOCKET_LIMIT, offset: 0 }),
    deps.readModels.casebook({ limit: RECENT_LIMIT, offset: 0 }),
    deps.readModels.listJurisdictions(),
  ]);
  const names = new Map(jurisdictions.map((j) => [j.jurisdictionId, j.name]));
  const views = await Promise.all(open.map((c) => deps.readModels.getCaseView(c.caseId)));
  const docket = open.map((c, i): PublicCaseLine => ({
    caseId: c.caseId,
    caseNumber: c.caseNumber,
    title: c.title,
    jurisdiction: names.get(c.jurisdictionId) ?? c.jurisdictionId,
    charges: (views[i]?.charges ?? []).map((ch) => ({ article: ch.article, title: ch.title })),
    status: "OPEN",
    stage: c.stage,
    deadline: c.deadline,
    judge: c.judge?.label ?? null,
    outcome: null,
    finding: null,
    summary: null,
    filedAt: c.filedAt,
    closedAt: null,
  }));
  const recent = closed.map((c): PublicCaseLine => ({
    caseId: c.caseId,
    caseNumber: c.caseNumber,
    title: c.title,
    jurisdiction: names.get(c.jurisdictionId) ?? c.jurisdictionId,
    charges: c.charges.map((ch) => ({ article: ch.article, title: ch.title })),
    status: "CLOSED",
    stage: null,
    deadline: null,
    judge: c.judge?.label ?? null,
    outcome: c.outcome,
    finding: c.finding,
    summary: c.summary,
    filedAt: c.filedAt,
    closedAt: c.closedAt,
  }));
  return {
    docket,
    recent,
    jurisdictions: jurisdictions.map((j) => ({
      name: j.name,
      lawCount: j.laws.length,
      world: j.connectorId,
    })),
  };
}
