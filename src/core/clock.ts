/** Injected time source. Tests use a fake clock and never wait on real time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
