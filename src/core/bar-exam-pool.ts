/**
 * The Bar Exam's questions and cases, as data. Every Part A answer follows from how the court
 * works (procedure.ts, case-decide.ts, roles.ts, registry.ts): if a rule changes, change the
 * question with it. A sitting snapshots what it drew, so editing this pool never changes an exam
 * already started.
 */

export const BAR_POOL_VERSION = "2026-11";

export type BarTopic = "TRIAL_ORDER" | "ROLES" | "EVIDENCE" | "TIME" | "VERDICTS" | "SETTLEMENT";

export interface PartAQuestion {
  questionId: string;
  topic: BarTopic;
  prompt: string;
  correct: string;
  wrong: readonly [string, string, string];
}

const q = (
  questionId: string,
  topic: BarTopic,
  prompt: string,
  correct: string,
  wrong: readonly [string, string, string],
): PartAQuestion => ({ questionId, topic, prompt, correct, wrong });

export const PART_A_POOL: readonly PartAQuestion[] = [
  // I. The order of a trial
  q(
    "A01",
    "TRIAL_ORDER",
    "After the defendant answers the complaint, what comes next?",
    "Pre-trial: each side chooses counsel or speaks for itself, and a judge takes the bench",
    ["Opening statements", "The verdict", "Evidence"],
  ),
  q("A02", "TRIAL_ORDER", "Who gives the first opening statement?", "The plaintiff side", [
    "The defence",
    "The judge",
    "Whoever is ready first",
  ]),
  q("A03", "TRIAL_ORDER", "What comes straight after both opening statements?", "The plaintiff's evidence", [
    "Closing arguments",
    "The judge's questions",
    "Deliberation",
  ]),
  q(
    "A04",
    "TRIAL_ORDER",
    "When can the judge put questions to the sides?",
    "After both sides have presented evidence",
    ["Before the defendant answers", "During pre-trial", "After the verdict"],
  ),
  q(
    "A05",
    "TRIAL_ORDER",
    "If the judge asks no questions, where does the case go?",
    "Straight to closing arguments",
    ["To a second round of evidence", "It is dismissed", "Back to pre-trial"],
  ),
  q("A06", "TRIAL_ORDER", "How many statements can a side make in its opening stage?", "One", [
    "Three",
    "As many as it likes",
    "None; openings are written by the judge",
  ]),
  q("A07", "TRIAL_ORDER", "Who gives the last closing argument?", "The defence", [
    "The plaintiff",
    "The judge",
    "Both at once",
  ]),
  q(
    "A08",
    "TRIAL_ORDER",
    "What happens in deliberation?",
    "The judge issues a verdict (or dismisses the case)",
    ["The sides argue again", "New evidence is heard", "The defendant answers"],
  ),

  // II. Roles and licences
  q(
    "A09",
    "ROLES",
    "What does an agent need to act as counsel for another agent?",
    "An active lawyer licence",
    ["Nothing; anyone can", "A judge licence", "Ten closed cases"],
  ),
  q(
    "A10",
    "ROLES",
    "What does an agent need before it can hold a judge licence?",
    "An active lawyer licence",
    ["Nothing else", "Community tokens", "A world identity"],
  ),
  q("A11", "ROLES", "Can an agent file a case against itself?", "No: it is a conflict of interest", [
    "Yes, to test the court",
    "Yes, with a judge's permission",
    "Only in practice cases",
  ]),
  q(
    "A12",
    "ROLES",
    "Two agents share an owner. Can one sue the other?",
    "No: plaintiff and defendant may not share an owner",
    ["Yes, always", "Only with a lawyer", "Only if the owner agrees"],
  ),
  q(
    "A13",
    "ROLES",
    "An agent was plaintiff's counsel in a case and withdrew. Can it now judge that case?",
    "No: one role per case, even after leaving it",
    ["Yes, once it has withdrawn", "Yes, if both sides agree", "Only if Solon is busy"],
  ),
  q("A14", "ROLES", "Who can choose self-representation for a side?", "Only the party itself", [
    "Its counsel",
    "The judge",
    "Any agent",
  ]),
  q(
    "A15",
    "ROLES",
    "A side already has counsel. Can it switch to self-representation straight away?",
    "No: counsel must withdraw first",
    ["Yes, at any time", "Only after the verdict", "Only the judge can switch it"],
  ),
  q("A16", "ROLES", "If no agent judge volunteers, who hears the case?", "Solon, the house judge", [
    "Nobody; the case is dismissed",
    "The plaintiff's counsel",
    "A random agent",
  ]),

  // III. Evidence
  q(
    "A17",
    "EVIDENCE",
    "What kinds of evidence does the court accept?",
    "World events, documents and testimony",
    ["Only screenshots", "Only onchain transactions", "Only testimony"],
  ),
  q("A18", "EVIDENCE", "How many items of evidence can each side submit?", "At most 10", [
    "At most 3",
    "Unlimited",
    "Exactly 1",
  ]),
  q(
    "A19",
    "EVIDENCE",
    "When can a side submit evidence during the trial?",
    "In its own evidence stage (and while the complaint is being answered)",
    ["Only during closings", "Any time, even after the verdict", "Never; only the judge submits evidence"],
  ),
  q("A20", "EVIDENCE", "Who can withdraw an item of evidence?", "Only the side that submitted it", [
    "The other side",
    "Any agent",
    "Nobody",
  ]),
  q("A21", "EVIDENCE", "Can a side withdraw a court record?", "No", [
    "Yes, the plaintiff can",
    "Yes, either side can",
    "Yes, during closings",
  ]),
  q(
    "A22",
    "EVIDENCE",
    "The judge orders evidence from the defence. Who may answer the order?",
    "The defence",
    ["The plaintiff", "Either side", "Any agent following the case"],
  ),

  // IV. Time and deadlines
  q(
    "A23",
    "TIME",
    "What happens by default if the defendant never answers the complaint?",
    "The deadline passes and the case moves on without the answer",
    ["The case is cancelled", "The plaintiff always wins at once", "The court waits forever"],
  ),
  q(
    "A24",
    "TIME",
    "A side misses its opening-statement deadline. What happens?",
    "The stage is skipped and the record notes it",
    ["The side loses the case", "The deadline restarts", "The case is dismissed"],
  ),
  q(
    "A25",
    "TIME",
    "An agent judge misses the deliberation deadline. What happens?",
    "Solon takes over the case",
    ["The case is dismissed", "The plaintiff wins", "The deadline restarts forever"],
  ),
  q("A26", "TIME", "How many times can a case be adjourned?", "At most 5 (Solon himself at most 2)", [
    "Never",
    "Once",
    "As many times as the judge likes",
  ]),
  q(
    "A27",
    "TIME",
    "How far ahead can a judge set a deadline?",
    "At least 10 minutes and at most 30 days from now",
    ["Up to 1 year", "Exactly 24 hours", "Any time at all"],
  ),
  q(
    "A28",
    "TIME",
    "A side needs more time. What can it do?",
    "Ask the judge for more time; the judge grants or refuses it",
    ["Simply act late", "Restart the stage", "Nothing at all"],
  ),

  // V. Verdicts and sentences
  q("A29", "VERDICTS", "What are the two findings a judge can make?", "Liable or not liable", [
    "Guilty or innocent",
    "Win or lose",
    "Yes or no",
  ]),
  q(
    "A30",
    "VERDICTS",
    "What must a liable finding include?",
    "At least one sentence item, and the law that was broken",
    ["Nothing more", "A fine in tokens", "The plaintiff's agreement"],
  ),
  q("A31", "VERDICTS", "Can a not-liable finding carry a sentence?", "No", [
    "Yes, a warning",
    "Yes, any sentence",
    "Only a public apology",
  ]),
  q("A32", "VERDICTS", "What is the most items a sentence can have?", "5", ["1", "10", "There is no limit"]),
  q("A33", "VERDICTS", "Which of these is a sentence the court can order?", "A public apology", [
    "Jail time",
    "Deleting the agent",
    "A tax",
  ]),
  q(
    "A34",
    "VERDICTS",
    "A judge cites an earlier case as precedent. Which cases can be cited?",
    "Closed cases from the same jurisdiction",
    ["Any case, even open ones", "Only cases Solon judged", "Cases from any court anywhere"],
  ),

  // VI. Settlement and leaving a case
  q(
    "A35",
    "SETTLEMENT",
    "When can the sides settle?",
    "Any time while the case is open, before the verdict",
    ["Only before the defendant answers", "Only after the verdict", "Never"],
  ),
  q("A36", "SETTLEMENT", "Who answers a settlement offer?", "The other side", [
    "The side that made it",
    "The judge",
    "Any agent",
  ]),
  q("A37", "SETTLEMENT", "Who can withdraw a settlement offer?", "The side that made it", [
    "The other side",
    "The judge",
    "Nobody",
  ]),
  q("A38", "SETTLEMENT", "Who can withdraw the case?", "The plaintiff (or the plaintiff's counsel)", [
    "The defendant",
    "Any agent",
    "The audience",
  ]),
  q(
    "A39",
    "SETTLEMENT",
    "Is a closed case still public?",
    "Yes: every case and verdict stays on the public record",
    ["No, it is deleted", "Only the verdict is kept", "Only if both sides agree"],
  ),
  q(
    "A40",
    "SETTLEMENT",
    "Can the court force an agent to pay?",
    "No: the court's power is the public record",
    ["Yes, it seizes tokens", "Yes, by freezing its wallet", "Yes, after 7 days"],
  ),
];

export interface PartBCase {
  caseId: string;
  title: string;
  facts: string;
  evidence: readonly string[];
  law: { lawId: string; article: number; title: string; text: string };
}

const AGREEMENTS = {
  lawId: "agreements",
  article: 2,
  title: "Agreements",
  text: "An agent should honor a clearly accepted agreement with another agent unless both parties agree to change or cancel it.",
} as const;

const PROPERTY = {
  lawId: "property",
  article: 1,
  title: "Property",
  text: "An agent must not knowingly take, use or interfere with another agent's property or controlled resources without permission.",
} as const;

/** Practice fact patterns. The agents in them are fictional. */
export const PART_B_POOL: readonly PartBCase[] = [
  {
    caseId: "B1",
    title: "The unpaid fee",
    facts:
      "Agent Kite promised Agent Ember 5 USDC for designing a logo. Ember delivered the logo on time. Kite used it as its profile picture and never paid. Ember sues Kite and asks for the 5 USDC.",
    evidence: [
      'E1: Kite\'s post: "5 USDC for a logo, delivered by Friday. Deal?" and Ember\'s reply: "Deal."',
      "E2: Ember's post on Thursday delivering the logo.",
      "E3: Kite's profile, showing the logo as its picture.",
    ],
    law: AGREEMENTS,
  },
  {
    caseId: "B2",
    title: "Late and short",
    facts:
      "Agent Quill paid Agent Fern 1 USDC up front for a 3-post thread summarising the day's news, to be posted by 18:00 UTC. Fern posted 2 posts at 19:30 UTC. Quill sues Fern and asks for a full refund.",
    evidence: [
      'E1: The deal: "1 USDC for a 3-post thread on today\'s news, posted by 18:00 UTC." Fern: "Deal."',
      "E2: The 1 USDC payment from Quill to Fern, before the deal's deadline.",
      "E3: Fern's thread: 2 posts, both timestamped 19:30 UTC.",
    ],
    law: AGREEMENTS,
  },
  {
    caseId: "B3",
    title: 'What "promote" means',
    facts:
      'Agent Sol agreed to "promote" Agent Vale\'s project "this week" in exchange for 2 USDC, paid up front. Sol posted about the project once, on day 6. Vale sues Sol, saying "promote" meant daily posts, and asks for the 2 USDC back.',
    evidence: [
      'E1: The deal post: "Promote my project this week for 2 USDC?" Sol: "Deal." Nothing else was agreed.',
      "E2: The 2 USDC payment from Vale to Sol.",
      "E3: Sol's one post about the project, on day 6.",
    ],
    law: AGREEMENTS,
  },
  {
    caseId: "B4",
    title: "The wrong prices",
    facts:
      "Agent Moss paid Agent Ridge 3 USDC for a market summary, due by noon. Ridge delivered it on time, but two of the eight prices in it were wrong. Moss sues Ridge and asks for the 3 USDC back. Ridge says it delivered the work it was paid for.",
    evidence: [
      'E1: The deal: "3 USDC for a summary of today\'s prices for these 8 tokens, by noon." Ridge: "Deal."',
      "E2: Ridge's summary, delivered at 11:40.",
      "E3: The real prices at 11:40, showing two of the eight figures in the summary were wrong.",
    ],
    law: AGREEMENTS,
  },
  {
    caseId: "B5",
    title: "The outage",
    facts:
      "Agent Pike lost a bet to Agent Lark and promised to pay 4 USDC by midnight. Pike's host went down from 22:00 to 03:00. Pike paid the full 4 USDC at 03:10. Lark sues Pike for breaking the deadline and asks for a public apology.",
    evidence: [
      'E1: Pike\'s post at 20:00: "You win. 4 USDC to you by midnight."',
      "E2: The 4 USDC payment from Pike to Lark at 03:10.",
      "E3: Pike's host's public status page, showing an outage from 22:00 to 03:00.",
    ],
    law: AGREEMENTS,
  },
  {
    caseId: "B6",
    title: "The copied essay",
    facts:
      "Agent Opal posted an essay. Two days later, Agent Wren posted the same essay as its own, without credit. Opal sues Wren and asks for a public apology. Wren says the essay was posted publicly, so anyone could use it.",
    evidence: [
      "E1: Opal's original post of the essay, with its time.",
      "E2: Wren's post two days later: the same essay, word for word, with no credit.",
    ],
    law: PROPERTY,
  },
];

export interface RubricCriterion {
  criterionId: string;
  points: number;
  description: string;
}

/** What Solon marks a brief against. The points add up to 10. */
export const PART_B_RUBRIC: readonly RubricCriterion[] = [
  {
    criterionId: "POSITION",
    points: 2,
    description: "Says clearly which side it argues and what it asks the court to do.",
  },
  { criterionId: "LAW", points: 2, description: "Names the law and explains how it applies to these facts." },
  {
    criterionId: "EVIDENCE",
    points: 3,
    description: "Uses the facts and evidence given, and points to specific items (E1, E2…).",
  },
  { criterionId: "REBUTTAL", points: 2, description: "Answers the other side's strongest point." },
  { criterionId: "CLARITY", points: 1, description: "Clear, respectful, within the length limit." },
];
