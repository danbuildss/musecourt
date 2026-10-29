import { afterAll, describe, expect, it } from "vitest";
import { BACKENDS, castOfFive, closeSharedPool, startApi } from "./harness";

afterAll(closeSharedPool);

describe.each(BACKENDS)("scheduling over the API (%s)", (backend) => {
  it("a judge adjourns over HTTP; the case, the error, the page and the card all say so", async () => {
    const h = await startApi({ backend });
    try {
      const { maple, nova, sol } = await castOfFive(h);
      const caseId: string = (await h.fileCase(maple, nova)).body.case.caseId;
      await h.act(sol, caseId, { action: "VOLUNTEER_AS_JUDGE" });
      await h.act(nova, caseId, { action: "RESPOND", response: "Denied." });
      await h.act(maple, caseId, { action: "DECLARE_SELF_REPRESENTATION", side: "PLAINTIFF" });
      await h.act(nova, caseId, { action: "DECLARE_SELF_REPRESENTATION", side: "DEFENCE" });

      const until = new Date(h.clock.now().getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const adjourned = await h.act(sol, caseId, {
        action: "ADJOURN",
        until,
        reason: "Hearing resumes Monday.",
      });
      expect(adjourned.status, JSON.stringify(adjourned.body)).toBe(200);
      expect(adjourned.body.case.stage).toMatchObject({ name: "OPENING_PLAINTIFF", adjournedUntil: until });
      expect(adjourned.body.case.adjournment).toMatchObject({ until, reason: "Hearing resumes Monday." });

      const early = await h.act(maple, caseId, { action: "MAKE_STATEMENT", text: "Opening." });
      expect(early.status).toBe(409);
      expect(early.body.error).toMatchObject({ code: "ADJOURNED", details: { until } });

      const bad = await h.act(sol, caseId, { action: "ADJOURN", until: "tomorrow", reason: "x" });
      expect(bad.status).toBe(400);

      const page = String((await h.get(`/casebook/${caseId}`)).body);
      expect(page).toContain("<strong>adjourned</strong>");
      expect(page).toContain("The hearing resumes");
      expect(page).toContain(": ADJOURNED"); // the share card's alt text

      const order = await h.act(sol, caseId, {
        action: "ORDER_EVIDENCE",
        side: "DEFENCE",
        request: "The permit.",
        dueBy: until,
      });
      const orderId = order.body.case.evidenceOrders[0].orderId;
      const tasks = await h.tasks(nova);
      expect(tasks.tasks.map((t: any) => t.kind)).toEqual(["PROVIDE_ORDERED_EVIDENCE"]);
      const answered = await h.act(nova, caseId, {
        action: "SUBMIT_EVIDENCE",
        orderId,
        evidence: { kind: "DOCUMENT", title: "Permit", content: "Maple said yes." },
      });
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      expect(answered.body.case.evidenceOrders[0].answeredBy).toBeTruthy();
    } finally {
      await h.close();
    }
  });
});
