import { afterAll, describe, expect, it } from "vitest";
import { cardStamp, cardVersion, caseCardData, renderCaseCard, type CaseCardData } from "@/site/case-card";
import type { PublicCaseRecord } from "@/site/public-data";
import { castOfFive, closeSharedPool, startApi } from "../api/harness";

afterAll(closeSharedPool);

const base: CaseCardData = {
  caseNumber: "OC-0001",
  title: "Maple v. Nova",
  jurisdiction: "Open Court",
  charges: [{ article: 2, title: "Agreements" }],
  status: "OPEN",
  stage: "AWAITING_RESPONSE",
  outcome: null,
  finding: null,
  filedAt: "2026-10-28T10:00:00.000Z",
  closedAt: null,
  presiding: null,
  shortLink: "musecourt.xyz/c/OC-0001",
};

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("a case's share card", () => {
  it("stamps every state a case can be in", () => {
    expect(cardStamp(base)).toEqual({ main: "FILED", sub: "AWAITING ANSWER" });
    expect(cardStamp({ ...base, stage: "OPENING_PLAINTIFF" })).toEqual({
      main: "IN SESSION",
      sub: "OPENING STATEMENT: PLAINTIFF",
    });
    const closed = { ...base, status: "CLOSED" as const, stage: null };
    expect(cardStamp({ ...closed, outcome: "VERDICT", finding: "LIABLE" }).main).toBe("JUDGMENT: LIABLE");
    expect(cardStamp({ ...closed, outcome: "VERDICT", finding: "NOT_LIABLE" }).main).toBe(
      "JUDGMENT: NOT LIABLE",
    );
    expect(cardStamp({ ...closed, outcome: "DEFAULT_JUDGMENT" }).main).toBe("DEFAULT JUDGMENT");
    for (const outcome of ["SETTLED", "WITHDRAWN", "DISMISSED"])
      expect(cardStamp({ ...closed, outcome }).main).toBe(outcome);
  });

  it("changes its link version when the case moves on", () => {
    expect(cardVersion(base)).toBe("awaiting-response");
    expect(cardVersion({ ...base, stage: "PRE_TRIAL" })).toBe("pre-trial");
    expect(cardVersion({ status: "CLOSED", stage: null, outcome: "VERDICT" })).toBe("verdict");
  });

  it("names the finding but never the sentence", () => {
    const record = {
      caseId: "case_x",
      caseNumber: "MW-0002",
      title: "Bailiff v. Clerk",
      jurisdiction: "Moonwake (Museworld)",
      status: "CLOSED",
      outcome: "VERDICT",
      filedAt: base.filedAt,
      closedAt: "2026-10-29T10:00:00.000Z",
      stage: null,
      judge: "Solon (MuseCourt House Judge)",
      charges: [{ lawId: "agreements", article: 2, title: "Agreements", version: 1, text: "…" }],
      verdict: {
        kind: "VERDICT",
        finding: "LIABLE",
        judge: "Solon (MuseCourt House Judge)",
        at: "2026-10-29T10:00:00.000Z",
        reasoning: "…",
        sentence: [{ kind: "TRANSFER_RESOURCES", description: "Transfer 1 timber to the plaintiff" }],
        citedLaws: [],
        citedEvidenceIds: [],
      },
    } as unknown as PublicCaseRecord;
    const card = caseCardData(record, "https://www.musecourt.xyz");
    expect(card.presiding).toBe("Solon presiding");
    expect(card.shortLink).toBe("musecourt.xyz/c/MW-0002");
    expect(cardStamp(card).main).toBe("JUDGMENT: LIABLE");
    expect(JSON.stringify(card)).not.toMatch(/timber|TRANSFER/);
  });

  it("draws a 1200×630 PNG", async () => {
    const png = await renderCaseCard({
      ...base,
      title: "A very long case title that has to shrink to fit the card",
    });
    expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
  });
});

describe("short links and share images", () => {
  it("sends /c/<number> to the case, in any case, serves its card, and 404s an unknown number", async () => {
    const h = await startApi();
    try {
      const { maple, nova } = await castOfFive(h);
      const filed = (await h.fileCase(maple, nova)).body.case;
      const number: string = filed.caseNumber;

      for (const ref of [number, number.toLowerCase()]) {
        const res = await fetch(`${h.baseUrl}/c/${ref}`, { redirect: "manual" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(`/casebook/${filed.caseId}`);
      }

      const card = await fetch(`${h.baseUrl}/c/${number}.png`);
      expect(card.status).toBe(200);
      expect(card.headers.get("content-type")).toBe("image/png");
      expect(pngSize(new Uint8Array(await card.arrayBuffer()))).toEqual({ width: 1200, height: 630 });

      expect((await h.get("/c/FW-9999")).status).toBe(404);
      expect((await fetch(`${h.baseUrl}/c/FW-9999.png`)).status).toBe(404);
      expect((await h.get("/c/not-a-number")).status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("gives the case page its own card, whose link changes when the stage changes", async () => {
    const h = await startApi();
    try {
      const { maple, nova } = await castOfFive(h);
      const filed = (await h.fileCase(maple, nova)).body.case;
      const page = async () => String((await h.get(`/casebook/${filed.caseId}`)).body);

      const before = await page();
      const image = `https://musecourt.test/c/${filed.caseNumber}.png?v=awaiting-response`;
      expect(before).toContain(`<meta property="og:image" content="${image}">`);
      expect(before).toContain(`<meta name="twitter:image" content="${image}">`);
      expect(before).toContain(
        `Share: <a href="/c/${filed.caseNumber}">musecourt.test/c/${filed.caseNumber}</a>`,
      );

      await h.act(nova, filed.caseId, { action: "RESPOND", response: "I deny it." });
      expect(await page()).not.toContain("?v=awaiting-response");

      expect(String((await h.get("/")).body)).toContain(
        '<meta property="og:image" content="https://musecourt.test/og.png">',
      );
    } finally {
      await h.close();
    }
  });
});
