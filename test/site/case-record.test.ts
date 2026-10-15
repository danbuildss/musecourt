import { afterAll, describe, expect, it } from "vitest";
import { MuseworldConnector } from "@/connectors/museworld";
import { FakeModel } from "@/model/fake-model";
import { seedJurisdiction } from "@/seed/seed-court";
import type { FakeClock } from "@/testing/fake-clock";
import { CAPTURED_MUSES, CAPTURED_RECORD, ISLAND, fakeIsland } from "../connectors/fake-island";
import { castOfFive, closeSharedPool, startApi, type ApiHarness } from "../api/harness";

afterAll(closeSharedPool);

const EVENT_ID = String(CAPTURED_RECORD.id);
const SECRET_WORDS = "the hidden coordinates are 41.40338, 2.17403";
const XSS = `<script>alert("x")</script>`;

async function museworldCourt() {
  let clock: FakeClock | undefined;
  const island = await fakeIsland(() => clock!.now());
  island.addEvent(CAPTURED_RECORD, { muses: CAPTURED_MUSES, summary: CAPTURED_RECORD.text });
  const h = await startApi({
    connectors: (c) => {
      clock = c;
      return [new MuseworldConnector({ baseUrl: ISLAND, fetch: island.fetch, now: () => c.now() })];
    },
  });
  await seedJurisdiction(h.court, {
    jurisdictionId: "moonwake",
    name: "Moonwake",
    casePrefix: "MW",
    connectorId: "museworld",
  });
  return h;
}
const page = async (h: ApiHarness, caseId: string) => String((await h.get(`/casebook/${caseId}`)).body);

describe("the Case Record (/casebook/:caseId)", () => {
  it("shows world-verified evidence as a numbered exhibit, never the receipt itself", async () => {
    const h = await museworldCourt();
    try {
      const { maple, nova } = await castOfFive(h);
      const filed = await h.fileCase(maple, nova, {
        jurisdictionId: "moonwake",
        evidence: [{ kind: "WORLD_EVENT", eventId: EVENT_ID }],
      });
      const caseId = filed.body.case.caseId;
      const api = (await h.get(`/api/v1/cases/${caseId}`)).body.case;
      const token = api.evidence[0].world.snapshot.proof.token as string;
      const res = await h.get(`/casebook/${caseId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
      const html = String(res.body);
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain("Exhibit 1");
      expect(html).toContain("World-verified ✓");
      expect(html).toContain("verified against the world's signed receipt, key mw-current");
      expect(html).toContain(`https://museworld.lol/v1/events/${EVENT_ID}`);
      expect(html).not.toContain(token);
      expect(html).not.toContain(token.split(".")[2]!);
      expect(html).toContain("No judgment has been entered. The case is in session.");
    } finally {
      await h.close();
    }
  });

  it("never shows removed or withdrawn evidence words, only the court's notice", async () => {
    const h = await museworldCourt();
    try {
      const { maple, nova } = await castOfFive(h);
      const caseId = (
        await h.fileCase(maple, nova, {
          jurisdictionId: "moonwake",
          evidence: [
            { kind: "DOCUMENT", title: "Map", content: SECRET_WORDS },
            { kind: "DOCUMENT", title: "Draft", content: `withdrawn ${SECRET_WORDS}` },
          ],
        })
      ).body.case.caseId;
      const ids = (await h.get(`/api/v1/cases/${caseId}`)).body.case.evidence.map(
        (x: { evidenceId: string }) => x.evidenceId,
      );
      const removed = await h.post(
        `/api/v1/admin/cases/${caseId}/redactions`,
        { target: { kind: "EVIDENCE", evidenceId: ids[0] }, reason: "Personal data." },
        { admin: true },
      );
      expect(removed.status, JSON.stringify(removed.body)).toBe(201);
      const withdrawn = await h.post(
        `/api/v1/cases/${caseId}/actions`,
        { action: "WITHDRAW_EVIDENCE", evidenceId: ids[1], reason: "Superseded." },
        { apiKey: maple.apiKey },
      );
      expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
      const html = await page(h, caseId);
      expect(html).not.toContain(SECRET_WORDS);
      expect(html).toContain("[Removed by MuseCourt: Personal data.]");
      expect(html).toContain("Withdrawn by the submitting side");
    } finally {
      await h.close();
    }
  });

  it("shows agent-written text as written, escaped, never as markup", async () => {
    const h = await startApi();
    try {
      const { maple, nova } = await castOfFive(h);
      const caseId = (await h.fileCase(maple, nova, { complaint: `Line one\n${XSS}`, remedySought: XSS }))
        .body.case.caseId;
      const html = await page(h, caseId);
      expect(html).not.toContain(XSS);
      expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    } finally {
      await h.close();
    }
  });

  it("answers unknown and malformed case ids with a 404 page", async () => {
    const h = await startApi();
    try {
      for (const id of ["case_missing", "%3Cscript%3E", "not-a-case"]) {
        const res = await h.get(`/casebook/${id}`);
        expect(res.status).toBe(404);
        expect(String(res.body)).toContain("No case with that number.");
        expect(String(res.body)).not.toContain("<script>");
      }
    } finally {
      await h.close();
    }
  });

  it("states plainly that a withdrawn case has no judgment", async () => {
    const h = await startApi();
    try {
      const { maple, nova } = await castOfFive(h);
      const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
      await h.post(
        `/api/v1/cases/${caseId}/actions`,
        { action: "WITHDRAW_CASE", reason: "Test over." },
        { apiKey: maple.apiKey },
      );
      const html = await page(h, caseId);
      expect(html).toContain("No judgment was entered: the plaintiff withdrew the case.");
      expect(html).not.toContain("Judgment entered");
    } finally {
      await h.close();
    }
  });

  it("shows Solon's judgment: finding, judge, reasoning, remedies and what it relied on", async () => {
    const model = new FakeModel({
      judgment: (r) => ({
        finding: "LIABLE",
        reasoning: "The record shows the taking.",
        sentence: [{ kind: "RETURN_PROPERTY", description: "Return 5 timber." }],
        citedLawIds: ["property"],
        citedEvidenceIds: r.evidence.slice(0, 1).map((e) => e.evidenceId),
      }),
    });
    const h = await startApi({ model });
    try {
      const { maple, nova } = await castOfFive(h);
      const caseId = (await h.fileCase(maple, nova)).body.case.caseId;
      let view = (await h.get(`/api/v1/cases/${caseId}`)).body.case;
      for (let i = 0; i < 15 && view.status === "OPEN"; i++) {
        h.clock.set(view.stage.deadline);
        await h.cronTick();
        view = (await h.get(`/api/v1/cases/${caseId}`)).body.case;
      }
      expect(view.outcome).toBe("VERDICT");
      const html = await page(h, caseId);
      expect(html).toContain("Judgment entered");
      expect(html).toContain("Found liable");
      expect(html).toContain("By Solon (MuseCourt House Judge)");
      expect(html).toContain("The record shows the taking.");
      expect(html).toContain("Return property");
      expect(html).toMatch(/Art\. 1 Property · Exhibit \d/);
    } finally {
      await h.close();
    }
  });
});
