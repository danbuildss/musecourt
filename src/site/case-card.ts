import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import satori from "satori";
import type { Stage } from "@/core/procedure";
import { STAGE_LABEL, formatDate } from "./format";
import type { PublicCaseRecord } from "./public-data";

/**
 * A case's share card: a 1200×630 PNG drawn from the live case, for X, Discord and Telegram.
 * It names the finding only, never the sentence: a verdict is a public ruling and the card must
 * not suggest anything was carried out.
 */

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export interface CaseCardData {
  caseNumber: string;
  title: string;
  jurisdiction: string;
  charges: Array<{ article: number; title: string }>;
  status: "OPEN" | "CLOSED";
  stage: Stage | null;
  /** When an adjourned hearing resumes. */
  adjournedUntil: string | null;
  outcome: string | null;
  finding: "LIABLE" | "NOT_LIABLE" | null;
  filedAt: string;
  closedAt: string | null;
  /** Who presides, e.g. "Solon presiding"; null while no judge sits. */
  presiding: string | null;
  /** The short link printed on the card, without the scheme, e.g. "musecourt.xyz/c/MW-0002". */
  shortLink: string;
}

/** "https://www.musecourt.xyz" + "MW-0002" → "musecourt.xyz/c/MW-0002" (printed on the card and the page). */
export function shortLinkLabel(origin: string, caseNumber: string): string {
  return `${new URL(origin).host.replace(/^www\./, "")}/c/${caseNumber}`;
}

/** The card for a case's public record. */
export function caseCardData(c: PublicCaseRecord, origin: string): CaseCardData {
  const judge = c.verdict?.judge ?? c.judge;
  return {
    caseNumber: c.caseNumber,
    title: c.title,
    jurisdiction: c.jurisdiction,
    charges: c.charges.map(({ article, title }) => ({ article, title })),
    status: c.status,
    stage: c.stage?.name ?? null,
    adjournedUntil: c.stage?.adjournedUntil ?? null,
    outcome: c.outcome,
    finding: c.verdict?.finding ?? null,
    filedAt: c.filedAt,
    closedAt: c.closedAt,
    presiding: judge ? `${judge.replace(/\s*\(.*\)$/, "")} presiding` : null,
    shortLink: shortLinkLabel(origin, c.caseNumber),
  };
}

/** The stamp on the card: what state the case is in, in two lines. */
export function cardStamp(c: CaseCardData): { main: string; sub: string } {
  if (c.status === "OPEN") {
    if (c.adjournedUntil) return { main: "ADJOURNED", sub: `UNTIL ${cardDate(c.adjournedUntil)}` };
    if (c.stage === "AWAITING_RESPONSE" || !c.stage) return { main: "FILED", sub: "AWAITING ANSWER" };
    return { main: "IN SESSION", sub: STAGE_LABEL[c.stage].toUpperCase() };
  }
  switch (c.outcome) {
    case "VERDICT":
      return {
        main: `JUDGMENT: ${c.finding === "NOT_LIABLE" ? "NOT LIABLE" : "LIABLE"}`,
        sub: "THE RECORD IS PUBLIC",
      };
    case "DEFAULT_JUDGMENT":
      return { main: "DEFAULT JUDGMENT", sub: "THE DEFENDANT DID NOT ANSWER" };
    case "SETTLED":
      return { main: "SETTLED", sub: "THE PARTIES AGREED" };
    case "WITHDRAWN":
      return { main: "WITHDRAWN", sub: "BY THE PLAINTIFF" };
    case "DISMISSED":
      return { main: "DISMISSED", sub: "THE RECORD IS PUBLIC" };
    default:
      return { main: "CLOSED", sub: "THE RECORD IS PUBLIC" };
  }
}

/** "2026-11-02T15:00:00Z" → "2 NOV, 15:00 UTC" */
function cardDate(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" }).toUpperCase();
  const time = d.toISOString().slice(11, 16);
  return `${d.getUTCDate()} ${month}, ${time} UTC`;
}

/** A changing part of a card URL, so link previews fetch a new card when the case moves on. */
export function cardVersion(
  c: Pick<CaseCardData, "status" | "stage" | "outcome"> & { adjournedUntil?: string | null },
): string {
  const open = c.adjournedUntil ? `adjourned-${Date.parse(c.adjournedUntil) / 1000}` : (c.stage ?? "FILED");
  return (c.status === "OPEN" ? open : (c.outcome ?? "CLOSED")).toLowerCase().replaceAll("_", "-");
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const C = {
  paper: "#121211",
  ink: "#eeeae1",
  char: "#c9c4b8",
  muted: "#9a958b",
  rule: "#34322e",
  seal: "#d0846f",
};

type Node = { type: string; props: { style?: Record<string, unknown>; children?: unknown } };
const el = (style: Record<string, unknown>, ...children: unknown[]): Node => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children: children.length === 1 ? children[0] : children },
});

function layout(c: CaseCardData): Node {
  const stamp = cardStamp(c);
  const charges = c.charges.length
    ? `Charged under ${c.charges.map((x) => `Art. ${x.article} · ${x.title}`).join(", ")}`
    : "";
  const ended = c.outcome === "VERDICT" || c.outcome === "DEFAULT_JUDGMENT" ? "Decided" : "Closed";
  const dates = c.closedAt
    ? `Filed ${formatDate(c.filedAt)} · ${ended} ${formatDate(c.closedAt)}`
    : `Filed ${formatDate(c.filedAt)}`;
  const titleSize = c.title.length > 34 ? 56 : c.title.length > 22 ? 72 : 88;
  return el(
    {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      backgroundColor: C.paper,
      color: C.ink,
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "52px 64px",
      boxSizing: "border-box",
      fontFamily: "Plex Sans",
    },
    el(
      {
        justifyContent: "space-between",
        borderBottom: `1px solid ${C.ink}`,
        paddingBottom: 14,
        fontFamily: "Plex Mono",
        fontSize: 15,
        letterSpacing: 2,
      },
      el({}, "MUSECOURT"),
      el({ color: C.muted }, c.jurisdiction.toUpperCase()),
    ),
    el(
      { flexDirection: "column" },
      el({ fontFamily: "Plex Mono", fontSize: 26, color: C.seal, letterSpacing: 1.5 }, c.caseNumber),
      el(
        { fontFamily: "Newsreader", fontWeight: 500, fontSize: titleSize, lineHeight: 1.05, marginTop: 8 },
        c.title,
      ),
      charges ? el({ fontSize: 24, color: C.char, marginTop: 16 }, charges) : null,
    ),
    el(
      { justifyContent: "space-between", alignItems: "flex-end" },
      el(
        { flexDirection: "column", fontSize: 20, color: C.char, lineHeight: 1.5 },
        el({}, dates),
        c.presiding ? el({}, c.presiding) : null,
      ),
      el(
        {
          flexDirection: "column",
          border: `3px solid ${C.seal}`,
          padding: "12px 20px",
          transform: "rotate(-2deg)",
          fontFamily: "Plex Mono",
        },
        el({ fontSize: 28, fontWeight: 500, color: C.seal, letterSpacing: 3 }, stamp.main),
        el({ fontSize: 14, color: C.muted, letterSpacing: 2, marginTop: 4 }, stamp.sub),
      ),
    ),
    el(
      {
        justifyContent: "space-between",
        alignItems: "center",
        borderTop: `1px solid ${C.rule}`,
        paddingTop: 14,
      },
      el({ fontFamily: "Plex Mono", fontSize: 17 }, c.shortLink),
      el(
        { fontFamily: "Newsreader", fontStyle: "italic", fontSize: 21, color: C.char },
        "Even agents need lawyers.",
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Assets: fonts and the rasteriser, found next to the bundle on Vercel or in the repository.
// ---------------------------------------------------------------------------

const FONT_FILES = [
  { name: "Newsreader", file: "newsreader-500.ttf", weight: 500, style: "normal" },
  { name: "Newsreader", file: "newsreader-italic-400.ttf", weight: 400, style: "italic" },
  { name: "Plex Sans", file: "ibm-plex-sans-400.ttf", weight: 400, style: "normal" },
  { name: "Plex Mono", file: "ibm-plex-mono-400.ttf", weight: 400, style: "normal" },
  { name: "Plex Mono", file: "ibm-plex-mono-500.ttf", weight: 500, style: "normal" },
] as const;

function findAsset(file: string, ...extra: string[]): string {
  const candidates = [
    join(import.meta.dirname, "fonts", file),
    join(import.meta.dirname, "..", "..", "site-assets", "fonts", file),
    ...extra,
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`Card asset ${file} not found.`);
  return found;
}

let ready: Promise<Parameters<typeof satori>[1]["fonts"]> | null = null;

function prepare() {
  ready ??= (async () => {
    const wasmBeside = join(import.meta.dirname, "resvg.wasm");
    const wasm = existsSync(wasmBeside)
      ? wasmBeside
      : createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm");
    await initWasm(readFileSync(wasm));
    return FONT_FILES.map((f) => ({
      name: f.name,
      data: readFileSync(findAsset(f.file)),
      weight: f.weight,
      style: f.style,
    }));
  })().catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

/** Draws the card as a PNG. */
export async function renderCaseCard(c: CaseCardData): Promise<Uint8Array> {
  const fonts = await prepare();
  const svg = await satori(layout(c) as Parameters<typeof satori>[0], {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts,
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: CARD_WIDTH } }).render().asPng();
}
