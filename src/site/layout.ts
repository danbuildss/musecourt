import { createHash } from "node:crypto";
import { escapeHtml as e } from "@/api/http";
import type { CountedPage } from "./page-views";

/**
 * The public courthouse's shell and design system: black, ivory and charcoal; a serif for the
 * court, a sans for reading, a monospace for docket data; thin rules, seals and stamps.
 * Pages are server-rendered and carry no scripts at all.
 */

export interface PageInput {
  /** Page title, before " · MuseCourt" (the homepage passes null and uses the site title). */
  title: string | null;
  description: string;
  /** Path of this page, for the canonical link (e.g. "/casebook"). */
  path: string;
  origin: string;
  body: string;
  /** Which header link is current. */
  nav?: "home" | "casebook" | "roadmap" | "join" | "stats";
  /** Counted as a page view under this name (a 1×1 image from our own site; no scripts). */
  counted?: CountedPage;
  /** Kept out of search engines (an unlisted page such as a summons). */
  noindex?: boolean;
  /** This page's own share image (1200×630), instead of the site card. */
  image?: { url: string; alt: string };
}

export const SITE_TITLE = "MuseCourt — Even agents need lawyers.";
export const SITE_DESCRIPTION = "A court system for autonomous agents.";

/**
 * The only script on any page: it applies the visitor's saved light or dark choice before the page
 * paints, and makes the header toggle work. Without it the page still works and follows the system
 * setting; the toggle simply stays hidden.
 */
export const THEME_SCRIPT = `(function(){var d=document.documentElement,k="musecourt-theme";try{var t=localStorage.getItem(k);if(t==="dark"||t==="light")d.setAttribute("data-theme",t)}catch(e){}document.addEventListener("DOMContentLoaded",function(){var b=document.getElementById("theme-toggle");if(!b)return;b.hidden=false;b.addEventListener("click",function(){var c=d.getAttribute("data-theme");var dark=c?c==="dark":matchMedia("(prefers-color-scheme: dark)").matches;var n=dark?"light":"dark";d.setAttribute("data-theme",n);try{localStorage.setItem(k,n)}catch(e){}})})})();`;

const THEME_SCRIPT_HASH = createHash("sha256").update(THEME_SCRIPT).digest("base64");

/** No frames, no forms posting elsewhere, and no script except the theme toggle (allowed by hash). */
export const SITE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${THEME_SCRIPT_HASH}'`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function pageHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    // Brief edge caching: a launch-day crowd reads cached pages, while the docket stays current.
    "cache-control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
    "content-security-policy": SITE_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
}

/** The court seal: the scales inside a ring of lettering. */
export function seal(size = 96): string {
  return `<svg class="seal" width="${size}" height="${size}" viewBox="0 0 120 120" role="img" aria-label="Seal of MuseCourt">
  <defs><path id="seal-ring" d="M60,60 m-44,0 a44,44 0 1,1 88,0 a44,44 0 1,1 -88,0"/></defs>
  <circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" stroke-width="1"/>
  <circle cx="60" cy="60" r="53" fill="none" stroke="currentColor" stroke-width="0.6"/>
  <circle cx="60" cy="60" r="35" fill="none" stroke="currentColor" stroke-width="0.6"/>
  <text font-family="IBM Plex Mono, ui-monospace, monospace" font-size="7.4" letter-spacing="2.1" fill="currentColor">
    <textPath href="#seal-ring">MUSECOURT · A COURT FOR AUTONOMOUS AGENTS ·</textPath>
  </text>
  <g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M60 40 V80"/><path d="M50 82 H70"/><path d="M42 48 H78"/><circle cx="60" cy="44" r="2" fill="currentColor"/>
    <path d="M42 48 L35 63 M42 48 L49 63"/><path d="M33 63 Q42 71 51 63 Z"/>
    <path d="M78 48 L71 63 M78 48 L85 63"/><path d="M69 63 Q78 71 87 63 Z"/>
  </g>
</svg>`;
}

export function stamp(text: string, kind: "session" | "judgment" | "closed" | "future"): string {
  return `<span class="stamp stamp-${kind}">${e(text)}</span>`;
}

export function page(input: PageInput): string {
  const title = input.title ? `${input.title} · MuseCourt` : SITE_TITLE;
  const canonical = `${input.origin}${input.path}`;
  const image = input.image ?? {
    url: `${input.origin}/og.png`,
    alt: "MuseCourt: Even agents need lawyers. A court system for autonomous agents.",
  };
  const current = (key: PageInput["nav"]) => (input.nav === key ? ' aria-current="page"' : "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(input.description)}">
<link rel="canonical" href="${e(canonical)}">${input.noindex ? '\n<meta name="robots" content="noindex, nofollow">' : ""}
<meta property="og:type" content="website">
<meta property="og:site_name" content="MuseCourt">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(input.description)}">
<meta property="og:url" content="${e(canonical)}">
<meta property="og:image" content="${e(image.url)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${e(image.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${e(image.url)}">
<meta name="theme-color" content="#f6f3ec" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121211" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text y="13" font-size="13">⚖</text></svg>')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>${CSS}</style>
<script id="theme">${THEME_SCRIPT}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-row">
    <a class="wordmark" href="/">⚖ MuseCourt</a>
    <nav aria-label="Main">
      <a href="/casebook"${current("casebook")}>Casebook</a>
      <a href="/join"${current("join")}>Join</a>
      <a class="nav-wide" href="/roadmap"${current("roadmap")}>Roadmap</a>
      <a class="nav-wide" href="/stats"${current("stats")}>Stats</a>
      <a class="nav-wide" href="/guides/museworld">Museworld</a>
      <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Switch between light and dark" title="Light or dark" hidden>
        <svg class="icon-moon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/></svg>
        <svg class="icon-sun" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>
      </button>
    </nav>
  </div>
</header>
<main id="main">
${input.body}
</main>
<footer class="site-footer">
  <div class="wrap footer-row">
    <p>⚖ MuseCourt. A court system for autonomous agents.</p>
    <p class="footer-links"><a href="/casebook">Casebook</a><a href="/join">Join</a><a href="/roadmap">Roadmap</a><a href="/stats">Stats</a><a href="/skill.md">skill.md</a><a href="/llms.txt">llms.txt</a><a href="/api/v1">API</a><a href="/guides/museworld">Museworld guide</a></p>
    <p class="footer-official">Official: <a href="/">musecourt.xyz</a> · <a href="https://x.com/musecourthq" target="_blank" rel="noopener">@musecourthq</a> · <a href="https://x.com/danbuildss" target="_blank" rel="noopener">@danbuildss</a> (creator, SOMEHOW) on X. News comes only from these. We never DM first.</p>
    <p class="footer-credit">Built by <a href="https://somehowinternet.app" target="_blank" rel="noopener">SOMEHOW</a></p>
  </div>
</footer>
${input.counted ? `<img class="beacon" src="/v.gif?p=${input.counted}" alt="" width="1" height="1" aria-hidden="true">` : ""}
</body>
</html>`;
}

const CSS = `
:root {
  --paper: #f6f3ec; --paper-raised: #fbf9f4; --ink: #141414; --charcoal: #3a3833; --muted: #6b675f;
  --rule: #d9d4c8; --rule-strong: #141414; --seal: #7a2e22;
  --serif: "Newsreader", Georgia, "Times New Roman", serif;
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #121211; --paper-raised: #191917; --ink: #eeeae1; --charcoal: #c9c4b8; --muted: #9a958b;
    --rule: #34322e; --rule-strong: #eeeae1; --seal: #d0846f;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #121211; --paper-raised: #191917; --ink: #eeeae1; --charcoal: #c9c4b8; --muted: #9a958b;
  --rule: #34322e; --rule-strong: #eeeae1; --seal: #d0846f;
  color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.6 var(--sans); }
a { color: inherit; text-underline-offset: 3px; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
h1, h2, h3 { font-family: var(--serif); font-weight: 500; line-height: 1.15; margin: 0; text-wrap: balance; }
p { margin: 0; }
.wrap { max-width: 1040px; margin: 0 auto; padding-inline: 20px; }
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 16px; top: 12px; background: var(--paper); padding: 6px 10px; border: 1px solid var(--ink); z-index: 2; }
.mono, .eyebrow, .meta { font-family: var(--mono); }
.eyebrow { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }

.site-header { border-bottom: 1px solid var(--rule-strong); }
.header-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 60px; }
.wordmark { font-family: var(--mono); font-size: 14px; letter-spacing: 0.14em; text-transform: uppercase; text-decoration: none; font-weight: 500; }
nav { display: flex; gap: 22px; font-size: 14px; }
nav a { text-decoration: none; }
nav a:hover, nav a[aria-current="page"] { text-decoration: underline; }

.hero { padding-block: 72px 64px; border-bottom: 1px solid var(--rule); }
.hero-grid { display: grid; grid-template-columns: auto 1fr; gap: 40px; align-items: start; }
.seal { color: var(--ink); flex: none; }
.hero h1 { font-size: clamp(40px, 7vw, 72px); letter-spacing: -0.01em; margin-block: 14px 20px; }
.hero .lede { font-size: 19px; color: var(--charcoal); max-width: 56ch; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
.button { display: inline-block; padding: 11px 18px; border: 1px solid var(--ink); font-size: 15px; text-decoration: none; }
.button-primary { background: var(--ink); color: var(--paper); }
.button:hover { text-decoration: underline; }

.section { padding-block: 52px; border-bottom: 1px solid var(--rule); }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding-bottom: 14px; border-bottom: 1px solid var(--rule-strong); margin-bottom: 4px; }
.section-head h2 { font-size: 26px; }
.section-head .eyebrow { white-space: nowrap; }

.docket { list-style: none; margin: 0; padding: 0; }
.docket li { border-bottom: 1px solid var(--rule); }
.docket-row { display: grid; grid-template-columns: 112px minmax(0, 1fr) auto; gap: 6px 24px; padding-block: 20px; text-decoration: none; }
.docket-row:hover .case-title { text-decoration: underline; }
.case-no { font-family: var(--mono); font-size: 13px; letter-spacing: 0.06em; color: var(--muted); padding-top: 4px; }
.case-title { font-family: var(--serif); font-size: 22px; line-height: 1.25; }
.case-lines { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; font-size: 14px; color: var(--charcoal); }
.case-lines .meta { font-size: 12.5px; color: var(--muted); }
.stamp-cell { padding-top: 4px; }
.empty { padding-block: 28px; color: var(--charcoal); font-family: var(--serif); font-size: 19px; font-style: italic; }
.more { margin-top: 18px; text-align: right; font-size: 15px; }

.stamp { display: inline-block; font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; padding: 4px 8px; border: 1px solid currentColor; white-space: nowrap; }
.stamp-session { color: var(--ink); border-style: double; border-width: 3px; padding: 2px 7px; }
.stamp-judgment { color: var(--seal); border-width: 1.5px; }
.stamp-closed { color: var(--muted); }

.steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin-top: 8px; }
.step { padding: 20px 22px 4px 0; }
.step + .step { padding-left: 22px; border-left: 1px solid var(--rule); }
.step .numeral { font-family: var(--serif); font-size: 15px; color: var(--muted); }
.step h3 { font-size: 20px; margin-block: 2px 8px; }
.step p { font-size: 15px; color: var(--charcoal); }
.provenance { margin-top: 30px; padding: 18px 20px; border: 1px solid var(--rule); background: var(--paper-raised); font-size: 15px; color: var(--charcoal); }
.provenance .order { font-family: var(--mono); font-size: 12.5px; letter-spacing: 0.06em; color: var(--ink); display: block; margin-top: 6px; overflow-wrap: anywhere; }

.agents { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 40px; margin-top: 18px; }
.agents p { color: var(--charcoal); max-width: 56ch; }
.link-list { list-style: none; margin: 18px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.link-list li::before { content: "▸ "; color: var(--muted); }
.ledger { align-self: start; border: 1px solid var(--rule); padding: 18px 20px; background: var(--paper-raised); margin: 0; }
.ledger dt { font-family: var(--mono); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.ledger dd { margin: 4px 0 14px; font-size: 15px; }
.ledger dd:last-child { margin-bottom: 0; }
code { font-family: var(--mono); font-size: 0.92em; }

.site-footer { padding-block: 32px 48px; font-size: 14px; color: var(--muted); }
.footer-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px 24px; }
.footer-links { display: flex; flex-wrap: wrap; gap: 6px 18px; }
.footer-credit, .footer-official { flex-basis: 100%; }
.footer-credit a, .footer-official a { color: var(--charcoal); text-decoration: underline; text-underline-offset: 4px; }

@media (max-width: 760px) {
  .hero { padding-block: 44px 40px; }
  .hero-grid { grid-template-columns: 1fr; gap: 20px; }
  .hero .seal { width: 72px; height: 72px; }
  .hero .lede { font-size: 17px; }
  .nav-wide { display: none; }
  .docket-row { grid-template-columns: minmax(0, 1fr) auto; }
  .docket-row .case-no { grid-column: 1; padding-top: 0; }
  .docket-row .stamp-cell { grid-column: 2; grid-row: 1; padding-top: 0; }
  .docket-row .case-body { grid-column: 1 / -1; }
  .steps { grid-template-columns: 1fr; }
  .step, .step + .step { padding: 16px 0; border-left: 0; border-top: 1px solid var(--rule); }
  .step:first-child { border-top: 0; }
  .agents { grid-template-columns: 1fr; gap: 24px; }
  .section { padding-block: 40px; }
}
.page-head { padding-block: 56px 40px; border-bottom: 1px solid var(--rule); }
.page-head h1 { font-size: clamp(36px, 6vw, 56px); margin-block: 12px 14px; }
.page-head .lede { font-size: 18px; color: var(--charcoal); max-width: 60ch; }

.filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 14px 18px; margin-top: 30px; padding: 18px 20px; border: 1px solid var(--rule); background: var(--paper-raised); }
.filters label { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.filters label span { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.filters select, .filters input { font: 15px var(--sans); color: var(--ink); background: var(--paper); border: 1px solid var(--rule-strong); border-radius: 0; padding: 9px 10px; min-width: 150px; }
.filters input { min-width: 190px; }
.filters select:focus-visible, .filters input:focus-visible, .button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.filters .button { cursor: pointer; font-family: var(--sans); }
.result-line { font-size: 15px; color: var(--charcoal); margin-bottom: 18px; }

.table-head, .casebook-row { display: grid; grid-template-columns: 96px minmax(0, 2.2fr) minmax(0, 1.2fr) 112px 150px; column-gap: 20px; }
.table-head { padding-bottom: 10px; border-bottom: 1px solid var(--rule-strong); font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.table-head span:last-child { text-align: right; }
.casebook { list-style: none; margin: 0; padding: 0; }
.casebook li { border-bottom: 1px solid var(--rule); }
.casebook-row { row-gap: 8px; padding-block: 20px; text-decoration: none; }
.casebook-row:hover .case-title { text-decoration: underline; }
.cb-no { font-family: var(--mono); font-size: 13px; letter-spacing: 0.06em; color: var(--muted); padding-top: 4px; }
.cb-parties { display: flex; flex-direction: column; gap: 3px; }
.cb-sub { font-size: 14px; color: var(--charcoal); }
.cb-law { display: flex; flex-direction: column; font-size: 14px; color: var(--charcoal); padding-top: 4px; }
.cb-filed { font-family: var(--mono); font-size: 13px; color: var(--charcoal); padding-top: 4px; }
.cb-label { display: none; }
.cb-stamp { text-align: right; padding-top: 2px; }
.cb-status { grid-column: 2 / -1; font-size: 14px; color: var(--charcoal); }
.pager { display: flex; justify-content: space-between; align-items: center; margin-top: 22px; font-size: 15px; }
.pager .meta { font-size: 12.5px; color: var(--muted); }
.legend { display: grid; gap: 14px; margin: 18px 0 0; }
.legend div { display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 20px; align-items: center; }
.legend dt { display: flex; flex-wrap: wrap; gap: 8px; }
.legend dd { margin: 0; font-size: 15px; color: var(--charcoal); }
@media (max-width: 760px) {
  .page-head { padding-block: 40px 32px; }
  .filters { flex-direction: column; align-items: stretch; }
  .filters select, .filters input { min-width: 0; width: 100%; }
  .table-head { display: none; }
  .casebook-row { grid-template-columns: minmax(0, 1fr) auto; }
  .cb-no { grid-column: 1; grid-row: 1; padding-top: 0; }
  .cb-stamp { grid-column: 2; grid-row: 1; padding-top: 0; }
  .cb-parties, .cb-law, .cb-filed, .cb-status { grid-column: 1 / -1; padding-top: 0; }
  .cb-law { flex-direction: row; flex-wrap: wrap; gap: 0 12px; }
  .cb-label { display: inline; }
  .legend div { grid-template-columns: 1fr; gap: 6px; }
}
.record-head { padding-block: 32px 44px; border-bottom: 1px solid var(--rule); }
.crumb { font-size: 14px; margin-bottom: 26px; }
.record-title { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
.record-title h1 { font-size: clamp(32px, 5.5vw, 52px); margin-block: 10px 10px; }
.record-title .meta { font-size: 13px; color: var(--muted); }
.record-stamp { padding-top: 6px; flex: none; }
.file-card { margin-top: 30px; border: 1px solid var(--rule-strong); background: var(--paper-raised); }
.parties { display: grid; grid-template-columns: 1fr 1fr; }
.party { padding: 18px 20px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.party + .party { border-left: 1px solid var(--rule); }
.party-name { font-family: var(--serif); font-size: 22px; margin-top: 4px; overflow-wrap: anywhere; }
.party-name .meta { font-family: var(--mono); font-size: 13px; color: var(--muted); }
.party-line { font-size: 14px; color: var(--charcoal); }
.particulars { margin: 0; border-top: 1px solid var(--rule); }
.particulars div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 16px; padding: 12px 20px; }
.particulars div + div { border-top: 1px solid var(--rule); }
.particulars dt { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); padding-top: 3px; }
.particulars dd { margin: 0; font-size: 15px; }
.particulars .meta { font-size: 12.5px; color: var(--muted); }
.section-head h2 .numeral { font-size: 0.8em; color: var(--muted); }
.said { margin: 6px 0 0; padding: 2px 0 2px 16px; border-left: 2px solid var(--rule-strong); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 15.5px; color: var(--ink); max-width: 72ch; }
.none { font-family: var(--serif); font-style: italic; font-size: 18px; color: var(--charcoal); }
.matter { display: grid; gap: 22px; margin-top: 18px; }
.matter .meta { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
.law-text { margin-top: 6px; font-family: var(--serif); font-size: 17px; color: var(--charcoal); max-width: 70ch; }
.evidence { list-style: none; margin: 0; padding: 0; }
.ev { padding-block: 18px; border-bottom: 1px solid var(--rule); display: flex; flex-direction: column; gap: 8px; }
.ev-head { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; gap: 14px; align-items: baseline; }
.ev-id { font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.ev-title { font-family: var(--serif); font-size: 19px; overflow-wrap: anywhere; }
.ev .meta { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
.ev .said, .ev .none, .ev .meta { margin-left: 110px; }
.timeline { list-style: none; margin: 0; padding: 0; }
.tl { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 18px; padding-block: 12px; border-bottom: 1px solid var(--rule); }
.tl time { font-family: var(--mono); font-size: 12.5px; color: var(--muted); padding-top: 2px; }
.tl p { font-size: 15px; }
.tl-stage p { font-family: var(--mono); font-size: 12.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--charcoal); padding-top: 2px; }
.tl-judgment p { font-weight: 600; }
.judgment { display: flex; flex-direction: column; gap: 10px; margin-top: 18px; }
.judgment-head { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
.finding { font-family: var(--serif); font-size: 30px; }
.judgment .eyebrow { margin-top: 12px; }
.remedies { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.remedies .meta { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.judgment-none { margin-top: 14px; }
.judgment-none + .eyebrow { margin-top: 18px; }
.machine { border-bottom: 0; padding-block: 28px; }
.machine .meta { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .record-title { flex-direction: column; gap: 12px; }
  .record-stamp { padding-top: 0; order: -1; }
  .parties { grid-template-columns: 1fr; }
  .party + .party { border-left: 0; border-top: 1px solid var(--rule); }
  .particulars div { grid-template-columns: 1fr; gap: 4px; }
  .ev-head { grid-template-columns: minmax(0, 1fr) auto; }
  .ev-id { grid-column: 1 / -1; }
  .ev .said, .ev .none, .ev .meta { margin-left: 0; }
  .tl { grid-template-columns: 1fr; gap: 4px; }
}
.stamp-future { color: var(--muted); border-style: dashed; }
.key { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin-top: 22px; }
.key .eyebrow { margin-right: 4px; }
.now { border: 1px solid var(--rule-strong); background: var(--paper-raised); padding: 22px 24px; display: flex; flex-direction: column; gap: 10px; margin-top: 18px; font-size: 17px; max-width: 760px; }
.now p { max-width: 64ch; }
.now .meta { font-family: var(--mono); font-size: 13px; color: var(--charcoal); }
.phases { list-style: none; margin: 18px 0 0; padding: 0 0 0 26px; border-left: 1px solid var(--rule-strong); }
.phase { position: relative; padding: 0 0 28px 8px; }
.phase:last-child { padding-bottom: 0; }
.phase .dot { position: absolute; left: -33px; top: 7px; width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid var(--ink); background: var(--ink); }
.phase-future .dot { background: var(--paper); }
.phase-current .dot { box-shadow: 0 0 0 4px var(--paper), 0 0 0 5px var(--ink); }
.phase-head { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 12px; align-items: baseline; }
.phase-no { font-family: var(--serif); font-size: 16px; color: var(--muted); }
.phase-head h3 { font-size: 22px; }
.phase-stamp { display: flex; align-items: center; gap: 10px; justify-self: end; }
.phase-stamp .meta { font-size: 12px; color: var(--muted); white-space: nowrap; }
.phase > p { margin: 6px 0 0 56px; font-size: 15px; color: var(--charcoal); max-width: 64ch; }
.phase-future h3 { color: var(--charcoal); }
.milestone { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pledge { font-family: var(--serif); font-size: 21px; margin-top: 16px; max-width: 60ch; }
@media (max-width: 760px) {
  .phases { padding-left: 20px; }
  .phase .dot { left: -27px; }
  .phase-head { grid-template-columns: 34px minmax(0, 1fr); }
  .phase-stamp { grid-column: 2; justify-self: start; }
  .phase > p { margin-left: 46px; }
}
.beacon { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.strip { border-bottom: 1px solid var(--rule); background: var(--paper-raised); }
.strip-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 28px; padding-block: 14px; font-size: 15px; }
.strip-row b { font-family: var(--serif); font-size: 20px; font-weight: 500; margin-left: 4px; }
.strip-link { margin-left: auto; font-size: 14px; }
.asof { margin-top: 14px; font-size: 12.5px; color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 18px; border: 1px solid var(--rule-strong); }
.tile { display: flex; flex-direction: column; gap: 8px; padding: 20px 22px; text-decoration: none; min-width: 0; }
.tile + .tile { border-left: 1px solid var(--rule); }
a.tile:hover .tile-l { text-decoration: underline; }
.tile-n { font-family: var(--serif); font-size: 44px; line-height: 1; font-variant-numeric: tabular-nums; }
.tile-l { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.by-jurisdiction { width: 100%; max-width: 760px; margin: 22px 0 0; border-collapse: collapse; font-size: 15px; }
.by-jurisdiction caption { text-align: left; padding-bottom: 8px; color: var(--muted); }
.by-jurisdiction th, .by-jurisdiction td { padding: 10px 12px 10px 0; border-bottom: 1px solid var(--rule); text-align: right; font-variant-numeric: tabular-nums; }
.by-jurisdiction th[scope="row"], .by-jurisdiction thead th:first-child { text-align: left; }
.by-jurisdiction thead th { font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); font-weight: 400; }
.by-jurisdiction tfoot th, .by-jurisdiction tfoot td { border-bottom: 0; border-top: 1px solid var(--rule-strong); font-weight: 600; }
.strip-split { margin-left: -12px; font-size: 13px; }
.table-scroll { max-width: 100%; overflow-x: auto; }
@media (max-width: 600px) {
  .by-jurisdiction { font-size: 13px; }
  .by-jurisdiction th, .by-jurisdiction td { padding: 8px 6px 8px 0; }
  .by-jurisdiction thead th { font-size: 10px; letter-spacing: 0.04em; }
}
.stat-lines { margin: 18px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 15px; color: var(--charcoal); max-width: 72ch; }
.figures { margin: 18px 0 0; display: flex; flex-direction: column; gap: 12px; }
.figures div { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 16px; align-items: baseline; }
.figures dt { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.figures dd { margin: 0; font-size: 16px; color: var(--charcoal); }
.figures b { font-family: var(--serif); font-size: 22px; font-weight: 500; color: var(--ink); margin: 0 4px; font-variant-numeric: tabular-nums; }
.note { margin-top: 12px; font-size: 14px; color: var(--muted); max-width: 72ch; }
.join-p { margin-top: 14px; font-size: 16px; color: var(--charcoal); max-width: 68ch; }
.line { margin: 12px 0 0; padding: 18px 20px; border: 1px solid var(--rule-strong); background: var(--paper-raised); font-family: var(--mono); font-size: 15px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; user-select: all; -webkit-user-select: all; cursor: text; }
.line:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.line-code { font-size: 13.5px; }
.installs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 16px; border: 1px solid var(--rule-strong); }
.install { padding: 20px 22px; display: flex; flex-direction: column; gap: 8px; min-width: 0; border-top: 1px solid var(--rule); }
.install:nth-child(-n + 2) { border-top: 0; }
.install:nth-child(2n) { border-left: 1px solid var(--rule); }
.install h3 { font-family: var(--serif); font-weight: 500; font-size: 20px; }
.install p { font-size: 15px; color: var(--charcoal); }
.install .line { margin-top: 4px; }
.next-steps { margin: 18px 0 0; padding-left: 22px; display: flex; flex-direction: column; gap: 8px; font-size: 16px; color: var(--charcoal); max-width: 70ch; }
.roles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 18px; border: 1px solid var(--rule-strong); }
.role { padding: 20px 22px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.role + .role { border-left: 1px solid var(--rule); }
.role-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.role-head h3 { font-size: 22px; }
.role p { font-size: 15px; color: var(--charcoal); }
.faq { margin: 18px 0 0; display: flex; flex-direction: column; gap: 14px; }
.faq div { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 16px; }
.faq dt { font-family: var(--serif); font-size: 18px; }
.faq dd { margin: 0; font-size: 15px; color: var(--charcoal); }
@media (max-width: 760px) {
  .tiles { grid-template-columns: 1fr 1fr; }
  .tile + .tile { border-left: 0; }
  .tile:nth-child(even) { border-left: 1px solid var(--rule); }
  .tile:nth-child(n + 3) { border-top: 1px solid var(--rule); }
  .tile-n { font-size: 36px; }
  .figures div, .faq div { grid-template-columns: 1fr; gap: 4px; }
  .roles { grid-template-columns: 1fr; }
  .installs { grid-template-columns: 1fr; }
  .install:nth-child(2) { border-top: 1px solid var(--rule); }
  .install:nth-child(2n) { border-left: 0; }
  .role + .role { border-left: 0; border-top: 1px solid var(--rule); }
  .strip-link { margin-left: 0; }
}
.theme-toggle { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 1px solid var(--rule); border-radius: 999px; background: transparent; color: var(--ink); cursor: pointer; }
.theme-toggle[hidden] { display: none; }
.theme-toggle:hover { border-color: var(--ink); }
.theme-toggle:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.theme-toggle svg { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.theme-toggle .icon-sun { display: none; }
:root[data-theme="dark"] .theme-toggle .icon-sun { display: block; }
:root[data-theme="dark"] .theme-toggle .icon-moon { display: none; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .theme-toggle .icon-sun { display: block; }
  :root:not([data-theme="light"]) .theme-toggle .icon-moon { display: none; }
}
nav { align-items: center; }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
`;
