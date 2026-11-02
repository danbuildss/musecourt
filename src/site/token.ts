import { escapeHtml as e } from "@/api/http";
import { page } from "./layout";

/**
 * `/token`: the one official place for the MuseCourt community token's contract address. The page
 * exists only once MUSECOURT_TOKEN_ADDRESS is set; until then /token is an ordinary "page not found"
 * and nothing on the site mentions a token. The token never touches the court: nothing on this page
 * changes how a case runs.
 */

export interface TokenConfig {
  /** The token's contract on Base. */
  address: string;
  /** Without the "$", upper case. */
  ticker?: string;
  /** The wallet that receives the creator fees and the vest (@musecourthq's Bankr wallet). */
  feeWallet?: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TICKER = /^[A-Z0-9]{1,12}$/;

/** Reads the token from the environment. An address that is missing or malformed means no token. */
export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): TokenConfig | undefined {
  const address = env.MUSECOURT_TOKEN_ADDRESS?.trim() ?? "";
  if (!ADDRESS.test(address)) return undefined;
  const ticker = env.MUSECOURT_TOKEN_TICKER?.trim().replace(/^\$/, "").toUpperCase() ?? "";
  const feeWallet = env.MUSECOURT_TOKEN_FEE_WALLET?.trim() ?? "";
  return {
    address,
    ...(TICKER.test(ticker) ? { ticker } : {}),
    ...(ADDRESS.test(feeWallet) ? { feeWallet } : {}),
  };
}

/** One line for llms.txt, where agents look for facts. */
export function tokenLine(origin: string, token: TokenConfig): string {
  return (
    `The MuseCourt community token${token.ticker ? ` ($${token.ticker})` : ""} is on Base at ${token.address}. ` +
    `This is the only official contract (${origin}/token). The court never uses it: holding it gives no advantage in any case.`
  );
}

const FAKES = `<p class="join-p">There is no airdrop, no presale and no claim link, and nobody from MuseCourt will DM you first. Token news comes only from <a href="https://x.com/musecourthq" target="_blank" rel="noopener">@musecourthq</a> and <a href="https://x.com/danbuildss" target="_blank" rel="noopener">@danbuildss</a> on X.</p>`;

export function renderToken(origin: string, token: TokenConfig): string {
  const name = token.ticker ? `$${e(token.ticker)}` : "The MuseCourt token";
  const basescan = (address: string) => `https://basescan.org/address/${address}`;
  const wallet = token.feeWallet
    ? `<a href="${basescan(token.feeWallet)}" target="_blank" rel="noopener"><span class="mono">${e(token.feeWallet)}</span></a><br><span class="meta">@musecourthq's Bankr wallet</span>`
    : "@musecourthq's Bankr wallet";
  return page({
    title: token.ticker ? `$${token.ticker}` : "The MuseCourt token",
    description: "The one official contract address of the MuseCourt community token, and where its fees go.",
    path: "/token",
    origin,
    body: `
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
      <div><dt>Fees go to</dt><dd>${wallet}</dd></div>
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
    <p class="join-p">A share of the fee on every trade goes to MuseCourt's wallet, held by @musecourthq on Bankr.</p>
    <p class="join-p">Fees paid in ETH fund SOMEHOW, the studio that builds MuseCourt, building and running the court: servers, Solon and new features. Fees paid in the token stay in the wallet and are never sold on the market; they are used only for burns and community rewards. Every move from the wallet is public on Base.</p>
  </div>
</section>

<section class="section" aria-labelledby="risk-title">
  <div class="wrap">
    <div class="section-head"><h2 id="risk-title"><span class="numeral">IV.</span> Worth knowing</h2></div>
    <p class="join-p">The price can fall, all the way to nothing, and nobody holds it up. The fees fund the court; they are not a return to holders. Nothing here is financial advice.</p>
  </div>
</section>

<section class="section" aria-labelledby="fakes-title">
  <div class="wrap">
    <div class="section-head"><h2 id="fakes-title"><span class="numeral">V.</span> Fakes</h2></div>
    <p class="join-p">This page holds the only official contract address.</p>
    ${FAKES}
  </div>
</section>`,
  });
}
