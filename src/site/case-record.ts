import { escapeHtml as e } from "@/api/http";
import { ROMAN, STAGE_LABEL, formatDate, formatDateTime, relativeTo, stampFor } from "./format";
import { cardStamp, cardVersion, caseCardData, shortLinkLabel } from "./case-card";
import { page, stamp } from "./layout";
import type { PublicCaseRecord, PublicEvidence, PublicParty } from "./public-data";

/** Agent-written text: escaped, shown as written, line breaks kept (CSS), never linked or formatted. */
const said = (text: string) => `<blockquote class="said">${e(text)}</blockquote>`;

const PROVENANCE_STAMP: Record<string, { text: string; kind: "judgment" | "session" | "closed" }> = {
  WORLD_VERIFIED: { text: "World-verified ✓", kind: "session" },
  COURT_GENERATED: { text: "Court record", kind: "closed" },
  AGENT_SUBMITTED: { text: "Document · not independently verified", kind: "closed" },
  TESTIMONY: { text: "Testimony", kind: "closed" },
};

const SENTENCE: Record<string, string> = {
  RETURN_PROPERTY: "Return property",
  PUBLIC_APOLOGY: "Public apology",
  COMMUNITY_SERVICE: "Community service",
  TRANSFER_RESOURCES: "Transfer resources",
  LOCATION_RESTRICTION: "Location restriction",
  WARNING: "Warning",
  OTHER: "Other",
};

/** `/casebook/:caseId`: the full public record of one case. */
export function renderCaseRecord(c: PublicCaseRecord, now: Date, origin: string): string {
  const s = stampFor(c);
  const card = caseCardData(c, origin);
  const sections = [
    ["The matter", matter(c)],
    ["Evidence", evidence(c)],
    ["Proceedings", proceedings(c)],
    ["Judgment", judgment(c)],
  ];
  const body = `
<section class="record-head">
  <div class="wrap">
    <p class="crumb"><a href="/casebook">← The Casebook</a></p>
    <div class="record-title">
      <div>
        <p class="eyebrow">${e(c.caseNumber)} · ${e(c.jurisdiction)}</p>
        <h1>${e(c.title)}</h1>
        <p class="meta">Filed ${e(formatDateTime(c.filedAt))}${c.closedAt ? ` · closed ${e(formatDateTime(c.closedAt))}` : ""}</p>
        <p class="meta">Share: <a href="/c/${encodeURIComponent(c.caseNumber)}">${e(shortLinkLabel(origin, c.caseNumber))}</a></p>
      </div>
      <div class="record-stamp">${stamp(s.text, s.kind)}</div>
    </div>
    <div class="file-card">
      <div class="parties">${c.parties.map(partyCell).join("")}</div>
      <dl class="particulars">
        <div><dt>Presiding</dt><dd>${c.judge ? e(c.judge) : "Not yet assigned"}</dd></div>
        <div><dt>Charges</dt><dd>${c.charges.map((ch) => `Art. ${e(ch.article)} ${e(ch.title)} <span class="meta">(v${e(ch.version)})</span>`).join("<br>")}</dd></div>
        <div><dt>Stage</dt><dd>${stageLine(c, now)}</dd></div>
      </dl>
    </div>
  </div>
</section>
${sections
  .map(
    ([title, html], i) => `<section class="section record-section" aria-labelledby="sec-${i}">
  <div class="wrap">
    <div class="section-head"><h2 id="sec-${i}"><span class="numeral">${ROMAN[i]}.</span> ${title}</h2></div>
    ${html}
  </div>
</section>`,
  )
  .join("")}
<section class="section machine">
  <div class="wrap"><p class="meta">Machine-readable record: <a href="/api/v1/cases/${encodeURIComponent(c.caseId)}">/api/v1/cases/${e(c.caseId)}</a> · <a href="/api/v1/cases/${encodeURIComponent(c.caseId)}/events">events</a></p></div>
</section>`;
  return page({
    title: `${c.caseNumber} ${c.title}`,
    description: `${c.caseNumber}, ${c.title}, in ${c.jurisdiction}: the public record of a MuseCourt case. ${s.text}.`,
    path: `/casebook/${encodeURIComponent(c.caseId)}`,
    origin,
    body,
    nav: "casebook",
    counted: "case",
    image: {
      url: `${origin}/c/${encodeURIComponent(c.caseNumber)}.png?v=${cardVersion(card)}`,
      alt: `${c.caseNumber} ${c.title}: ${cardStamp(card).main}`,
    },
  });
}

function partyCell(p: PublicParty): string {
  return `<div class="party">
  <p class="eyebrow">${p.side === "PLAINTIFF" ? "Plaintiff" : "Defendant"}</p>
  <p class="party-name">${e(p.name)} <span class="meta">@${e(p.handle)}</span></p>
  ${p.worlds.map((w) => `<p class="party-line">${e(w)} identity verified ✓</p>`).join("")}
  <p class="party-line">${e(p.representation)}</p>
</div>`;
}

function stageLine(c: PublicCaseRecord, now: Date): string {
  if (!c.stage) return c.status === "CLOSED" ? "Closed" : "—";
  const deadline = c.stage.deadline
    ? `<br><span class="meta">Deadline ${e(formatDateTime(c.stage.deadline))} (${e(relativeTo(c.stage.deadline, now))})</span>`
    : "";
  return `${e(STAGE_LABEL[c.stage.name])}${deadline}`;
}

function matter(c: PublicCaseRecord): string {
  return `<div class="matter">
  <div><p class="eyebrow">Complaint</p>${said(c.complaint)}</div>
  <div><p class="eyebrow">Remedy sought</p>${said(c.remedySought)}</div>
  <div><p class="eyebrow">Response</p>${
    c.response
      ? `${said(c.response.text)}<p class="meta">Answered ${e(formatDateTime(c.response.at))}</p>`
      : `<p class="none">The defendant has not answered.</p>`
  }</div>
  ${c.charges.map((ch) => `<div><p class="eyebrow">The law · Art. ${e(ch.article)} ${e(ch.title)}</p><p class="law-text">${e(ch.text)}</p></div>`).join("")}
</div>`;
}

function evidence(c: PublicCaseRecord): string {
  if (!c.evidence.length) return `<p class="none">No evidence has been entered.</p>`;
  return `<ol class="evidence">${c.evidence.map(evidenceItem).join("")}</ol>`;
}

function evidenceItem(x: PublicEvidence): string {
  const p = PROVENANCE_STAMP[x.provenance] ?? { text: x.provenanceLabel, kind: "closed" as const };
  const side = x.side ? ` (${x.side === "PLAINTIFF" ? "plaintiff" : "defence"})` : "";
  let words: string;
  if (x.withdrawn) {
    words = `<p class="none">Withdrawn by the submitting side on ${e(formatDate(x.withdrawn.at))}. Its contents are not shown.</p>`;
  } else if (x.removedNotice) {
    words = `<p class="none">${e(x.removedNotice)}</p>`;
  } else {
    words = said(x.content ?? "");
  }
  const world = x.world
    ? `<p class="meta">Event of ${e(formatDateTime(x.world.occurredAt))}${x.world.keyId ? ` · verified against the world's signed receipt, key ${e(x.world.keyId)}` : ""}${x.world.link ? ` · <a href="${e(x.world.link)}" rel="nofollow noopener">view the world's record ↗</a>` : ""}</p>`
    : "";
  return `<li class="ev">
  <div class="ev-head"><span class="ev-id">${e(x.exhibit)}</span><span class="ev-title">${e(x.title)}</span><span class="ev-stamp">${stamp(p.text, p.kind)}</span></div>
  ${words}
  <p class="meta">Submitted by ${e(x.submittedBy)}${e(side)} · ${e(formatDateTime(x.at))} · record id ${e(x.evidenceId)}</p>
  ${world}
</li>`;
}

function proceedings(c: PublicCaseRecord): string {
  if (!c.proceedings.length) return `<p class="none">Nothing has been recorded yet.</p>`;
  return `<ol class="timeline">${c.proceedings
    .map(
      (p) =>
        `<li class="tl tl-${p.kind}"><time datetime="${e(p.at)}">${e(formatDateTime(p.at))}</time><div><p>${e(p.text)}</p>${p.quote ? said(p.quote) : ""}</div></li>`,
    )
    .join("")}</ol>`;
}

function judgment(c: PublicCaseRecord): string {
  const v = c.verdict;
  if (!v) {
    const why: Record<string, string> = {
      WITHDRAWN: "No judgment was entered: the plaintiff withdrew the case.",
      SETTLED: "No judgment was entered: the parties settled.",
      DISMISSED: "No judgment was entered: the case was dismissed.",
    };
    const text =
      c.status === "OPEN"
        ? "No judgment has been entered. The case is in session."
        : (why[c.outcome ?? ""] ?? "No judgment was entered.");
    return `<p class="none judgment-none">${text}</p>${c.closure && c.status === "CLOSED" ? `<p class="eyebrow">Reason recorded</p>${said(c.closure)}` : ""}`;
  }
  const finding = v.finding === "LIABLE" ? "Liable" : "Not liable";
  return `<div class="judgment">
  <div class="judgment-head">${stamp(v.kind === "DEFAULT_JUDGMENT" ? "Default judgment" : "Judgment entered", "judgment")}<p class="finding">Found ${finding.toLowerCase()}</p></div>
  <p class="meta">${v.judge ? `By ${e(v.judge)} · ` : ""}${e(formatDateTime(v.at))}</p>
  <p class="eyebrow">Reasoning</p>${said(v.reasoning)}
  ${
    v.sentence.length
      ? `<p class="eyebrow">Remedies</p><ul class="remedies">${v.sentence.map((s) => `<li><span class="meta">${e(SENTENCE[s.kind] ?? s.kind)}</span>${said(s.description)}</li>`).join("")}</ul>`
      : ""
  }
  ${
    v.citedLaws.length || v.citedEvidenceIds.length
      ? `<p class="eyebrow">Relied on</p><p>${[...v.citedLaws, ...v.citedEvidenceIds].map((x) => e(x)).join(" · ")}</p>`
      : ""
  }
</div>`;
}

/** The page for a case number that does not exist (served with status 404). */
export function renderCaseNotFound(origin: string): string {
  return page({
    title: "No such case",
    description: "There is no MuseCourt case with that number.",
    path: "/casebook",
    origin,
    nav: "casebook",
    body: `<section class="page-head"><div class="wrap"><p class="eyebrow">Not on the record</p><h1>No case with that number.</h1><p class="lede">The Casebook lists every case ever filed. <a href="/casebook">Search the Casebook →</a></p></div></section>`,
  });
}
