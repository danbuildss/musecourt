import { afterAll, describe, expect, it } from "vitest";
import { connectMcp } from "@/mcp/client";
import { BACKENDS, castOfFive, closeSharedPool, startApi } from "./harness";

afterAll(closeSharedPool);

describe.each(BACKENDS)("a case by its number (%s)", (backend) => {
  it("every case address takes the number (any case) as well as the ID", async () => {
    const h = await startApi({ backend });
    try {
      const { maple, nova } = await castOfFive(h);
      const filed = (await h.fileCase(maple, nova)).body.case;
      const number = filed.caseNumber as string;
      expect(number).toMatch(/^[A-Z]{2,6}-\d+$/);

      for (const ref of [number, number.toLowerCase()]) {
        const res = await h.get(`/api/v1/cases/${ref}`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.case.caseId).toBe(filed.caseId);
      }
      expect((await h.get(`/api/v1/cases/${number}/events`)).body.events.length).toBeGreaterThan(0);
      expect((await h.get(`/api/v1/cases/${number}/transcript`)).status).toBe(200);

      // An action by number lands on the same case as one by ID.
      const byNumber = await h.act(nova, number, { action: "RESPOND", response: "I deny it." });
      expect(byNumber.status, JSON.stringify(byNumber.body)).toBe(200);
      expect(byNumber.body.case.caseId).toBe(filed.caseId);
      const byId = await h.act(nova, filed.caseId, {
        action: "DECLARE_SELF_REPRESENTATION",
        side: "DEFENCE",
      });
      expect(byId.status, JSON.stringify(byId.body)).toBe(200);

      const missing = await h.get("/api/v1/cases/OC-9999");
      expect(missing.status).toBe(404);
      expect(missing.body.error.message).toBe("Case OC-9999 not found.");
      expect((await h.get("/api/v1/cases/OC-0001x")).body.error.code).toBe("VALIDATION_FAILED");
    } finally {
      await h.close();
    }
  });
});

describe("a case by its number over MCP", () => {
  it("get_case, get_transcript and case actions take the number", async () => {
    const h = await startApi();
    try {
      const { maple, nova } = await castOfFive(h);
      const filed = (await h.fileCase(maple, nova)).body.case;
      const anon = await connectMcp(h.baseUrl);
      const asNova = await connectMcp(h.baseUrl, { apiKey: nova.apiKey });
      try {
        const got = await anon.call("get_case", { caseId: filed.caseNumber });
        expect(got.isError, got.text).toBe(false);
        expect((got.structured as any).case.caseId).toBe(filed.caseId);
        expect((await anon.call("get_transcript", { caseId: filed.caseNumber })).isError).toBe(false);
        const acted = await asNova.call("respond_to_complaint", {
          caseId: filed.caseNumber,
          response: "I deny it.",
        });
        expect(acted.isError, acted.text).toBe(false);
        expect((acted.structured as any).case.caseId).toBe(filed.caseId);
      } finally {
        await anon.close();
        await asNova.close();
      }
    } finally {
      await h.close();
    }
  });
});
