import { createHash } from 'node:crypto';

import { APIError } from 'better-auth/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../observability/logger';
import type { AuthBeforeHookContext } from './before-hook';
import {
  EMAIL_RATE_LIMITED_CODE,
  EMAIL_RATE_LIMITED_MESSAGE,
  EMAIL_RATE_LIMIT_BUCKET,
  SIGN_IN_EMAIL_PATH,
  bindEmailRateLimitPort,
  emailRateLimitHook,
  emailRateLimitKey,
  emailRateLimitReleaseHook,
  normaliseEmailForKey,
} from './email-rate-limit-hook';
import { AUTH_RATE_LIMIT_BUCKETS, AuthRateLimitExceededError } from './ports/auth-rate-limit.port';
import type { AuthRateLimitBucket, AuthRateLimitCharge, AuthRateLimitPort } from './ports/auth-rate-limit.port';

/**
 * STORY-1b-08 — AC-1b-39's unit half. TASK-1b-09 (item 1b, wave 3; D-15).
 *
 * Contract: `docs/contracts/rate-limit.md` ("The email bucket runs inside Better Auth",
 * "`ctx.body` is unvalidated at hook time", "The email key is normalised, and both failure
 * modes are tested", "Response on limit"). ADR-0013 (F-019, F-025, F-027, F-228), ADR-0012,
 * ADR-0055, F-216.
 *
 * WHAT IS HERE: the normalisation table, the predicate, the F-228 rule (nothing but an
 * `APIError` ever leaves the hook, and a body that is not a string is not charged), the 429's
 * shape, the fixed message, the hashed key, and both degrade-open branches. WHAT IS NOT:
 * whether `ctx.path` really reads `/sign-in/email` inside Better Auth — that is a framework
 * fact and `test/auth/sign-in-email-bucket.int-spec.ts` pins it against a real request,
 * because a wrong literal here is a limiter that quietly does not exist (F-025 b).
 *
 * The context is a structural stand-in cast to `AuthBeforeHookContext`: the hook reads
 * `path` and `body` and nothing else, and the real type is a large inferred structure whose
 * other members are irrelevant to every assertion below.
 */

/** A recording port: every `check` call, and a scripted rejection for the next one. */
class RecordingPort implements AuthRateLimitPort {
  readonly calls: { bucket: AuthRateLimitBucket; key: string }[] = [];
  readonly releases: { bucket: AuthRateLimitBucket; key: string; charge: AuthRateLimitCharge }[] = [];
  nextRejection: unknown;
  nextReleaseRejection: unknown;

  chargeWindow = 1_000;

  async check(bucket: AuthRateLimitBucket, key: string): Promise<AuthRateLimitCharge> {
    this.calls.push({ bucket, key });

    if (this.nextRejection !== undefined) {
      const rejection: unknown = this.nextRejection;
      this.nextRejection = undefined;
      throw rejection;
    }

    return { windowStart: this.chargeWindow };
  }

  async release(bucket: AuthRateLimitBucket, key: string, charge: AuthRateLimitCharge): Promise<void> {
    this.releases.push({ bucket, key, charge });

    if (this.nextReleaseRejection !== undefined) {
      const rejection: unknown = this.nextReleaseRejection;
      this.nextReleaseRejection = undefined;
      throw rejection;
    }
  }
}

function ctx(path: string, body: unknown): AuthBeforeHookContext {
  return { path, body } as unknown as AuthBeforeHookContext;
}

/**
 * A per-request pair of contexts, the way `dispatchAuthEndpoint` builds them: the before hook
 * and the after hook receive different outer objects that share ONE `ctx.context` (the
 * per-request `AuthContext` copy), on which the after hook also finds the endpoint's `returned`.
 */
function requestPair(path: string, body: unknown): {
  before: AuthBeforeHookContext;
  after: (returned: unknown) => AuthBeforeHookContext;
} {
  const scope: { returned?: unknown } = {};

  return {
    before: { path, body, context: scope } as unknown as AuthBeforeHookContext,
    after: (returned: unknown) => {
      scope.returned = returned;
      return { path, body, context: scope } as unknown as AuthBeforeHookContext;
    },
  };
}

/** An after-hook context on its own: no before hook ran in this "request", so no charge exists. */
function afterCtx(path: string, body: unknown, returned: unknown): AuthBeforeHookContext {
  return { path, body, context: { returned } } as unknown as AuthBeforeHookContext;
}

async function outcome(work: Promise<unknown>): Promise<{ resolved: true } | { threw: unknown }> {
  try {
    await work;
    return { resolved: true };
  } catch (error) {
    return { threw: error };
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

let port: RecordingPort;

beforeEach(() => {
  port = new RecordingPort();
  bindEmailRateLimitPort(port);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normaliseEmailForKey (rate-limit.md, F-228)', () => {
  it('trims and lower-cases a string, and nothing else', () => {
    expect(normaliseEmailForKey('  Foo.Bar+tag@Example.COM  ')).toBe('foo.bar+tag@example.com');
    // No dot-removal, no +tag removal: two real accounts may differ exactly that way.
    expect(normaliseEmailForKey('foo.bar@example.com')).not.toBe(normaliseEmailForKey('foobar@example.com'));
    expect(normaliseEmailForKey('foo+a@example.com')).not.toBe(normaliseEmailForKey('foo@example.com'));
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 12345],
    ['an object', { ne: null }],
    ['an array', ['a@b.com']],
    ['a boolean', true],
    ['the empty string', ''],
    ['whitespace only', ' \t\n '],
  ])('answers null for %s and does not throw', (_label, input) => {
    expect(normaliseEmailForKey(input)).toBeNull();
  });
});

describe('the bucket and the key', () => {
  it('charges signInPerEmail, which the port table fixes at 5 per 15 minutes', () => {
    expect(EMAIL_RATE_LIMIT_BUCKET).toBe('signInPerEmail');
    expect(AUTH_RATE_LIMIT_BUCKETS[EMAIL_RATE_LIMIT_BUCKET]).toEqual({ limit: 5, windowSeconds: 900 });
  });

  it('keys on hex SHA-256 of the normalised address, so the keyspace holds no addresses', () => {
    expect(emailRateLimitKey('foo@example.com')).toBe(sha256('foo@example.com'));
    expect(emailRateLimitKey('foo@example.com')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('emailRateLimitHook', () => {
  it("applies to '/sign-in/email' only: every other path returns without touching the port", async () => {
    for (const path of ['/sign-up/email', '/sign-out', '/get-session', '/token', '/sign-in/social']) {
      await expect(emailRateLimitHook(ctx(path, { email: 'foo@example.com' }))).resolves.toBeUndefined();
    }

    expect(port.calls).toEqual([]);
    expect(SIGN_IN_EMAIL_PATH).toBe('/sign-in/email');
  });

  it('charges one attempt under the hashed normalised key, so case variants share an allowance (F-025 a)', async () => {
    await emailRateLimitHook(ctx(SIGN_IN_EMAIL_PATH, { email: 'Foo@Example.com' }));
    await emailRateLimitHook(ctx(SIGN_IN_EMAIL_PATH, { email: '  foo@example.COM ' }));

    expect(port.calls).toEqual([
      { bucket: 'signInPerEmail', key: sha256('foo@example.com') },
      { bucket: 'signInPerEmail', key: sha256('foo@example.com') },
    ]);
    // And the address itself is not the key.
    expect(port.calls.map((call) => call.key)).not.toContain('foo@example.com');
  });

  it.each([
    ['no body at all', undefined],
    ['a null body', null],
    ['a body with no email', { password: 'x' }],
    ['an object-typed email', { email: { ne: null }, password: 'x' }],
    ['a number-typed email', { email: 12345, password: 'x' }],
    ['an empty-string email', { email: '   ', password: 'x' }],
    ['a string body', 'email=a@b.com'],
  ])('F-228: %s is neither charged nor refused — the endpoint answers its own 400', async (_label, body) => {
    await expect(emailRateLimitHook(ctx(SIGN_IN_EMAIL_PATH, body))).resolves.toBeUndefined();
    expect(port.calls).toEqual([]);
  });

  it('exhausted → APIError 429 with code rate_limited, the fixed message, retryAfterSeconds in the body and Retry-After on the error (F-027)', async () => {
    port.nextRejection = new AuthRateLimitExceededError('signInPerEmail', 37);

    const result = await outcome(emailRateLimitHook(ctx(SIGN_IN_EMAIL_PATH, { email: 'foo@example.com' })));

    expect('threw' in result).toBe(true);
    const thrown = (result as { threw: unknown }).threw;
    expect(thrown).toBeInstanceOf(APIError);

    const apiError = thrown as APIError;
    expect(apiError.statusCode).toBe(429);
    expect(apiError.body).toEqual({
      code: EMAIL_RATE_LIMITED_CODE,
      message: EMAIL_RATE_LIMITED_MESSAGE,
      retryAfterSeconds: 37,
    });
    expect(new Headers(apiError.headers).get('retry-after')).toBe('37');
  });

  it('F-216: the refusal message is a fixed string that names no address and no key', async () => {
    port.nextRejection = new AuthRateLimitExceededError('signInPerEmail', 5);
    const address = 'unique-victim-2f8a@example.com';

    const result = await outcome(emailRateLimitHook(ctx(SIGN_IN_EMAIL_PATH, { email: address })));
    const apiError = (result as { threw: APIError }).threw;

    expect(EMAIL_RATE_LIMITED_CODE).toBe('rate_limited');
    expect(EMAIL_RATE_LIMITED_MESSAGE).toBe('Too many sign-in attempts for this account. Try again shortly.');
    expect(apiError.message).toBe(EMAIL_RATE_LIMITED_MESSAGE);
    expect(JSON.stringify(apiError.body)).not.toContain(address);
    expect(JSON.stringify(apiError.body)).not.toContain(sha256(address));
    expect(apiError.message).not.toContain('@');
  });

  it('a store failure that is not the refusal degrades OPEN with a warn line and no message on it (ADR-0012)', async () => {
    port.nextRejection = new Error('ECONNRESET reading redis://secret-host');

    await expect(emailRateLimitHook(ctx(SIGN_IN_EMAIL_PATH, { email: 'foo@example.com' }))).resolves.toBeUndefined();

    const warn = vi.mocked(logger.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('the auth rate-limit store failed to answer; the request proceeded without a limit');
    expect(fields).toHaveProperty('err_name', 'Error');
    expect(fields).not.toHaveProperty('err_message');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-host');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('foo@example.com');
  });

  it('with no bound port (the unit tier never runs main.ts) it degrades OPEN with a fixed warn line, once a minute', async () => {
    vi.resetModules();
    // A fresh module instance: nothing has called `bindEmailRateLimitPort` on it.
    const fresh = await import('./email-rate-limit-hook');
    const { logger: freshLogger } = await import('../observability/logger');
    const warn = vi.spyOn(freshLogger, 'warn').mockImplementation(() => undefined);

    await expect(fresh.emailRateLimitHook(ctx(SIGN_IN_EMAIL_PATH, { email: 'foo@example.com' }))).resolves.toBeUndefined();
    await expect(fresh.emailRateLimitHook(ctx(SIGN_IN_EMAIL_PATH, { email: 'foo@example.com' }))).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('no bound limiter');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('foo@example.com');
    expect(port.calls).toEqual([]);
  });

  it('never throws anything but an APIError, whatever the body is (F-228)', async () => {
    const hostile = [
      undefined,
      null,
      0,
      'a string',
      [],
      { email: Symbol('x') },
      { email: () => 'foo@example.com' },
      { email: { toString: () => 'foo@example.com' } },
      Object.create(null) as unknown,
    ];

    for (const body of hostile) {
      const result = await outcome(emailRateLimitHook(ctx(SIGN_IN_EMAIL_PATH, body)));
      expect(result, `body ${String(typeof body)}`).toEqual({ resolved: true });
    }

    expect(port.calls).toEqual([]);
  });
});

describe('emailRateLimitReleaseHook — a success gives its charge back (architect ruling, 2026-08-18)', () => {
  const SUCCESS = { redirect: false, token: 'sess', user: { id: 'u1' } };
  const BODY = { email: 'Foo@Example.com', password: 'x' };

  it("applies to '/sign-in/email' only", async () => {
    for (const path of ['/sign-up/email', '/sign-out', '/get-session', '/token']) {
      const request = requestPair(path, BODY);
      await emailRateLimitHook(request.before);
      await expect(emailRateLimitReleaseHook(request.after(SUCCESS))).resolves.toBeUndefined();
    }

    expect(port.releases).toEqual([]);
  });

  it('a returned value that is not an APIError releases signInPerEmail under the same key AND the same charge the before hook made', async () => {
    port.chargeWindow = 1_755_000_000_000;
    const request = requestPair(SIGN_IN_EMAIL_PATH, BODY);
    await emailRateLimitHook(request.before);
    await emailRateLimitReleaseHook(request.after(SUCCESS));

    expect(port.releases).toEqual([
      { bucket: 'signInPerEmail', key: sha256('foo@example.com'), charge: { windowStart: 1_755_000_000_000 } },
    ]);
    expect(port.calls).toEqual([{ bucket: 'signInPerEmail', key: sha256('foo@example.com') }]);
  });

  it('the charge is per request: two requests for one address each release their own charge, once', async () => {
    port.chargeWindow = 10;
    const first = requestPair(SIGN_IN_EMAIL_PATH, BODY);
    await emailRateLimitHook(first.before);
    port.chargeWindow = 20;
    const second = requestPair(SIGN_IN_EMAIL_PATH, BODY);
    await emailRateLimitHook(second.before);

    await emailRateLimitReleaseHook(second.after(SUCCESS));
    await emailRateLimitReleaseHook(first.after(SUCCESS));
    // A second after-hook run for the same request finds nothing (the entry was consumed).
    await emailRateLimitReleaseHook(first.after(SUCCESS));

    expect(port.releases.map((release) => release.charge.windowStart)).toEqual([20, 10]);
  });

  it('an after hook whose request made no charge releases nothing — never a release computed from "now"', async () => {
    await expect(emailRateLimitReleaseHook(afterCtx(SIGN_IN_EMAIL_PATH, BODY, SUCCESS))).resolves.toBeUndefined();
    expect(port.releases).toEqual([]);
  });

  it.each([
    ['an APIError 401 (invalid credentials)', new APIError('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'x' })],
    ['an APIError 400 (validation)', new APIError('BAD_REQUEST', { code: 'VALIDATION_ERROR', message: 'x' })],
    ['an APIError 403', new APIError('FORBIDDEN', { code: 'EMAIL_NOT_VERIFIED', message: 'x' })],
    ['nothing returned at all', undefined],
  ])('a failed attempt is NOT refunded: %s leaves the charge standing', async (_label, returned) => {
    const request = requestPair(SIGN_IN_EMAIL_PATH, BODY);
    await emailRateLimitHook(request.before);
    await expect(emailRateLimitReleaseHook(request.after(returned))).resolves.toBeUndefined();
    expect(port.calls).toHaveLength(1);
    expect(port.releases).toEqual([]);
  });

  it.each([
    ['no body', undefined],
    ['an object-typed email', { email: { ne: null } }],
    ['a number-typed email', { email: 12345 }],
    ['an empty email', { email: '  ' }],
  ])('F-228: %s was never charged, so nothing is released and nothing throws', async (_label, body) => {
    const request = requestPair(SIGN_IN_EMAIL_PATH, body);
    await emailRateLimitHook(request.before);
    await expect(emailRateLimitReleaseHook(request.after(SUCCESS))).resolves.toBeUndefined();
    expect(port.calls).toEqual([]);
    expect(port.releases).toEqual([]);
  });

  it('a store failure on release NEVER throws — the sign-in already succeeded — and warns with no message on the line', async () => {
    port.nextReleaseRejection = new Error('ECONNRESET redis://secret-host');
    const request = requestPair(SIGN_IN_EMAIL_PATH, BODY);
    await emailRateLimitHook(request.before);

    await expect(emailRateLimitReleaseHook(request.after(SUCCESS))).resolves.toBeUndefined();

    const warn = vi.mocked(logger.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain('release');
    expect(fields).not.toHaveProperty('err_message');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-host');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('foo@example.com');
  });

  it('with no bound port the before hook charged nothing, and the after hook releases nothing without throwing', async () => {
    vi.resetModules();
    const fresh = await import('./email-rate-limit-hook');
    const { logger: freshLogger } = await import('../observability/logger');
    vi.spyOn(freshLogger, 'warn').mockImplementation(() => undefined);
    const request = requestPair(SIGN_IN_EMAIL_PATH, BODY);

    await fresh.emailRateLimitHook(request.before);
    await expect(fresh.emailRateLimitReleaseHook(request.after(SUCCESS))).resolves.toBeUndefined();
    expect(port.releases).toEqual([]);
  });

  it('never throws, whatever the context holds', async () => {
    const hostile = [
      afterCtx(SIGN_IN_EMAIL_PATH, BODY, null),
      { path: SIGN_IN_EMAIL_PATH, body: BODY } as unknown as AuthBeforeHookContext,
      { path: SIGN_IN_EMAIL_PATH, body: BODY, context: null } as unknown as AuthBeforeHookContext,
      { path: SIGN_IN_EMAIL_PATH, body: BODY, context: 'x' } as unknown as AuthBeforeHookContext,
    ];

    for (const context of hostile) {
      await expect(emailRateLimitHook(context)).resolves.toBeUndefined();
      await expect(emailRateLimitReleaseHook(context)).resolves.toBeUndefined();
    }
  });
});
