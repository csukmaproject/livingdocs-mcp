export class RateLimitExceededError extends Error {}

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxRequests) {
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
