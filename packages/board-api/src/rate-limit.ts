/**
 * A token bucket per client: `max` requests per `windowMs`, refilled continuously, so a burst up
 * to `max` is fine but a steady flood is not.
 */
export interface RateLimiter {
  /** Takes one token; says how long to wait when the bucket is empty. */
  take(key: string): { allowed: true } | { allowed: false; retryAfterMs: number };
}

const MAX_BUCKETS = 10_000;

export function createRateLimiter(max: number, windowMs: number): RateLimiter {
  const buckets = new Map<string, { tokens: number; updated: number }>();
  const perMs = max / windowMs;

  return {
    take(key) {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= MAX_BUCKETS) {
          // forget clients that have been quiet long enough for their bucket to be full again
          for (const [name, b] of buckets) if (now - b.updated >= windowMs) buckets.delete(name);
        }
        bucket = { tokens: max, updated: now };
        buckets.set(key, bucket);
      }
      bucket.tokens = Math.min(max, bucket.tokens + (now - bucket.updated) * perMs);
      bucket.updated = now;
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true };
      }
      return { allowed: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / perMs) };
    },
  };
}
