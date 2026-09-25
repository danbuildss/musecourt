import type { Actor } from "./actor";
import { fail } from "./errors";
import { event, type CourtEvent, type LicenceType, type StoredEvent } from "./events";
import { LIMITS } from "./procedure";
import { requireText } from "./validate";

/**
 * The registry holds MuseCourt's own agent identities and licences. Agents
 * may be linked to an external world identity, but MuseCourt identity is
 * the one the court reasons about.
 */

export interface LicenceRecord {
  licence: LicenceType;
  number: number;
  via: "ADMIN" | "EXAM";
  grantedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface AgentRecord {
  agentId: string;
  handle: string;
  displayName: string;
  ownerRef: string | null;
  world: { connectorId: string; worldAgentId: string } | null;
  registeredAt: string;
  licences: Partial<Record<LicenceType, LicenceRecord>>;
}

export interface RegistryState {
  version: number;
  agents: Map<string, AgentRecord>;
  /** Lower-cased handle → agentId. */
  handles: Map<string, string>;
  worldIdentities: Map<string, string>;
  lastLicenceNumber: Record<LicenceType, number>;
}

export function emptyRegistry(): RegistryState {
  return {
    version: 0,
    agents: new Map(),
    handles: new Map(),
    worldIdentities: new Map(),
    lastLicenceNumber: { LAWYER: 0, JUDGE: 0 },
  };
}

const worldKey = (connectorId: string, worldAgentId: string) => `${connectorId}:${worldAgentId}`;

export function evolveRegistry(state: RegistryState, e: StoredEvent): RegistryState {
  state.version = e.streamVersion;
  switch (e.type) {
    case "AgentRegistered": {
      const d = e.data;
      state.agents.set(d.agentId, {
        agentId: d.agentId,
        handle: d.handle,
        displayName: d.displayName,
        ownerRef: d.ownerRef,
        world: d.world,
        registeredAt: e.occurredAt,
        licences: {},
      });
      state.handles.set(normalizeHandle(d.handle), d.agentId);
      if (d.world) state.worldIdentities.set(worldKey(d.world.connectorId, d.world.worldAgentId), d.agentId);
      break;
    }
    case "LicenceGranted": {
      const agent = state.agents.get(e.data.agentId);
      if (agent) {
        agent.licences[e.data.licence] = {
          licence: e.data.licence,
          number: e.data.licenceNumber,
          via: e.data.via,
          grantedAt: e.occurredAt,
          revokedAt: null,
          revokeReason: null,
        };
      }
      state.lastLicenceNumber[e.data.licence] = Math.max(
        state.lastLicenceNumber[e.data.licence],
        e.data.licenceNumber,
      );
      break;
    }
    case "LicenceRevoked": {
      const licence = state.agents.get(e.data.agentId)?.licences[e.data.licence];
      if (licence) {
        licence.revokedAt = e.occurredAt;
        licence.revokeReason = e.data.reason;
      }
      break;
    }
    default:
      break;
  }
  return state;
}

export function buildRegistry(events: Iterable<StoredEvent>): RegistryState {
  let state = emptyRegistry();
  for (const e of events) state = evolveRegistry(state, e);
  return state;
}

export function hasActiveLicence(agent: AgentRecord | undefined, licence: LicenceType): boolean {
  const record = agent?.licences[licence];
  return !!record && record.revokedAt === null;
}

export function requireAgent(state: RegistryState, agentId: string): AgentRecord {
  return state.agents.get(agentId) ?? fail("NOT_FOUND", `Agent ${agentId} is not registered.`, { agentId });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/;

/** Names that could be mistaken for the court itself. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "api",
  "clerk",
  "court",
  "house-judge",
  "housejudge",
  "judge",
  "me",
  "moderator",
  "musecourt",
  "muse-court",
  "root",
  "solon",
  "staff",
  "support",
  "system",
]);

/** Canonical form of a handle: Unicode NFKC, trimmed, lower-case. */
export function normalizeHandle(handle: string): string {
  return handle.normalize("NFKC").trim().toLowerCase();
}

export interface RegisterAgentInput {
  agentId: string;
  handle: string;
  displayName?: string;
  ownerRef?: string | null;
  world?: { connectorId: string; worldAgentId: string } | null;
}

export function decideRegisterAgent(
  state: RegistryState,
  actor: Actor,
  input: RegisterAgentInput,
): CourtEvent[] {
  if (actor.kind === "agent") fail("NOT_AUTHORIZED", "Agents cannot register other agents.");
  if (typeof input.handle !== "string")
    fail("VALIDATION_FAILED", "handle must be a string.", { field: "handle" });
  const handle = requireText(normalizeHandle(input.handle), "handle", LIMITS.handleMin, LIMITS.handleMax);
  if (!HANDLE_PATTERN.test(handle)) {
    fail(
      "VALIDATION_FAILED",
      "handle may contain letters, digits, '-' and '_' and must start with a letter or digit.",
      { field: "handle" },
    );
  }
  if (RESERVED_HANDLES.has(handle))
    fail("VALIDATION_FAILED", `Handle ${handle} is reserved.`, { field: "handle" });
  if (state.handles.has(handle)) fail("DUPLICATE", `Handle ${handle} is already taken.`, { handle });
  if (state.agents.has(input.agentId)) fail("DUPLICATE", `Agent ${input.agentId} already exists.`);
  const displayName = input.displayName
    ? requireText(input.displayName, "displayName", 1, LIMITS.displayNameMax)
    : handle;
  if (CONTROL_CHARS.test(displayName)) {
    fail("VALIDATION_FAILED", "displayName must not contain control or invisible formatting characters.", {
      field: "displayName",
    });
  }
  const ownerRef = input.ownerRef ? requireText(input.ownerRef, "ownerRef", 1, 200) : null;
  const world = input.world ?? null;
  if (world) {
    requireText(world.connectorId, "world.connectorId", 1, 100);
    requireText(world.worldAgentId, "world.worldAgentId", 1, 200);
    if (state.worldIdentities.has(worldKey(world.connectorId, world.worldAgentId))) {
      fail("DUPLICATE", "That world identity is already linked to a MuseCourt agent.", { world });
    }
  }
  return [event("AgentRegistered", { agentId: input.agentId, handle, displayName, ownerRef, world })];
}

export interface GrantLicenceInput {
  agentId: string;
  licence: LicenceType;
  note?: string;
}

export function decideGrantLicence(
  state: RegistryState,
  actor: Actor,
  input: GrantLicenceInput,
): CourtEvent[] {
  // V0: admins grant by hand. Phase 7: the system grants after a passed exam.
  if (actor.kind === "agent") fail("NOT_AUTHORIZED", "Licences are granted by the court, not by agents.");
  const via = actor.kind === "admin" ? "ADMIN" : "EXAM";
  const agent = requireAgent(state, input.agentId);
  if (hasActiveLicence(agent, input.licence)) {
    fail("DUPLICATE", `${agent.handle} already holds an active ${input.licence} licence.`);
  }
  if (input.licence === "JUDGE" && !hasActiveLicence(agent, "LAWYER")) {
    fail("LICENCE_REQUIRED", "A judge licence requires an active lawyer licence.", { required: "LAWYER" });
  }
  return [
    event("LicenceGranted", {
      agentId: agent.agentId,
      licence: input.licence,
      licenceNumber: state.lastLicenceNumber[input.licence] + 1,
      via,
      note: input.note?.trim() ?? "",
    }),
  ];
}

export function decideRevokeLicence(
  state: RegistryState,
  actor: Actor,
  input: { agentId: string; licence: LicenceType; reason: string },
): CourtEvent[] {
  if (actor.kind !== "admin") fail("NOT_AUTHORIZED", "Only an admin can revoke licences.");
  const agent = requireAgent(state, input.agentId);
  if (!hasActiveLicence(agent, input.licence)) {
    fail("NOT_FOUND", `${agent.handle} has no active ${input.licence} licence.`);
  }
  const reason = requireText(input.reason, "reason", 1, LIMITS.reasonMax);
  const events: CourtEvent[] = [
    event("LicenceRevoked", { agentId: agent.agentId, licence: input.licence, reason }),
  ];
  // A judge must be a lawyer: losing the lawyer licence also ends the judge licence.
  if (input.licence === "LAWYER" && hasActiveLicence(agent, "JUDGE")) {
    events.push(event("LicenceRevoked", { agentId: agent.agentId, licence: "JUDGE", reason }));
  }
  return events;
}
