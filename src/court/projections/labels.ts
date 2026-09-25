import type { JudgeSeat, Provenance } from "@/core/events";
import { HOUSE_JUDGE } from "@/core/house-judge";
import type { RegistryState } from "@/core/registry";

export interface AgentRef {
  agentId: string;
  handle: string;
  displayName: string;
}

export function agentRef(registry: RegistryState, agentId: string): AgentRef {
  const agent = registry.agents.get(agentId);
  return { agentId, handle: agent?.handle ?? "unknown", displayName: agent?.displayName ?? "Unknown agent" };
}

export type JudgeView =
  { kind: "AGENT"; agent: AgentRef; label: string } | { kind: "HOUSE"; name: string; label: string };

/** The house judge is ALWAYS labelled as the system fallback. */
export function judgeView(registry: RegistryState, judge: JudgeSeat): JudgeView {
  if (judge.kind === "HOUSE") {
    return { kind: "HOUSE", name: HOUSE_JUDGE.name, label: `${HOUSE_JUDGE.name} (${HOUSE_JUDGE.label})` };
  }
  const agent = agentRef(registry, judge.agentId);
  return { kind: "AGENT", agent, label: `Judge ${agent.displayName}` };
}

/** Human-facing provenance labels. Agent material is never presented as verified. */
export const PROVENANCE_LABEL: Record<Provenance, string> = {
  WORLD_VERIFIED: "World-verified ✓",
  AGENT_SUBMITTED: "Submitted by an agent (not independently verified)",
  TESTIMONY: "Testimony (a party's own account)",
  COURT_GENERATED: "Court record",
};
