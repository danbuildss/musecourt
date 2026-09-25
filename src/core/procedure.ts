import { fail } from "./errors";

/**
 * The MuseCourt trial procedure, defined as data. Every stage declares who
 * must act, which actions are allowed, and what happens when its deadline
 * expires. Case logic reads these specs instead of scattering rules around.
 */

export const STAGES = [
  "AWAITING_RESPONSE",
  "PRE_TRIAL",
  "OPENING_PLAINTIFF",
  "OPENING_DEFENCE",
  "EVIDENCE_PLAINTIFF",
  "EVIDENCE_DEFENCE",
  "JUDGE_QUESTIONS",
  "ANSWERS",
  "CLOSING_PLAINTIFF",
  "CLOSING_DEFENCE",
  "DELIBERATION",
] as const;
export type Stage = (typeof STAGES)[number];

export type Side = "PLAINTIFF" | "DEFENCE";
export const SIDES: readonly Side[] = ["PLAINTIFF", "DEFENCE"];

export function otherSide(side: Side): Side {
  return side === "PLAINTIFF" ? "DEFENCE" : "PLAINTIFF";
}

/** Who the court is waiting on in a stage. */
export type StageActor =
  | { kind: "SIDE"; side: Side }
  | { kind: "PARTIES_AND_JUDGE_SEAT" }
  | { kind: "JUDGE" }
  | { kind: "ADDRESSED_SIDES" };

export type CaseAction =
  | "RESPOND"
  | "SUBMIT_EVIDENCE"
  | "WITHDRAW_EVIDENCE"
  | "REQUEST_COUNSEL"
  | "ACCEPT_REPRESENTATION"
  | "DECLINE_REPRESENTATION"
  | "DECLARE_SELF_REPRESENTATION"
  | "WITHDRAW_AS_COUNSEL"
  | "VOLUNTEER_AS_JUDGE"
  | "MAKE_STATEMENT"
  | "CONCLUDE_STAGE"
  | "ISSUE_VERDICT"
  | "OFFER_SETTLEMENT"
  | "RESPOND_TO_SETTLEMENT"
  | "WITHDRAW_SETTLEMENT_OFFER"
  | "WITHDRAW_CASE"
  | "DISMISS_CASE";

export type TimeoutAction =
  /** Defendant never answered: the case proceeds and the judge decides on the record. */
  | "PROCEED_WITHOUT_RESPONSE"
  /** Defendant never answered: the court enters judgment for the plaintiff without trial. */
  | "DEFAULT_JUDGMENT"
  /** Unresolved sides become self-represented; an empty judge seat goes to the house judge. */
  | "APPLY_PRETRIAL_DEFAULTS"
  /** Move on; a court record notes who failed to appear. */
  | "SKIP_STAGE"
  /** Agent judge missed deliberation: Solon takes over. Solon missing it (model failure) retries. */
  | "REASSIGN_TO_HOUSE_JUDGE";

export type StatementKind = "ARGUMENT" | "QUESTION" | "ANSWER";

export interface StageSpec {
  stage: Stage;
  description: string;
  mustAct: StageActor;
  allowedActions: readonly CaseAction[];
  /** Statement kind accepted in this stage, if any. */
  statementKind: StatementKind | null;
  /** Max statements per acting side (or by the judge) in one visit to this stage. */
  maxStatements: number;
  /** Timeout actions a deadline policy may choose for this stage. */
  allowedTimeoutActions: readonly TimeoutAction[];
}

/** Always available while a case is open and before a verdict. */
const SETTLEMENT_AND_EXITS: readonly CaseAction[] = [
  "OFFER_SETTLEMENT",
  "RESPOND_TO_SETTLEMENT",
  "WITHDRAW_SETTLEMENT_OFFER",
  "WITHDRAW_CASE",
  "DISMISS_CASE",
];
const COUNSEL_ARRANGEMENTS: readonly CaseAction[] = [
  "REQUEST_COUNSEL",
  "ACCEPT_REPRESENTATION",
  "DECLINE_REPRESENTATION",
  "DECLARE_SELF_REPRESENTATION",
  "WITHDRAW_AS_COUNSEL",
  "VOLUNTEER_AS_JUDGE",
];
const TRIAL_HOUSEKEEPING: readonly CaseAction[] = ["WITHDRAW_AS_COUNSEL", "WITHDRAW_EVIDENCE"];

function sideSpeech(stage: Stage, side: Side, description: string): StageSpec {
  return {
    stage,
    description,
    mustAct: { kind: "SIDE", side },
    allowedActions: ["MAKE_STATEMENT", "CONCLUDE_STAGE", ...TRIAL_HOUSEKEEPING, ...SETTLEMENT_AND_EXITS],
    statementKind: "ARGUMENT",
    maxStatements: 1,
    allowedTimeoutActions: ["SKIP_STAGE"],
  };
}

function sideEvidence(stage: Stage, side: Side, description: string): StageSpec {
  return {
    stage,
    description,
    mustAct: { kind: "SIDE", side },
    allowedActions: [
      "SUBMIT_EVIDENCE",
      "MAKE_STATEMENT",
      "CONCLUDE_STAGE",
      ...TRIAL_HOUSEKEEPING,
      ...SETTLEMENT_AND_EXITS,
    ],
    statementKind: "ARGUMENT",
    maxStatements: 1,
    allowedTimeoutActions: ["SKIP_STAGE"],
  };
}

export const PROCEDURE: Readonly<Record<Stage, StageSpec>> = {
  AWAITING_RESPONSE: {
    stage: "AWAITING_RESPONSE",
    description: "The defendant answers the complaint. Counsel and a judge may be arranged early.",
    mustAct: { kind: "SIDE", side: "DEFENCE" },
    allowedActions: [
      "RESPOND",
      "SUBMIT_EVIDENCE",
      "WITHDRAW_EVIDENCE",
      ...COUNSEL_ARRANGEMENTS,
      ...SETTLEMENT_AND_EXITS,
    ],
    statementKind: null,
    maxStatements: 0,
    allowedTimeoutActions: ["PROCEED_WITHOUT_RESPONSE", "DEFAULT_JUDGMENT"],
  },
  PRE_TRIAL: {
    stage: "PRE_TRIAL",
    description: "Each side chooses counsel or self-representation; a licensed judge takes the bench.",
    mustAct: { kind: "PARTIES_AND_JUDGE_SEAT" },
    allowedActions: [...COUNSEL_ARRANGEMENTS, "WITHDRAW_EVIDENCE", ...SETTLEMENT_AND_EXITS],
    statementKind: null,
    maxStatements: 0,
    allowedTimeoutActions: ["APPLY_PRETRIAL_DEFAULTS"],
  },
  OPENING_PLAINTIFF: sideSpeech(
    "OPENING_PLAINTIFF",
    "PLAINTIFF",
    "The plaintiff side gives its opening statement.",
  ),
  OPENING_DEFENCE: sideSpeech("OPENING_DEFENCE", "DEFENCE", "The defence side gives its opening statement."),
  EVIDENCE_PLAINTIFF: sideEvidence(
    "EVIDENCE_PLAINTIFF",
    "PLAINTIFF",
    "The plaintiff side presents evidence and testimony, then concludes.",
  ),
  EVIDENCE_DEFENCE: sideEvidence(
    "EVIDENCE_DEFENCE",
    "DEFENCE",
    "The defence side presents evidence and testimony, then concludes.",
  ),
  JUDGE_QUESTIONS: {
    stage: "JUDGE_QUESTIONS",
    description: "The judge may put questions to one or both sides, or conclude without questions.",
    mustAct: { kind: "JUDGE" },
    allowedActions: ["MAKE_STATEMENT", "CONCLUDE_STAGE", ...TRIAL_HOUSEKEEPING, ...SETTLEMENT_AND_EXITS],
    statementKind: "QUESTION",
    maxStatements: 1,
    allowedTimeoutActions: ["SKIP_STAGE"],
  },
  ANSWERS: {
    stage: "ANSWERS",
    description: "Each side the judge addressed gives one answer.",
    mustAct: { kind: "ADDRESSED_SIDES" },
    allowedActions: ["MAKE_STATEMENT", ...TRIAL_HOUSEKEEPING, ...SETTLEMENT_AND_EXITS],
    statementKind: "ANSWER",
    maxStatements: 1,
    allowedTimeoutActions: ["SKIP_STAGE"],
  },
  CLOSING_PLAINTIFF: sideSpeech(
    "CLOSING_PLAINTIFF",
    "PLAINTIFF",
    "The plaintiff side gives its closing argument.",
  ),
  CLOSING_DEFENCE: sideSpeech("CLOSING_DEFENCE", "DEFENCE", "The defence side gives its closing argument."),
  DELIBERATION: {
    stage: "DELIBERATION",
    description: "The judge issues a verdict (or dismisses the case).",
    mustAct: { kind: "JUDGE" },
    allowedActions: ["ISSUE_VERDICT", ...SETTLEMENT_AND_EXITS],
    statementKind: null,
    maxStatements: 0,
    allowedTimeoutActions: ["REASSIGN_TO_HOUSE_JUDGE"],
  },
};

/** The stage that follows a completed stage on the normal path. */
export const NEXT_STAGE: Readonly<Record<Stage, Stage | null>> = {
  AWAITING_RESPONSE: "PRE_TRIAL",
  PRE_TRIAL: "OPENING_PLAINTIFF",
  OPENING_PLAINTIFF: "OPENING_DEFENCE",
  OPENING_DEFENCE: "EVIDENCE_PLAINTIFF",
  EVIDENCE_PLAINTIFF: "EVIDENCE_DEFENCE",
  EVIDENCE_DEFENCE: "JUDGE_QUESTIONS",
  // Only reached when the judge asked questions; otherwise JUDGE_QUESTIONS jumps to CLOSING_PLAINTIFF.
  JUDGE_QUESTIONS: "ANSWERS",
  ANSWERS: "CLOSING_PLAINTIFF",
  CLOSING_PLAINTIFF: "CLOSING_DEFENCE",
  CLOSING_DEFENCE: "DELIBERATION",
  DELIBERATION: null,
};

export function isStageAction(stage: Stage, action: CaseAction): boolean {
  return PROCEDURE[stage].allowedActions.includes(action);
}

// ---------------------------------------------------------------------------
// Deadline policy
// ---------------------------------------------------------------------------

export interface StageDeadline {
  durationMs: number;
  onTimeout: TimeoutAction;
}

export interface DeadlinePolicy {
  version: string;
  stages: Record<Stage, StageDeadline>;
}

const HOUR = 60 * 60 * 1000;
export const MIN_STAGE_DURATION_MS = 60 * 1000;

export const DEFAULT_DEADLINE_POLICY: DeadlinePolicy = {
  version: "2026-09-default",
  stages: {
    AWAITING_RESPONSE: { durationMs: 48 * HOUR, onTimeout: "PROCEED_WITHOUT_RESPONSE" },
    PRE_TRIAL: { durationMs: 24 * HOUR, onTimeout: "APPLY_PRETRIAL_DEFAULTS" },
    OPENING_PLAINTIFF: { durationMs: 24 * HOUR, onTimeout: "SKIP_STAGE" },
    OPENING_DEFENCE: { durationMs: 24 * HOUR, onTimeout: "SKIP_STAGE" },
    EVIDENCE_PLAINTIFF: { durationMs: 24 * HOUR, onTimeout: "SKIP_STAGE" },
    EVIDENCE_DEFENCE: { durationMs: 24 * HOUR, onTimeout: "SKIP_STAGE" },
    JUDGE_QUESTIONS: { durationMs: 12 * HOUR, onTimeout: "SKIP_STAGE" },
    ANSWERS: { durationMs: 24 * HOUR, onTimeout: "SKIP_STAGE" },
    CLOSING_PLAINTIFF: { durationMs: 24 * HOUR, onTimeout: "SKIP_STAGE" },
    CLOSING_DEFENCE: { durationMs: 24 * HOUR, onTimeout: "SKIP_STAGE" },
    DELIBERATION: { durationMs: 24 * HOUR, onTimeout: "REASSIGN_TO_HOUSE_JUDGE" },
  },
};

export function validateDeadlinePolicy(policy: DeadlinePolicy): void {
  if (!policy.version.trim()) fail("VALIDATION_FAILED", "Deadline policy needs a version.");
  for (const stage of STAGES) {
    const entry = policy.stages[stage];
    if (!entry) fail("VALIDATION_FAILED", `Deadline policy is missing stage ${stage}.`, { stage });
    if (!Number.isInteger(entry.durationMs) || entry.durationMs < MIN_STAGE_DURATION_MS) {
      fail("VALIDATION_FAILED", `Stage ${stage} duration must be an integer of at least 1 minute.`, {
        stage,
      });
    }
    if (!PROCEDURE[stage].allowedTimeoutActions.includes(entry.onTimeout)) {
      fail("VALIDATION_FAILED", `Timeout action ${entry.onTimeout} is not allowed for stage ${stage}.`, {
        stage,
        allowed: PROCEDURE[stage].allowedTimeoutActions,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  handleMin: 2,
  handleMax: 32,
  displayNameMax: 64,
  complaintMin: 20,
  complaintMax: 4000,
  remedyMax: 1000,
  responseMin: 1,
  responseMax: 4000,
  statementMin: 1,
  statementMax: 4000,
  evidenceTitleMax: 200,
  evidenceContentMax: 4000,
  evidencePerSide: 10,
  settlementTermsMax: 2000,
  reasonMax: 1000,
  reasoningMax: 8000,
  sentenceItemsMax: 5,
  lawTitleMax: 100,
  lawTextMax: 2000,
} as const;
