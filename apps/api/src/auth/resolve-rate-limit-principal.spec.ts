import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../observability/logger';
import {
  BFF_CLIENT_IP_HEADER,
  BFF_PROXY_AUTH_HEADER,
  BFF_TRUST_BOUNDARIES,
  resolveRateLimitPrincipal,
} from './resolve-rate-limit-principal';

/**
 * STORY-001 — no AC states this; `docs/contracts/rate-limit.md` does. TASK-004, wave 3.
 *
 * Contract: `docs/contracts/rate-limit.md` ("Which address the client IP means, under the
 * BFF", F-031, F-033, F-320), `docs/contracts/trusted-client-address.md` ("The two callers").
 * ADR-0040, ADR-0014.
 *
 * ============================================================================
 * THE ONLY SITE THAT MAKES THE TRUSTED-PROXY DECISION, SO ITS FOUR RULES ARE A TABLE.
 * ============================================================================
 *
 * `resolveRateLimitPrincipal` returns `X-Shortkit-Client-IP` only when all four of F-033's
 * rules hold, otherwise falls through to `readTrustedClientAddress`, otherwise `null`. Rules 1
 * and 2 close the naive implementation's bypass — `header === process.env.BFF_PROXY_SECRET`
 * is `undefined === undefined` for a direct anonymous request with the variable unset — and
 * that is the case pinned first below, because it is the one a refactor reintroduces.
 *
 * `null` IS A REAL RETURN AND NOT A DEFECT. Under ADR-0040 no address is established where
 * neither the BFF nor a declared header supplies one, and the bucket that receives `null`
 * does not run. Nothing here may substitute a sentinel, the empty string or the peer address.
 */

const SECRET = 'FIXTURE-bff-proxy-secret_not_a_real_value_00';
const OTHER_SECRET = 'FIXTURE-bff-proxy-secret_not_a_real_value_01';

const BFF_ENV = { BFF_PROXY_SECRET: SECRET };
const BFF_AND_DECLARED_ENV = { BFF_PROXY_SECRET: SECRET, TRUSTED_CLIENT_IP_HEADER: 'x-test-client-ip' };
const DECLARED_ENV = { TRUSTED_CLIENT_IP_HEADER: 'x-test-client-ip' };

/**
 * A request the BFF forwarded, exactly as `web-api-client.md` says it sets the two headers.
 * `null` for `proxyAuth` means the auth header is ABSENT — `undefined` would select the
 * default parameter and quietly turn "no header" into "the right secret".
 */
function forwarded(clientIp: string, proxyAuth: string | string[] | null = SECRET) {
  return {
    [BFF_CLIENT_IP_HEADER]: clientIp,
    ...(proxyAuth === null ? {} : { [BFF_PROXY_AUTH_HEADER]: proxyAuth }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('resolveRateLimitPrincipal', () => {
  it('rate-limit.md: the two header names are the contract’s, lower-cased as Node presents them', () => {
    expect({
      clientIp: BFF_CLIENT_IP_HEADER,
      proxyAuth: BFF_PROXY_AUTH_HEADER,
      boundaries: [...BFF_TRUST_BOUNDARIES],
    }).toEqual({
      clientIp: 'x-shortkit-client-ip',
      proxyAuth: 'x-shortkit-proxy-auth',
      boundaries: ['bff', 'direct'],
    });
  });

  it('F-033: returns the forwarded address when all four rules hold', () => {
    expect([
      resolveRateLimitPrincipal(forwarded('203.0.113.7'), BFF_ENV),
      resolveRateLimitPrincipal(forwarded(' 2001:db8::7 '), BFF_ENV),
    ]).toEqual(['203.0.113.7', '2001:db8::7']);
  });

  it('F-033 rule 1: an unset or empty secret disables the branch even when the header "matches"', () => {
    // THE BYPASS THE RULE CLOSES. With the variable unset, `undefined === undefined` is true,
    // and an attacker who sends no auth header at all would name their own principal. So the
    // comparison is never REACHED, not merely never equal: an absent secret and an absent
    // header must not resolve to the forwarded address.
    expect([
      resolveRateLimitPrincipal(forwarded('203.0.113.7', null), {}),
      resolveRateLimitPrincipal(forwarded('203.0.113.7', ''), { BFF_PROXY_SECRET: '' }),
      resolveRateLimitPrincipal(forwarded('203.0.113.7'), {}),
      resolveRateLimitPrincipal(forwarded('203.0.113.7'), { BFF_PROXY_SECRET: '   ' }),
    ]).toEqual([null, null, null, null]);
  });

  it('F-033 rule 2: an absent, empty or repeated proxy-auth header never matches', () => {
    expect([
      resolveRateLimitPrincipal(forwarded('203.0.113.7', null), BFF_ENV),
      resolveRateLimitPrincipal(forwarded('203.0.113.7', ''), BFF_ENV),
      resolveRateLimitPrincipal(forwarded('203.0.113.7', [SECRET, SECRET]), BFF_ENV),
    ]).toEqual([null, null, null]);
  });

  it('F-033 rule 3: a secret that does not match falls through rather than being rejected', () => {
    // Fail-open-with-signal. The request proceeds under the declared-header fallback or under
    // no principal; a 4xx here would let a probe learn whether the secret is close.
    expect([
      resolveRateLimitPrincipal(forwarded('203.0.113.7', OTHER_SECRET), BFF_ENV),
      resolveRateLimitPrincipal(forwarded('203.0.113.7', SECRET.slice(0, -1)), BFF_ENV),
      resolveRateLimitPrincipal(forwarded('203.0.113.7', `${SECRET}x`), BFF_ENV),
      resolveRateLimitPrincipal(
        { ...forwarded('203.0.113.7', OTHER_SECRET), 'x-test-client-ip': '198.51.100.9' },
        BFF_AND_DECLARED_ENV,
      ),
    ]).toEqual([null, null, null, '198.51.100.9']);
  });

  it('F-033 rule 4: a forwarded value net.isIP rejects falls through, so it never becomes a key', () => {
    expect([
      resolveRateLimitPrincipal(forwarded('evil.example'), BFF_ENV),
      resolveRateLimitPrincipal(forwarded('203.0.113.7, 198.51.100.9'), BFF_ENV),
      resolveRateLimitPrincipal(forwarded('a'.repeat(16_384)), BFF_ENV),
      resolveRateLimitPrincipal(
        { [BFF_CLIENT_IP_HEADER]: ['203.0.113.7', '198.51.100.9'], [BFF_PROXY_AUTH_HEADER]: SECRET },
        BFF_ENV,
      ),
      resolveRateLimitPrincipal({ [BFF_PROXY_AUTH_HEADER]: SECRET }, BFF_ENV),
    ]).toEqual([null, null, null, null, null]);
  });

  it('ADR-0040: the BFF branch runs first, then the declared header, then null', () => {
    const both = { ...forwarded('203.0.113.7'), 'x-test-client-ip': '198.51.100.9' };

    expect([
      resolveRateLimitPrincipal(both, BFF_AND_DECLARED_ENV),
      resolveRateLimitPrincipal({ 'x-test-client-ip': '198.51.100.9' }, BFF_AND_DECLARED_ENV),
      resolveRateLimitPrincipal({ 'x-test-client-ip': '198.51.100.9' }, DECLARED_ENV),
      resolveRateLimitPrincipal({ 'x-test-client-ip': '198.51.100.9' }, {}),
      resolveRateLimitPrincipal({}, BFF_AND_DECLARED_ENV),
    ]).toEqual(['203.0.113.7', '198.51.100.9', '198.51.100.9', null, null]);
  });

  it('trusted-client-address.md invariant 2: X-Forwarded-For and Forwarded are read at no position, for no purpose', () => {
    // With the BFF secret set, with a header declared, and with neither: a request whose only
    // address is in a forwarding header resolves to nothing. `null`, and NEVER the peer
    // address or a sentinel — the bucket that receives `null` does not run.
    const xff = { 'x-forwarded-for': '203.0.113.7, 198.51.100.9', forwarded: 'for=203.0.113.7' };

    expect([
      resolveRateLimitPrincipal(xff, {}),
      resolveRateLimitPrincipal(xff, BFF_ENV),
      resolveRateLimitPrincipal(xff, DECLARED_ENV),
      resolveRateLimitPrincipal(xff, BFF_AND_DECLARED_ENV),
    ]).toEqual([null, null, null, null]);
  });

  it('never throws, whatever the headers or the environment contain', () => {
    const hostile: Record<string, string | string[] | undefined> = {
      [BFF_PROXY_AUTH_HEADER]: undefined,
      [BFF_CLIENT_IP_HEADER]: undefined,
      __proto__: SECRET,
    };

    expect([
      resolveRateLimitPrincipal(hostile, BFF_ENV),
      resolveRateLimitPrincipal(hostile, { BFF_PROXY_SECRET: undefined }),
      resolveRateLimitPrincipal({}, { TRUSTED_CLIENT_IP_HEADER: 'x-forwarded-for' }),
    ]).toEqual([null, null, null]);
  });

  it('F-033: a present proxy-auth header that fails a rule warns once per minute and names bff_proxy_auth_mismatch_total', () => {
    // The signal is what turns a secret mismatch into a counter rather than into users
    // reporting that signup is broken. Once per minute, because the BFF sends the header on
    // EVERY request and a warn per request would train an operator to ignore the channel.
    // NEITHER THE SECRET NOR THE HEADER VALUE IS ON THE LINE: only `msg`, and it names the
    // counter.
    const warn = vi.mocked(logger.warn);

    // The once-per-minute state is process-wide, and the tables above have already tripped
    // it inside this same minute. Step past the window first so the count below is this
    // test's own.
    vi.advanceTimersByTime(60_001);

    resolveRateLimitPrincipal(forwarded('203.0.113.7', OTHER_SECRET), BFF_ENV);
    resolveRateLimitPrincipal(forwarded('203.0.113.7', OTHER_SECRET), BFF_ENV);
    resolveRateLimitPrincipal(forwarded('evil.example'), BFF_ENV);
    vi.advanceTimersByTime(60_001);
    resolveRateLimitPrincipal(forwarded('203.0.113.7', OTHER_SECRET), BFF_ENV);

    const lines = warn.mock.calls.map((call) => JSON.stringify(call));

    expect({
      count: lines.length,
      namesTheCounter: lines.every((line) => line.includes('bff_proxy_auth_mismatch_total')),
      leaksASecret: lines.some((line) => line.includes(SECRET) || line.includes(OTHER_SECRET)),
    }).toEqual({ count: 2, namesTheCounter: true, leaksASecret: false });
  });

  it('F-033: an absent proxy-auth header is silent — a direct request is not a mismatch', () => {
    resolveRateLimitPrincipal({}, BFF_ENV);
    resolveRateLimitPrincipal({ 'x-test-client-ip': '198.51.100.9' }, BFF_AND_DECLARED_ENV);
    resolveRateLimitPrincipal(forwarded('203.0.113.7', null), BFF_ENV);

    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});
