import type { StoredEvent } from "@/core/events";
import type { RegistryState } from "@/core/registry";
import { PROVENANCE_LABEL, agentRef, judgeView } from "./labels";

export interface TranscriptLine {
  streamVersion: number;
  at: string;
  text: string;
}

/** Human-readable court transcript, rebuilt from a case's events. */
export function buildTranscript(events: StoredEvent[], registry: RegistryState): TranscriptLine[] {
  const name = (agentId: string) => agentRef(registry, agentId).displayName;
  const lines: TranscriptLine[] = [];
  for (const e of events) {
    const text = describe(e, name, registry);
    if (text) lines.push({ streamVersion: e.streamVersion, at: e.occurredAt, text });
  }
  return lines;
}

function describe(e: StoredEvent, name: (id: string) => string, registry: RegistryState): string | null {
  switch (e.type) {
    case "CaseFiled":
      return `${e.data.caseNumber} ${e.data.title} filed. Charges: ${e.data.charges
        .map((c) => `Art. ${c.article} ${c.title} (v${c.version})`)
        .join(", ")}. Complaint: ${e.data.complaint}`;
    case "StageEntered":
      return `— ${e.data.stage}${e.data.reason === "RETRY" ? " (restarted)" : ""} · deadline ${e.data.deadline}`;
    case "DeadlineExpired":
      return `Deadline for ${e.data.stage} expired → ${e.data.action}.`;
    case "ComplaintAnswered":
      return `${name(e.data.byAgentId)} answered the complaint: ${e.data.response}`;
    case "CounselRequested":
      return e.data.lawyerId
        ? `${name(e.data.byAgentId)} asked ${name(e.data.lawyerId)} to act as ${e.data.side} counsel.`
        : `${name(e.data.byAgentId)} asked for any licensed lawyer to act as ${e.data.side} counsel.`;
    case "CounselRequestDeclined":
      return `${name(e.data.lawyerId)} declined to act as ${e.data.side} counsel.`;
    case "CounselRequestLapsed":
      return `The request for ${e.data.side} counsel lapsed.`;
    case "CounselAppointed":
      return `${name(e.data.lawyerId)} appointed ${e.data.side} counsel.`;
    case "CounselWithdrew":
      return `${name(e.data.lawyerId)} withdrew as ${e.data.side} counsel: ${e.data.reason}`;
    case "SelfRepresentationDeclared":
      return `The ${e.data.side} side is self-represented${e.data.by === "COURT" ? " (by default)" : ""}.`;
    case "JudgeAssigned":
      return `${judgeView(registry, e.data.judge).label} takes the bench (${e.data.reason}).`;
    case "StatementMade": {
      const who = e.data.speaker.kind === "AGENT" ? name(e.data.speaker.agentId) : "Solon";
      const to = e.data.addressedTo.length ? ` to ${e.data.addressedTo.join(" & ")}` : "";
      const cites = e.data.evidenceIds.length ? ` [cites ${e.data.evidenceIds.join(", ")}]` : "";
      return `${who} (${e.data.kind.toLowerCase()}${to}): ${e.data.text}${cites}`;
    }
    case "EvidenceRecorded":
      return `Evidence ${e.data.evidenceId} — ${e.data.title} [${PROVENANCE_LABEL[e.data.provenance]}]: ${e.data.content}`;
    case "EvidenceWithdrawn":
      return `Evidence ${e.data.evidenceId} withdrawn by ${name(e.data.byAgentId)}: ${e.data.reason}`;
    case "SettlementOffered":
      return `${name(e.data.byAgentId)} offered settlement (${e.data.offerId}): ${e.data.terms}`;
    case "SettlementOfferWithdrawn":
      return `Settlement offer ${e.data.offerId} ${e.data.reason === "SUPERSEDED" ? "superseded" : "withdrawn"}.`;
    case "SettlementRejected":
      return `${name(e.data.byAgentId)} rejected settlement offer ${e.data.offerId}.`;
    case "SettlementAccepted":
      return `${name(e.data.byAgentId)} accepted settlement offer ${e.data.offerId}.`;
    case "CaseWithdrawn":
      return `${name(e.data.byAgentId)} withdrew the case: ${e.data.reason}`;
    case "CaseDismissed":
      return `${judgeView(registry, e.data.judge).label} dismissed the case: ${e.data.reason}`;
    case "VerdictIssued":
      return `VERDICT by ${judgeView(registry, e.data.judge).label}: ${e.data.finding}. ${e.data.reasoning}${
        e.data.sentence.length ? ` Sentence: ${e.data.sentence.map((s) => s.description).join("; ")}.` : ""
      }`;
    case "DefaultJudgmentEntered":
      return `DEFAULT JUDGMENT: ${e.data.reasoning}`;
    case "CaseClosed":
      return `Case closed (${e.data.outcome}).`;
    case "RecordCorrected":
      return `Correction to record entry #${e.data.targetStreamVersion}: ${e.data.note}`;
    default:
      return null;
  }
}
