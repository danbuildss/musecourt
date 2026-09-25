import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentActor } from "@/core/actor";
import { event } from "@/core/events";
import { createPostgresBackend } from "@/infra/backends";
import { migrate } from "@/infra/migrate";
import { PostgresEventStore } from "@/infra/postgres-event-store";
import { eventStoreContract } from "./event-store-contract";
import { createTestCourt, driveToDeliberation, fileStandardCase } from "./helpers";

/**
 * Runs only when TEST_DATABASE_URL points at a disposable database (CI sets
 * one up). Each test starts from an empty schema.
 */
const url = process.env.TEST_DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 5 }) : null;

async function resetDatabase() {
  await pool!.query("DROP SCHEMA IF EXISTS musecourt CASCADE");
  await migrate(pool!);
}

describe.skipIf(!pool)("Postgres", () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);
  afterAll(() => pool?.end());

  eventStoreContract("PostgresEventStore", async () => new PostgresEventStore(pool!));

  describe("migrations", () => {
    it("are idempotent and recorded", async () => {
      expect(await migrate(pool!)).toEqual([]);
      const { rows } = await pool!.query("SELECT name FROM musecourt.schema_migrations ORDER BY name");
      expect(rows.map((r) => r.name)).toEqual([
        "0001_event_store.sql",
        "0002_read_models_auth_idempotency.sql",
      ]);
    });

    it("keep MuseCourt out of the public schema", async () => {
      const { rows } = await pool!.query(
        "SELECT table_schema FROM information_schema.tables WHERE table_name = 'court_events'",
      );
      expect(rows).toEqual([{ table_schema: "musecourt" }]);
    });
  });

  describe("append-only enforcement in the database", () => {
    beforeEach(async () => {
      const store = new PostgresEventStore(pool!);
      await store.append(
        [
          {
            streamId: "s",
            expectedVersion: 0,
            events: [event("CaseDocketed", { caseId: "c", caseNumber: "FW-0001", sequence: 1 })],
          },
        ],
        { actor: agentActor("a"), occurredAt: new Date() },
      );
    });

    it("refuses UPDATE", async () => {
      await expect(pool!.query("UPDATE musecourt.court_events SET event_type = 'X'")).rejects.toThrow(
        /append-only/,
      );
    });

    it("refuses DELETE", async () => {
      await expect(pool!.query("DELETE FROM musecourt.court_events")).rejects.toThrow(/append-only/);
    });

    it("refuses TRUNCATE", async () => {
      await expect(pool!.query("TRUNCATE musecourt.court_events")).rejects.toThrow(/append-only/);
    });

    it("refuses a duplicate stream version even from raw SQL", async () => {
      await expect(
        pool!.query(
          `INSERT INTO musecourt.court_events (stream_id, stream_version, event_type, data, actor, occurred_at)
           VALUES ('s', 1, 'X', '{}', '{}', now())`,
        ),
      ).rejects.toThrow(/court_events_stream_version_unique/);
    });
  });

  it("runs a full trial on Postgres and rebuilds identical state from the stored log", async () => {
    const t = await createTestCourt({ backend: createPostgresBackend(pool!) });
    const { caseId } = await fileStandardCase(t);
    await driveToDeliberation(t, caseId);
    const closed = await t.act(caseId, t.agents.sol, {
      type: "IssueVerdict",
      finding: "LIABLE",
      reasoning: "Verified harvest.",
      sentence: [{ kind: "RETURN_PROPERTY", description: "Return 5 timber." }],
      citedLawIds: ["property"],
      citedEvidenceIds: ["ev_1"],
    });
    expect(closed.outcome).toBe("VERDICT");
    expect(closed.evidence[0]!.world!.snapshot.eventId).toBe("action_72882");
    const cases = await t.court.replayAllCases();
    expect(cases).toEqual([closed]);
  });
});
