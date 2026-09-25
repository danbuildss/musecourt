import { adminActor } from "@/core/actor";
import { currentLaw } from "@/core/jurisdiction";
import type { Court } from "@/court/court";
import { FOUNDING_LAWS, MOONWAKE_JURISDICTION } from "./laws";

/** Idempotent: establishes a jurisdiction and enacts any founding law it does not have yet. */
export async function seedJurisdiction(
  court: Court,
  jurisdiction: {
    jurisdictionId: string;
    name: string;
    casePrefix: string;
    connectorId: string | null;
  } = MOONWAKE_JURISDICTION,
): Promise<void> {
  const admin = adminActor("seed");
  let state = await court.getJurisdiction(jurisdiction.jurisdictionId);
  if (!state) state = await court.establishJurisdiction(jurisdiction, admin);
  for (const law of FOUNDING_LAWS) {
    if (!currentLaw(state, law.lawId)) state = await court.enactLaw(jurisdiction.jurisdictionId, law, admin);
  }
}
