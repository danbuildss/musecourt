import { describe, expect, it } from "vitest";
import { MUSE_WORDS_NOTE, MuseworldConnector } from "@/connectors/museworld";
import { WorldEventNotKept } from "@/core/ports";
import { CAPTURED_MUSES, CAPTURED_RECORD, ISLAND, fakeIsland } from "./fake-island";

const ID = String(CAPTURED_RECORD.id);

async function setup() {
  const now = new Date("2026-10-09T09:00:00.000Z");
  const island = await fakeIsland(() => now);
  const sleeps: number[] = [];
  const connector = new MuseworldConnector({
    baseUrl: ISLAND,
    fetch: island.fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  island.addEvent(CAPTURED_RECORD, { muses: CAPTURED_MUSES, summary: CAPTURED_RECORD.text });
  return { island, connector, sleeps };
}

describe("MuseworldConnector.getEvent (receipts, offline)", () => {
  it("admits an event whose receipt verifies, built from the signed record, with the receipt kept verbatim", async () => {
    const { connector } = await setup();
    const record = (await connector.getEvent(ID))!;
    expect(record).toMatchObject({
      eventId: ID,
      type: "work",
      occurredAt: new Date(CAPTURED_RECORD.at).toISOString(),
      actorWorldId: CAPTURED_RECORD.actorId,
      summary: CAPTURED_RECORD.text,
      data: {
        world: "moonwake-island",
        island: "moonwake",
        muses: [
          { id: CAPTURED_MUSES[0]!.id, role: "actor" },
          { id: CAPTURED_MUSES[1]!.id, role: "with" },
        ],
        record: CAPTURED_RECORD,
      },
      proof: { format: "jws", keyId: "mw-current" },
    });
    // Names change; ids don't: only ids and roles are kept from the readable form.
    expect(JSON.stringify(record.data.muses)).not.toContain("bob_explorer");
    expect(record.proof!.token.split(".")).toHaveLength(3);
    expect(record.redacted).toBeUndefined();
  });

  it("accepts a receipt signed by a retired key (retired keys still vouch for receipts)", async () => {
    const { island, connector } = await setup();
    const receipt = await island.receiptFor(CAPTURED_RECORD, { key: island.keys.retired });
    island.script(ID, { status: 200, body: { event: {}, record: CAPTURED_RECORD, receipt } });
    expect((await connector.getEvent(ID))!.proof!.keyId).toBe("mw-retired");
  });

  it("refuses a record that does not match its receipt, and receipts for another event, world or island", async () => {
    const { island, connector } = await setup();
    const tampered = { ...CAPTURED_RECORD, text: "Bob stole the moonflower pollen." };
    const cases = [
      { record: tampered, receipt: await island.receiptFor(CAPTURED_RECORD), error: /does not match/ },
      {
        record: CAPTURED_RECORD,
        receipt: await island.receiptFor(CAPTURED_RECORD, { sub: "moonwake-island/events/1" }),
        error: /does not verify/,
      },
      {
        record: CAPTURED_RECORD,
        receipt: await island.receiptFor(CAPTURED_RECORD, {
          world: "other-island",
          sub: `other-island/events/${ID}`,
        }),
        error: /does not verify|different world/,
      },
      {
        record: CAPTURED_RECORD,
        receipt: await island.receiptFor(CAPTURED_RECORD, { island: "elsewhere" }),
        error: /different world/,
      },
      {
        record: CAPTURED_RECORD,
        receipt: await island.receiptFor(CAPTURED_RECORD, { key: island.keys.stranger }),
        error: /does not publish/,
      },
      {
        record: CAPTURED_RECORD,
        receipt: await island.receiptFor(CAPTURED_RECORD, { key: island.keys.stranger, kid: "mw-current" }),
        error: /does not verify/,
      },
      {
        record: CAPTURED_RECORD,
        receipt: await island.receiptFor(CAPTURED_RECORD, { typ: "muse-proof+jwt" }),
        error: /not a Museworld event receipt/,
      },
      { record: CAPTURED_RECORD, receipt: null, error: /without a usable receipt/ },
    ];
    for (const c of cases) {
      island.script(ID, { status: 200, body: { event: {}, record: c.record, receipt: c.receipt } });
      await expect(connector.getEvent(ID)).rejects.toThrow(c.error);
    }
  });

  it("an event already taken down is admitted in its redacted form only", async () => {
    const { island, connector } = await setup();
    island.takedown(ID);
    const record = (await connector.getEvent(ID))!;
    expect(record.redacted).toBe(true);
    expect(record.summary).toBe("Removed by the island's operators.");
    expect(JSON.stringify(record)).not.toContain("moonflower");
  });

  it("marks summaries that may quote a Muse's own words", async () => {
    const { island, connector } = await setup();
    island.addEvent({ ...CAPTURED_RECORD, id: 9001, kind: "notice", text: "Ondine: free timber at noon." });
    expect((await connector.getEvent("9001"))!.summary).toBe(
      `Ondine: free timber at noon. (${MUSE_WORDS_NOTE})`,
    );
  });

  it("maps the island's answers: pending retried once, 404 not found, 410 not kept, 503 and outages unavailable", async () => {
    const { island, connector, sleeps } = await setup();
    const pending = { status: 404, body: { code: "EVENT_PENDING" }, headers: { "retry-after": "2" } };
    island.script(ID, pending);
    expect((await connector.getEvent(ID))!.eventId).toBe(ID);
    expect(sleeps).toEqual([2000]);

    island.script(ID, pending, pending);
    await expect(connector.getEvent(ID)).rejects.toThrow(/still being written/);

    expect(await connector.getEvent("999999")).toBeNull();
    expect(await connector.getEvent("not-an-id")).toBeNull();
    expect(await connector.getEvent("../admin")).toBeNull();

    island.script(ID, { status: 410, body: { code: "EVENT_NOT_KEPT", oldestEventId: 400000 } });
    await expect(connector.getEvent(ID)).rejects.toBeInstanceOf(WorldEventNotKept);

    island.script(ID, { status: 503, body: { code: "EVENTS_UNAVAILABLE" } });
    await expect(connector.getEvent(ID)).rejects.toThrow(/503/);

    island.setReachable(false);
    await expect(connector.getEvent(ID)).rejects.toThrow(/fetch failed/);
  });

  it("re-checks a held receipt for a later takedown with /v1/verify", async () => {
    const { island, connector } = await setup();
    const record = (await connector.getEvent(ID))!;
    expect(await connector.recheckEvent(record)).toEqual({ redacted: false });
    island.takedown(ID);
    expect(await connector.recheckEvent(record)).toEqual({ redacted: true });
    expect(island.verifyCalls).toBe(2);
    // A receipt the island no longer vouches for cannot tell us anything: an error, retried later.
    await expect(
      connector.recheckEvent({ ...record, proof: { ...record.proof!, token: "x.y.z" } }),
    ).rejects.toThrow(/no longer verifies/);
  });
});
