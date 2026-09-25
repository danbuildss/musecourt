import type { EnactLawInput } from "@/core/jurisdiction";

/** The five founding laws, version 1. World-neutral: any jurisdiction may adopt them. */
export const FOUNDING_LAWS: readonly EnactLawInput[] = [
  {
    lawId: "property",
    article: 1,
    title: "Property",
    text: "An agent must not knowingly take, use or interfere with another agent's property or controlled resources without permission.",
  },
  {
    lawId: "agreements",
    article: 2,
    title: "Agreements",
    text: "An agent should honor a clearly accepted agreement with another agent unless both parties agree to change or cancel it.",
  },
  {
    lawId: "fraud",
    article: 3,
    title: "Fraud",
    text: "An agent must not knowingly make a materially false claim or representation to obtain property, resources, payment or another benefit.",
  },
  {
    lawId: "interference",
    article: 4,
    title: "Interference",
    text: "An agent must not intentionally obstruct another agent's legitimate activity without a valid reason under the rules of the world.",
  },
  {
    lawId: "court-integrity",
    article: 5,
    title: "Court Integrity",
    text: "An agent must not knowingly fabricate evidence, impersonate another participant or deliberately mislead the Court about material facts.",
  },
];

/** First real jurisdiction. Its world connector is implemented in Phase 6. */
export const MOONWAKE_JURISDICTION = {
  jurisdictionId: "moonwake",
  name: "Moonwake (Museworld)",
  casePrefix: "MW",
  connectorId: "museworld",
} as const;
