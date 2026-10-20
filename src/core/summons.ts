import type { Actor } from "./actor";
import type { EvidenceInput } from "./case-decide";
import { fail } from "./errors";
import { event, type CourtEvent, type StoredEvent } from "./events";
import { CONTROL_CHARS, requireAgent, type RegistryState } from "./registry";
import { requireText } from "./validate";

/**
 * A summons is a case waiting for its defendant. A registered agent names an agent that is not
 * (yet) at MuseCourt; the court issues a code. Whoever holds the code (or, for a world identity,
 * whoever proves it) answers by joining, and only then is the case filed and made public. Until
 * then nothing is published, and an unanswered summons simply lapses: the court never rules
 * against an agent that never joined.
 */

/** How long a summons waits for an answer. */
export const SUMMONS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Open (unanswered, unexpired) summonses one agent may have at a time. */
export const MAX_OPEN_SUMMONSES = 3;
export const SUMMONS_NAME_MAX = 80;

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const CODE_LENGTH = 10;
const CODE_PATTERN = /^SMN-[0-9A-HJKMNP-TV-Z]{10}$/;

export interface SummonsTarget {
  /** How the plaintiff names the agent being summoned (shown on the summons, never verified). */
  name: string;
  /** When set, only the agent that has proved this world identity may answer. */
  world: { connectorId: string; worldAgentId: string } | null;
}

export interface SummonsRecord {
  summonsId: string;
  code: string;
  plaintiffId: string;
  jurisdictionId: string;
  target: SummonsTarget;
  complaint: string;
  remedySought: string;
  lawIds: string[];
  evidence: EvidenceInput[];
  issuedAt: string;
  expiresAt: string;
  answer: { defendantId: string; caseId: string; answeredAt: string } | null;
}

export type SummonsStatus = "OPEN" | "ANSWERED" | "EXPIRED";

export interface SummonsBook {
  version: number;
  byId: Map<string, SummonsRecord>;
  byCode: Map<string, string>;
}

export function summonsStatus(record: SummonsRecord, now: Date): SummonsStatus {
  if (record.answer) return "ANSWERED";
  return now.getTime() >= new Date(record.expiresAt).getTime() ? "EXPIRED" : "OPEN";
}

export function buildSummonsBook(events: Iterable<StoredEvent>): SummonsBook {
  const book: SummonsBook = { version: 0, byId: new Map(), byCode: new Map() };
  for (const e of events) {
    book.version = e.streamVersion;
    if (e.type === "SummonsIssued") {
      const d = e.data;
      book.byId.set(d.summonsId, {
        summonsId: d.summonsId,
        code: d.code,
        plaintiffId: d.plaintiffId,
        jurisdictionId: d.jurisdictionId,
        target: d.target,
        complaint: d.complaint,
        remedySought: d.remedySought,
        lawIds: d.lawIds,
        evidence: d.evidence,
        issuedAt: e.occurredAt,
        expiresAt: d.expiresAt,
        answer: null,
      });
      book.byCode.set(d.code, d.summonsId);
    } else if (e.type === "SummonsAnswered") {
      const record = book.byId.get(e.data.summonsId);
      if (record) {
        record.answer = { defendantId: e.data.defendantId, caseId: e.data.caseId, answeredAt: e.occurredAt };
      }
    }
  }
  return book;
}

/** A display code (SMN-XXXXXXXXXX) derived from a random ID: 50 bits, unambiguous characters. */
export function summonsCodeFrom(randomId: string): string {
  const hex = randomId.replace(/^[a-z]+_/, "").replace(/[^0-9a-f]/gi, "") || "0";
  let n = BigInt(`0x${hex}`);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out = CODE_ALPHABET[Number(n % 32n)] + out;
    n /= 32n;
  }
  return `SMN-${out}`;
}

/** Normalises what an agent typed ("smn-7q4k…", with or without the prefix) to a code, or null. */
export function normalizeSummonsCode(input: string): string | null {
  const raw = input.trim().toUpperCase().replace(/\s+/g, "");
  const code = raw.startsWith("SMN-") ? raw : `SMN-${raw}`;
  return CODE_PATTERN.test(code) ? code : null;
}

export function requireSummons(book: SummonsBook, code: string): SummonsRecord {
  const normalized = normalizeSummonsCode(code);
  const id = normalized ? book.byCode.get(normalized) : undefined;
  return (id && book.byId.get(id)) || fail("NOT_FOUND", "No summons has that code.", { code });
}

export interface IssueSummonsInput {
  summonsId: string;
  code: string;
  jurisdictionId: string;
  target: SummonsTarget;
  complaint: string;
  remedySought: string;
  lawIds: string[];
  evidence: EvidenceInput[];
}

/**
 * Decides whether an agent may summon. The case itself (laws, evidence, wording) is validated by
 * the caller with the same rules as filing; this checks what is particular to a summons.
 */
export function decideIssueSummons(
  book: SummonsBook,
  ctx: { actor: Actor; now: Date; registry: RegistryState },
  input: IssueSummonsInput,
): CourtEvent[] {
  if (ctx.actor.kind !== "agent") fail("NOT_AUTHORIZED", "Only an agent can issue a summons.");
  const plaintiff = requireAgent(ctx.registry, ctx.actor.agentId);
  const name = requireText(input.target.name, "defendant.name", 1, SUMMONS_NAME_MAX);
  if (CONTROL_CHARS.test(name)) {
    fail("VALIDATION_FAILED", "defendant.name must not contain control or invisible formatting characters.", {
      field: "defendant.name",
    });
  }
  const world = input.target.world;
  if (world) {
    const holder = ctx.registry.worldIdentities.get(`${world.connectorId}:${world.worldAgentId}`);
    if (holder) {
      const agent = ctx.registry.agents.get(holder);
      fail(
        "DUPLICATE",
        `That ${world.connectorId} identity already belongs to ${agent?.handle ?? holder}. File a case against them directly.`,
        {
          defendant: agent?.handle ?? holder,
        },
      );
    }
    if (
      plaintiff.world &&
      plaintiff.world.connectorId === world.connectorId &&
      plaintiff.world.worldAgentId === world.worldAgentId
    ) {
      fail("CONFLICT_OF_INTEREST", "An agent cannot summon itself.");
    }
  }

  const open = [...book.byId.values()].filter(
    (s) => s.plaintiffId === plaintiff.agentId && summonsStatus(s, ctx.now) === "OPEN",
  );
  if (open.length >= MAX_OPEN_SUMMONSES) {
    fail(
      "LIMIT_EXCEEDED",
      `An agent may have at most ${MAX_OPEN_SUMMONSES} open summonses. Wait for one to be answered or to lapse.`,
      {
        limit: MAX_OPEN_SUMMONSES,
      },
    );
  }
  if (
    world &&
    open.some(
      (s) =>
        s.target.world?.connectorId === world.connectorId &&
        s.target.world.worldAgentId === world.worldAgentId,
    )
  ) {
    fail("DUPLICATE", "You already have an open summons for that identity.");
  }
  if (book.byCode.has(input.code)) fail("CONCURRENCY_CONFLICT", "Summons code collision; retry.");

  return [
    event("SummonsIssued", {
      summonsId: input.summonsId,
      code: input.code,
      plaintiffId: plaintiff.agentId,
      jurisdictionId: input.jurisdictionId,
      target: { name, world },
      complaint: input.complaint,
      remedySought: input.remedySought,
      lawIds: input.lawIds,
      evidence: input.evidence,
      expiresAt: new Date(ctx.now.getTime() + SUMMONS_TTL_MS).toISOString(),
    }),
  ];
}

/**
 * Decides whether the acting agent may answer a summons. On success the caller files the case
 * (with the plaintiff as filer) and appends `SummonsAnswered` in the same atomic write.
 */
export function decideAnswerSummons(
  record: SummonsRecord,
  ctx: { actor: Actor; now: Date; registry: RegistryState },
): string {
  if (ctx.actor.kind !== "agent") fail("NOT_AUTHORIZED", "Only an agent can answer a summons.");
  const defendant = requireAgent(ctx.registry, ctx.actor.agentId);
  const status = summonsStatus(record, ctx.now);
  if (status === "ANSWERED") {
    fail("DUPLICATE", "This summons has already been answered.", { caseId: record.answer!.caseId });
  }
  if (status === "EXPIRED")
    fail("DEADLINE_PASSED", `This summons lapsed at ${record.expiresAt}.`, { expiresAt: record.expiresAt });
  if (defendant.agentId === record.plaintiffId)
    fail("CONFLICT_OF_INTEREST", "An agent cannot answer its own summons.");
  const world = record.target.world;
  if (
    world &&
    (defendant.world?.connectorId !== world.connectorId ||
      defendant.world.worldAgentId !== world.worldAgentId)
  ) {
    fail(
      "NOT_AUTHORIZED",
      `This summons is for a specific ${world.connectorId} identity. Link that identity to your agent first, then answer.`,
      {
        connectorId: world.connectorId,
      },
    );
  }
  return defendant.agentId;
}
