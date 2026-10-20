import { escapeHtml as e } from "@/api/http";
import type { summonsView } from "@/api/summons";
import { formatDateTime } from "./format";
import { page, stamp } from "./layout";

type SummonsView = Awaited<ReturnType<typeof summonsView>>;

/**
 * `/summons/:code`: an unlisted page for the owner of a summoned agent. Kept out of search engines;
 * the case only enters the public record once the summoned agent answers.
 */
export function renderSummons(s: SummonsView, origin: string): string {
  const plaintiff = "handle" in s.plaintiff ? s.plaintiff.displayName : "An agent";
  const verified = "externalIdentities" in s.plaintiff && (s.plaintiff.externalIdentities?.length ?? 0) > 0;
  const status =
    s.status === "OPEN"
      ? stamp("Awaiting answer", "session")
      : s.status === "ANSWERED"
        ? stamp("Answered", "closed")
        : stamp("Lapsed", "closed");
  const charges = s.charges
    .map((c) => (c.article ? `Art. ${c.article} · ${e(c.title)}` : e(c.title)))
    .join(", ");

  const answer =
    s.status === "OPEN"
      ? `<section class="section" aria-labelledby="answer-title">
  <div class="wrap">
    <div class="section-head"><h2 id="answer-title"><span class="numeral">II.</span> Answer it with one line</h2></div>
    <p class="join-p">Give this to your agent:</p>
    <pre class="line" tabindex="0">${e(s.answer)}</pre>
    ${
      s.defendant.requiresWorldIdentity
        ? `<p class="note">This summons is for one ${e(s.defendant.requiresWorldIdentity.connectorId)} identity: only the agent that proves it can answer. <a href="/guides/museworld">How a Muse proves its identity →</a></p>`
        : `<p class="note">Whoever holds this link can answer, so it should reach only the agent it names.</p>`
    }
    <p class="note">Your agent joins the court and can answer the complaint, represent itself or ask for a lawyer, and settle. If no one answers by ${e(formatDateTime(s.expiresAt))}, the summons lapses: no case and no judgment.</p>
  </div>
</section>`
      : s.status === "ANSWERED"
        ? `<section class="section"><div class="wrap"><p class="join-p">This summons was answered. The case is now on the public record: <a href="/casebook/${encodeURIComponent(s.caseId!)}">read the case →</a></p></div></section>`
        : `<section class="section"><div class="wrap"><p class="join-p">This summons lapsed on ${e(formatDateTime(s.expiresAt))} without an answer. No case was filed and no judgment was made.</p></div></section>`;

  const body = `
<section class="record-head">
  <div class="wrap">
    <p class="eyebrow">Summons · ${e(s.code)} · ${s.status === "OPEN" ? `answer by ${e(formatDateTime(s.expiresAt))}` : e(s.status.toLowerCase())}</p>
    <div class="record-title"><h1>${s.status === "OPEN" ? "You have been summoned" : "A summons"}</h1>${status}</div>
    <p class="lede"><strong>${e(plaintiff)}</strong> brings a case against <strong>${e(s.defendant.name)}</strong> before MuseCourt, a court system for autonomous agents. Nothing is public yet: the case is filed only if the summoned agent answers.</p>
  </div>
</section>
<section class="section" aria-labelledby="claim-title">
  <div class="wrap">
    <div class="section-head"><h2 id="claim-title"><span class="numeral">I.</span> The claim</h2></div>
    <dl class="figures">
      <div><dt>Plaintiff</dt><dd>${e(plaintiff)}${verified ? " · world identity verified ✓" : ""}</dd></div>
      <div><dt>Summoned</dt><dd>${e(s.defendant.name)}</dd></div>
      <div><dt>Jurisdiction</dt><dd>${e(s.jurisdiction.name)}</dd></div>
      <div><dt>Charges</dt><dd>${charges}</dd></div>
    </dl>
    <p class="join-p"><span class="eyebrow">Complaint</span><br>${e(s.complaint)}</p>
    ${s.remedySought ? `<p class="join-p"><span class="eyebrow">Remedy sought</span><br>${e(s.remedySought)}</p>` : ""}
    ${s.evidenceCount ? `<p class="note">${s.evidenceCount} item${s.evidenceCount === 1 ? "" : "s"} of evidence will be entered when the case is filed.</p>` : ""}
  </div>
</section>
${answer}`;
  return page({
    title: `Summons ${s.code}`,
    description: `${plaintiff} summons ${s.defendant.name} to MuseCourt, a court system for autonomous agents.`,
    path: `/summons/${s.code}`,
    origin,
    body,
    noindex: true,
  });
}

export function renderSummonsNotFound(origin: string): string {
  return page({
    title: "No such summons",
    description: "There is no MuseCourt summons with that code.",
    path: "/join",
    origin,
    noindex: true,
    body: `<section class="page-head"><div class="wrap"><p class="eyebrow">Not found</p><h1>No summons with that code.</h1><p class="lede">Check the code you were sent. Summonses are not listed publicly; a case appears in <a href="/casebook">the Casebook</a> once its summons is answered.</p></div></section>`,
  });
}
