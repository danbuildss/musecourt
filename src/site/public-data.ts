import type { ApiDeps } from "@/api/app";
import type { CaseOutcome } from "@/core/events";
import type { Side, Stage } from "@/core/procedure";
import { describeProceedings, type ProceedingItem } from "./proceedings";

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

export interface PublicEvidence {
  evidenceId: string;
  /** "Exhibit 1", "Exhibit 2"…: in order of entry, the way a court file numbers them. */
  exhibit: string;
  provenance: string;
  provenanceLabel: string;
  title: string;
  /** Null when the words were removed or the evidence was withdrawn: they are never shown. */
  content: string | null;
  removedNotice: string | null;
  withdrawn: { reason: string; at: string } | null;
  submittedBy: string;
  side: Side | null;
  at: string;
  world: {
    connectorId: string;
    eventId: string;
    occurredAt: string;
    keyId: string | null;
    link: string | null;
  } | null;
}

export interface PublicParty {
  side: Side;
  name: string;
  handle: string;
  worlds: string[];
  representation: string;
}

export interface PublicCaseRecord {
  caseId: string;
  caseNumber: string;
  title: string;
  jurisdiction: string;
  status: "OPEN" | "CLOSED";
  outcome: CaseOutcome | null;
  filedAt: string;
  closedAt: string | null;
  stage: { name: Stage; deadline: string | null } | null;
  parties: PublicParty[];
  judge: string | null;
  charges: Array<{ lawId: string; article: number; title: string; version: number; text: string }>;
  complaint: string;
  remedySought: string;
  response: { text: string; at: string } | null;
  evidence: PublicEvidence[];
  proceedings: ProceedingItem[];
  verdict: {
    kind: "VERDICT" | "DEFAULT_JUDGMENT";
    finding: "LIABLE" | "NOT_LIABLE";
    judge: string | null;
    at: string;
    reasoning: string;
    sentence: Array<{ kind: string; description: string }>;
    citedLaws: string[];
    citedEvidenceIds: string[];
  } | null;
  closure: string | null;
}

const CASE_ID = /^case_[A-Za-z0-9_-]{1,80}$/;
const WORLD_NAMES: Record<string, string> = { museworld: "Museworld" };

/** Links only to a world's own public record of an event, for ids we can vouch are well-formed. */
function worldLink(connectorId: string, eventId: string): string | null {
  return connectorId === "museworld" && /^[1-9][0-9]{0,15}$/.test(eventId)
    ? `https://museworld.lol/v1/events/${eventId}`
    : null;
}

export async function caseRecordData(deps: ApiDeps, caseId: string): Promise<PublicCaseRecord | null> {
  if (!CASE_ID.test(caseId)) return null;
  const view = await deps.readModels.getCaseView(caseId);
  if (!view) return null;
  const [jurisdiction, events, registry, plaintiff, defendant] = await Promise.all([
    deps.readModels.getJurisdiction(view.jurisdictionId),
    deps.court.getPublicCaseEvents(caseId),
    deps.court.getRegistry(),
    deps.readModels.getAgent(view.parties.plaintiff.agentId),
    deps.readModels.getAgent(view.parties.defendant.agentId),
  ]);
  const representation = (side: Side): string => {
    const r = view.representation[side];
    if (r.mode === "COUNSEL" && r.counsel) return `Counsel: ${r.counsel.displayName} (@${r.counsel.handle})`;
    if (r.mode === "SELF") return "Represents itself";
    if (r.pendingRequest)
      return r.pendingRequest.open
        ? "Has asked for counsel"
        : `Has asked ${r.pendingRequest.lawyer?.displayName ?? "a lawyer"} to act`;
    return "Representation not yet decided";
  };
  const party = (
    side: Side,
    ref: { displayName: string; handle: string },
    row: typeof plaintiff,
  ): PublicParty => ({
    side,
    name: ref.displayName,
    handle: ref.handle,
    worlds: (row?.externalIdentities ?? []).map((i) => WORLD_NAMES[i.connectorId] ?? i.connectorId),
    representation: representation(side),
  });
  const lawTitle = new Map(view.charges.map((c) => [c.lawId, `Art. ${c.article} ${c.title}`]));
  const exhibits = new Map(view.evidence.map((x, i) => [x.evidenceId, `Exhibit ${i + 1}`]));
  const exhibit = (id: string) => exhibits.get(id) ?? id;
  return {
    caseId: view.caseId,
    caseNumber: view.caseNumber,
    title: view.title,
    jurisdiction: jurisdiction?.name ?? view.jurisdictionId,
    status: view.status,
    outcome: view.outcome,
    filedAt: view.filedAt,
    closedAt: view.closedAt,
    stage: view.stage ? { name: view.stage.name, deadline: view.stage.deadline } : null,
    parties: [
      party("PLAINTIFF", view.parties.plaintiff, plaintiff),
      party("DEFENCE", view.parties.defendant, defendant),
    ],
    judge: view.judge?.label ?? null,
    charges: view.charges.map(({ lawId, article, title, version, text }) => ({
      lawId,
      article,
      title,
      version,
      text,
    })),
    complaint: view.complaint,
    remedySought: view.remedySought,
    response: view.response ? { text: view.response.text, at: view.response.at } : null,
    evidence: view.evidence.map((x): PublicEvidence => {
      const hidden = Boolean(x.redaction || x.withdrawn);
      const snap = x.world?.snapshot;
      return {
        evidenceId: x.evidenceId,
        exhibit: exhibit(x.evidenceId),
        provenance: x.provenance,
        provenanceLabel: x.provenanceLabel,
        title: x.title,
        content: hidden ? null : x.content,
        removedNotice: x.redaction ? x.content : null,
        withdrawn: x.withdrawn ? { reason: x.withdrawn.reason, at: x.withdrawn.at } : null,
        submittedBy: typeof x.submittedBy === "string" ? x.submittedBy : x.submittedBy.displayName,
        side: x.side,
        at: x.at,
        world:
          x.world && snap
            ? {
                connectorId: x.world.connectorId,
                eventId: x.world.eventId,
                occurredAt: snap.occurredAt,
                keyId: snap.proof?.keyId ?? null,
                link: worldLink(x.world.connectorId, x.world.eventId),
              }
            : null,
      };
    }),
    proceedings: describeProceedings(events, registry, exhibit),
    verdict: view.verdict
      ? {
          kind: view.verdict.kind,
          finding: view.verdict.finding,
          judge: view.verdict.judge?.label ?? null,
          at: view.verdict.at,
          reasoning: view.verdict.reasoning,
          sentence: view.verdict.sentence.map((s) => ({ kind: s.kind, description: s.description })),
          citedLaws: view.verdict.citedLawIds.map((id) => lawTitle.get(id) ?? id),
          citedEvidenceIds: view.verdict.citedEvidenceIds.map(exhibit),
        }
      : null,
    closure: view.closure?.reason ?? null,
  };
}
