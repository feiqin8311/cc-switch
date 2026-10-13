interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window failure counter kept in memory. Good enough for a single
 * server instance; swap for Redis when running several replicas.
 */
export class FailureLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  isBlocked(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key);
    if (!b) return false;
    if (b.resetAt <= now) {
      this.buckets.delete(key);
      return false;
    }
    return b.count >= this.max;
  }

  recordFailure(key: string, now = Date.now()): void {
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
    } else {
      b.count += 1;
    }
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(now: number): void {
    if (this.buckets.size < 10_000) return;
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k);
    }
  }
}
