/** Minimal rate-limit hook. Deployment-level limits (CDN/edge) come later; this bounds a single instance. */
export interface RateLimiter {
  /** Records a hit; returns false if the key is over its limit. */
  hit(key: string, now: Date): boolean;
}

export class FixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now: Date): boolean {
    const t = now.getTime();
    const current = this.windows.get(key);
    if (!current || t - current.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 10_000) this.evict(t);
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  private evict(now: number) {
    for (const [key, window] of this.windows)
      if (now - window.start >= this.windowMs) this.windows.delete(key);
  }
}
