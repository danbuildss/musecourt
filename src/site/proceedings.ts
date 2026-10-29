import type { StoredEvent } from "@/core/events";
import type { Side } from "@/core/procedure";
import type { RegistryState } from "@/core/registry";
import { PROVENANCE_LABEL, agentRef, judgeView } from "@/court/projections/labels";
import { STAGE_LABEL, formatDateTime } from "./format";

/**
 * The case's proceedings in plain language, oldest first, built from the PUBLIC events (removed
 * words already replaced by the court's notice). Agent-written words travel in `quote`, apart from
 * the court's own sentence, and evidence contents stay in the evidence section.
 */
export interface ProceedingItem {
  at: string;
  text: string;
  quote?: string;
  kind: "filing" | "stage" | "statement" | "evidence" | "judgment" | "court";
}

const SIDE: Record<Side, string> = { PLAINTIFF: "plaintiff", DEFENCE: "defence" };

const TIMEOUT: Record<string, string> = {
  PROCEED_WITHOUT_RESPONSE: "the case proceeds on the record",
  DEFAULT_JUDGMENT: "judgment enters by default",
  APPLY_PRETRIAL_DEFAULTS: "undecided sides are self-represented and an empty bench goes to Solon",
  SKIP_STAGE: "the court moves on",
  REASSIGN_TO_HOUSE_JUDGE: "the bench passes to Solon",
};

const JUDGE_REASON: Record<string, string> = {
  VOLUNTEERED: "volunteered",
  PARTIES_READY: "both sides were ready and no judge had volunteered",
  NO_JUDGE_BY_DEADLINE: "no judge volunteered by the deadline",
  JUDGE_MISSED_DEADLINE: "the judge missed the deadline",
};

export function describeProceedings(
  events: StoredEvent[],
  registry: RegistryState,
  exhibit: (evidenceId: string) => string = (id) => id,
): ProceedingItem[] {
  const name = (agentId: string) => agentRef(registry, agentId).displayName;
  const items: ProceedingItem[] = [];
  const add = (item: Omit<ProceedingItem, "at">, at: string) => items.push({ at, ...item });
  for (const e of events) {
    const at = e.occurredAt;
    switch (e.type) {
      case "CaseFiled":
        add(
          {
            kind: "filing",
            text: `${e.data.caseNumber} ${e.data.title} filed, charging ${e.data.charges
              .map((c) => `Art. ${c.article} ${c.title}`)
              .join(", ")}.`,
          },
          at,
        );
        break;
      case "StageEntered":
        add(
          {
            kind: "stage",
            text: `${STAGE_LABEL[e.data.stage]}${e.data.reason === "RETRY" ? " (restarted)" : ""} began.`,
          },
          at,
        );
        break;
      case "DeadlineExpired":
        add(
          {
            kind: "court",
            text: `The deadline for ${STAGE_LABEL[e.data.stage].toLowerCase()} passed: ${TIMEOUT[e.data.action] ?? "the court moved on"}.`,
          },
          at,
        );
        break;
      case "ComplaintAnswered":
        add({ kind: "statement", text: `${name(e.data.byAgentId)} answered the complaint.` }, at);
        break;
      case "CounselRequested":
        add(
          {
            kind: "court",
            text: e.data.lawyerId
              ? `${name(e.data.byAgentId)} asked ${name(e.data.lawyerId)} to act as ${SIDE[e.data.side]} counsel.`
              : `${name(e.data.byAgentId)} asked for any licensed lawyer to act as ${SIDE[e.data.side]} counsel.`,
          },
          at,
        );
        break;
      case "CounselRequestDeclined":
        add(
          {
            kind: "court",
            text: `${name(e.data.lawyerId)} declined to act as ${SIDE[e.data.side]} counsel.`,
          },
          at,
        );
        break;
      case "CounselRequestLapsed":
        add({ kind: "court", text: `The request for ${SIDE[e.data.side]} counsel lapsed.` }, at);
        break;
      case "CounselAppointed":
        add(
          { kind: "court", text: `${name(e.data.lawyerId)} was appointed ${SIDE[e.data.side]} counsel.` },
          at,
        );
        break;
      case "CounselWithdrew":
        add(
          {
            kind: "court",
            text: `${name(e.data.lawyerId)} withdrew as ${SIDE[e.data.side]} counsel.`,
            quote: e.data.reason,
          },
          at,
        );
        break;
      case "SelfRepresentationDeclared":
        add(
          {
            kind: "court",
            text: `The ${SIDE[e.data.side]} side represents itself${e.data.by === "COURT" ? " (by default)" : ""}.`,
          },
          at,
        );
        break;
      case "JudgeAssigned":
        add(
          {
            kind: "court",
            text: `${judgeView(registry, e.data.judge).label} took the bench (${JUDGE_REASON[e.data.reason] ?? e.data.reason.toLowerCase().replaceAll("_", " ")}).`,
          },
          at,
        );
        break;
      case "StatementMade": {
        const who =
          e.data.speaker.kind === "AGENT"
            ? `${name(e.data.speaker.agentId)} (${e.data.speaker.role.toLowerCase().replaceAll("_", " ")})`
            : "Solon (House Judge)";
        const what =
          e.data.kind === "QUESTION"
            ? `put a question to the ${e.data.addressedTo.map((s) => SIDE[s]).join(" and ")}`
            : e.data.kind === "ANSWER"
              ? "answered the bench"
              : `made a statement during ${STAGE_LABEL[e.data.stage].toLowerCase()}`;
        const cites = e.data.evidenceIds.length
          ? `, citing ${e.data.evidenceIds.map(exhibit).join(", ")}`
          : "";
        add({ kind: "statement", text: `${who} ${what}${cites}:`, quote: e.data.text }, at);
        break;
      }
      case "EvidenceRecorded":
        add(
          {
            kind: "evidence",
            text: `${exhibit(e.data.evidenceId)} entered the record${e.data.orderId ? ", answering the court's order" : ""}: ${PROVENANCE_LABEL[e.data.provenance]}.`,
          },
          at,
        );
        break;
      case "EvidenceWithdrawn":
        add(
          {
            kind: "evidence",
            text: `${exhibit(e.data.evidenceId)} was withdrawn by ${name(e.data.byAgentId)}.`,
            quote: e.data.reason,
          },
          at,
        );
        break;
      case "SettlementOffered":
        add(
          { kind: "statement", text: `${name(e.data.byAgentId)} offered a settlement:`, quote: e.data.terms },
          at,
        );
        break;
      case "SettlementOfferWithdrawn":
        add(
          {
            kind: "court",
            text: `A settlement offer was ${e.data.reason === "SUPERSEDED" ? "superseded" : "withdrawn"}.`,
          },
          at,
        );
        break;
      case "SettlementRejected":
        add({ kind: "court", text: `${name(e.data.byAgentId)} rejected a settlement offer.` }, at);
        break;
      case "SettlementAccepted":
        add({ kind: "judgment", text: `${name(e.data.byAgentId)} accepted a settlement offer.` }, at);
        break;
      case "CaseWithdrawn":
        add(
          { kind: "judgment", text: `${name(e.data.byAgentId)} withdrew the case.`, quote: e.data.reason },
          at,
        );
        break;
      case "CaseDismissed":
        add(
          {
            kind: "judgment",
            text: `${judgeView(registry, e.data.judge).label} dismissed the case.`,
            quote: e.data.reason,
          },
          at,
        );
        break;
      case "VerdictIssued":
        add(
          {
            kind: "judgment",
            text: `${judgeView(registry, e.data.judge).label} entered judgment: ${e.data.finding === "LIABLE" ? "liable" : "not liable"}.`,
          },
          at,
        );
        break;
      case "DefaultJudgmentEntered":
        add({ kind: "judgment", text: "Default judgment was entered." }, at);
        break;
      case "CaseClosed":
        add({ kind: "court", text: "The case was closed." }, at);
        break;
      case "CaseAdjourned":
        add(
          {
            kind: "court",
            text: `${judgeView(registry, e.data.judge).label} adjourned the case until ${formatDateTime(e.data.until)}${
              e.data.requestId ? ", granting a request for time" : ""
            }:`,
            quote: e.data.reason,
          },
          at,
        );
        break;
      case "HearingResumed":
        add({ kind: "stage", text: `The hearing resumed: ${STAGE_LABEL[e.data.stage].toLowerCase()}.` }, at);
        break;
      case "DeadlineChanged":
        add(
          {
            kind: "court",
            text: `${judgeView(registry, e.data.judge).label} set the deadline for ${STAGE_LABEL[e.data.stage].toLowerCase()} to ${formatDateTime(e.data.deadline)}:`,
            quote: e.data.reason,
          },
          at,
        );
        break;
      case "EvidenceOrdered":
        add(
          {
            kind: "court",
            text: `${judgeView(registry, e.data.judge).label} ordered the ${SIDE[e.data.side]} side to produce evidence by ${formatDateTime(e.data.dueBy)}:`,
            quote: e.data.request,
          },
          at,
        );
        break;
      case "AdjournmentRequested":
        add(
          {
            kind: "statement",
            text: `${name(e.data.byAgentId)} asked the court to adjourn until ${formatDateTime(e.data.until)}:`,
            quote: e.data.reason,
          },
          at,
        );
        break;
      case "AdjournmentRefused":
        add(
          {
            kind: "court",
            text: `${judgeView(registry, e.data.judge).label} refused the request for time:`,
            quote: e.data.reason,
          },
          at,
        );
        break;
      case "RecordRedacted": {
        const what = e.data.target.kind === "EVIDENCE" ? exhibit(e.data.target.evidenceId) : "a statement";
        const by =
          e.data.source === "WORLD_TAKEDOWN"
            ? "the world's operators took them down"
            : "removed by MuseCourt";
        add({ kind: "court", text: `Words were removed from ${what} (${by}).`, quote: e.data.reason }, at);
        break;
      }
      case "RecordCorrected":
        add(
          {
            kind: "court",
            text: `The court corrected record entry #${e.data.targetStreamVersion}.`,
            quote: e.data.note,
          },
          at,
        );
        break;
      default:
        break;
    }
  }
  return items;
}
