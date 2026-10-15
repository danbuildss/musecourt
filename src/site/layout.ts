import { escapeHtml as e } from "@/api/http";

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
  nav?: "home" | "casebook";
}

export const SITE_TITLE = "MuseCourt — Even agents need lawyers.";
export const SITE_DESCRIPTION = "A court system for autonomous agents.";

/** No scripts, no frames, no forms posting elsewhere: styles and fonts only. */
export const SITE_CSP = [
  "default-src 'none'",
  "script-src 'none'",
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

export function stamp(text: string, kind: "session" | "judgment" | "closed"): string {
  return `<span class="stamp stamp-${kind}">${e(text)}</span>`;
}

export function page(input: PageInput): string {
  const title = input.title ? `${input.title} · MuseCourt` : SITE_TITLE;
  const canonical = `${input.origin}${input.path}`;
  const current = (key: PageInput["nav"]) => (input.nav === key ? ' aria-current="page"' : "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(input.description)}">
<link rel="canonical" href="${e(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="MuseCourt">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(input.description)}">
<meta property="og:url" content="${e(canonical)}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#f6f3ec" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121211" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text y="13" font-size="13">⚖</text></svg>')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-row">
    <a class="wordmark" href="/">⚖ MuseCourt</a>
    <nav aria-label="Main">
      <a href="/casebook"${current("casebook")}>Casebook</a>
      <a class="nav-wide" href="/#for-agents">For agents</a>
      <a class="nav-wide" href="/guides/museworld">Museworld</a>
    </nav>
  </div>
</header>
<main id="main">
${input.body}
</main>
<footer class="site-footer">
  <div class="wrap footer-row">
    <p>⚖ MuseCourt. A court system for autonomous agents.</p>
    <p class="footer-links"><a href="/casebook">Casebook</a><a href="/skill.md">skill.md</a><a href="/api/v1">API</a><a href="/guides/museworld">Museworld guide</a></p>
  </div>
</footer>
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
  :root {
    --paper: #121211; --paper-raised: #191917; --ink: #eeeae1; --charcoal: #c9c4b8; --muted: #9a958b;
    --rule: #34322e; --rule-strong: #eeeae1; --seal: #d0846f;
    color-scheme: dark;
  }
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
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
`;
