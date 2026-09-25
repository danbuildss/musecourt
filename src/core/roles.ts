import type { CaseState } from "./case-state";
import { fail } from "./errors";
import type { CaseRole, LicenceType } from "./events";
import type { Side } from "./procedure";
import { hasActiveLicence, requireAgent, type RegistryState } from "./registry";

/**
 * Conflict-of-interest rules. This is the ONLY place that decides whether an
 * agent may take a seat in a case; every role change goes through
 * `assertCanTakeRole`, and `assertRosterInvariants` re-checks the whole roster
 * after every command as a safety net.
 *
 * Rules:
 * 1. One agent holds at most one role per case, ever. This covers: a party
 *    cannot judge, a judge cannot represent, nobody represents both sides,
 *    opposing counsel cannot be the same agent. Holding a role and later
 *    switching to a different one (even after withdrawing) is blocked.
 * 2. A plaintiff cannot sue themselves.
 * 3. Owner rule: agents that declare the same owner cannot sit on opposing
 *    sides, and a judge cannot share an owner with any participant.
 * 4. Counsel needs an active LAWYER licence, an agent judge a JUDGE licence.
 */

export function sideOfRole(role: CaseRole): Side | null {
  switch (role) {
    case "PLAINTIFF":
    case "PLAINTIFF_COUNSEL":
      return "PLAINTIFF";
    case "DEFENDANT":
    case "DEFENCE_COUNSEL":
      return "DEFENCE";
    case "JUDGE":
      return null;
  }
}

export function counselRoleFor(side: Side): CaseRole {
  return side === "PLAINTIFF" ? "PLAINTIFF_COUNSEL" : "DEFENCE_COUNSEL";
}

const REQUIRED_LICENCE: Partial<Record<CaseRole, LicenceType>> = {
  PLAINTIFF_COUNSEL: "LAWYER",
  DEFENCE_COUNSEL: "LAWYER",
  JUDGE: "JUDGE",
};

/** Two holdings with the same owner conflict if they are on opposing sides or either is the judge. */
function ownersConflict(a: CaseRole, b: CaseRole): boolean {
  const sideA = sideOfRole(a);
  const sideB = sideOfRole(b);
  return sideA === null || sideB === null || sideA !== sideB;
}

function seatHolder(state: CaseState, role: CaseRole): string | null {
  switch (role) {
    case "PLAINTIFF":
      return state.plaintiffId;
    case "DEFENDANT":
      return state.defendantId;
    case "PLAINTIFF_COUNSEL":
      return state.representation.PLAINTIFF.mode === "COUNSEL"
        ? state.representation.PLAINTIFF.lawyerId
        : null;
    case "DEFENCE_COUNSEL":
      return state.representation.DEFENCE.mode === "COUNSEL" ? state.representation.DEFENCE.lawyerId : null;
    case "JUDGE":
      return state.judge?.kind === "AGENT" ? state.judge.agentId : state.judge ? "HOUSE" : null;
  }
}

/** Checks the parties of a case about to be filed. */
export function assertCanFile(registry: RegistryState, plaintiffId: string, defendantId: string): void {
  const plaintiff = requireAgent(registry, plaintiffId);
  const defendant = requireAgent(registry, defendantId);
  if (plaintiffId === defendantId)
    fail("CONFLICT_OF_INTEREST", "An agent cannot file a case against itself.");
  if (plaintiff.ownerRef && plaintiff.ownerRef === defendant.ownerRef) {
    fail("CONFLICT_OF_INTEREST", "Plaintiff and defendant share an owner.", { rule: "OWNER" });
  }
}

/** Throws unless `agentId` may take `role` in this case right now. */
export function assertCanTakeRole(
  state: CaseState,
  registry: RegistryState,
  agentId: string,
  role: CaseRole,
): void {
  const agent = requireAgent(registry, agentId);

  const licence = REQUIRED_LICENCE[role];
  if (licence && !hasActiveLicence(agent, licence)) {
    fail("LICENCE_REQUIRED", `${agent.handle} needs an active ${licence} licence to act as ${role}.`, {
      required: licence,
    });
  }

  const holder = seatHolder(state, role);
  if (holder === agentId) fail("DUPLICATE", `${agent.handle} already holds ${role} in this case.`);
  if (holder !== null) fail("SEAT_OCCUPIED", `The ${role} seat is already taken.`, { role });

  const otherRole = state.roles.find((h) => h.agentId === agentId && h.role !== role);
  if (otherRole) {
    fail(
      "CONFLICT_OF_INTEREST",
      `${agent.handle} has ${otherRole.current ? "the role" : "previously held the role"} ${otherRole.role} in this case and cannot also act as ${role}.`,
      { rule: "ONE_ROLE_PER_CASE", existingRole: otherRole.role },
    );
  }

  if (agent.ownerRef) {
    for (const holding of state.roles) {
      if (holding.agentId === agentId) continue;
      const other = registry.agents.get(holding.agentId);
      if (other?.ownerRef === agent.ownerRef && ownersConflict(role, holding.role)) {
        fail(
          "CONFLICT_OF_INTEREST",
          `${agent.handle} shares an owner with ${other.handle} (${holding.role}) and cannot act as ${role}.`,
          { rule: "OWNER", conflictingRole: holding.role },
        );
      }
    }
  }
}

/** Whole-roster check, run after every command. Violations mean a bug, not bad input. */
export function assertRosterInvariants(state: CaseState, registry: RegistryState): void {
  const rolesByAgent = new Map<string, Set<CaseRole>>();
  for (const holding of state.roles) {
    const set = rolesByAgent.get(holding.agentId) ?? new Set<CaseRole>();
    set.add(holding.role);
    rolesByAgent.set(holding.agentId, set);
  }
  for (const [agentId, roles] of rolesByAgent) {
    if (roles.size > 1) {
      fail("INVARIANT_VIOLATION", `Agent ${agentId} holds multiple roles: ${[...roles].join(", ")}.`);
    }
  }
  const seated = state.roles.filter((h) => h.current);
  for (const role of ["PLAINTIFF", "DEFENDANT", "PLAINTIFF_COUNSEL", "DEFENCE_COUNSEL", "JUDGE"] as const) {
    if (seated.filter((h) => h.role === role).length > 1) {
      fail("INVARIANT_VIOLATION", `More than one agent currently holds ${role}.`);
    }
  }
  for (let i = 0; i < state.roles.length; i++) {
    for (let j = i + 1; j < state.roles.length; j++) {
      const a = state.roles[i]!;
      const b = state.roles[j]!;
      const ownerA = registry.agents.get(a.agentId)?.ownerRef;
      const ownerB = registry.agents.get(b.agentId)?.ownerRef;
      if (ownerA && ownerA === ownerB && a.agentId !== b.agentId && ownersConflict(a.role, b.role)) {
        fail("INVARIANT_VIOLATION", `Owner conflict between ${a.role} and ${b.role}.`);
      }
    }
  }
}
