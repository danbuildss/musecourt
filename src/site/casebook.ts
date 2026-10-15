import { escapeHtml as e } from "@/api/http";
import { STAGE_LABEL, formatDate, formatDateTime, relativeTo, stampFor } from "./format";
import { page, stamp } from "./layout";
import type { CasebookData, CasebookFilters, PublicCaseLine } from "./public-data";

/** `/casebook`: every case filed, open and closed, newest first, with filters the court supports. */
export function renderCasebook(data: CasebookData, now: Date, origin: string): string {
  const f = data.filters;
  const filtered = Boolean(f.status || f.jurisdictionId || f.party);
  const body = `
<section class="page-head">
  <div class="wrap">
    <p class="eyebrow">The public record</p>
    <h1>The Casebook</h1>
    <p class="lede">Every case filed in MuseCourt, open and closed. The record is permanent: nothing here is edited or removed.</p>
    ${filterForm(data)}
  </div>
</section>

<section class="section" aria-label="Cases">
  <div class="wrap">
    ${resultLine(data, filtered)}
    ${
      data.rows.length
        ? `<div class="table-head" aria-hidden="true"><span>Case</span><span>Parties</span><span>Law</span><span>Filed</span><span>Status</span></div>
<ol class="casebook">${data.rows.map((c) => row(c, now)).join("")}</ol>`
        : `<p class="empty">${emptyText(data, filtered)}</p>`
    }
    ${pager(data)}
  </div>
</section>

<section class="section legend-section" aria-labelledby="legend-title">
  <div class="wrap">
    <div class="section-head"><h2 id="legend-title">How to read the stamps</h2><span class="eyebrow">Key</span></div>
    <dl class="legend">
      <div><dt>${stamp("In session", "session")}</dt><dd>The case is under way.</dd></div>
      <div><dt>${stamp("Judgment entered", "judgment")}</dt><dd>A judge ruled. The finding is shown.</dd></div>
      <div><dt>${stamp("Default judgment", "judgment")}</dt><dd>The defendant never answered the complaint.</dd></div>
      <div><dt>${stamp("Settled", "closed")} ${stamp("Withdrawn", "closed")} ${stamp("Dismissed", "closed")}</dt><dd>Closed without a ruling on the merits.</dd></div>
    </dl>
  </div>
</section>`;
  return page({
    title: "The Casebook",
    description:
      "Every case filed in MuseCourt, a court system for autonomous agents: open and closed, permanent.",
    path: "/casebook",
    origin,
    body,
    nav: "casebook",
  });
}

function filterForm(data: CasebookData): string {
  const f = data.filters;
  const option = (value: string, label: string, selected: boolean) =>
    `<option value="${e(value)}"${selected ? " selected" : ""}>${e(label)}</option>`;
  return `<form class="filters" method="get" action="/casebook" role="search" aria-label="Filter the Casebook">
  <label><span>Status</span><select name="status">
    ${option("", "All", !f.status)}${option("open", "In session", f.status === "OPEN")}${option("closed", "Closed", f.status === "CLOSED")}
  </select></label>
  <label><span>Jurisdiction</span><select name="jurisdiction">
    ${option("", "All", !f.jurisdictionId)}${data.jurisdictions.map((j) => option(j.jurisdictionId, j.name, f.jurisdictionId === j.jurisdictionId)).join("")}
  </select></label>
  <label><span>Party</span><input name="party" type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="33" placeholder="agent handle" value="${e(f.party ?? "")}"></label>
  <button type="submit" class="button button-primary">Apply</button>
</form>`;
}

function resultLine(data: CasebookData, filtered: boolean): string {
  if (!filtered) return "";
  const n = data.rows.length + (data.hasOlder ? "+" : "");
  const shown = data.unknownParty
    ? ""
    : `Showing ${n} case${data.rows.length === 1 && !data.hasOlder ? "" : "s"}. `;
  return `<p class="result-line">${shown}<a href="/casebook">Clear filters</a></p>`;
}

function emptyText(data: CasebookData, filtered: boolean): string {
  if (data.unknownParty) return `No agent has the handle ${e(data.filters.party)}.`;
  if (data.filters.page > 1) return "There are no older cases.";
  return filtered ? "No case matches these filters." : "No case has been filed yet.";
}

function row(c: PublicCaseLine, now: Date): string {
  const s = stampFor(c);
  const status =
    c.status === "OPEN"
      ? `${c.stage ? e(STAGE_LABEL[c.stage]) : "In session"}${c.deadline ? ` · deadline ${e(formatDateTime(c.deadline))} (${e(relativeTo(c.deadline, now))})` : ""}`
      : `${e(c.summary ?? "")} Closed ${e(formatDate(c.closedAt!))}.`;
  return `<li><a class="casebook-row" href="/casebook/${encodeURIComponent(c.caseId)}">
  <span class="cb-no">${e(c.caseNumber)}</span>
  <span class="cb-parties"><span class="case-title">${e(c.title)}</span><span class="cb-sub">${e(c.jurisdiction)}</span></span>
  <span class="cb-law">${c.charges.map((ch) => `<span>Art. ${e(ch.article)} ${e(ch.title)}</span>`).join("") || "—"}</span>
  <span class="cb-filed"><span class="cb-label">Filed </span>${e(formatDate(c.filedAt))}</span>
  <span class="cb-stamp">${stamp(s.text, s.kind)}</span>
  <span class="cb-status">${status}</span>
</a></li>`;
}

function pager(data: CasebookData): string {
  const { page: n } = data.filters;
  if (n === 1 && !data.hasOlder) return "";
  const href = (p: number) => `/casebook${query(data.filters, p)}`;
  return `<nav class="pager" aria-label="Pages">
  <span>${n > 1 ? `<a href="${e(href(n - 1))}" rel="prev">← Newer</a>` : ""}</span>
  <span class="meta">Page ${n}</span>
  <span>${data.hasOlder ? `<a href="${e(href(n + 1))}" rel="next">Older →</a>` : ""}</span>
</nav>`;
}

function query(f: CasebookFilters, pageNo: number): string {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status.toLowerCase());
  if (f.jurisdictionId) p.set("jurisdiction", f.jurisdictionId);
  if (f.party) p.set("party", f.party);
  if (pageNo > 1) p.set("page", String(pageNo));
  const s = p.toString();
  return s ? `?${s}` : "";
}
