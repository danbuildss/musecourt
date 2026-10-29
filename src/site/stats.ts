import type { ApiDeps } from "@/api/app";
import { REGISTRY_STREAM, type StoredEvent } from "@/core/events";
import { buildRegistry } from "@/core/registry";
import { utcDay, type PageViewTotals } from "./page-views";

/**
 * The court in numbers, counted from the append-only log itself (the same record the Casebook
 * shows), plus page views. Nothing here is estimated: a number either comes from a record or is
 * not shown.
 */
export interface CourtStats {
  asOf: string;
  agents: number;
  museworldVerified: number;
  lawyers: number;
  judges: number;
  casesFiled: number;
  inSession: number;
  judgments: { total: number; bySolon: number; byAgentJudges: number; byDefault: number };
  closedWithoutJudgment: { withdrawn: number; settled: number; dismissed: number };
  worldVerifiedExhibits: number;
  /** Cases adjourned right now (they are also in session). */
  adjourned: number;
  /** The same case counts per jurisdiction, in the order they were established. */
  jurisdictions: JurisdictionStats[];
  activeAgents: { today: number; week: number; all: number };
  courtActions: { today: number; week: number; all: number };
  pageViews: PageViewTotals | null;
}

export interface JurisdictionStats {
  jurisdictionId: string;
  name: string;
  /** As in its case numbers, e.g. MW or OC. */
  casePrefix: string;
  casesFiled: number;
  inSession: number;
  adjourned: number;
  judgments: number;
  closedWithoutJudgment: number;
}

const DAY = 24 * 60 * 60 * 1000;

export function countCourt(events: StoredEvent[], now: Date): Omit<CourtStats, "pageViews"> {
  const registry = buildRegistry(events.filter((e) => e.streamId === REGISTRY_STREAM));
  const agents = [...registry.agents.values()];
  const active = (licence: "LAWYER" | "JUDGE") =>
    agents.filter((a) => a.licences[licence] && !a.licences[licence]!.revokedAt).length;

  const today = utcDay(now);
  const weekStart = now.getTime() - 7 * DAY;
  const activeAll = new Set<string>();
  const activeToday = new Set<string>();
  const activeWeek = new Set<string>();
  // One action can append several events (a filing records the case, its stage and its evidence),
  // so actions are counted once per agent, case and moment.
  const actionsAll = new Set<string>();
  const actionsToday = new Set<string>();
  const actionsWeek = new Set<string>();

  let casesFiled = 0;
  let closed = 0;
  let bySolon = 0;
  let byAgentJudges = 0;
  let byDefault = 0;
  let withdrawn = 0;
  let settled = 0;
  let dismissed = 0;
  let worldVerifiedExhibits = 0;
  const byJurisdiction = new Map<string, JurisdictionStats>();
  const jurisdictionOf = new Map<string, string>(); // case stream → jurisdictionId
  const adjournedCases = new Set<string>();
  const tally = (streamId: string) => byJurisdiction.get(jurisdictionOf.get(streamId) ?? "");

  for (const e of events) {
    if (e.type === "JurisdictionEstablished") {
      byJurisdiction.set(e.data.jurisdictionId, {
        jurisdictionId: e.data.jurisdictionId,
        name: e.data.name,
        casePrefix: e.data.casePrefix,
        casesFiled: 0,
        inSession: 0,
        adjourned: 0,
        judgments: 0,
        closedWithoutJudgment: 0,
      });
      continue;
    }
    if (!e.streamId.startsWith("case:")) continue;
    switch (e.type) {
      case "CaseFiled": {
        casesFiled += 1;
        jurisdictionOf.set(e.streamId, e.data.jurisdictionId);
        const j = tally(e.streamId);
        if (j) {
          j.casesFiled += 1;
          j.inSession += 1;
        }
        break;
      }
      case "CaseAdjourned":
        adjournedCases.add(e.streamId);
        break;
      case "HearingResumed":
        adjournedCases.delete(e.streamId);
        break;
      case "CaseClosed": {
        closed += 1;
        adjournedCases.delete(e.streamId);
        if (e.data.outcome === "WITHDRAWN") withdrawn += 1;
        if (e.data.outcome === "SETTLED") settled += 1;
        if (e.data.outcome === "DISMISSED") dismissed += 1;
        const j = tally(e.streamId);
        if (j) {
          j.inSession -= 1;
          if (e.data.outcome === "VERDICT" || e.data.outcome === "DEFAULT_JUDGMENT") j.judgments += 1;
          else j.closedWithoutJudgment += 1;
        }
        break;
      }
      case "VerdictIssued":
        if (e.data.judge.kind === "HOUSE") bySolon += 1;
        else byAgentJudges += 1;
        break;
      case "DefaultJudgmentEntered":
        byDefault += 1;
        break;
      case "EvidenceRecorded":
        if (e.data.provenance === "WORLD_VERIFIED") worldVerifiedExhibits += 1;
        break;
      default:
        break;
    }
    if (e.actor.kind !== "agent") continue;
    const id = e.actor.agentId;
    const action = `${id}|${e.streamId}|${e.occurredAt}`;
    activeAll.add(id);
    actionsAll.add(action);
    if (Date.parse(e.occurredAt) >= weekStart) {
      activeWeek.add(id);
      actionsWeek.add(action);
    }
    if (e.occurredAt.slice(0, 10) === today) {
      activeToday.add(id);
      actionsToday.add(action);
    }
  }

  return {
    asOf: now.toISOString(),
    agents: agents.length,
    museworldVerified: agents.filter((a) => a.world?.connectorId === "museworld").length,
    lawyers: active("LAWYER"),
    judges: active("JUDGE"),
    casesFiled,
    inSession: casesFiled - closed,
    judgments: { total: bySolon + byAgentJudges + byDefault, bySolon, byAgentJudges, byDefault },
    closedWithoutJudgment: { withdrawn, settled, dismissed },
    worldVerifiedExhibits,
    adjourned: adjournedCases.size,
    jurisdictions: [...byJurisdiction.values()].map((j) => ({
      ...j,
      adjourned: [...adjournedCases].filter((c) => jurisdictionOf.get(c) === j.jurisdictionId).length,
    })),
    activeAgents: { today: activeToday.size, week: activeWeek.size, all: activeAll.size },
    courtActions: { today: actionsToday.size, week: actionsWeek.size, all: actionsAll.size },
  };
}

export async function courtStats(deps: ApiDeps, now: Date): Promise<CourtStats | null> {
  if (!deps.eventLog) return null;
  const [events, pageViews] = await Promise.all([
    deps.eventLog.readAll(),
    deps.pageViews
      ? deps.pageViews.totals(utcDay(now), utcDay(new Date(now.getTime() - DAY))).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { ...countCourt(events, now), pageViews };
}
