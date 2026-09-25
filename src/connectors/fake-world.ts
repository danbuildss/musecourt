import type { WorldEventRecord } from "@/core/events";
import type { WorldConnector } from "@/core/ports";

/**
 * An in-memory world for development, tests and agent simulations. It stands
 * in for Museworld until the real connector exists (Phase 6).
 */
export class FakeWorld implements WorldConnector {
  private readonly events = new Map<string, WorldEventRecord>();
  /** When true, every call fails as if the world were unreachable. */
  offline = false;

  constructor(
    readonly id = "fake-world",
    events: WorldEventRecord[] = FAKE_WORLD_EVENTS,
  ) {
    for (const e of events) this.events.set(e.eventId, e);
  }

  addEvent(record: WorldEventRecord): void {
    this.events.set(record.eventId, record);
  }

  async getEvent(eventId: string): Promise<WorldEventRecord | null> {
    if (this.offline) throw new Error(`${this.id} is offline`);
    const found = this.events.get(eventId);
    return found ? structuredClone(found) : null;
  }
}

/** The canonical demo dispute: Nova harvests timber from Maple's plot. */
export const FAKE_WORLD_EVENTS: WorldEventRecord[] = [
  {
    eventId: "action_72882",
    type: "harvest",
    occurredAt: "2025-12-30T14:02:11.000Z",
    actorWorldId: "nova",
    summary: "Nova harvested 5 timber from plot 17 (owned by Maple).",
    data: { resource: "timber", quantity: 5, plot: 17, plotOwner: "maple" },
  },
  {
    eventId: "action_72901",
    type: "enter_plot",
    occurredAt: "2025-12-30T13:58:40.000Z",
    actorWorldId: "nova",
    summary: "Nova entered plot 17 (owned by Maple).",
    data: { plot: 17, plotOwner: "maple" },
  },
  {
    eventId: "note_5521",
    type: "note",
    occurredAt: "2025-12-29T09:15:00.000Z",
    actorWorldId: "maple",
    summary: "Maple to Nova: 'Please don't take anything from my plot while I'm away.'",
    data: { from: "maple", to: "nova" },
  },
  // Trial 2 — an unkept agreement
  {
    eventId: "note_6101",
    type: "note",
    occurredAt: "2025-12-20T10:00:00.000Z",
    actorWorldId: "athena",
    summary:
      "Athena to Nova: 'Deal: send me 5 timber now and I will deliver 3 stone blocks to your plot by day 5.'",
    data: { from: "athena", to: "nova" },
  },
  {
    eventId: "note_6102",
    type: "note",
    occurredAt: "2025-12-20T10:05:00.000Z",
    actorWorldId: "nova",
    summary: "Nova to Athena: 'Agreed. Sending the timber now.'",
    data: { from: "nova", to: "athena" },
  },
  {
    eventId: "transfer_6103",
    type: "transfer",
    occurredAt: "2025-12-20T10:06:00.000Z",
    actorWorldId: "nova",
    summary: "Nova gave 5 timber to Athena.",
    data: { resource: "timber", quantity: 5, from: "nova", to: "athena" },
  },
  {
    eventId: "inventory_6104",
    type: "inventory_snapshot",
    occurredAt: "2025-12-26T00:00:00.000Z",
    actorWorldId: null,
    summary: "Day 6 inventory check: no stone was ever delivered from Athena to Nova's plot.",
    data: { plot: "nova", stoneReceivedFromAthena: 0 },
  },
  // Trial 3 — a misrepresented sale
  {
    eventId: "listing_7201",
    type: "market_listing",
    occurredAt: "2025-12-10T09:00:00.000Z",
    actorWorldId: "maple",
    summary: "Maple listed 'genuine moonstone, rare' for 10 timber.",
    data: { seller: "maple", item: "moonstone", price: { timber: 10 } },
  },
  {
    eventId: "trade_7202",
    type: "trade",
    occurredAt: "2025-12-10T09:30:00.000Z",
    actorWorldId: "sol",
    summary: "Sol paid 10 timber to Maple and received the listed item.",
    data: { buyer: "sol", seller: "maple", paid: { timber: 10 } },
  },
  {
    eventId: "appraisal_7203",
    type: "appraisal",
    occurredAt: "2025-12-11T12:00:00.000Z",
    actorWorldId: null,
    summary: "World appraisal: the item Sol received from Maple is ordinary river stone, not moonstone.",
    data: { item: "river_stone", claimed: "moonstone" },
  },
  {
    eventId: "note_7204",
    type: "note",
    occurredAt: "2025-12-09T18:00:00.000Z",
    actorWorldId: "maple",
    summary: "Maple to Bob: 'I painted some river stones silver. Nobody will know the difference.'",
    data: { from: "maple", to: "bob" },
  },
];
