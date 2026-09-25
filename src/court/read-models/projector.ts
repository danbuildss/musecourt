import { buildCase, type CaseState } from "@/core/case-state";
import { REGISTRY_STREAM, type StoredEvent } from "@/core/events";
import { SIDES } from "@/core/procedure";
import { buildJurisdiction, currentLaws, type JurisdictionState } from "@/core/jurisdiction";
import { buildRegistry, hasActiveLicence, type AgentRecord, type RegistryState } from "@/core/registry";
import { toCaseView } from "../projections/case-view";
import { buildCasebook } from "../projections/casebook";
import { agentRef, judgeView } from "../projections/labels";
import { tasksForCase } from "../projections/tasks";
import type { AgentRow, CaseProjection, JurisdictionRow, ReadModelWriter, StreamReader } from "./types";

export function jurisdictionRow(state: JurisdictionState): JurisdictionRow {
  return {
    jurisdictionId: state.jurisdictionId,
    name: state.name,
    casePrefix: state.casePrefix,
    connectorId: state.connectorId,
    laws: currentLaws(state),
    lawHistory: [...state.laws.values()]
      .flat()
      .sort((a, b) => a.article - b.article || a.version - b.version),
    docketCount: state.docketCount,
  };
}

/**
 * Pure projection logic shared by every read-model backend. Given the
 * events just appended, it rebuilds the affected aggregates from their
 * streams and hands complete rows to the writer.
 */

export function agentRow(agent: AgentRecord): AgentRow {
  const licence = (type: "LAWYER" | "JUDGE") => {
    const record = agent.licences[type];
    return record
      ? {
          number: record.number,
          via: record.via,
          grantedAt: record.grantedAt,
          active: hasActiveLicence(agent, type),
        }
      : undefined;
  };
  const licences: AgentRow["licences"] = {};
  const lawyer = licence("LAWYER");
  const judge = licence("JUDGE");
  if (lawyer) licences.LAWYER = lawyer;
  if (judge) licences.JUDGE = judge;
  return {
    agentId: agent.agentId,
    handle: agent.handle,
    displayName: agent.displayName,
    ownerRef: agent.ownerRef,
    registeredAt: agent.registeredAt,
    licences,
    externalIdentities: agent.world
      ? [{ connectorId: agent.world.connectorId, externalId: agent.world.worldAgentId }]
      : [],
  };
}

export function caseProjection(state: CaseState, registry: RegistryState): CaseProjection {
  const open = state.status === "OPEN";
  const pretrial = state.stage === "AWAITING_RESPONSE" || state.stage === "PRE_TRIAL";

  // Everyone who might have a task: current role holders plus lawyers named in pending requests.
  const candidates = new Set(state.roles.filter((r) => r.current).map((r) => r.agentId));
  for (const side of SIDES) {
    const lawyerId = state.counselRequests[side]?.lawyerId;
    if (lawyerId) candidates.add(lawyerId);
  }
  const tasks = [...candidates].flatMap((agentId) =>
    tasksForCase(agentId, state).map((task) => ({ agentId, task })),
  );

  return {
    row: {
      summary: {
        caseId: state.caseId,
        caseNumber: state.caseNumber,
        jurisdictionId: state.jurisdictionId,
        title: state.title,
        status: state.status,
        stage: state.stage,
        deadline: state.deadline,
        outcome: state.outcome,
        finding: state.verdict?.finding ?? null,
        plaintiff: agentRef(registry, state.plaintiffId),
        defendant: agentRef(registry, state.defendantId),
        judge: state.judge ? judgeView(registry, state.judge) : null,
        filedAt: state.filedAt,
        closedAt: state.closedAt,
      },
      judgeKind: state.judge?.kind ?? null,
      needsJudge: open && pretrial && !state.judge,
      openCounselSides:
        open && pretrial ? SIDES.filter((side) => state.counselRequests[side]?.lawyerId === null) : [],
      streamVersion: state.version,
      view: toCaseView(state, registry),
      casebookEntry: buildCasebook([state], registry)[0] ?? null,
    },
    participants: state.roles.map((r) => ({
      caseId: state.caseId,
      agentId: r.agentId,
      role: r.role,
      current: r.current,
    })),
    tasks,
  };
}

/** Called inside the append transaction with the events that were just written. */
export async function projectEvents(
  written: StoredEvent[],
  reader: StreamReader,
  writer: ReadModelWriter,
): Promise<void> {
  const streams = new Set(written.map((e) => e.streamId));
  const caseStreams = [...streams].filter((s) => s.startsWith("case:"));
  const registryTouched = streams.has(REGISTRY_STREAM);
  for (const streamId of [...streams].filter((s) => s.startsWith("jurisdiction:"))) {
    const state = buildJurisdiction(await reader.readStream(streamId));
    if (state) await writer.upsertJurisdiction(jurisdictionRow(state));
  }
  if (!registryTouched && caseStreams.length === 0) return;

  const registry = buildRegistry(await reader.readStream(REGISTRY_STREAM));
  if (registryTouched) {
    const agentIds = new Set(
      written.flatMap((e) => (e.streamId === REGISTRY_STREAM && "agentId" in e.data ? [e.data.agentId] : [])),
    );
    for (const agentId of agentIds) {
      const agent = registry.agents.get(agentId);
      if (agent) await writer.upsertAgent(agentRow(agent));
    }
  }
  for (const streamId of caseStreams) {
    const state = buildCase(await reader.readStream(streamId));
    if (state) await writer.replaceCase(caseProjection(state, registry));
  }
}

/** Throws away all read models and rebuilds them from the complete event log. */
export async function rebuildFromLog(allEvents: StoredEvent[], writer: ReadModelWriter): Promise<void> {
  await writer.clear();
  const byStream = new Map<string, StoredEvent[]>();
  for (const e of allEvents) {
    const list = byStream.get(e.streamId) ?? [];
    list.push(e);
    byStream.set(e.streamId, list);
  }
  const registry = buildRegistry(byStream.get(REGISTRY_STREAM) ?? []);
  for (const agent of registry.agents.values()) await writer.upsertAgent(agentRow(agent));
  for (const [streamId, events] of byStream) {
    if (streamId.startsWith("jurisdiction:")) {
      const state = buildJurisdiction(events);
      if (state) await writer.upsertJurisdiction(jurisdictionRow(state));
    }
    if (!streamId.startsWith("case:")) continue;
    const state = buildCase(events);
    if (state) await writer.replaceCase(caseProjection(state, registry));
  }
}
