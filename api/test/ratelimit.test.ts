import { describe, it, expect } from 'vitest';
import { createLimiter } from '../src/http/middleware/rateLimit.js';

describe('rate limiter', () => {
  it('allows up to max then blocks within the window', () => {
    const limiter = createLimiter(1000, 3);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    const blocked = limiter.check('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('tracks keys independently', () => {
    const limiter = createLimiter(1000, 1);
    expect(limiter.check('x').allowed).toBe(true);
    expect(limiter.check('x').allowed).toBe(false);
    expect(limiter.check('y').allowed).toBe(true); // different key, fresh budget
  });

  it('resets after the window elapses', async () => {
    const limiter = createLimiter(50, 1);
    expect(limiter.check('z').allowed).toBe(true);
    expect(limiter.check('z').allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(limiter.check('z').allowed).toBe(true);
  });
});
