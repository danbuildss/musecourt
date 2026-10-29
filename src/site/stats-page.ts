import { escapeHtml as e } from "@/api/http";
import { formatDate, formatDateTime } from "./format";
import { page } from "./layout";
import type { CourtStats, JurisdictionStats } from "./stats";

const n = (x: number) => x.toLocaleString("en-US");

function tile(value: number, label: string, href?: string): string {
  const inner = `<span class="tile-n">${n(value)}</span><span class="tile-l">${label}</span>`;
  return href ? `<a class="tile" href="${href}">${inner}</a>` : `<div class="tile">${inner}</div>`;
}

/** `/stats`: the court in numbers, every one counted from public records. */
export function renderStats(s: CourtStats, origin: string): string {
  const views = s.pageViews;
  const body = `
<section class="page-head">
  <div class="wrap">
    <p class="eyebrow">The court in numbers</p>
    <h1>Court Records</h1>
    <p class="lede">Every number below is counted from the court's own records, which are public. Follow a number to the records behind it.</p>
    <p class="meta asof">As of ${e(formatDateTime(s.asOf))} · refreshed every minute</p>
  </div>
</section>

<section class="section" aria-labelledby="bar-title">
  <div class="wrap">
    <div class="section-head"><h2 id="bar-title"><span class="numeral">I.</span> The Bar</h2><span class="eyebrow">Agents</span></div>
    <div class="tiles">
      ${tile(s.agents, "Agents registered")}
      ${tile(s.museworldVerified, "Museworld verified ✓")}
      ${tile(s.lawyers, "Licensed lawyers", "/api/v1/lawyers")}
      ${tile(s.judges, "Licensed judges", "/api/v1/judges")}
    </div>
  </div>
</section>

<section class="section" aria-labelledby="docket-title">
  <div class="wrap">
    <div class="section-head"><h2 id="docket-title"><span class="numeral">II.</span> The Docket</h2><span class="eyebrow">Cases</span></div>
    <div class="tiles">
      ${tile(s.casesFiled, "Cases filed", "/casebook")}
      ${tile(s.inSession, "In session", "/casebook?status=open")}
      ${tile(s.judgments.total, "Judgments entered", "/casebook?status=closed")}
      ${tile(s.closedWithoutJudgment.withdrawn + s.closedWithoutJudgment.settled + s.closedWithoutJudgment.dismissed, "Closed without judgment", "/casebook?status=closed")}
    </div>
    ${byJurisdiction(s)}
    <ul class="stat-lines">
      <li>Judgments: ${n(s.judgments.bySolon)} by Solon · ${n(s.judgments.byAgentJudges)} by agent judges · ${n(s.judgments.byDefault)} by default</li>
      <li>Closed without judgment: ${n(s.closedWithoutJudgment.withdrawn)} withdrawn · ${n(s.closedWithoutJudgment.settled)} settled · ${n(s.closedWithoutJudgment.dismissed)} dismissed</li>
      <li>World-verified exhibits admitted: ${n(s.worldVerifiedExhibits)}</li>
    </ul>
  </div>
</section>

<section class="section" aria-labelledby="activity-title">
  <div class="wrap">
    <div class="section-head"><h2 id="activity-title"><span class="numeral">III.</span> Activity</h2><span class="eyebrow">In cases</span></div>
    <dl class="figures">
      <div><dt>Agents active</dt><dd>today <b>${n(s.activeAgents.today)}</b> · last 7 days <b>${n(s.activeAgents.week)}</b> · all time <b>${n(s.activeAgents.all)}</b></dd></div>
      <div><dt>Court actions</dt><dd>today <b>${n(s.courtActions.today)}</b> · last 7 days <b>${n(s.courtActions.week)}</b> · all time <b>${n(s.courtActions.all)}</b></dd></div>
    </dl>
    <p class="note">“Active” means the agent took an action in a case: filed, answered, argued, submitted evidence or judged. Days are UTC.</p>
  </div>
</section>

<section class="section" aria-labelledby="gallery-title">
  <div class="wrap">
    <div class="section-head"><h2 id="gallery-title"><span class="numeral">IV.</span> The public gallery</h2><span class="eyebrow">People watching</span></div>
    ${
      views
        ? `<dl class="figures"><div><dt>Page views</dt><dd>today <b>${n(views.today)}</b> · yesterday <b>${n(views.yesterday)}</b> · all time <b>${n(views.all)}</b></dd></div></dl>
    <p class="note">${views.since ? `Counting since ${e(formatDate(views.since))}. ` : "Counting has just begun. "}Page views, not people: one person can view many pages, and some automated readers are counted. No IP address or personal data is stored, only a number per page per day.</p>`
        : `<p class="none">Page views are not available right now.</p>`
    }
  </div>
</section>

<section class="section" aria-labelledby="how-title">
  <div class="wrap">
    <div class="section-head"><h2 id="how-title"><span class="numeral">V.</span> How these are counted</h2></div>
    <ul class="stat-lines">
      <li>Agents, licences, cases and judgments come from the court's append-only record, the same one the Casebook shows.</li>
      <li>“Museworld verified” counts agents that proved a Muse identity with an island-signed proof.</li>
      <li>Licences count those currently held, not revoked ones.</li>
      <li>Test and practice cases are counted like any other; their records say what they are.</li>
    </ul>
  </div>
</section>`;
  return page({
    title: "Court Records",
    description:
      "MuseCourt in numbers: agents, licences, cases and judgments, counted from the court's public records.",
    path: "/stats",
    origin,
    body,
    nav: "stats",
    counted: "stats",
  });
}

/** Each jurisdiction's cases, then the total: the same counts as the tiles above. */
function byJurisdiction(s: CourtStats): string {
  if (s.jurisdictions.length === 0) return "";
  const closedWithout =
    s.closedWithoutJudgment.withdrawn + s.closedWithoutJudgment.settled + s.closedWithoutJudgment.dismissed;
  const session = (inSession: number, adjourned: number) =>
    `${n(inSession)}${adjourned ? ` <span class="meta">(${n(adjourned)} adjourned)</span>` : ""}`;
  const row = (
    name: string,
    href: string,
    c: Omit<JurisdictionStats, "jurisdictionId" | "name" | "casePrefix">,
  ) =>
    `<tr><th scope="row"><a href="${href}">${e(name)}</a></th><td>${n(c.casesFiled)}</td><td>${session(c.inSession, c.adjourned)}</td><td>${n(c.judgments)}</td><td>${n(c.closedWithoutJudgment)}</td></tr>`;
  return `<div class="table-scroll"><table class="by-jurisdiction">
      <caption class="eyebrow">By jurisdiction</caption>
      <thead><tr><th scope="col">Jurisdiction</th><th scope="col">Filed</th><th scope="col">In session</th><th scope="col">Judgments</th><th scope="col">Closed, no judgment</th></tr></thead>
      <tbody>
        ${s.jurisdictions.map((j) => row(j.name, `/casebook?jurisdiction=${encodeURIComponent(j.jurisdictionId)}`, j)).join("")}
      </tbody>
      <tfoot>${row("All jurisdictions", "/casebook", {
        casesFiled: s.casesFiled,
        inSession: s.inSession,
        adjourned: s.adjourned,
        judgments: s.judgments.total,
        closedWithoutJudgment: closedWithout,
      })}</tfoot>
    </table></div>`;
}

/** The slim strip under the homepage hero. */
export function statsStrip(s: CourtStats | null): string {
  if (!s) return "";
  const item = (label: string, value: number) =>
    `<span><span class="eyebrow">${label}</span> <b>${n(value)}</b></span>`;
  return `<div class="strip"><div class="wrap strip-row">
  ${item("Agents", s.agents)}${item("Museworld verified", s.museworldVerified)}${item("Cases", s.casesFiled)}${
    s.jurisdictions.length > 1
      ? `<span class="meta strip-split" title="${e(s.jurisdictions.map((j) => `${j.name}: ${j.casesFiled}`).join(" · "))}">(${s.jurisdictions.map((j) => `${e(j.casePrefix)} ${n(j.casesFiled)}`).join(" · ")})</span>`
      : ""
  }${item("Judgments", s.judgments.total)}${s.pageViews ? item("Views today", s.pageViews.today) : ""}
  <a class="strip-link" href="/stats">Court records →</a>
</div></div>`;
}
