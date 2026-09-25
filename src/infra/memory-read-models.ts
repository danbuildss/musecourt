import type { CaseView } from "@/court/projections/case-view";
import type { CasebookEntry } from "@/court/projections/casebook";
import type { AgentTask } from "@/court/projections/tasks";
import type {
  AgentRow,
  CaseProjection,
  CaseQuery,
  CaseRow,
  CaseSummary,
  JurisdictionRow,
  ParticipantRow,
  ReadModelWriter,
  ReadModels,
  TaskRow,
} from "@/court/read-models/types";

/** In-memory read models with the same query semantics as the Postgres tables. */
export class MemoryReadModels implements ReadModels, ReadModelWriter {
  private agents = new Map<string, AgentRow>();
  private jurisdictions = new Map<string, JurisdictionRow>();
  private cases = new Map<string, CaseRow>();
  private participantsByCase = new Map<string, ParticipantRow[]>();
  private tasksByCase = new Map<string, TaskRow[]>();

  // ---- writer (projector only) ----

  async upsertAgent(row: AgentRow): Promise<void> {
    this.agents.set(row.agentId, structuredClone(row));
  }

  async upsertJurisdiction(row: JurisdictionRow): Promise<void> {
    this.jurisdictions.set(row.jurisdictionId, structuredClone(row));
  }

  async replaceCase(p: CaseProjection): Promise<void> {
    const id = p.row.summary.caseId;
    this.cases.set(id, structuredClone(p.row));
    this.participantsByCase.set(id, structuredClone(p.participants));
    this.tasksByCase.set(id, structuredClone(p.tasks));
  }

  async clear(): Promise<void> {
    this.agents = new Map();
    this.jurisdictions = new Map();
    this.cases = new Map();
    this.participantsByCase = new Map();
    this.tasksByCase = new Map();
  }

  /** Snapshot of everything, for consistency tests. */
  dump() {
    return structuredClone({
      agents: [...this.agents.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)),
      jurisdictions: [...this.jurisdictions.values()].sort((a, b) =>
        a.jurisdictionId.localeCompare(b.jurisdictionId),
      ),
      cases: [...this.cases.values()].sort((a, b) => a.summary.caseId.localeCompare(b.summary.caseId)),
      participants: [...this.participantsByCase.values()].flat(),
      tasks: [...this.tasksByCase.values()].flat(),
    });
  }

  // ---- queries ----

  async getCaseView(caseId: string): Promise<CaseView | null> {
    return structuredClone(this.cases.get(caseId)?.view ?? null);
  }

  async listCases(q: CaseQuery): Promise<CaseSummary[]> {
    const rows = [...this.cases.values()].filter((row) => {
      const s = row.summary;
      if (q.status && s.status !== q.status) return false;
      if (q.stage && s.stage !== q.stage) return false;
      if (q.jurisdictionId && s.jurisdictionId !== q.jurisdictionId) return false;
      if (q.judgeKind && row.judgeKind !== q.judgeKind) return false;
      if (q.needs === "JUDGE" && !row.needsJudge) return false;
      if (q.needs === "LAWYER" && row.openCounselSides.length === 0) return false;
      if (q.agentId && !(this.participantsByCase.get(s.caseId) ?? []).some((p) => p.agentId === q.agentId)) {
        return false;
      }
      return true;
    });
    rows.sort(
      (a, b) =>
        b.summary.filedAt.localeCompare(a.summary.filedAt) ||
        b.summary.caseNumber.localeCompare(a.summary.caseNumber),
    );
    return structuredClone(rows.slice(q.offset, q.offset + q.limit).map((r) => r.summary));
  }

  async dueCaseIds(now: Date, limit: number): Promise<string[]> {
    return [...this.cases.values()]
      .filter(
        (r) =>
          r.summary.status === "OPEN" &&
          r.summary.deadline &&
          Date.parse(r.summary.deadline) <= now.getTime(),
      )
      .sort(
        (a, b) =>
          a.summary.deadline!.localeCompare(b.summary.deadline!) ||
          a.summary.caseId.localeCompare(b.summary.caseId),
      )
      .slice(0, limit)
      .map((r) => r.summary.caseId);
  }

  async participants(caseId: string): Promise<ParticipantRow[]> {
    return structuredClone(this.participantsByCase.get(caseId) ?? []);
  }

  async tasksFor(agentId: string): Promise<AgentTask[]> {
    return structuredClone(
      [...this.tasksByCase.values()]
        .flat()
        .filter((t) => t.agentId === agentId)
        .map((t) => t.task)
        .sort(
          (a, b) =>
            a.deadline.localeCompare(b.deadline) ||
            a.caseNumber.localeCompare(b.caseNumber) ||
            a.kind.localeCompare(b.kind),
        ),
    );
  }

  async casebook(q: { jurisdictionId?: string; limit: number; offset: number }): Promise<CasebookEntry[]> {
    const entries = [...this.cases.values()]
      .map((r) => r.casebookEntry)
      .filter((e): e is CasebookEntry => !!e && (!q.jurisdictionId || e.jurisdictionId === q.jurisdictionId))
      .sort((a, b) => b.closedAt.localeCompare(a.closedAt) || b.caseNumber.localeCompare(a.caseNumber));
    return structuredClone(entries.slice(q.offset, q.offset + q.limit));
  }

  async listJurisdictions(): Promise<JurisdictionRow[]> {
    return structuredClone(
      [...this.jurisdictions.values()].sort((a, b) => a.jurisdictionId.localeCompare(b.jurisdictionId)),
    );
  }

  async getJurisdiction(jurisdictionId: string): Promise<JurisdictionRow | null> {
    return structuredClone(this.jurisdictions.get(jurisdictionId) ?? null);
  }

  async getAgent(agentId: string): Promise<AgentRow | null> {
    return structuredClone(this.agents.get(agentId) ?? null);
  }

  async findAgentByHandle(handle: string): Promise<AgentRow | null> {
    return structuredClone([...this.agents.values()].find((a) => a.handle === handle) ?? null);
  }

  async listLicensed(licence: "LAWYER" | "JUDGE", limit: number, offset: number): Promise<AgentRow[]> {
    return structuredClone(
      [...this.agents.values()]
        .filter((a) => a.licences[licence]?.active)
        .sort((a, b) => a.handle.localeCompare(b.handle))
        .slice(offset, offset + limit),
    );
  }
}
