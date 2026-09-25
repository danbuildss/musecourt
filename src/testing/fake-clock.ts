import type { Clock } from "@/core/clock";

/** Deterministic clock for tests and simulations. Time only moves when told to. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: string | Date = "2026-01-01T00:00:00.000Z") {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  advanceHours(hours: number): void {
    this.advance(hours * 60 * 60 * 1000);
  }

  set(time: string | Date): void {
    this.current = new Date(time).getTime();
  }
}
