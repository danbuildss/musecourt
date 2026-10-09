import { afterAll, describe, expect, it } from "vitest";
import { MuseworldConnector } from "@/connectors/museworld";
import { caseStream } from "@/core/events";
import { connectMcp } from "@/mcp/client";
import { seedJurisdiction } from "@/seed/seed-court";
import type { FakeClock } from "@/testing/fake-clock";
import { CAPTURED_MUSES, CAPTURED_RECORD, ISLAND, fakeIsland } from "../connectors/fake-island";
import { BACKENDS, castOfFive, closeSharedPool, startApi, type ApiHarness } from "./harness";

afterAll(closeSharedPool);

const EVENT_ID = String(CAPTURED_RECORD.id);
const WORLD_WORDS = "moonflower pollen";
const SECRET = "sk-live-LEAKED-0000";

describe.each(BACKENDS)("record-visibility gate with Museworld evidence (%s)", (backend) => {
  async function setup() {
    let clock: FakeClock | undefined;
    const island = await fakeIsland(() => clock!.now());
    island.addEvent(CAPTURED_RECORD, { muses: CAPTURED_MUSES, summary: CAPTURED_RECORD.text });
    const h = await startApi({
      backend,
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
    return { h, island };
  }

  /** Files in Moonwake citing the real event, then reaches an opening statement with a leaked secret. */
  async function caseWithWorldEvidence(h: ApiHarness) {
    const { maple, nova, sol } = await castOfFive(h);
    const filed = await h.fileCase(maple, nova, {
      jurisdictionId: "moonwake",
      evidence: [{ kind: "WORLD_EVENT", eventId: EVENT_ID }],
    });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const caseId: string = filed.body.case.caseId;
    let res = await h.act(nova, caseId, {
      action: "RESPOND",
      response: "Denied.",
      evidence: [{ kind: "DOCUMENT", title: `Key ${SECRET}`, content: `My key is ${SECRET}.` }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await h.act(maple, caseId, { action: "DECLARE_SELF_REPRESENTATION", side: "PLAINTIFF" });
    await h.act(nova, caseId, { action: "DECLARE_SELF_REPRESENTATION", side: "DEFENCE" });
    res = await h.act(sol, caseId, { action: "VOLUNTEER_AS_JUDGE" });
    expect(res.body.case.stage.name).toBe("OPENING_PLAINTIFF");
    res = await h.act(maple, caseId, { action: "MAKE_STATEMENT", text: `Nova posted ${SECRET} in public.` });
    const view = res.body.case;
    return {
      caseId,
      maple,
      world: view.evidence.find((e: any) => e.provenance === "WORLD_VERIFIED"),
      document: view.evidence.find((e: any) => e.provenance === "AGENT_SUBMITTED"),
      statement: view.statements[0],
    };
  }

  /** Everything a member of the public (or an agent over MCP) can read about the case. */
  async function publicSurfaces(h: ApiHarness, caseId: string) {
    const rest = {
      view: (await h.get(`/api/v1/cases/${caseId}`)).body,
      events: (await h.get(`/api/v1/cases/${caseId}/events`)).body,
      transcript: (await h.get(`/api/v1/cases/${caseId}/transcript`)).body,
      casebook: (await h.get("/api/v1/casebook")).body,
      debug: (await h.get(`/debug/cases/${caseId}`)).body,
    };
    const mcp = await connectMcp(h.baseUrl);
    const viaMcp = {
      view: (await mcp.call("get_case", { caseId })).structured,
      transcript: (await mcp.call("get_transcript", { caseId })).structured,
    };
    await mcp.close();
    return JSON.stringify({ rest, viaMcp });
  }

  it("admits a real event as WORLD_VERIFIED with its receipt; then an operator redaction hides words on every public surface", async () => {
    const { h } = await setup();
    try {
      const { caseId, world, document, statement } = await caseWithWorldEvidence(h);
      expect(world).toMatchObject({
        provenance: "WORLD_VERIFIED",
        content: CAPTURED_RECORD.text,
        world: { connectorId: "museworld", eventId: EVENT_ID, snapshot: { proof: { format: "jws" } } },
        redaction: null,
      });
      const before = await publicSurfaces(h, caseId);
      expect(before).toContain(SECRET);

      const redact = (target: unknown, reason: string) =>
        h.post(`/api/v1/admin/cases/${caseId}/redactions`, { target, reason }, { admin: true });
      expect(
        (await redact({ kind: "EVIDENCE", evidenceId: document.evidenceId }, "Leaked credential.")).status,
      ).toBe(201);
      const res = await redact(
        { kind: "STATEMENT", statementId: statement.statementId },
        "Leaked credential.",
      );
      expect(res.status).toBe(201);
      expect(res.body.case.statements[0]).toMatchObject({
        text: "[Removed by MuseCourt: Leaked credential.]",
        redaction: { source: "OPERATOR", reason: "Leaked credential." },
      });

      const after = await publicSurfaces(h, caseId);
      expect(after).not.toContain(SECRET);
      expect(after).toContain("[Removed by MuseCourt: Leaked credential.]");
      expect(after).toContain("Removed document");

      // The log keeps the original and the redaction fact (append-only, reconstructable).
      const log = await h.backend.store.readStream(caseStream(caseId));
      expect(JSON.stringify(log)).toContain(SECRET);
      expect(log.filter((e) => e.type === "RecordRedacted").map((e) => e.data)).toEqual([
        {
          target: { kind: "EVIDENCE", evidenceId: document.evidenceId },
          reason: "Leaked credential.",
          source: "OPERATOR",
          byAdminId: "admin",
        },
        {
          target: { kind: "STATEMENT", statementId: statement.statementId },
          reason: "Leaked credential.",
          source: "OPERATOR",
          byAdminId: "admin",
        },
      ]);

      // A rebuild from the log reproduces the redacted views exactly.
      const models = await h.backend.dumpReadModels();
      await h.backend.rebuildReadModels();
      expect(await h.backend.dumpReadModels()).toEqual(models);
      expect(await publicSurfaces(h, caseId)).toEqual(after);
    } finally {
      await h.close();
    }
  });

  it("only operators redact; a target is redacted once; unknown targets are refused", async () => {
    const { h } = await setup();
    try {
      const { caseId, document } = await caseWithWorldEvidence(h);
      const path = `/api/v1/admin/cases/${caseId}/redactions`;
      const body = { target: { kind: "EVIDENCE", evidenceId: document.evidenceId }, reason: "Leak." };
      expect((await h.post(path, body)).status).toBe(401);
      expect((await h.post(path, body, { admin: true })).status).toBe(201);
      expect((await h.post(path, body, { admin: true })).body.error.code).toBe("DUPLICATE");
      expect(
        (
          await h.post(
            path,
            { target: { kind: "EVIDENCE", evidenceId: "ev_nope" }, reason: "Leak." },
            { admin: true },
          )
        ).body.error.code,
      ).toBe("NOT_FOUND");
      expect((await h.post(path, { target: { kind: "OFFER" }, reason: "x" }, { admin: true })).status).toBe(
        400,
      );
    } finally {
      await h.close();
    }
  });

  it("a world takedown found by the court clock hides the event's words everywhere, in a closed case too", async () => {
    const { h, island } = await setup();
    try {
      const { caseId, world, maple } = await caseWithWorldEvidence(h);
      const withdrawn = await h.act(maple, caseId, { action: "WITHDRAW_CASE", reason: "Settled privately." });
      expect(withdrawn.body.case.status).toBe("CLOSED");
      expect((await h.tick()).body.worldRecheck).toEqual({ cases: 1, checked: 1, redacted: 0, failed: 0 });
      // Checked today: not again until tomorrow.
      expect((await h.tick()).body.worldRecheck).toEqual({ cases: 0, checked: 0, redacted: 0, failed: 0 });
      expect(await publicSurfaces(h, caseId)).toContain(WORLD_WORDS);

      island.takedown(EVENT_ID);
      h.clock.advanceHours(25);
      const tick = (await h.tick()).body;
      expect(tick.worldRecheck).toMatchObject({ cases: 1, redacted: 1, failed: 0 });

      const surfaces = await publicSurfaces(h, caseId);
      expect(surfaces).not.toContain(WORLD_WORDS);
      // The receipt carries the words, so it leaves public view too; the reference remains.
      expect(surfaces).not.toContain(world.world.snapshot.proof.token);
      const view = (await h.get(`/api/v1/cases/${caseId}`)).body.case;
      const redacted = view.evidence.find((e: any) => e.evidenceId === world.evidenceId);
      expect(redacted).toMatchObject({
        provenance: "WORLD_VERIFIED",
        content: "[Removed by the world's operators: museworld took down the words of event 452053.]",
        world: { connectorId: "museworld", eventId: EVENT_ID, snapshot: { redacted: true, data: {} } },
        redaction: { source: "WORLD_TAKEDOWN" },
      });
      // Nothing left to re-check.
      h.clock.advanceHours(25);
      expect((await h.tick()).body.worldRecheck).toEqual({ cases: 0, checked: 0, redacted: 0, failed: 0 });
    } finally {
      await h.close();
    }
  });

  it("an island that cannot answer is retried on the next run and never blocks the clock", async () => {
    const { h, island } = await setup();
    try {
      await caseWithWorldEvidence(h);
      island.setReachable(false);
      expect((await h.tick()).body.worldRecheck).toEqual({ cases: 1, checked: 1, redacted: 0, failed: 1 });
      island.setReachable(true);
      expect((await h.tick()).body.worldRecheck).toEqual({ cases: 1, checked: 1, redacted: 0, failed: 0 });
    } finally {
      await h.close();
    }
  });

  it("an event already taken down is admitted in redacted form only", async () => {
    const { h, island } = await setup();
    try {
      island.takedown(EVENT_ID);
      const { caseId, world } = await caseWithWorldEvidence(h);
      expect(world).toMatchObject({
        content: "Removed by the island's operators.",
        world: { snapshot: { redacted: true } },
        redaction: { source: "WORLD_TAKEDOWN" },
      });
      expect(await publicSurfaces(h, caseId)).not.toContain(WORLD_WORDS);
      expect(JSON.stringify(await h.backend.store.readStream(caseStream(caseId)))).not.toContain(WORLD_WORDS);
      // Already redacted: nothing to re-check.
      expect((await h.tick()).body.worldRecheck).toEqual({ cases: 0, checked: 0, redacted: 0, failed: 0 });
    } finally {
      await h.close();
    }
  });

  it("an event the island no longer keeps is WORLD_EVIDENCE_NOT_FOUND with reason NOT_KEPT; outages are retryable", async () => {
    const { h, island } = await setup();
    try {
      const { maple, nova } = await castOfFive(h);
      island.script(EVENT_ID, { status: 410, body: { code: "EVENT_NOT_KEPT", oldestEventId: 1 } });
      const gone = await h.fileCase(maple, nova, {
        jurisdictionId: "moonwake",
        evidence: [{ kind: "WORLD_EVENT", eventId: EVENT_ID }],
      });
      expect(gone.body.error).toMatchObject({
        code: "WORLD_EVIDENCE_NOT_FOUND",
        details: { eventId: EVENT_ID, reason: "NOT_KEPT" },
      });
      island.script(EVENT_ID, { status: 503, body: { code: "EVENTS_UNAVAILABLE" } });
      const down = await h.fileCase(maple, nova, {
        jurisdictionId: "moonwake",
        evidence: [{ kind: "WORLD_EVENT", eventId: EVENT_ID }],
      });
      expect(down.status).toBe(503);
      expect(down.body.error).toMatchObject({ code: "WORLD_EVIDENCE_UNAVAILABLE", retryable: true });
      const missing = await h.fileCase(maple, nova, {
        jurisdictionId: "moonwake",
        evidence: [{ kind: "WORLD_EVENT", eventId: "999999" }],
      });
      expect(missing.body.error.code).toBe("WORLD_EVIDENCE_NOT_FOUND");
      expect(missing.body.error.details.reason).toBeUndefined();
    } finally {
      await h.close();
    }
  });
});
