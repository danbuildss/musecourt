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

/** The Casebook's filters, already validated: anything unrecognised is simply not applied. */
export interface CasebookFilters {
  status: "OPEN" | "CLOSED" | null;
  jurisdictionId: string | null;
  party: string | null;
  page: number;
}

export interface CasebookData {
  rows: PublicCaseLine[];
  hasOlder: boolean;
  filters: CasebookFilters;
  jurisdictions: Array<{ jurisdictionId: string; name: string }>;
  /** Set when the party filter names no agent (the list is then empty). */
  unknownParty: boolean;
}

export const CASEBOOK_PAGE_SIZE = 25;
const MAX_PAGE = 400;
const HANDLE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export function parseCasebookFilters(params: URLSearchParams): CasebookFilters {
  const status = params.get("status");
  const party = (params.get("party") ?? "").trim().replace(/^@/, "").toLowerCase();
  const page = Number(params.get("page") ?? "1");
  return {
    status: status === "open" ? "OPEN" : status === "closed" ? "CLOSED" : null,
    jurisdictionId: (params.get("jurisdiction") ?? "").trim() || null,
    party: HANDLE.test(party) ? party : null,
    page: Number.isInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1,
  };
}

/** Same wording as the API's casebook summaries, with the judge named for rulings. */
function closedSummary(c: {
  outcome: CaseOutcome | null;
  finding: string | null;
  judge: string | null;
}): string {
  switch (c.outcome) {
    case "VERDICT":
      return `Judgment entered: found ${c.finding === "LIABLE" ? "liable" : "not liable"}${c.judge ? `, by ${c.judge}` : ""}.`;
    case "DEFAULT_JUDGMENT":
      return "Default judgment: the defendant did not respond.";
    case "SETTLED":
      return "Settled by agreement.";
    case "WITHDRAWN":
      return "Withdrawn by the plaintiff.";
    case "DISMISSED":
      return "Dismissed by the court.";
    default:
      return "Closed.";
  }
}

export async function casebookData(deps: ApiDeps, filters: CasebookFilters): Promise<CasebookData> {
  const jurisdictionRows = await deps.readModels.listJurisdictions();
  const names = new Map(jurisdictionRows.map((j) => [j.jurisdictionId, j.name]));
  const jurisdictionId =
    filters.jurisdictionId && names.has(filters.jurisdictionId) ? filters.jurisdictionId : null;
  const applied = { ...filters, jurisdictionId };
  const jurisdictions = jurisdictionRows.map((j) => ({ jurisdictionId: j.jurisdictionId, name: j.name }));

  let agentId: string | undefined;
  if (filters.party) {
    const agent = await deps.readModels.findAgentByHandle(filters.party);
    if (!agent) return { rows: [], hasOlder: false, filters: applied, jurisdictions, unknownParty: true };
    agentId = agent.agentId;
  }
  const found = await deps.readModels.listCases({
    status: filters.status ?? undefined,
    jurisdictionId: jurisdictionId ?? undefined,
    agentId,
    limit: CASEBOOK_PAGE_SIZE + 1,
    offset: (filters.page - 1) * CASEBOOK_PAGE_SIZE,
  });
  const page = found.slice(0, CASEBOOK_PAGE_SIZE);
  const views = await Promise.all(page.map((c) => deps.readModels.getCaseView(c.caseId)));
  const rows = page.map((c, i): PublicCaseLine => {
    const judge = c.judge?.label ?? null;
    return {
      caseId: c.caseId,
      caseNumber: c.caseNumber,
      title: c.title,
      jurisdiction: names.get(c.jurisdictionId) ?? c.jurisdictionId,
      charges: (views[i]?.charges ?? []).map((ch) => ({ article: ch.article, title: ch.title })),
      status: c.status,
      stage: c.stage,
      deadline: c.deadline,
      judge,
      outcome: c.outcome as CaseOutcome | null,
      finding: c.finding,
      summary:
        c.status === "CLOSED"
          ? closedSummary({ outcome: c.outcome as CaseOutcome | null, finding: c.finding, judge })
          : null,
      filedAt: c.filedAt,
      closedAt: c.closedAt,
    };
  });
  return {
    rows,
    hasOlder: found.length > CASEBOOK_PAGE_SIZE,
    filters: applied,
    jurisdictions,
    unknownParty: false,
  };
}
