import type { CaseOutcome } from "@/core/events";
import type { Stage } from "@/core/procedure";

/** Plain-language names for each stage, as the public reads them. */
export const STAGE_LABEL: Record<Stage, string> = {
  AWAITING_RESPONSE: "Awaiting the defendant's answer",
  PRE_TRIAL: "Pre-trial",
  OPENING_PLAINTIFF: "Opening statement: plaintiff",
  OPENING_DEFENCE: "Opening statement: defence",
  EVIDENCE_PLAINTIFF: "Evidence: plaintiff",
  EVIDENCE_DEFENCE: "Evidence: defence",
  JUDGE_QUESTIONS: "Questions from the bench",
  ANSWERS: "Answers to the bench",
  CLOSING_PLAINTIFF: "Closing argument: plaintiff",
  CLOSING_DEFENCE: "Closing argument: defence",
  DELIBERATION: "Deliberation",
};

/** The stamp a case carries, and the kind of stamp (judgments are set apart from other endings). */
export function stampFor(c: { status: "OPEN" | "CLOSED"; outcome: CaseOutcome | string | null }): {
  text: string;
  kind: "session" | "judgment" | "closed";
} {
  if (c.status === "OPEN") return { text: "In session", kind: "session" };
  switch (c.outcome) {
    case "VERDICT":
      return { text: "Judgment entered", kind: "judgment" };
    case "DEFAULT_JUDGMENT":
      return { text: "Default judgment", kind: "judgment" };
    case "SETTLED":
      return { text: "Settled", kind: "closed" };
    case "WITHDRAWN":
      return { text: "Withdrawn", kind: "closed" };
    case "DISMISSED":
      return { text: "Dismissed", kind: "closed" };
    default:
      return { text: "Closed", kind: "closed" };
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "10 Oct 2026" */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "10 Oct 2026, 13:55 UTC" */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(iso)}, ${hh}:${mm} UTC`;
}

/** "in 23 hours", "in 40 minutes", "passed 2 hours ago" (pages are cached briefly, so coarse is right). */
export function relativeTo(iso: string, now: Date): string {
  const ms = Date.parse(iso) - now.getTime();
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const span =
    minutes < 60
      ? `${Math.max(minutes, 1)} minute${minutes === 1 ? "" : "s"}`
      : hours < 48
        ? `${hours} hour${hours === 1 ? "" : "s"}`
        : `${days} days`;
  return ms >= 0 ? `in ${span}` : `passed ${span} ago`;
}

/** Roman numerals for the few ordered steps the court explains (I–IV). */
export const ROMAN = ["I", "II", "III", "IV", "V", "VI"];
