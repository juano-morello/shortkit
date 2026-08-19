import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../observability/logger';
import {
  LOCAL_AUTH_LIMITER_MAX_PRINCIPALS,
  LOCAL_AUTH_LIMITER_SWEEP_MS,
  LocalAuthRateLimiter,
  authRateLimit,
} from './auth-rate-limit';
import { AUTH_RATE_LIMIT_BUCKETS, AuthRateLimitExceededError } from './ports/auth-rate-limit.port';
import type { AuthRateLimitBucket, AuthRateLimitPort } from './ports/auth-rate-limit.port';

/**
 * STORY-001 — no AC states this; `docs/contracts/rate-limit.md` does. TASK-004, wave 3.
 *
 * Contract: `docs/contracts/rate-limit.md` ("`/api/auth/*` is covered by a separate limiter",
 * "`LocalAuthRateLimiter` is bounded, per bucket", "Response on limit"),
 * `docs/contracts/trusted-client-address.md` ("What a `null` principal means to each bucket").
 * ADR-0013, ADR-0012, ADR-0040.
 *
 * Two subjects, one file, because the middleware is thin and the store is what carries the
 * rules: `authRateLimit` maps a route to a bucket, obtains a principal, and turns the port's
 * refusal into the 429 the contract shapes; `LocalAuthRateLimiter` is the process-local store
 * with F-028's three bounding rules. The 429 on the wire, with the real principal resolution
 * behind it, is `test/auth/auth-mount.int-spec.ts`'s.
 *
 * FAKE TIMERS THROUGHOUT. Fixed windows are computed from `Date.now()`, so a test that
 * wants "the window elapsed" advances the clock rather than sleeping.
 */

const SIGN_IN = AUTH_RATE_LIMIT_BUCKETS.signInPerIp;
const SIGN_UP = AUTH_RATE_LIMIT_BUCKETS.signUpPerIp;
const OTHER = AUTH_RATE_LIMIT_BUCKETS.otherPerIp;

async function outcome(run: () => Promise<void>): Promise<'allowed' | AuthRateLimitExceededError | unknown> {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    return error;
  }
}

/** Runs `check` `n` times for one key and reports how many were allowed. */
async function allowedOf(limiter: AuthRateLimitPort, bucket: AuthRateLimitBucket, key: string, n: number): Promise<number> {
  let allowed = 0;
  for (let i = 0; i < n; i += 1) {
    if ((await outcome(() => limiter.check(bucket, key))) === 'allowed') {
      allowed += 1;
    }
  }
  return allowed;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('the bucket table', () => {
  it('ADR-0013: sign-in 10 per 5 min, sign-up 3 per hour, everything else 60 per min, all IP-keyed', () => {
    // The email-keyed sign-in bucket (5 per 15 min) is DELIBERATELY ABSENT: it runs inside
    // Better Auth as a `hooks.before` middleware and belongs to item 1b, and `beforeHooks` is
    // empty until then (TASK-003). Recorded here so its absence is a statement rather than
    // an omission — across many addresses an attacker is bounded only by the three below.
    expect(AUTH_RATE_LIMIT_BUCKETS).toEqual({
      signInPerIp: { limit: 10, windowSeconds: 300 },
      signUpPerIp: { limit: 3, windowSeconds: 3600 },
      otherPerIp: { limit: 60, windowSeconds: 60 },
    });
  });
});

describe('LocalAuthRateLimiter', () => {
  let limiter: LocalAuthRateLimiter;

  beforeEach(() => {
    limiter = new LocalAuthRateLimiter();
  });

  afterEach(() => {
    limiter.onModuleDestroy();
  });

  it('allows exactly the limit inside one window and refuses the next with a 429-mapping error', async () => {
    const allowed = await allowedOf(limiter, 'signInPerIp', '203.0.113.7', SIGN_IN.limit);
    const refused = await outcome(() => limiter.check('signInPerIp', '203.0.113.7'));

    expect({
      allowed,
      refused: refused instanceof AuthRateLimitExceededError,
      bucket: refused instanceof AuthRateLimitExceededError ? refused.bucket : undefined,
      retryAfterBounded:
        refused instanceof AuthRateLimitExceededError &&
        refused.retryAfterSeconds >= 1 &&
        refused.retryAfterSeconds <= SIGN_IN.windowSeconds,
    }).toEqual({ allowed: SIGN_IN.limit, refused: true, bucket: 'signInPerIp', retryAfterBounded: true });
  });

  it('keys are independent within a bucket, and buckets are independent for one key', async () => {
    await allowedOf(limiter, 'signUpPerIp', '203.0.113.7', SIGN_UP.limit);

    expect({
      sameBucketOtherKey: await outcome(() => limiter.check('signUpPerIp', '198.51.100.9')),
      sameKeyOtherBucket: await outcome(() => limiter.check('signInPerIp', '203.0.113.7')),
      exhausted: (await outcome(() => limiter.check('signUpPerIp', '203.0.113.7'))) instanceof AuthRateLimitExceededError,
    }).toEqual({ sameBucketOtherKey: 'allowed', sameKeyOtherBucket: 'allowed', exhausted: true });
  });

  it('a fixed window: once the window elapses the key is admitted again', async () => {
    // Fixed rather than sliding, as `rate-limit.md` documents: a boundary allows up to 2× the
    // limit across two adjacent windows, and that is recorded rather than fixed.
    await allowedOf(limiter, 'otherPerIp', '203.0.113.7', OTHER.limit + 1);
    vi.advanceTimersByTime(OTHER.windowSeconds * 1000);

    expect(await outcome(() => limiter.check('otherPerIp', '203.0.113.7'))).toBe('allowed');
  });

  it('F-028: one map per bucket, capped at LOCAL_AUTH_LIMITER_MAX_PRINCIPALS, evicting under-limit entries first', async () => {
    // THE BYPASS THE ORDER CLOSES. An attacker who has exhausted a principal's allowance must
    // not be able to churn 10,000 fresh principals to evict that entry and reset its count.
    // Eviction takes the oldest UNDER-limit entry, so the exhausted one survives the churn.
    expect(LOCAL_AUTH_LIMITER_MAX_PRINCIPALS).toBe(10_000);

    await allowedOf(limiter, 'signUpPerIp', 'exhausted', SIGN_UP.limit + 1);
    for (let i = 0; i < LOCAL_AUTH_LIMITER_MAX_PRINCIPALS; i += 1) {
      await limiter.check('signUpPerIp', `churn-${String(i)}`);
    }

    expect({
      stillExhausted:
        (await outcome(() => limiter.check('signUpPerIp', 'exhausted'))) instanceof AuthRateLimitExceededError,
      size: limiter.size('signUpPerIp'),
      forcedEvictions: vi.mocked(logger.warn).mock.calls.length,
    }).toEqual({ stillExhausted: true, size: LOCAL_AUTH_LIMITER_MAX_PRINCIPALS, forcedEvictions: 0 });
  });

  it('F-028: when every entry is at its limit and the cap is reached, the oldest is evicted anyway and a warn names local_rate_limit_forced_eviction_total', async () => {
    // Memory is bounded absolutely; the counter is the signal that the limiter is under
    // pressure. Failing closed for new principals instead would let an attacker lock out
    // every new user.
    for (let i = 0; i < LOCAL_AUTH_LIMITER_MAX_PRINCIPALS; i += 1) {
      await allowedOf(limiter, 'signUpPerIp', `full-${String(i)}`, SIGN_UP.limit);
    }

    const admitted = await outcome(() => limiter.check('signUpPerIp', 'one-more'));
    const lines = vi.mocked(logger.warn).mock.calls.map((call) => JSON.stringify(call));

    expect({
      admitted,
      size: limiter.size('signUpPerIp'),
      warned: lines.length,
      namesTheCounter: lines.every((line) => line.includes('local_rate_limit_forced_eviction_total')),
      leaksAKey: lines.some((line) => line.includes('full-') || line.includes('one-more')),
    }).toEqual({
      admitted: 'allowed',
      size: LOCAL_AUTH_LIMITER_MAX_PRINCIPALS,
      warned: 1,
      namesTheCounter: true,
      leaksAKey: false,
    });
  });

  it('F-028: entries whose window has elapsed are swept every LOCAL_AUTH_LIMITER_SWEEP_MS', async () => {
    // The sweep is what bounds `signUpPerIp`, whose one-hour window would otherwise hold an
    // hour of distinct IPs. Lazy expiry on access does not reach a key nobody asks about again.
    expect(LOCAL_AUTH_LIMITER_SWEEP_MS).toBe(60_000);

    await limiter.check('otherPerIp', '203.0.113.7');
    await limiter.check('otherPerIp', '198.51.100.9');
    vi.advanceTimersByTime(OTHER.windowSeconds * 1000 + LOCAL_AUTH_LIMITER_SWEEP_MS);

    expect(limiter.size('otherPerIp')).toBe(0);
  });
});

/** A `Response` double that records what the middleware wrote. */
function fakeResponse(): { res: Response; written: () => { status?: number; headers: Record<string, string>; body?: unknown } } {
  const state: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    set(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as unknown as Response;

  return { res, written: () => state };
}

function fakeRequest(method: string, path: string, headers: Record<string, string | string[]> = {}): Request {
  return { method, path, headers } as unknown as Request;
}

/** Runs the middleware to completion: it calls `next` or writes a response, asynchronously. */
async function run(port: AuthRateLimitPort, req: Request): Promise<{ next: number; written: ReturnType<ReturnType<typeof fakeResponse>['written']> }> {
  const { res, written } = fakeResponse();
  let next = 0;

  await new Promise<void>((resolve) => {
    const middleware = authRateLimit(port);
    const done: NextFunction = () => {
      next += 1;
      resolve();
    };
    const original = res.json.bind(res);
    (res as { json: Response['json'] }).json = ((body: unknown) => {
      original(body);
      resolve();
      return res;
    }) as Response['json'];

    void middleware(req, res, done);
  });

  return { next, written: written() };
}

describe('authRateLimit', () => {
  const recording = (): AuthRateLimitPort & { calls: [string, string][] } => {
    const calls: [string, string][] = [];
    return {
      calls,
      check: async (bucket, key) => {
        calls.push([bucket, key]);
      },
    };
  };

  it('ADR-0013: routes map to their buckets — sign-in, sign-up, and everything else under /api/auth', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', 'x-test-client-ip');
    const port = recording();
    const headers = { 'x-test-client-ip': '203.0.113.7' };

    await run(port, fakeRequest('POST', '/api/auth/sign-in/email', headers));
    await run(port, fakeRequest('POST', '/api/auth/sign-up/email', headers));
    await run(port, fakeRequest('GET', '/api/auth/token', headers));
    await run(port, fakeRequest('POST', '/api/auth/sign-out', headers));
    await run(port, fakeRequest('GET', '/api/auth/sign-in/email', headers));

    expect(port.calls).toEqual([
      ['signInPerIp', '203.0.113.7'],
      ['signUpPerIp', '203.0.113.7'],
      ['otherPerIp', '203.0.113.7'],
      ['otherPerIp', '203.0.113.7'],
      ['otherPerIp', '203.0.113.7'],
    ]);
  });

  it('ADR-0040: a null principal means the bucket does not run and the request proceeds', async () => {
    // Not a sentinel, not `''`, not the peer address: the port is never called, so no two
    // unidentified callers can share an allowance. And it is silent when no header is
    // declared, because compose, CI and local dev are in that state on purpose.
    const port = recording();

    const { next } = await run(port, fakeRequest('POST', '/api/auth/sign-in/email', { 'x-forwarded-for': '203.0.113.7' }));

    expect({ next, calls: port.calls, warned: vi.mocked(logger.warn).mock.calls.length }).toEqual({
      next: 1,
      calls: [],
      warned: 0,
    });
  });

  it('trusted-client-address.md: with a header declared and the read failing, the null is warned once per minute and names trusted_client_ip_unresolved_total', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', 'x-test-client-ip');
    vi.advanceTimersByTime(60_001);
    const port = recording();

    await run(port, fakeRequest('POST', '/api/auth/sign-in/email', { 'x-test-client-ip': 'not-an-ip' }));
    await run(port, fakeRequest('POST', '/api/auth/sign-in/email', {}));
    vi.advanceTimersByTime(60_001);
    await run(port, fakeRequest('POST', '/api/auth/sign-in/email', { 'x-test-client-ip': ['a', 'b'] }));

    const lines = vi.mocked(logger.warn).mock.calls.map((call) => JSON.stringify(call));

    expect({
      calls: port.calls,
      warned: lines.length,
      namesTheCounter: lines.every((line) => line.includes('trusted_client_ip_unresolved_total')),
      leaksTheHeaderName: lines.some((line) => line.includes('x-test-client-ip')),
    }).toEqual({ calls: [], warned: 2, namesTheCounter: true, leaksTheHeaderName: false });
  });

  it('rate-limit.md: an exhausted bucket answers 429 with Retry-After and { code, message, retryAfterSeconds }', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', 'x-test-client-ip');
    const port: AuthRateLimitPort = {
      check: async () => {
        throw new AuthRateLimitExceededError('signInPerIp', 42);
      },
    };

    const { next, written } = await run(port, fakeRequest('POST', '/api/auth/sign-in/email', { 'x-test-client-ip': '203.0.113.7' }));

    expect({ next, status: written.status, retryAfter: written.headers['retry-after'], body: written.body }).toEqual({
      next: 0,
      status: 429,
      retryAfter: '42',
      body: {
        code: 'rate_limited',
        message: expect.stringMatching(/./) as unknown,
        retryAfterSeconds: 42,
      },
    });
  });

  it('ADR-0012: a port failure that is not a refusal lets the request proceed and warns', async () => {
    // Never a 5xx from the limiter. The local store cannot fail, so this is the posture a
    // future Redis-backed port inherits: degrade with signal rather than take the credential
    // surface down with the store.
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', 'x-test-client-ip');
    const port: AuthRateLimitPort = {
      check: async () => {
        throw new Error('store unavailable');
      },
    };

    const { next, written } = await run(port, fakeRequest('POST', '/api/auth/sign-in/email', { 'x-test-client-ip': '203.0.113.7' }));

    expect({ next, status: written.status, warned: vi.mocked(logger.warn).mock.calls.length }).toEqual({
      next: 1,
      status: undefined,
      warned: 1,
    });
  });
});
