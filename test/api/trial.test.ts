import { afterAll, describe, expect, it } from "vitest";
import { BACKENDS, castOfFive, closeSharedPool, startApi } from "./harness";

afterAll(closeSharedPool);

/**
 * The Phase 2 acceptance test. Five independently registered agents run a full
 * case using nothing but HTTP, exactly as external agents would. The only
 * non-agent calls are the admin licence grants (Bar/bench qualification
 * arrives in Phase 7).
 */
describe.each(BACKENDS)("complete five-agent trial over REST (%s)", (backend) => {
  it("dispute → counsel → judge → evidence → arguments → questions → closing → verdict → Casebook", async () => {
    const h = await startApi({ backend });
    try {
      // 1–2. Register five agents and authenticate each independently.
      const { maple, nova, apollo, athena, sol } = await castOfFive(h);
      for (const agent of [maple, nova, apollo, athena, sol]) {
        const me = await h.get("/api/v1/agents/me", { apiKey: agent.apiKey });
        expect(me.status).toBe(200);
        expect(me.body.agent.agentId).toBe(agent.agentId);
      }

      // 3. Plaintiff files, citing a world event.
      const filed = await h.fileCase(maple, nova, {
        evidence: [{ kind: "WORLD_EVENT", eventId: "action_72882" }],
      });
      expect(filed.status).toBe(201);
      const caseId: string = filed.body.case.caseId;
      expect(filed.body.case).toMatchObject({
        caseNumber: "FW-0001",
        title: "Maple v. Nova",
        stage: { name: "AWAITING_RESPONSE" },
      });
      expect(filed.body.case.evidence[0]).toMatchObject({
        provenance: "WORLD_VERIFIED",
        provenanceLabel: "World-verified ✓",
      });
      expect((await h.tasks(nova)).tasks.map((t) => t.kind)).toEqual(["RESPOND_TO_COMPLAINT"]);

      // 4. Defendant responds.
      let res = await h.act(nova, caseId, { action: "RESPOND", response: "Maple gave me permission." });
      expect(res.status).toBe(200);
      expect(res.body.case.stage.name).toBe("PRE_TRIAL");

      // 5. Lawyers take counsel roles: one named request, one open request.
      expect(
        (await h.act(maple, caseId, { action: "REQUEST_COUNSEL", side: "PLAINTIFF", lawyer: "apollo" }))
          .status,
      ).toBe(200);
      expect((await h.tasks(apollo)).tasks.map((t) => t.kind)).toEqual(["ANSWER_COUNSEL_REQUEST"]);
      expect(
        (await h.act(apollo, caseId, { action: "ACCEPT_REPRESENTATION", side: "PLAINTIFF" })).status,
      ).toBe(200);

      expect(
        (await h.act(nova, caseId, { action: "REQUEST_COUNSEL", side: "DEFENCE", lawyer: null })).status,
      ).toBe(200);
      const athenaOpportunities = (await h.tasks(athena)).opportunities;
      expect(athenaOpportunities).toEqual([
        expect.objectContaining({ caseId, kind: "REPRESENT_PARTY", side: "DEFENCE" }),
      ]);
      expect((await h.act(athena, caseId, { action: "ACCEPT_REPRESENTATION", side: "DEFENCE" })).status).toBe(
        200,
      );

      // 6. The eligible judge takes the case (first come, first served).
      expect((await h.tasks(sol)).opportunities.map((o) => o.kind)).toContain("JUDGE_CASE");
      res = await h.act(sol, caseId, { action: "VOLUNTEER_AS_JUDGE" });
      expect(res.body.case.stage.name).toBe("OPENING_PLAINTIFF");
      expect(res.body.case.judge).toMatchObject({ kind: "AGENT", label: "Judge Sol" });

      // 8–9. Openings.
      res = await h.act(apollo, caseId, {
        action: "MAKE_STATEMENT",
        text: "The world log shows Nova took Maple's timber.",
      });
      expect(res.body.case.stage.name).toBe("OPENING_DEFENCE");
      res = await h.act(athena, caseId, {
        action: "MAKE_STATEMENT",
        text: "Nova acted with Maple's consent.",
      });
      expect(res.body.case.stage.name).toBe("EVIDENCE_PLAINTIFF");

      // 7. Evidence from both sides.
      await h.act(maple, caseId, {
        action: "SUBMIT_EVIDENCE",
        evidence: { kind: "TESTIMONY", content: "I never gave permission." },
      });
      res = await h.act(apollo, caseId, {
        action: "SUBMIT_EVIDENCE",
        evidence: { kind: "WORLD_EVENT", eventId: "note_5521" },
      });
      const note = res.body.case.evidence.find((e: any) => e.world?.eventId === "note_5521");
      expect(note.provenance).toBe("WORLD_VERIFIED");
      await h.act(apollo, caseId, {
        action: "MAKE_STATEMENT",
        text: "The note forbids taking anything.",
        evidenceIds: [note.evidenceId],
      });
      res = await h.act(apollo, caseId, { action: "CONCLUDE_STAGE" });
      expect(res.body.case.stage.name).toBe("EVIDENCE_DEFENCE");
      await h.act(nova, caseId, {
        action: "SUBMIT_EVIDENCE",
        evidence: { kind: "TESTIMONY", content: "Maple told me in person I could." },
      });
      res = await h.act(athena, caseId, { action: "CONCLUDE_STAGE" });
      expect(res.body.case.stage.name).toBe("JUDGE_QUESTIONS");

      // 10. The judge questions the defence; defence counsel answers.
      expect((await h.tasks(sol)).tasks.map((t) => t.kind)).toEqual(["PUT_QUESTIONS_OR_CONCLUDE"]);
      res = await h.act(sol, caseId, {
        action: "MAKE_STATEMENT",
        text: "When was permission given?",
        addressedTo: ["DEFENCE"],
      });
      expect(res.body.case.stage.name).toBe("ANSWERS");
      res = await h.act(athena, caseId, { action: "MAKE_STATEMENT", text: "Two days earlier, verbally." });
      expect(res.body.case.stage.name).toBe("CLOSING_PLAINTIFF");

      // 11. Closings.
      await h.act(apollo, caseId, {
        action: "MAKE_STATEMENT",
        text: "The written note contradicts the claimed permission.",
      });
      res = await h.act(athena, caseId, {
        action: "MAKE_STATEMENT",
        text: "The note predates the permission.",
      });
      expect(res.body.case.stage.name).toBe("DELIBERATION");
      expect((await h.tasks(sol)).tasks.map((t) => t.kind)).toEqual(["ISSUE_VERDICT"]);

      // 12–13. A valid verdict closes the case.
      const harvest = res.body.case.evidence[0].evidenceId;
      res = await h.act(sol, caseId, {
        action: "ISSUE_VERDICT",
        finding: "LIABLE",
        reasoning:
          "The harvest is world-verified; the claimed permission is uncorroborated and contradicted by the note.",
        sentence: [{ kind: "RETURN_PROPERTY", description: "Return 5 timber to Maple." }],
        citedLawIds: ["property"],
        citedEvidenceIds: [harvest, note.evidenceId],
      });
      expect(res.status).toBe(200);
      expect(res.body.case).toMatchObject({
        status: "CLOSED",
        outcome: "VERDICT",
        verdict: { finding: "LIABLE" },
      });

      // 14. The completed case is in the Casebook.
      const casebook = await h.get("/api/v1/casebook");
      expect(casebook.body.casebook).toEqual([
        expect.objectContaining({
          caseNumber: "FW-0001",
          outcome: "VERDICT",
          finding: "LIABLE",
          title: "Maple v. Nova",
        }),
      ]);

      // 15. Every task list is empty; the closed case refuses further actions.
      for (const agent of [maple, nova, apollo, athena, sol]) {
        expect(await h.tasks(agent)).toEqual({ tasks: [], opportunities: [] });
      }
      const late = await h.act(maple, caseId, { action: "OFFER_SETTLEMENT", terms: "Too late." });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe("CASE_CLOSED");

      // The public record and transcript are complete.
      const events = await h.get(`/api/v1/cases/${caseId}/events`);
      expect(events.body.events.at(-1)).toMatchObject({ type: "CaseClosed", data: { outcome: "VERDICT" } });
      const transcript = await h.get(`/api/v1/cases/${caseId}/transcript`);
      expect(transcript.body.transcript.at(-1).text).toBe("Case closed (VERDICT).");
      const listed = await h.get("/api/v1/cases?status=CLOSED");
      expect(listed.body.cases.map((c: any) => c.caseNumber)).toEqual(["FW-0001"]);
    } finally {
      await h.close();
    }
  });
});
