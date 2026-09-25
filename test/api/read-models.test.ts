import { afterAll, describe, expect, it } from "vitest";
import { buildCase } from "@/core/case-state";
import { toCaseView } from "@/court/projections/case-view";
import { tasksForCase } from "@/court/projections/tasks";
import { MemoryEventStore } from "@/infra/memory-event-store";
import { event } from "@/core/events";
import { agentActor } from "@/core/actor";
import { BACKENDS, castOfFive, closeSharedPool, startApi, type ApiHarness } from "./harness";

afterAll(closeSharedPool);

/** Runs a mixed workload: one full trial, one settled case, one open case, one timed-out case. */
async function workload(h: ApiHarness) {
  const { maple, nova, apollo, athena, sol } = await castOfFive(h);
  const tried = (
    await h.fileCase(maple, nova, { evidence: [{ kind: "WORLD_EVENT", eventId: "action_72882" }] })
  ).body.case.caseId;
  await h.act(nova, tried, { action: "RESPOND", response: "Denied." });
  await h.act(maple, tried, { action: "REQUEST_COUNSEL", side: "PLAINTIFF", lawyer: "apollo" });
  await h.act(apollo, tried, { action: "ACCEPT_REPRESENTATION", side: "PLAINTIFF" });
  await h.act(nova, tried, { action: "REQUEST_COUNSEL", side: "DEFENCE", lawyer: "athena" });
  await h.act(athena, tried, { action: "ACCEPT_REPRESENTATION", side: "DEFENCE" });
  await h.act(sol, tried, { action: "VOLUNTEER_AS_JUDGE" });
  for (const agent of [apollo, athena, apollo, athena, sol])
    await h.act(agent, tried, { action: "CONCLUDE_STAGE" });
  await h.act(apollo, tried, { action: "MAKE_STATEMENT", text: "Closing." });
  await h.act(athena, tried, { action: "MAKE_STATEMENT", text: "Closing." });
  await h.act(sol, tried, { action: "ISSUE_VERDICT", finding: "NOT_LIABLE", reasoning: "Not proven." });

  const settled = (await h.fileCase(nova, maple)).body.case.caseId;
  const offer = await h.act(maple, settled, { action: "OFFER_SETTLEMENT", terms: "Apology." });
  await h.act(nova, settled, {
    action: "RESPOND_TO_SETTLEMENT",
    offerId: offer.body.case.offers[0].offerId,
    decision: "ACCEPT",
  });

  const open = (await h.fileCase(maple, nova)).body.case.caseId;
  await h.act(maple, open, { action: "REQUEST_COUNSEL", side: "PLAINTIFF", lawyer: null });

  const timedOut = (await h.fileCase(athena, apollo)).body.case.caseId;
  h.clock.advanceHours(48);
  await h.tick();
  return { tried, settled, open, timedOut, agents: { maple, nova, apollo, athena, sol } };
}

describe.each(BACKENDS)("read models (%s)", (backend) => {
  it("rebuilding from the event log reproduces the incrementally maintained read models exactly", async () => {
    const h = await startApi({ backend });
    try {
      await workload(h);
      const incremental = await h.backend.dumpReadModels();
      const rebuilt = await h.post("/api/v1/admin/read-models/rebuild", {}, { admin: true });
      expect(rebuilt.status).toBe(200);
      expect(await h.backend.dumpReadModels()).toEqual(incremental);
    } finally {
      await h.close();
    }
  });

  it("every case view and task list equals a direct replay of the case's events", async () => {
    const h = await startApi({ backend });
    try {
      const { agents } = await workload(h);
      const registry = await h.court.getRegistry();
      for (const state of await h.court.replayAllCases()) {
        const fromApi = (await h.get(`/api/v1/cases/${state.caseId}`)).body.case;
        const replayed = buildCase(await h.court.getCaseEvents(state.caseId))!;
        expect(fromApi).toEqual(JSON.parse(JSON.stringify(toCaseView(replayed, registry))));
      }
      for (const agent of Object.values(agents)) {
        const expected = (await h.court.replayAllCases())
          .flatMap((c) => tasksForCase(agent.agentId, c))
          .sort(
            (a, b) =>
              a.deadline.localeCompare(b.deadline) ||
              a.caseNumber.localeCompare(b.caseNumber) ||
              a.kind.localeCompare(b.kind),
          );
        expect((await h.tasks(agent)).tasks).toEqual(JSON.parse(JSON.stringify(expected)));
      }
    } finally {
      await h.close();
    }
  });

  it("answers the Phase 2 queries: open cases, stage, participants, deadlines, tasks, Casebook", async () => {
    const h = await startApi({ backend });
    try {
      const { tried, settled, open, timedOut, agents } = await workload(h);
      const ids = (res: any) => res.body.cases.map((c: any) => c.caseId).sort();

      expect(ids(await h.get("/api/v1/cases?status=OPEN"))).toEqual([open, timedOut].sort());
      expect(ids(await h.get("/api/v1/cases?status=CLOSED"))).toEqual([settled, tried].sort());
      expect(ids(await h.get("/api/v1/cases?stage=PRE_TRIAL"))).toEqual([open, timedOut].sort());
      expect(ids(await h.get("/api/v1/cases?needs=LAWYER"))).toEqual([open]);
      expect(ids(await h.get("/api/v1/cases?needs=JUDGE"))).toEqual([open, timedOut].sort());
      expect(ids(await h.get("/api/v1/cases?agent=sol"))).toEqual([tried]);
      expect(ids(await h.get("/api/v1/cases?agent=apollo"))).toEqual([timedOut, tried].sort());
      expect(ids(await h.get("/api/v1/cases?limit=1"))).toHaveLength(1);

      const participants = await h.backend.readModels.participants(tried);
      expect(
        participants
          .filter((p) => p.current)
          .map((p) => p.role)
          .sort(),
      ).toEqual(["DEFENCE_COUNSEL", "DEFENDANT", "JUDGE", "PLAINTIFF", "PLAINTIFF_COUNSEL"].sort());
      h.clock.advanceHours(24);
      expect((await h.backend.readModels.dueCaseIds(h.clock.now(), 10)).sort()).toEqual(
        [open, timedOut].sort(),
      );

      const casebook = (await h.get("/api/v1/casebook")).body.casebook;
      expect(casebook.map((e: any) => [e.caseId, e.outcome])).toEqual([
        [settled, "SETTLED"],
        [tried, "VERDICT"],
      ]);
      // Maple's open case already has a pending counsel request, so only Nova must still choose.
      expect((await h.tasks(agents.maple)).tasks).toEqual([]);
      expect((await h.tasks(agents.nova)).tasks.map((t) => [t.caseId, t.kind])).toEqual([
        [open, "ARRANGE_REPRESENTATION"],
      ]);
      expect((await h.get("/api/v1/lawyers")).body.lawyers.map((l: any) => l.handle)).toEqual([
        "apollo",
        "athena",
        "sol",
      ]);
      expect((await h.get("/api/v1/judges")).body.judges.map((l: any) => l.handle)).toEqual(["sol"]);
      const laws = (await h.get("/api/v1/jurisdictions/fake/laws")).body.laws;
      expect(laws.map((l: any) => l.lawId)).toEqual([
        "property",
        "agreements",
        "fraud",
        "interference",
        "court-integrity",
      ]);
    } finally {
      await h.close();
    }
  });
});

describe("projection is atomic with the append", () => {
  it("if projection fails, the events are not recorded", async () => {
    const store = new MemoryEventStore({
      onAppend: async () => {
        throw new Error("projection bug");
      },
    });
    await expect(
      store.append(
        [
          {
            streamId: "s",
            expectedVersion: 0,
            events: [event("CaseDocketed", { caseId: "c", caseNumber: "X-1", sequence: 1 })],
          },
        ],
        {
          actor: agentActor("a"),
          occurredAt: new Date(),
        },
      ),
    ).rejects.toThrow("projection bug");
    expect(await store.readAll()).toEqual([]);
    expect(await store.readStream("s")).toEqual([]);
  });
});
