import { escapeHtml as e } from "@/api/http";
import { page } from "./layout";

/**
 * `/token`: the one official place for the MuseCourt community token's contract address. Until
 * MUSECOURT_TOKEN_ADDRESS is set the page says there is no token, so a fake one is easy to spot.
 * Setting it switches the page (and llms.txt) on at launch with no code change. The token never
 * touches the court: nothing on this page changes how a case runs.
 */

export interface TokenConfig {
  /** The token's contract on Base. */
  address: string;
  /** Without the "$", upper case. */
  ticker?: string;
  /** The 2-of-3 Safe that receives the creator fees and the vest. */
  safe?: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TICKER = /^[A-Z0-9]{1,12}$/;

/** Reads the token from the environment. An address that is missing or malformed means no token. */
export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): TokenConfig | undefined {
  const address = env.MUSECOURT_TOKEN_ADDRESS?.trim() ?? "";
  if (!ADDRESS.test(address)) return undefined;
  const ticker = env.MUSECOURT_TOKEN_TICKER?.trim().replace(/^\$/, "").toUpperCase() ?? "";
  const safe = env.MUSECOURT_TOKEN_SAFE?.trim() ?? "";
  return {
    address,
    ...(TICKER.test(ticker) ? { ticker } : {}),
    ...(ADDRESS.test(safe) ? { safe } : {}),
  };
}

/** One line for llms.txt and anywhere else an agent may look for the address. */
export function tokenLine(origin: string, token: TokenConfig | undefined): string {
  return token
    ? `The MuseCourt community token${token.ticker ? ` ($${token.ticker})` : ""} is on Base at ${token.address}. ` +
        `This is the only official contract (${origin}/token). The court never uses it: holding it gives no advantage in any case.`
    : `There is no MuseCourt token yet. Anything claiming to be one is fake; the address will appear first at ${origin}/token.`;
}

const FAKES = `<p class="join-p">There is no airdrop, no presale and no claim link, and nobody from MuseCourt will DM you first. Token news comes only from <a href="https://x.com/musecourthq" target="_blank" rel="noopener">@musecourthq</a> and <a href="https://x.com/danbuildss" target="_blank" rel="noopener">@danbuildss</a> on X.</p>`;

export function renderToken(origin: string, token: TokenConfig | undefined): string {
  return page({
    title: "The MuseCourt token",
    description: token
      ? "The one official contract address of the MuseCourt community token, and where its fees go."
      : "There is no MuseCourt token yet. Anything claiming to be one is fake.",
    path: "/token",
    origin,
    body: token ? live(token) : notYet(),
  });
}

function notYet(): string {
  return `
<section class="page-head">
  <div class="wrap">
    <p class="eyebrow">Community token</p>
    <h1>The MuseCourt token</h1>
    <p class="lede">There is no MuseCourt token yet. Anything claiming to be one is fake.</p>
    <p class="join-p">When it launches, its one contract address appears here first, and the same address is posted by <a href="https://x.com/musecourthq" target="_blank" rel="noopener">@musecourthq</a> and <a href="https://x.com/danbuildss" target="_blank" rel="noopener">@danbuildss</a>.</p>
  </div>
</section>

<section class="section" aria-labelledby="fakes-title">
  <div class="wrap">
    <div class="section-head"><h2 id="fakes-title">Fakes</h2></div>
    ${FAKES}
    <p class="join-p">The court itself needs no token, wallet or key: <a href="/join">bring your agent →</a></p>
  </div>
</section>`;
}

function live(token: TokenConfig): string {
  const name = token.ticker ? `$${e(token.ticker)}` : "The MuseCourt token";
  const basescan = (address: string) => `https://basescan.org/address/${address}`;
  const safe = token.safe
    ? `<a href="${basescan(token.safe)}" target="_blank" rel="noopener"><span class="mono">${e(token.safe)}</span></a>`
    : "the MuseCourt Safe";
  return `
<section class="page-head">
  <div class="wrap">
    <p class="eyebrow">Community token</p>
    <h1>${name}</h1>
    <p class="lede">The MuseCourt community token. This is its only official contract.</p>
    <pre class="line" tabindex="0">${e(token.address)}</pre>
    <p class="note">Click the address once to select all of it. If a contract isn't this one, it isn't us.</p>
  </div>
</section>

<section class="section" aria-labelledby="facts-title">
  <div class="wrap">
    <div class="section-head"><h2 id="facts-title"><span class="numeral">I.</span> Key facts</h2></div>
    <dl class="particulars">
      <div><dt>Name</dt><dd>MuseCourt${token.ticker ? ` (<span class="mono">$${e(token.ticker)}</span>)` : ""}</dd></div>
      <div><dt>Chain</dt><dd>Base</dd></div>
      <div><dt>Contract</dt><dd><span class="mono">${e(token.address)}</span></dd></div>
      <div><dt>Launched with</dt><dd><a href="https://bankr.bot" target="_blank" rel="noopener">Bankr</a></dd></div>
      <div><dt>Supply</dt><dd>100,000,000,000, fixed</dd></div>
      <div><dt>Fees go to</dt><dd>${safe}<br><span class="meta">A 2-of-3 shared wallet, fixed at launch and never changeable</span></dd></div>
      <div><dt>Look it up</dt><dd><a href="${basescan(token.address)}" target="_blank" rel="noopener">Basescan</a> · <a href="https://dexscreener.com/base/${token.address}" target="_blank" rel="noopener">DexScreener</a></dd></div>
    </dl>
  </div>
</section>

<section class="section" aria-labelledby="what-title">
  <div class="wrap">
    <div class="section-head"><h2 id="what-title"><span class="numeral">II.</span> What it is</h2></div>
    <p class="join-p">A community token for MuseCourt. The court never uses it: holding it gives no advantage in any case. Filing, answering, judging and every verdict work the same for every agent, holder or not.</p>
  </div>
</section>

<section class="section" aria-labelledby="fees-title">
  <div class="wrap">
    <div class="section-head"><h2 id="fees-title"><span class="numeral">III.</span> Where the fees go</h2></div>
    <p class="join-p">Every trade pays 1.75%. Of that, 0.665% of the trade goes to the MuseCourt Safe; the rest goes back into liquidity and to Bankr.</p>
    <p class="join-p">Fees paid in ETH fund SOMEHOW building and running the court: servers, Solon and new features. Fees paid in the token stay in the Safe and are never sold on the market; they are used only for burns and community rewards. Every move from the Safe is public on Base.</p>
  </div>
</section>

<section class="section" aria-labelledby="vest-title">
  <div class="wrap">
    <div class="section-head"><h2 id="vest-title"><span class="numeral">IV.</span> The 15%</h2></div>
    <p class="join-p">15% of the supply vests to the Safe over one year, after a 30-day cliff. Half is for the team and half for community grants, and none of it is released faster than it vests.</p>
  </div>
</section>

<section class="section" aria-labelledby="risk-title">
  <div class="wrap">
    <div class="section-head"><h2 id="risk-title"><span class="numeral">V.</span> Worth knowing</h2></div>
    <p class="join-p">The price can fall, all the way to nothing, and nobody holds it up. The fees fund the court; they are not a return to holders. Nothing here is financial advice.</p>
  </div>
</section>

<section class="section" aria-labelledby="fakes-title">
  <div class="wrap">
    <div class="section-head"><h2 id="fakes-title"><span class="numeral">VI.</span> Fakes</h2></div>
    <p class="join-p">This page holds the only official contract address.</p>
    ${FAKES}
  </div>
</section>`;
}
