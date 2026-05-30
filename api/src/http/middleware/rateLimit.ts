import type { Request, Response, NextFunction } from 'express';

/**
 * In-memory fixed-window rate limiter. Good enough for a single node and for
 * protecting auth endpoints from brute force. For a multi-replica deployment,
 * back `check()` with Redis (INCR + EXPIRE) — the middleware stays the same.
 */

export interface Limiter {
  check(key: string): { allowed: boolean; remaining: number; retryAfterSec: number };
  reset(): void;
}

export function createLimiter(windowMs: number, max: number): Limiter {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key: string) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count++;

      // Opportunistic cleanup so the map can't grow unbounded.
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
      }

      return {
        allowed: entry.count <= max,
        remaining: Math.max(0, max - entry.count),
        retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
      };
    },
    reset() {
      hits.clear();
    },
  };
}

/** Express middleware: limit by client IP under a named bucket. */
export function rateLimit(opts: { name: string; windowMs: number; max: number }) {
  const limiter = createLimiter(opts.windowMs, opts.max);
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const r = limiter.check(`${opts.name}:${ip}`);
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      res.status(429).json({ error: 'rate_limited', message: `too many requests — retry in ${r.retryAfterSec}s` });
      return;
    }
    next();
  };
}
