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
];
