import type { CaseRole, LawRef, StoredEvent } from "@/core/events";
import type { Side, Stage } from "@/core/procedure";
import type { CaseView } from "../projections/case-view";
import type { CasebookEntry } from "../projections/casebook";
import type { AgentRef, JudgeView } from "../projections/labels";
import type { AgentTask } from "../projections/tasks";

/**
 * Read models are derived, rebuildable state. They are written only by the
 * projector (inside the same transaction as the events they reflect) and
 * never by API routes.
 */

export interface LicenceSummary {
  number: number;
  via: "ADMIN" | "EXAM";
  grantedAt: string;
  active: boolean;
}

export interface AgentRow {
  agentId: string;
  handle: string;
  displayName: string;
  ownerRef: string | null;
  registeredAt: string;
  licences: { LAWYER?: LicenceSummary; JUDGE?: LicenceSummary };
  externalIdentities: Array<{ connectorId: string; externalId: string }>;
}

export interface JurisdictionRow {
  jurisdictionId: string;
  name: string;
  casePrefix: string;
  connectorId: string | null;
  /** Current version of every law, by article. */
  laws: LawRef[];
  /** Every version ever enacted, oldest first per law. */
  lawHistory: LawRef[];
  docketCount: number;
}

export interface CaseSummary {
  caseId: string;
  caseNumber: string;
  jurisdictionId: string;
  title: string;
  status: "OPEN" | "CLOSED";
  stage: Stage | null;
  deadline: string | null;
  outcome: string | null;
  finding: "LIABLE" | "NOT_LIABLE" | null;
  plaintiff: AgentRef;
  defendant: AgentRef;
  judge: JudgeView | null;
  filedAt: string;
  closedAt: string | null;
}

export interface CaseRow {
  summary: CaseSummary;
  judgeKind: "AGENT" | "HOUSE" | null;
  needsJudge: boolean;
  openCounselSides: Side[];
  streamVersion: number;
  view: CaseView;
  casebookEntry: CasebookEntry | null;
}

export interface ParticipantRow {
  caseId: string;
  agentId: string;
  role: CaseRole;
  current: boolean;
}

export interface TaskRow {
  agentId: string;
  task: AgentTask;
}

export interface CaseProjection {
  row: CaseRow;
  participants: ParticipantRow[];
  tasks: TaskRow[];
}

export interface ReadModelWriter {
  upsertAgent(row: AgentRow): Promise<void>;
  upsertJurisdiction(row: JurisdictionRow): Promise<void>;
  replaceCase(projection: CaseProjection): Promise<void>;
  clear(): Promise<void>;
}

export interface CaseQuery {
  status?: "OPEN" | "CLOSED";
  stage?: Stage;
  jurisdictionId?: string;
  /** Cases where this agent holds (or held) any role. */
  agentId?: string;
  needs?: "LAWYER" | "JUDGE";
  judgeKind?: "AGENT" | "HOUSE";
  limit: number;
  offset: number;
}

export interface ReadModels {
  getCaseView(caseId: string): Promise<CaseView | null>;
  listCases(query: CaseQuery): Promise<CaseSummary[]>;
  /** Open cases whose current deadline is at or before `now`, oldest deadline first. */
  dueCaseIds(now: Date, limit: number): Promise<string[]>;
  participants(caseId: string): Promise<ParticipantRow[]>;
  tasksFor(agentId: string): Promise<AgentTask[]>;
  casebook(query: { jurisdictionId?: string; limit: number; offset: number }): Promise<CasebookEntry[]>;
  listJurisdictions(): Promise<JurisdictionRow[]>;
  getJurisdiction(jurisdictionId: string): Promise<JurisdictionRow | null>;
  getAgent(agentId: string): Promise<AgentRow | null>;
  findAgentByHandle(handle: string): Promise<AgentRow | null>;
  listLicensed(licence: "LAWYER" | "JUDGE", limit: number, offset: number): Promise<AgentRow[]>;
}

/** Reads a stream inside the current append transaction (sees the events being appended). */
export interface StreamReader {
  readStream(streamId: string): Promise<StoredEvent[]>;
}
