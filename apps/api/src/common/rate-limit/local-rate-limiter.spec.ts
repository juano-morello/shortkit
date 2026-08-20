import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_AUTH_LIMITER_SWEEP_MS } from '../../auth/auth-rate-limit';
import { logger } from '../../observability/logger';
import { LocalRateLimiter } from './local-rate-limiter';
import {
  LOCAL_LIMITER_MAX_PUBLIC_IPS,
  LOCAL_LIMITER_MAX_TENANTS,
  PUBLIC_IP_LIMIT,
  PUBLIC_IP_WINDOW_S,
  RATE_LIMIT_MAX_WRITES,
  RATE_LIMIT_WINDOW_S,
} from './rate-limit.types';

/**
 * TASK-1b-07, wave 1 of item 1b: the process-local `@Public()` IP bucket. Debt sweep D1
 * (2026-08-19): the tenant-keyed write bucket, its own map.
 *
 * Contract: `docs/contracts/rate-limit.md` ("Limits", "Scope", "Behaviour when Redis is
 * unavailable": two maps, two key spaces, F-028's three rules on the IP map and a PLAIN LRU
 * on the tenant map). ADR-0012.
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

/** Runs `checkTenant` `n` times for one tenant and reports how many were admitted. */
async function tenantAdmittedOf(limiter: LocalRateLimiter, tenantId: string, n: number): Promise<number> {
  let admitted = 0;
  for (let i = 0; i < n; i += 1) {
    if ((await limiter.checkTenant(tenantId)).allowed) {
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
  it('rate-limit.md: the @Public() bucket is 30 per 60 s, the tenant bucket 120 per 60 s, and each map is capped at 10 000', () => {
    expect({
      PUBLIC_IP_LIMIT,
      PUBLIC_IP_WINDOW_S,
      RATE_LIMIT_MAX_WRITES,
      RATE_LIMIT_WINDOW_S,
      LOCAL_LIMITER_MAX_PUBLIC_IPS,
      LOCAL_LIMITER_MAX_TENANTS,
    }).toEqual({
      PUBLIC_IP_LIMIT: 30,
      PUBLIC_IP_WINDOW_S: 60,
      RATE_LIMIT_MAX_WRITES: 120,
      RATE_LIMIT_WINDOW_S: 60,
      LOCAL_LIMITER_MAX_PUBLIC_IPS: 10_000,
      LOCAL_LIMITER_MAX_TENANTS: 10_000,
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

describe('LocalRateLimiter.checkTenant (debt sweep D1: the tenant-keyed write bucket, process-local)', () => {
  const TENANT_A = '3f2a9c1e-7b4d-4e8a-9c6f-1d2e3f4a5b6c';
  const TENANT_B = '9b1d3f5a-2c4e-4a6b-8d0f-1e3a5c7b9d2f';

  it('admits exactly RATE_LIMIT_MAX_WRITES inside one window and refuses the next with a Retry-After of at least 1', async () => {
    const admitted = await tenantAdmittedOf(limiter, TENANT_A, RATE_LIMIT_MAX_WRITES);
    const refused = await limiter.checkTenant(TENANT_A);

    expect({ admitted, refused }).toEqual({
      admitted: RATE_LIMIT_MAX_WRITES,
      refused: { allowed: false, retryAfterSeconds: expect.any(Number) },
    });
    if (!refused.allowed) {
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_S);
      expect(Number.isInteger(refused.retryAfterSeconds)).toBe(true);
    }
  });

  it('AC-84: tenants are independent — one exhausted tenant does not touch another', async () => {
    await tenantAdmittedOf(limiter, TENANT_A, RATE_LIMIT_MAX_WRITES + 1);

    expect(await limiter.checkTenant(TENANT_B)).toEqual({ allowed: true });
  });

  it('AC-85: a fixed window aligned to the epoch — once the window elapses the tenant writes again', async () => {
    const windowMs = RATE_LIMIT_WINDOW_S * 1000;
    vi.setSystemTime(Math.floor(Date.now() / windowMs) * windowMs);

    await tenantAdmittedOf(limiter, TENANT_A, RATE_LIMIT_MAX_WRITES + 1);
    const stillRefused = await limiter.checkTenant(TENANT_A);
    vi.advanceTimersByTime(windowMs);
    const afterTheWindow = await limiter.checkTenant(TENANT_A);

    expect({ stillRefused: stillRefused.allowed, afterTheWindow: afterTheWindow.allowed }).toEqual({
      stillRefused: false,
      afterTheWindow: true,
    });
  });

  it('F-034: the tenant map is bounded at LOCAL_LIMITER_MAX_TENANTS and SEPARATE from the IP map — tenant churn cannot evict an address and vice versa', async () => {
    await limiter.checkPublicIp('203.0.113.7');
    await limiter.checkPublicIp('203.0.113.8');

    for (let i = 0; i <= LOCAL_LIMITER_MAX_TENANTS; i += 1) {
      await limiter.checkTenant(`tenant-${String(i)}`);
    }

    expect({ tenants: limiter.tenantSize(), ips: limiter.size() }).toEqual({
      tenants: LOCAL_LIMITER_MAX_TENANTS,
      ips: 2,
    });
  });

  it('a PLAIN LRU, per the contract: at the cap the oldest entry is evicted, exhausted or not — F-028\'s churn defence is deliberately absent because tenant ids require authentication', async () => {
    await tenantAdmittedOf(limiter, 'exhausted-tenant', RATE_LIMIT_MAX_WRITES + 1);
    for (let i = 0; i < LOCAL_LIMITER_MAX_TENANTS; i += 1) {
      await limiter.checkTenant(`churn-${String(i)}`);
    }

    // The exhausted entry was the oldest and is gone; the next charge opens a fresh entry.
    // `rate-limit.md`, "Behaviour when Redis is unavailable" states the rule and the reason.
    expect({
      readmitted: (await limiter.checkTenant('exhausted-tenant')).allowed,
      size: limiter.tenantSize(),
      warned: vi.mocked(logger.warn).mock.calls.length,
    }).toEqual({ readmitted: true, size: LOCAL_LIMITER_MAX_TENANTS, warned: 0 });
  });

  it('entries whose window has elapsed are swept from the tenant map on the shared cadence', async () => {
    await limiter.checkTenant(TENANT_A);
    await limiter.checkTenant(TENANT_B);
    vi.advanceTimersByTime(RATE_LIMIT_WINDOW_S * 1000 + LOCAL_AUTH_LIMITER_SWEEP_MS);

    expect(limiter.tenantSize()).toBe(0);
  });
});
