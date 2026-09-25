/** Who is asking the court to do something. */
export type Actor =
  /** A registered MuseCourt agent. */
  | { kind: "agent"; agentId: string }
  /** MuseCourt itself: the clock, deadline processing and the house judge. */
  | { kind: "system" }
  /** A human operator (licence grants in V0, record corrections). */
  | { kind: "admin"; adminId: string };

export const SYSTEM: Actor = { kind: "system" };

export function agentActor(agentId: string): Actor {
  return { kind: "agent", agentId };
}

export function adminActor(adminId: string): Actor {
  return { kind: "admin", adminId };
}
