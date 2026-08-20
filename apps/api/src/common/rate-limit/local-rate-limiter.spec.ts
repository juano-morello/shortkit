import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_AUTH_LIMITER_SWEEP_MS } from '../../auth/auth-rate-limit';
import { logger } from '../../observability/logger';
import { LocalRateLimiter } from './local-rate-limiter';
import {
  LOCAL_LIMITER_MAX_PUBLIC_IPS,
  PUBLIC_IP_LIMIT,
  PUBLIC_IP_WINDOW_S,
  RATE_LIMIT_MAX_WRITES,
  RATE_LIMIT_WINDOW_S,
} from './rate-limit.types';

/**
 * TASK-1b-07, wave 1 of item 1b. The process-local `@Public()` IP bucket.
 *
 * Contract: `docs/contracts/rate-limit.md` ("Limits", "Scope", "Behaviour when Redis is
 * unavailable": two maps, two key spaces, F-028's three rules on the IP map). ADR-0012.
 */

/** Runs `checkPublicIp` `n` times for one address and reports how many were admitted. */
async function admittedOf(limiter: LocalRateLimiter, ip: string, n: number): Promise<number> {
  let admitted = 0;
  for (let i = 0; i < n; i += 1) {
    if ((await limiter.checkPublicIp(ip)).allowed) {
      admitted += 1;
    }
  }
  return admitted;
}

let limiter: LocalRateLimiter;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  limiter = new LocalRateLimiter();
});

afterEach(() => {
  limiter.onModuleDestroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the constants', () => {
  it('rate-limit.md: the @Public() bucket is 30 per 60 s, the tenant bucket 120 per 60 s is declared for TASK-051, the IP map is capped at 10 000', () => {
    expect({ PUBLIC_IP_LIMIT, PUBLIC_IP_WINDOW_S, RATE_LIMIT_MAX_WRITES, RATE_LIMIT_WINDOW_S, LOCAL_LIMITER_MAX_PUBLIC_IPS }).toEqual({
      PUBLIC_IP_LIMIT: 30,
      PUBLIC_IP_WINDOW_S: 60,
      RATE_LIMIT_MAX_WRITES: 120,
      RATE_LIMIT_WINDOW_S: 60,
      LOCAL_LIMITER_MAX_PUBLIC_IPS: 10_000,
    });
  });
});

describe('LocalRateLimiter.checkPublicIp', () => {
  it('admits exactly the limit inside one window and refuses the next with a Retry-After of at least 1', async () => {
    const admitted = await admittedOf(limiter, '203.0.113.7', PUBLIC_IP_LIMIT);
    const refused = await limiter.checkPublicIp('203.0.113.7');

    expect({ admitted, refused }).toEqual({
      admitted: PUBLIC_IP_LIMIT,
      refused: { allowed: false, retryAfterSeconds: expect.any(Number) },
    });
    if (!refused.allowed) {
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(PUBLIC_IP_WINDOW_S);
      expect(Number.isInteger(refused.retryAfterSeconds)).toBe(true);
    }
  });

  it('addresses are independent: one exhausted address does not touch another', async () => {
    await admittedOf(limiter, '203.0.113.7', PUBLIC_IP_LIMIT + 1);

    expect(await limiter.checkPublicIp('203.0.113.8')).toEqual({ allowed: true });
  });

  it('a fixed window aligned to the epoch: once the window elapses the address is admitted again', async () => {
    // The window is epoch-aligned, so the clock is moved to a window start first; otherwise
    // the test would depend on where in a window vitest's fake clock happens to sit.
    const windowMs = PUBLIC_IP_WINDOW_S * 1000;
    vi.setSystemTime(Math.floor(Date.now() / windowMs) * windowMs);

    await admittedOf(limiter, '203.0.113.7', PUBLIC_IP_LIMIT + 1);
    const stillRefused = await limiter.checkPublicIp('203.0.113.7');
    vi.advanceTimersByTime(windowMs);
    const afterTheWindow = await limiter.checkPublicIp('203.0.113.7');

    expect({ stillRefused: stillRefused.allowed, afterTheWindow: afterTheWindow.allowed }).toEqual({
      stillRefused: false,
      afterTheWindow: true,
    });
  });

  it('F-028: the map is capped at LOCAL_LIMITER_MAX_PUBLIC_IPS, evicting under-limit entries first so churn cannot reset an exhausted address', async () => {
    await admittedOf(limiter, 'exhausted', PUBLIC_IP_LIMIT + 1);
    for (let i = 0; i < LOCAL_LIMITER_MAX_PUBLIC_IPS; i += 1) {
      await limiter.checkPublicIp(`churn-${String(i)}`);
    }

    expect({
      stillExhausted: (await limiter.checkPublicIp('exhausted')).allowed === false,
      size: limiter.size(),
      forcedEvictions: vi.mocked(logger.warn).mock.calls.length,
    }).toEqual({ stillExhausted: true, size: LOCAL_LIMITER_MAX_PUBLIC_IPS, forcedEvictions: 0 });
  });

  it('F-028: when every entry is at its limit and the cap is reached, the oldest is evicted anyway and a warn names local_rate_limit_forced_eviction_total without a key', async () => {
    for (let i = 0; i < LOCAL_LIMITER_MAX_PUBLIC_IPS; i += 1) {
      await admittedOf(limiter, `full-${String(i)}`, PUBLIC_IP_LIMIT);
    }

    const oneMore = await limiter.checkPublicIp('one-more');
    const lines = vi.mocked(logger.warn).mock.calls.map((call) => JSON.stringify(call));

    expect({
      admitted: oneMore.allowed,
      size: limiter.size(),
      warned: lines.length,
      namesTheCounter: lines.every((line) => line.includes('local_rate_limit_forced_eviction_total')),
      leaksAKey: lines.some((line) => line.includes('full-') || line.includes('one-more')),
    }).toEqual({ admitted: true, size: LOCAL_LIMITER_MAX_PUBLIC_IPS, warned: 1, namesTheCounter: true, leaksAKey: false });
  });

  it('F-028: entries whose window has elapsed are swept every LOCAL_AUTH_LIMITER_SWEEP_MS, reaching keys nobody asks about again', async () => {
    await limiter.checkPublicIp('203.0.113.7');
    await limiter.checkPublicIp('198.51.100.9');
    vi.advanceTimersByTime(PUBLIC_IP_WINDOW_S * 1000 + LOCAL_AUTH_LIMITER_SWEEP_MS);

    expect(limiter.size()).toBe(0);
  });
});
