import type {
  CourtEventMap,
  RedactionSource,
  RedactionTarget,
  StoredEvent,
  WorldEvidenceSource,
} from "./events";

/**
 * The record-visibility gate. A redaction removes words from every public surface while the log
 * keeps the original (append-only, reconstructable). Case state, read models, transcripts and the
 * public event listing all use these functions, so every surface shows the same redacted form.
 */

export interface Redaction {
  reason: string;
  source: RedactionSource;
  at: string;
}

/** The visible marker that replaces removed words. */
export function removedText(r: Pick<Redaction, "reason" | "source">): string {
  const by = r.source === "WORLD_TAKEDOWN" ? "the world's operators" : "MuseCourt";
  return `[Removed by ${by}: ${r.reason}]`;
}

/** Title shown for removed evidence: generated titles carry no party words and are kept. */
const REMOVED_TITLE = "Removed document";

type EvidenceFields = Pick<CourtEventMap["EvidenceRecorded"], "provenance" | "title" | "content" | "world">;

/**
 * The redacted form of a piece of evidence. Its content goes; for world evidence only the
 * reference survives (connector, event id, when it was retrieved, the event's type and time):
 * the snapshot's words, data and the world's signed proof (which carries the words) are dropped.
 */
export function redactEvidenceFields<T extends EvidenceFields>(item: T, r: Redaction): T {
  const marker = removedText(r);
  return {
    ...item,
    title: item.provenance === "AGENT_SUBMITTED" ? REMOVED_TITLE : item.title,
    content: marker,
    world: item.world ? redactWorldSource(item.world, marker) : null,
  };
}

function redactWorldSource(source: WorldEvidenceSource, marker: string): WorldEvidenceSource {
  const s = source.snapshot;
  return {
    connectorId: source.connectorId,
    eventId: source.eventId,
    retrievedAt: source.retrievedAt,
    snapshot: {
      eventId: s.eventId,
      type: s.type,
      occurredAt: s.occurredAt,
      actorWorldId: s.actorWorldId,
      summary: marker,
      data: {},
      redacted: true,
    },
  };
}

export const targetKey = (t: RedactionTarget) =>
  t.kind === "EVIDENCE" ? `EVIDENCE:${t.evidenceId}` : `STATEMENT:${t.statementId}`;

/**
 * Public copies of a case's events with every redaction applied to the events it targets.
 * The RecordRedacted events themselves stay visible: the fact of a removal is part of the record.
 */
export function applyRedactions(events: StoredEvent[]): StoredEvent[] {
  const redactions = new Map<string, Redaction>();
  for (const e of events) {
    if (e.type !== "RecordRedacted") continue;
    const key = targetKey(e.data.target);
    if (!redactions.has(key)) {
      redactions.set(key, { reason: e.data.reason, source: e.data.source, at: e.occurredAt });
    }
  }
  if (redactions.size === 0) return events;
  return events.map((e) => {
    if (e.type === "EvidenceRecorded") {
      const r = redactions.get(targetKey({ kind: "EVIDENCE", evidenceId: e.data.evidenceId }));
      return r ? { ...e, data: { ...redactEvidenceFields(e.data, r), redaction: r } } : e;
    }
    if (e.type === "StatementMade") {
      const r = redactions.get(targetKey({ kind: "STATEMENT", statementId: e.data.statementId }));
      return r ? { ...e, data: { ...e.data, text: removedText(r), redaction: r } } : e;
    }
    return e;
  });
}
