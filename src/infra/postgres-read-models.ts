import type { Pool, PoolClient } from "pg";
import type { CaseView } from "@/court/projections/case-view";
import type { CasebookEntry } from "@/court/projections/casebook";
import type { AgentTask } from "@/court/projections/tasks";
import type {
  AgentRow,
  CaseProjection,
  CaseQuery,
  CaseSummary,
  JurisdictionRow,
  ParticipantRow,
  ReadModelWriter,
  ReadModels,
} from "@/court/read-models/types";

type Queryable = Pick<Pool | PoolClient, "query">;

/** Writes read-model rows; always used with the client of the current append transaction. */
export class PostgresReadModelWriter implements ReadModelWriter {
  constructor(private readonly db: Queryable) {}

  async upsertAgent(row: AgentRow): Promise<void> {
    await this.db.query(
      `INSERT INTO musecourt.rm_agents (agent_id, handle, display_name, owner_ref, registered_at, licences, is_lawyer, is_judge)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id) DO UPDATE SET handle = EXCLUDED.handle, display_name = EXCLUDED.display_name,
         owner_ref = EXCLUDED.owner_ref, licences = EXCLUDED.licences,
         is_lawyer = EXCLUDED.is_lawyer, is_judge = EXCLUDED.is_judge`,
      [
        row.agentId,
        row.handle,
        row.displayName,
        row.ownerRef,
        row.registeredAt,
        JSON.stringify(row.licences),
        !!row.licences.LAWYER?.active,
        !!row.licences.JUDGE?.active,
      ],
    );
    await this.db.query("DELETE FROM musecourt.rm_agent_external_identities WHERE agent_id = $1", [
      row.agentId,
    ]);
    for (const identity of row.externalIdentities) {
      await this.db.query(
        "INSERT INTO musecourt.rm_agent_external_identities (connector_id, external_id, agent_id) VALUES ($1, $2, $3)",
        [identity.connectorId, identity.externalId, row.agentId],
      );
    }
  }

  async upsertJurisdiction(row: JurisdictionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO musecourt.rm_jurisdictions (jurisdiction_id, row) VALUES ($1, $2)
       ON CONFLICT (jurisdiction_id) DO UPDATE SET row = EXCLUDED.row`,
      [row.jurisdictionId, JSON.stringify(row)],
    );
  }

  async replaceCase(p: CaseProjection): Promise<void> {
    const s = p.row.summary;
    await this.db.query(
      `INSERT INTO musecourt.rm_cases (case_id, case_number, jurisdiction_id, status, stage, deadline, outcome, finding,
         judge_kind, needs_judge, open_counsel_sides, filed_at, closed_at, stream_version, summary, view, casebook_entry)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (case_id) DO UPDATE SET status = EXCLUDED.status, stage = EXCLUDED.stage,
         deadline = EXCLUDED.deadline, outcome = EXCLUDED.outcome, finding = EXCLUDED.finding,
         judge_kind = EXCLUDED.judge_kind, needs_judge = EXCLUDED.needs_judge,
         open_counsel_sides = EXCLUDED.open_counsel_sides, closed_at = EXCLUDED.closed_at,
         stream_version = EXCLUDED.stream_version, summary = EXCLUDED.summary, view = EXCLUDED.view,
         casebook_entry = EXCLUDED.casebook_entry`,
      [
        s.caseId,
        s.caseNumber,
        s.jurisdictionId,
        s.status,
        s.stage,
        s.deadline,
        s.outcome,
        s.finding,
        p.row.judgeKind,
        p.row.needsJudge,
        p.row.openCounselSides,
        s.filedAt,
        s.closedAt,
        p.row.streamVersion,
        JSON.stringify(s),
        JSON.stringify(p.row.view),
        p.row.casebookEntry ? JSON.stringify(p.row.casebookEntry) : null,
      ],
    );
    await this.db.query("DELETE FROM musecourt.rm_case_participants WHERE case_id = $1", [s.caseId]);
    for (const r of p.participants) {
      await this.db.query(
        "INSERT INTO musecourt.rm_case_participants (case_id, agent_id, role, current) VALUES ($1, $2, $3, $4)",
        [r.caseId, r.agentId, r.role, r.current],
      );
    }
    await this.db.query("DELETE FROM musecourt.rm_agent_tasks WHERE case_id = $1", [s.caseId]);
    for (const t of p.tasks) {
      await this.db.query(
        "INSERT INTO musecourt.rm_agent_tasks (agent_id, case_id, deadline, task) VALUES ($1, $2, $3, $4)",
        [t.agentId, t.task.caseId, t.task.deadline, JSON.stringify(t.task)],
      );
    }
  }

  async clear(): Promise<void> {
    await this.db.query(
      `TRUNCATE musecourt.rm_agent_tasks, musecourt.rm_case_participants, musecourt.rm_cases,
                musecourt.rm_agent_external_identities, musecourt.rm_agents, musecourt.rm_jurisdictions`,
    );
  }
}

interface AgentDbRow {
  agent_id: string;
  handle: string;
  display_name: string;
  owner_ref: string | null;
  registered_at: Date;
  licences: AgentRow["licences"];
  identities: AgentRow["externalIdentities"];
}

const AGENT_SELECT = `SELECT a.agent_id, a.handle, a.display_name, a.owner_ref, a.registered_at, a.licences,
  COALESCE((SELECT json_agg(json_build_object('connectorId', i.connector_id, 'externalId', i.external_id)
            ORDER BY i.connector_id, i.external_id)
            FROM musecourt.rm_agent_external_identities i WHERE i.agent_id = a.agent_id), '[]') AS identities
  FROM musecourt.rm_agents a`;

function toAgent(r: AgentDbRow): AgentRow {
  return {
    agentId: r.agent_id,
    handle: r.handle,
    displayName: r.display_name,
    ownerRef: r.owner_ref,
    registeredAt: r.registered_at.toISOString(),
    licences: r.licences,
    externalIdentities: r.identities,
  };
}

/** Query side. Every value comes from parameters; agent text is never interpolated into SQL. */
export class PostgresReadModels implements ReadModels {
  constructor(private readonly db: Queryable) {}

  async getCaseView(caseId: string): Promise<CaseView | null> {
    const { rows } = await this.db.query<{ view: CaseView }>(
      "SELECT view FROM musecourt.rm_cases WHERE case_id = $1",
      [caseId],
    );
    return rows[0]?.view ?? null;
  }

  async listCases(q: CaseQuery): Promise<CaseSummary[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };
    if (q.status) add("c.status = ?", q.status);
    if (q.stage) add("c.stage = ?", q.stage);
    if (q.jurisdictionId) add("c.jurisdiction_id = ?", q.jurisdictionId);
    if (q.judgeKind) add("c.judge_kind = ?", q.judgeKind);
    if (q.needs === "JUDGE") where.push("c.needs_judge");
    if (q.needs === "LAWYER") where.push("cardinality(c.open_counsel_sides) > 0");
    if (q.agentId) {
      add(
        "EXISTS (SELECT 1 FROM musecourt.rm_case_participants p WHERE p.case_id = c.case_id AND p.agent_id = ?)",
        q.agentId,
      );
    }
    params.push(q.limit, q.offset);
    const { rows } = await this.db.query<{ summary: CaseSummary }>(
      `SELECT c.summary FROM musecourt.rm_cases c
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY c.filed_at DESC, c.case_number DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((r) => r.summary);
  }

  async dueCaseIds(now: Date, limit: number): Promise<string[]> {
    const { rows } = await this.db.query<{ case_id: string }>(
      `SELECT case_id FROM musecourt.rm_cases WHERE status = 'OPEN' AND deadline <= $1
       ORDER BY deadline, case_id LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => r.case_id);
  }

  async participants(caseId: string): Promise<ParticipantRow[]> {
    const { rows } = await this.db.query<{
      case_id: string;
      agent_id: string;
      role: ParticipantRow["role"];
      current: boolean;
    }>(
      "SELECT case_id, agent_id, role, current FROM musecourt.rm_case_participants WHERE case_id = $1 ORDER BY agent_id, role",
      [caseId],
    );
    return rows.map((r) => ({ caseId: r.case_id, agentId: r.agent_id, role: r.role, current: r.current }));
  }

  async tasksFor(agentId: string): Promise<AgentTask[]> {
    const { rows } = await this.db.query<{ task: AgentTask }>(
      `SELECT task FROM musecourt.rm_agent_tasks WHERE agent_id = $1
       ORDER BY deadline, task->>'caseNumber', task->>'kind'`,
      [agentId],
    );
    return rows.map((r) => r.task);
  }

  async casebook(q: { jurisdictionId?: string; limit: number; offset: number }): Promise<CasebookEntry[]> {
    const { rows } = await this.db.query<{ casebook_entry: CasebookEntry }>(
      `SELECT casebook_entry FROM musecourt.rm_cases
       WHERE status = 'CLOSED' AND ($1::text IS NULL OR jurisdiction_id = $1)
       ORDER BY closed_at DESC, case_number DESC LIMIT $2 OFFSET $3`,
      [q.jurisdictionId ?? null, q.limit, q.offset],
    );
    return rows.map((r) => r.casebook_entry);
  }

  async listJurisdictions(): Promise<JurisdictionRow[]> {
    const { rows } = await this.db.query<{ row: JurisdictionRow }>(
      "SELECT row FROM musecourt.rm_jurisdictions ORDER BY jurisdiction_id",
    );
    return rows.map((r) => r.row);
  }

  async getJurisdiction(jurisdictionId: string): Promise<JurisdictionRow | null> {
    const { rows } = await this.db.query<{ row: JurisdictionRow }>(
      "SELECT row FROM musecourt.rm_jurisdictions WHERE jurisdiction_id = $1",
      [jurisdictionId],
    );
    return rows[0]?.row ?? null;
  }

  async getAgent(agentId: string): Promise<AgentRow | null> {
    const { rows } = await this.db.query<AgentDbRow>(`${AGENT_SELECT} WHERE a.agent_id = $1`, [agentId]);
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async findAgentByHandle(handle: string): Promise<AgentRow | null> {
    const { rows } = await this.db.query<AgentDbRow>(`${AGENT_SELECT} WHERE a.handle = $1`, [handle]);
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async listLicensed(licence: "LAWYER" | "JUDGE", limit: number, offset: number): Promise<AgentRow[]> {
    const column = licence === "LAWYER" ? "is_lawyer" : "is_judge";
    const { rows } = await this.db.query<AgentDbRow>(
      `${AGENT_SELECT} WHERE a.${column} ORDER BY a.handle LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map(toAgent);
  }

  /** Snapshot of everything, for consistency tests. */
  async dump() {
    const agents = (await this.db.query<AgentDbRow>(`${AGENT_SELECT} ORDER BY a.agent_id`)).rows.map(toAgent);
    const jurisdictions = await this.listJurisdictions();
    const cases = (
      await this.db.query(
        `SELECT summary, judge_kind, needs_judge, open_counsel_sides, stream_version, view, casebook_entry
         FROM musecourt.rm_cases ORDER BY case_id`,
      )
    ).rows;
    const participants = (
      await this.db.query(
        "SELECT case_id, agent_id, role, current FROM musecourt.rm_case_participants ORDER BY case_id, agent_id, role",
      )
    ).rows;
    const tasks = (
      await this.db.query(
        "SELECT agent_id, case_id, deadline, task FROM musecourt.rm_agent_tasks ORDER BY case_id, agent_id, task->>'kind'",
      )
    ).rows;
    return { agents, jurisdictions, cases, participants, tasks };
  }
}
