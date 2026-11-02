import { afterAll, describe, expect, it } from "vitest";
import { tokenFromEnv } from "@/site/token";
import { closeSharedPool, startApi } from "../api/harness";
import { withoutThemeScript } from "./helpers";

afterAll(closeSharedPool);

const ADDRESS = "0xdD25fbe2B14bD8A6dfE457Bd52c68a56F320CBa3";
const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("the token page (/token)", () => {
  it("doesn't exist until an address is set: no page, no llms.txt line, no sitemap entry", async () => {
    const h = await startApi({ publicOrigin: "https://musecourt.test" });
    try {
      const res = await h.get("/token");
      expect(res.status).toBe(404);
      expect(String(res.body)).not.toMatch(/0x[0-9a-fA-F]{40}/);
      expect(String((await h.get("/llms.txt")).body)).not.toContain("Token:");
      expect(String((await h.get("/sitemap.xml")).body)).not.toContain("/token");
    } finally {
      await h.close();
    }
  });

  it("shows the one contract, the fee wallet, where fees go and the risks once launched", async () => {
    const h = await startApi({
      publicOrigin: "https://musecourt.test",
      token: { address: ADDRESS, ticker: "MCOURT", feeWallet: WALLET },
    });
    try {
      const res = await h.get("/token");
      expect(res.status).toBe(200);
      const page = String(res.body);
      expect(withoutThemeScript(page)).not.toMatch(/<script/i);
      expect(page).toContain("<h1>$MCOURT</h1>");
      expect(page).toContain(`<pre class="line" tabindex="0">${ADDRESS}</pre>`);
      expect(page).toContain(`https://basescan.org/address/${WALLET}`);
      expect(page).toContain("@musecourthq's Bankr wallet");
      expect(page).toContain("holding it gives no advantage in any case");
      expect(page).toContain("Fees paid in ETH fund SOMEHOW, the studio that builds MuseCourt");
      expect(page).toContain("Nothing here is financial advice.");
      expect(page).toContain("no airdrop, no presale and no claim link");
      expect(String((await h.get("/llms.txt")).body)).toContain(
        `- Token: The MuseCourt community token ($MCOURT) is on Base at ${ADDRESS}. This is the only official contract (https://musecourt.test/token).`,
      );
      expect(String((await h.get("/sitemap.xml")).body)).toContain("https://musecourt.test/token");
    } finally {
      await h.close();
    }
  });
});

describe("tokenFromEnv", () => {
  it("needs a well-formed address; ticker and fee wallet are optional and checked", () => {
    expect(tokenFromEnv({})).toBeUndefined();
    expect(tokenFromEnv({ MUSECOURT_TOKEN_ADDRESS: "0x123" })).toBeUndefined();
    expect(
      tokenFromEnv({
        MUSECOURT_TOKEN_ADDRESS: ` ${ADDRESS} `,
        MUSECOURT_TOKEN_TICKER: "$mcourt",
        MUSECOURT_TOKEN_FEE_WALLET: WALLET,
      }),
    ).toEqual({ address: ADDRESS, ticker: "MCOURT", feeWallet: WALLET });
    expect(
      tokenFromEnv({
        MUSECOURT_TOKEN_ADDRESS: ADDRESS,
        MUSECOURT_TOKEN_TICKER: "not a ticker!",
        MUSECOURT_TOKEN_FEE_WALLET: "x",
      }),
    ).toEqual({ address: ADDRESS });
  });
});
