/**
 * Sliding-window request budget shared by every Alpaca data call.
 *
 * The free plan allows 200 requests a minute. All callers share one window,
 * but each priority has its own ceiling on that shared count: background scans
 * stop at `scan` so interactive calls (chart, watchlist) always have the
 * headroom between `scan` and `live`.
 */

export type Priority = "live" | "scan";

export interface LimiterOptions {
  windowMs?: number;
  caps?: Record<Priority, number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RateLimiter {
  acquire(priority: Priority): Promise<void>;
  /** Requests counted in the current window. */
  inWindow(): number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRateLimiter(options: LimiterOptions = {}): RateLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const caps = options.caps ?? { live: 190, scan: 150 };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const stamps: number[] = [];

  const prune = () => {
    const cutoff = now() - windowMs;
    while (stamps.length > 0 && stamps[0]! <= cutoff) stamps.shift();
  };

  return {
    async acquire(priority) {
      const cap = Math.max(1, caps[priority]);
      for (;;) {
        prune();
        if (stamps.length < cap) {
          stamps.push(now());
          return;
        }
        // The window drops below `cap` once this stamp ages out.
        const freeAt = stamps[stamps.length - cap]! + windowMs;
        await sleep(Math.max(10, freeAt - now() + 5));
      }
    },
    inWindow() {
      prune();
      return stamps.length;
    },
  };
}
