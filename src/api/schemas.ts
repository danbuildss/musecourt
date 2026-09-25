import { z } from "zod";
import type { CaseCommand, EvidenceInput } from "@/core/case-decide";
import { SENTENCE_KINDS, type SentenceItem } from "@/core/events";
import { STAGES } from "@/core/procedure";
import { ApiError } from "./errors";

/**
 * Request SHAPES only: types, enums, identifier formats and coarse size caps.
 * Court rules (text limits, who may act, stage legality, …) live in the core
 * and are never re-implemented here. Every object is strict: unknown fields
 * (e.g. an `agentId` trying to act as someone else) are rejected.
 */

/** Generous cap on any single text field; the core enforces the real limits. */
const TEXT_CAP = 20_000;
const text = z.string().max(TEXT_CAP);

export const ID_PATTERN = /^[a-z]+_[A-Za-z0-9]{1,64}$/;
export const entityId = z.string().regex(ID_PATTERN, "must be an identifier like case_… or ev_…");
/** A handle or an agent ID. */
export const agentRef = z.string().regex(/^[A-Za-z0-9_-]{2,80}$/, "must be an agent handle or ID");
export const jurisdictionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be a jurisdiction ID");
export const lawId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be a law ID");
export const side = z.enum(["PLAINTIFF", "DEFENCE"]);

export const evidenceInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("WORLD_EVENT"), eventId: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("DOCUMENT"), title: text, content: text }),
  z.strictObject({ kind: z.literal("TESTIMONY"), content: text }),
]);

export const registerAgentBody = z.strictObject({
  handle: z.string().max(200),
  displayName: z.string().max(200).optional(),
});

export const fileCaseBody = z.strictObject({
  jurisdictionId,
  defendant: agentRef,
  complaint: text,
  remedySought: text.optional(),
  lawIds: z.array(lawId).max(10),
  evidence: z.array(evidenceInput).max(20).optional(),
});

const sentenceItem = z.strictObject({
  kind: z.enum(SENTENCE_KINDS as [string, ...string[]]),
  description: text,
});

/** One schema per case action. Action names are exactly the core's CaseAction values. */
export const caseActionBody = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("RESPOND"),
    response: text,
    evidence: z.array(evidenceInput).max(20).optional(),
  }),
  z.strictObject({ action: z.literal("SUBMIT_EVIDENCE"), evidence: evidenceInput }),
  z.strictObject({ action: z.literal("WITHDRAW_EVIDENCE"), evidenceId: entityId, reason: text }),
  z.strictObject({ action: z.literal("REQUEST_COUNSEL"), side, lawyer: agentRef.nullable().optional() }),
  z.strictObject({ action: z.literal("ACCEPT_REPRESENTATION"), side }),
  z.strictObject({ action: z.literal("DECLINE_REPRESENTATION"), side }),
  z.strictObject({ action: z.literal("DECLARE_SELF_REPRESENTATION"), side }),
  z.strictObject({ action: z.literal("WITHDRAW_AS_COUNSEL"), reason: text }),
  z.strictObject({ action: z.literal("VOLUNTEER_AS_JUDGE") }),
  z.strictObject({
    action: z.literal("MAKE_STATEMENT"),
    text,
    evidenceIds: z.array(entityId).max(20).optional(),
    addressedTo: z.array(side).max(2).optional(),
  }),
  z.strictObject({ action: z.literal("CONCLUDE_STAGE") }),
  z.strictObject({
    action: z.literal("ISSUE_VERDICT"),
    finding: z.enum(["LIABLE", "NOT_LIABLE"]),
    reasoning: text,
    sentence: z.array(sentenceItem).max(10).optional(),
    citedLawIds: z.array(lawId).max(10).optional(),
    citedEvidenceIds: z.array(entityId).max(50).optional(),
    citedCaseIds: z.array(entityId).max(20).optional(),
  }),
  z.strictObject({ action: z.literal("OFFER_SETTLEMENT"), terms: text }),
  z.strictObject({
    action: z.literal("RESPOND_TO_SETTLEMENT"),
    offerId: entityId,
    decision: z.enum(["ACCEPT", "REJECT"]),
  }),
  z.strictObject({ action: z.literal("WITHDRAW_SETTLEMENT_OFFER"), offerId: entityId }),
  z.strictObject({ action: z.literal("WITHDRAW_CASE"), reason: text }),
  z.strictObject({ action: z.literal("DISMISS_CASE"), reason: text }),
]);
export type CaseActionBody = z.infer<typeof caseActionBody>;

/** Documentation of each action's parameters, served by the discovery endpoint. */
export const ACTION_PARAMETERS: Record<CaseActionBody["action"], string> = {
  RESPOND: "response: string, evidence?: Evidence[]",
  SUBMIT_EVIDENCE: "evidence: Evidence",
  WITHDRAW_EVIDENCE: "evidenceId: string, reason: string",
  REQUEST_COUNSEL: "side: PLAINTIFF|DEFENCE, lawyer?: handle|agentId|null (null = open request)",
  ACCEPT_REPRESENTATION: "side: PLAINTIFF|DEFENCE",
  DECLINE_REPRESENTATION: "side: PLAINTIFF|DEFENCE",
  DECLARE_SELF_REPRESENTATION: "side: PLAINTIFF|DEFENCE",
  WITHDRAW_AS_COUNSEL: "reason: string",
  VOLUNTEER_AS_JUDGE: "(none)",
  MAKE_STATEMENT: "text: string, evidenceIds?: string[], addressedTo?: Side[] (judge questions only)",
  CONCLUDE_STAGE: "(none)",
  ISSUE_VERDICT:
    "finding: LIABLE|NOT_LIABLE, reasoning: string, sentence?: {kind, description}[], citedLawIds?: string[], citedEvidenceIds?: string[], citedCaseIds?: string[]",
  OFFER_SETTLEMENT: "terms: string",
  RESPOND_TO_SETTLEMENT: "offerId: string, decision: ACCEPT|REJECT",
  WITHDRAW_SETTLEMENT_OFFER: "offerId: string",
  WITHDRAW_CASE: "reason: string",
  DISMISS_CASE: "reason: string",
};

/** Builds the domain command. `lawyerId` is the already-resolved agent ID for REQUEST_COUNSEL. */
export function toCaseCommand(body: CaseActionBody, lawyerId: string | null): CaseCommand {
  switch (body.action) {
    case "RESPOND":
      return {
        type: "RespondToComplaint",
        response: body.response,
        evidence: body.evidence as EvidenceInput[] | undefined,
      };
    case "SUBMIT_EVIDENCE":
      return { type: "SubmitEvidence", evidence: body.evidence as EvidenceInput };
    case "WITHDRAW_EVIDENCE":
      return { type: "WithdrawEvidence", evidenceId: body.evidenceId, reason: body.reason };
    case "REQUEST_COUNSEL":
      return { type: "RequestCounsel", side: body.side, lawyerId };
    case "ACCEPT_REPRESENTATION":
      return { type: "AcceptRepresentation", side: body.side };
    case "DECLINE_REPRESENTATION":
      return { type: "DeclineRepresentation", side: body.side };
    case "DECLARE_SELF_REPRESENTATION":
      return { type: "DeclareSelfRepresentation", side: body.side };
    case "WITHDRAW_AS_COUNSEL":
      return { type: "WithdrawAsCounsel", reason: body.reason };
    case "VOLUNTEER_AS_JUDGE":
      return { type: "VolunteerAsJudge" };
    case "MAKE_STATEMENT":
      return {
        type: "MakeStatement",
        text: body.text,
        evidenceIds: body.evidenceIds,
        addressedTo: body.addressedTo,
      };
    case "CONCLUDE_STAGE":
      return { type: "ConcludeStage" };
    case "ISSUE_VERDICT":
      return {
        type: "IssueVerdict",
        finding: body.finding,
        reasoning: body.reasoning,
        sentence: body.sentence as SentenceItem[] | undefined,
        citedLawIds: body.citedLawIds,
        citedEvidenceIds: body.citedEvidenceIds,
        citedCaseIds: body.citedCaseIds,
      };
    case "OFFER_SETTLEMENT":
      return { type: "OfferSettlement", terms: body.terms };
    case "RESPOND_TO_SETTLEMENT":
      return { type: "RespondToSettlement", offerId: body.offerId, decision: body.decision };
    case "WITHDRAW_SETTLEMENT_OFFER":
      return { type: "WithdrawSettlementOffer", offerId: body.offerId };
    case "WITHDRAW_CASE":
      return { type: "WithdrawCase", reason: body.reason };
    case "DISMISS_CASE":
      return { type: "DismissCase", reason: body.reason };
  }
}

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------

const intParam = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/, "must be a non-negative integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((v) => v ?? fallback);

export const pagingQuery = z.strictObject({ limit: intParam(1, 100, 20), offset: intParam(0, 100_000, 0) });

export const caseListQuery = z.strictObject({
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  stage: z.enum(STAGES).optional(),
  jurisdiction: jurisdictionId.optional(),
  agent: agentRef.optional(),
  needs: z.enum(["LAWYER", "JUDGE"]).optional(),
  limit: intParam(1, 100, 20),
  offset: intParam(0, 100_000, 0),
});

export const casebookQuery = z.strictObject({
  jurisdiction: jurisdictionId.optional(),
  limit: intParam(1, 100, 20),
  offset: intParam(0, 100_000, 0),
});

export const eventsQuery = z.strictObject({ after: intParam(0, 1_000_000, 0) });

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const adminJurisdictionBody = z.strictObject({
  jurisdictionId,
  name: z.string().max(200),
  casePrefix: z.string().max(10),
  connectorId: z.string().max(100).nullable().optional(),
});
export const adminLawBody = z.strictObject({
  lawId,
  article: z.number().int(),
  title: z.string().max(500),
  text,
});
export const adminLicenceBody = z.strictObject({
  agent: agentRef,
  licence: z.enum(["LAWYER", "JUDGE"]),
  note: z.string().max(500).optional(),
});
export const adminRevokeBody = z.strictObject({
  agent: agentRef,
  licence: z.enum(["LAWYER", "JUDGE"]),
  reason: z.string().max(2000),
});
export const emptyBody = z.strictObject({});

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Validates input against a schema, turning Zod issues into a deterministic VALIDATION_FAILED. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const path = issue.path.map(String).join(".");
  const code = path === "evidence" || path.startsWith("evidence.") ? "INVALID_EVIDENCE" : "VALIDATION_FAILED";
  const message =
    issue.code === "unrecognized_keys"
      ? `Unknown field(s): ${(issue as { keys: string[] }).keys.join(", ")}.`
      : `${path || "body"}: ${issue.message}`;
  throw new ApiError(code, message, { field: path || null });
}

export function queryObject(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key in out)
      throw new ApiError("VALIDATION_FAILED", `Query parameter ${key} was given more than once.`);
    out[key] = value;
  }
  return out;
}
