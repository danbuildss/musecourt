import { afterAll, describe, expect, it } from "vitest";
import { tokenFromEnv } from "@/site/token";
import { closeSharedPool, startApi } from "../api/harness";
import { withoutThemeScript } from "./helpers";

afterAll(closeSharedPool);

const ADDRESS = "0x1234567890abcdef1234567890ABCDEF12345678";
const SAFE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("the token page (/token)", () => {
  it("says there is no token yet until an address is set, everywhere an agent or person looks", async () => {
    const h = await startApi();
    try {
      const res = await h.get("/token");
      expect(res.status).toBe(200);
      const page = String(res.body);
      expect(withoutThemeScript(page)).not.toMatch(/<script/i);
      expect(page).toContain("There is no MuseCourt token yet. Anything claiming to be one is fake.");
      expect(page).not.toMatch(/0x[0-9a-fA-F]{40}/);
      expect(String((await h.get("/llms.txt")).body)).toContain(
        "- Token: There is no MuseCourt token yet. Anything claiming to be one is fake; the address will appear first at https://musecourt.test/token.",
      );
      expect(String((await h.get("/sitemap.xml")).body)).toContain("https://musecourt.test/token");
    } finally {
      await h.close();
    }
  });

  it("shows the one contract, the Safe, where fees go and the risks once launched", async () => {
    const h = await startApi({ token: { address: ADDRESS, ticker: "COURT", safe: SAFE } });
    try {
      const page = String((await h.get("/token")).body);
      expect(page).toContain("<h1>$COURT</h1>");
      expect(page).toContain(`<pre class="line" tabindex="0">${ADDRESS}</pre>`);
      expect(page).toContain(`https://basescan.org/address/${SAFE}`);
      expect(page).toContain(`https://dexscreener.com/base/${ADDRESS}`);
      expect(page).toContain("holding it gives no advantage in any case");
      expect(page).toContain("are never sold on the market");
      expect(page).toContain("15% of the supply vests to the Safe over one year, after a 30-day cliff.");
      expect(page).toContain("The price can fall, all the way to nothing");
      expect(page).not.toContain("There is no MuseCourt token yet");
      expect(String((await h.get("/llms.txt")).body)).toContain(
        `- Token: The MuseCourt community token ($COURT) is on Base at ${ADDRESS}. This is the only official contract (https://musecourt.test/token).`,
      );
    } finally {
      await h.close();
    }
  });

  it("is reached from /t and from every page's footer", async () => {
    const h = await startApi();
    try {
      const short = await fetch(`${h.baseUrl}/t`, { redirect: "manual" });
      expect(short.status).toBe(302);
      expect(short.headers.get("location")).toBe("/token");
      expect(String((await h.get("/")).body)).toContain('<a href="/token">musecourt.xyz/token</a>');
    } finally {
      await h.close();
    }
  });
});

describe("tokenFromEnv", () => {
  it("needs a well-formed address, and tidies the ticker", () => {
    expect(tokenFromEnv({})).toBeUndefined();
    expect(tokenFromEnv({ MUSECOURT_TOKEN_ADDRESS: "0x123" })).toBeUndefined();
    expect(
      tokenFromEnv({
        MUSECOURT_TOKEN_ADDRESS: ` ${ADDRESS} `,
        MUSECOURT_TOKEN_TICKER: "$court",
        MUSECOURT_TOKEN_SAFE: SAFE,
      }),
    ).toEqual({ address: ADDRESS, ticker: "COURT", safe: SAFE });
    expect(
      tokenFromEnv({
        MUSECOURT_TOKEN_ADDRESS: ADDRESS,
        MUSECOURT_TOKEN_TICKER: "<b>",
        MUSECOURT_TOKEN_SAFE: "x",
      }),
    ).toEqual({ address: ADDRESS });
  });
});
