import type { Actor } from "./actor";
import { fail } from "./errors";
import { event, type CourtEvent, type LawRef, type StoredEvent } from "./events";
import { LIMITS } from "./procedure";
import { requireText } from "./validate";

/**
 * A jurisdiction is a body of versioned law plus a docket, optionally linked
 * to a world connector for verified evidence. The core has no world-specific rules.
 */

export interface JurisdictionState {
  version: number;
  jurisdictionId: string;
  name: string;
  casePrefix: string;
  connectorId: string | null;
  /** lawId → all versions, oldest first. */
  laws: Map<string, LawRef[]>;
  docketCount: number;
}

export function buildJurisdiction(events: Iterable<StoredEvent>): JurisdictionState | null {
  let state: JurisdictionState | null = null;
  for (const e of events) {
    if (e.type === "JurisdictionEstablished") {
      state = {
        version: 0,
        jurisdictionId: e.data.jurisdictionId,
        name: e.data.name,
        casePrefix: e.data.casePrefix,
        connectorId: e.data.connectorId,
        laws: new Map(),
        docketCount: 0,
      };
    }
    if (!state) continue;
    state.version = e.streamVersion;
    if (e.type === "LawVersionEnacted") {
      const versions = state.laws.get(e.data.lawId) ?? [];
      versions.push({ ...e.data });
      state.laws.set(e.data.lawId, versions);
    }
    if (e.type === "CaseDocketed") state.docketCount = e.data.sequence;
  }
  return state;
}

export function currentLaw(state: JurisdictionState, lawId: string): LawRef | undefined {
  const versions = state.laws.get(lawId);
  return versions?.[versions.length - 1];
}

export function currentLaws(state: JurisdictionState): LawRef[] {
  return [...state.laws.keys()]
    .map((id) => currentLaw(state, id))
    .filter((law): law is LawRef => !!law)
    .sort((a, b) => a.article - b.article);
}

export function formatCaseNumber(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PREFIX_PATTERN = /^[A-Z]{2,6}$/;

export function decideEstablishJurisdiction(
  state: JurisdictionState | null,
  actor: Actor,
  input: { jurisdictionId: string; name: string; casePrefix: string; connectorId?: string | null },
): CourtEvent[] {
  if (actor.kind !== "admin") fail("NOT_PERMITTED", "Only an admin can establish a jurisdiction.");
  if (state) fail("DUPLICATE", `Jurisdiction ${input.jurisdictionId} already exists.`);
  if (!ID_PATTERN.test(input.jurisdictionId)) {
    fail("VALIDATION_FAILED", "jurisdictionId must be lower-case letters, digits and '-'.", {
      field: "jurisdictionId",
    });
  }
  if (!PREFIX_PATTERN.test(input.casePrefix)) {
    fail("VALIDATION_FAILED", "casePrefix must be 2–6 upper-case letters.", { field: "casePrefix" });
  }
  return [
    event("JurisdictionEstablished", {
      jurisdictionId: input.jurisdictionId,
      name: requireText(input.name, "name", 1, 100),
      casePrefix: input.casePrefix,
      connectorId: input.connectorId ?? null,
    }),
  ];
}

export interface EnactLawInput {
  lawId: string;
  article: number;
  title: string;
  text: string;
}

/** Enacts a new law (version 1) or a new version of an existing law. Old versions stay in the log. */
export function decideEnactLaw(
  state: JurisdictionState | null,
  actor: Actor,
  input: EnactLawInput,
): CourtEvent[] {
  if (actor.kind !== "admin") fail("NOT_PERMITTED", "Only an admin can enact law.");
  if (!state) fail("NOT_FOUND", "Jurisdiction not found.");
  if (!ID_PATTERN.test(input.lawId))
    fail("VALIDATION_FAILED", "lawId must be lower-case letters, digits and '-'.");
  if (!Number.isInteger(input.article) || input.article < 1) {
    fail("VALIDATION_FAILED", "article must be a positive integer.", { field: "article" });
  }
  const title = requireText(input.title, "title", 1, LIMITS.lawTitleMax);
  const text = requireText(input.text, "text", 10, LIMITS.lawTextMax);
  const existing = currentLaw(state, input.lawId);
  if (existing) {
    if (existing.article !== input.article) {
      fail("VALIDATION_FAILED", "An amendment cannot change a law's article number.", { lawId: input.lawId });
    }
    if (existing.title === title && existing.text === text) {
      fail("DUPLICATE", "The amendment is identical to the current version.", { lawId: input.lawId });
    }
  } else if (currentLaws(state).some((law) => law.article === input.article)) {
    fail("DUPLICATE", `Article ${input.article} is already used by another law.`, { article: input.article });
  }
  return [
    event("LawVersionEnacted", {
      lawId: input.lawId,
      article: input.article,
      title,
      text,
      version: (existing?.version ?? 0) + 1,
    }),
  ];
}
