import { describe, expect, it } from 'vitest';

import {
  CLIENT_TRUST_BOUNDARIES,
  FORBIDDEN_TRUSTED_HEADERS,
  TRUSTED_CLIENT_IP_HEADER_ENV,
  TRUSTED_CLIENT_IP_HEADER_PATTERN,
  readTrustedClientAddress,
} from './trusted-client-address';

/**
 * STORY-001 — no AC states this; `docs/contracts/trusted-client-address.md` does. TASK-004,
 * wave 3.
 *
 * Contract: `docs/contracts/trusted-client-address.md` ("The read, rule by rule",
 * "Invariants a caller may rely on", "What the implementer must guarantee"). ADR-0040.
 *
 * ============================================================================
 * THE READ IS PURE AND IS TESTED AS A TABLE. THE BOOT ASSERTION IS TESTED NEXT DOOR.
 * ============================================================================
 *
 * `readTrustedClientAddress(headers, env)` reads one header, named by one variable, and
 * returns a value `net.isIP` accepts or `null`. `assertTrustedClientIpHeaderConfigured` is
 * TASK-004's too and lives in `auth/boot-assertions.ts` beside the other boot refusals; its
 * table is in `boot-assertions.spec.ts`. The two share the constants imported above and
 * nothing else, which is why the pattern and the forbidden list are asserted here once.
 *
 * Every test below states the RULE it pins, because each rule closes a specific way the
 * naive read (`headers['x-forwarded-for'].split(',')[0]`) trusts a client-chosen address:
 * F-009 for the redirect path's `ip_hash`, and the collapsed-bucket outage F-031 measured for
 * the rate limiter.
 */

const DECLARED = { TRUSTED_CLIENT_IP_HEADER: 'x-test-client-ip' };
const UNDECLARED = {};

describe('readTrustedClientAddress', () => {
  it('returns the trimmed value of the declared header when it is one IP address', () => {
    expect([
      readTrustedClientAddress({ 'x-test-client-ip': '203.0.113.7' }, DECLARED),
      readTrustedClientAddress({ 'x-test-client-ip': '  203.0.113.7 ' }, DECLARED),
      readTrustedClientAddress({ 'x-test-client-ip': '2001:db8::1' }, DECLARED),
    ]).toEqual(['203.0.113.7', '203.0.113.7', '2001:db8::1']);
  });

  it('rule 1: an unset or empty declaration disables the read, whatever the request carries', () => {
    // No header is looked up at all — not the platform's, not a guessed one. A request that
    // carries a plausible header under an undeclared name is a client choosing its own
    // principal, which is F-009 by the front door.
    const headers = {
      'x-test-client-ip': '203.0.113.7',
      'fly-client-ip': '203.0.113.8',
      'cf-connecting-ip': '203.0.113.9',
    };

    expect([
      readTrustedClientAddress(headers, UNDECLARED),
      readTrustedClientAddress(headers, { TRUSTED_CLIENT_IP_HEADER: '' }),
      readTrustedClientAddress(headers, { TRUSTED_CLIENT_IP_HEADER: '   ' }),
    ]).toEqual([null, null, null]);
  });

  it('rule 2: a malformed or forbidden declared name returns null rather than throwing', () => {
    // Under `CLIENT_TRUST_BOUNDARY=proxy` the boot assertion has already refused these; under
    // `direct` and unset it has not, and the read still must not honour them. `x-forwarded-for`
    // and `forwarded` are appended to by every hop, so no hop can strip-and-set them, and a
    // read from either — at ANY position — is what invariant 2 forbids.
    const headers = {
      'X-Real-IP': '203.0.113.7',
      'x-real-ip': '203.0.113.7',
      'x-forwarded-for': '203.0.113.7',
      forwarded: 'for=203.0.113.7',
    };

    expect([
      readTrustedClientAddress(headers, { TRUSTED_CLIENT_IP_HEADER: 'X-Real-IP' }),
      readTrustedClientAddress(headers, { TRUSTED_CLIENT_IP_HEADER: 'x-forwarded-for' }),
      readTrustedClientAddress(headers, { TRUSTED_CLIENT_IP_HEADER: 'forwarded' }),
      readTrustedClientAddress(headers, { TRUSTED_CLIENT_IP_HEADER: 'x real ip' }),
    ]).toEqual([null, null, null, null]);
  });

  it('rule 3: a repeated header resolves to null, since that is the shape an appending proxy produces', () => {
    // Node presents a repeated header as an array. `[0]` is what a naive read would trust,
    // and it is exactly the entry an attacker set before the hop appended its own.
    expect(
      readTrustedClientAddress({ 'x-test-client-ip': ['203.0.113.7', '198.51.100.9'] }, DECLARED),
    ).toBeNull();
  });

  it('rule 3: a comma-joined value resolves to null, and no list is parsed at either end', () => {
    expect([
      readTrustedClientAddress({ 'x-test-client-ip': '203.0.113.7, 198.51.100.9' }, DECLARED),
      readTrustedClientAddress({ 'x-test-client-ip': '203.0.113.7,' }, DECLARED),
      readTrustedClientAddress({ 'x-test-client-ip': '' }, DECLARED),
      readTrustedClientAddress({ 'x-test-client-ip': '   ' }, DECLARED),
      readTrustedClientAddress({}, DECLARED),
    ]).toEqual([null, null, null, null, null]);
  });

  it('rule 4: a value net.isIP rejects resolves to null, so nothing unbounded becomes a map key', () => {
    // Node accepts 16 KiB headers, and the return value becomes a local-limiter map key
    // (F-028's memory budget) or a Redis key segment. Invariant 3: every non-null return is at
    // most 45 characters and carries no separator.
    expect([
      readTrustedClientAddress({ 'x-test-client-ip': 'evil.example' }, DECLARED),
      readTrustedClientAddress({ 'x-test-client-ip': '203.0.113' }, DECLARED),
      readTrustedClientAddress({ 'x-test-client-ip': '203.0.113.7:443' }, DECLARED),
      readTrustedClientAddress({ 'x-test-client-ip': 'a'.repeat(16_384) }, DECLARED),
      readTrustedClientAddress({ 'x-test-client-ip': '::ffff:203.0.113.7/24' }, DECLARED),
    ]).toEqual([null, null, null, null, null]);
  });

  it('invariant 2: X-Forwarded-For alone resolves to null with no declared header and with one', () => {
    // The contract's own required test, in its own words: "a request carrying only
    // `X-Forwarded-For: 203.0.113.7` resolves to `null` from `readTrustedClientAddress` ...
    // with no declared header and with one declared".
    const headers = { 'x-forwarded-for': '203.0.113.7' };

    expect([
      readTrustedClientAddress(headers, UNDECLARED),
      readTrustedClientAddress(headers, DECLARED),
      readTrustedClientAddress({ forwarded: 'for=203.0.113.7' }, UNDECLARED),
      readTrustedClientAddress({ forwarded: 'for=203.0.113.7' }, DECLARED),
    ]).toEqual([null, null, null, null]);
  });

  it('invariant 4: it never throws, whatever the headers or the environment contain', () => {
    // A throw here would land inside Express middleware ahead of Better Auth and turn a header
    // an attacker chose into a 500 on the credential surface. `constructor` is a legal header
    // name and, declared and carried as an OWN property, reads like any other; a declared
    // `__proto__` reaches nothing, because a header record's prototype is not a header.
    const hostile: Record<string, string | string[] | undefined> = {
      'x-test-client-ip': undefined,
      constructor: '203.0.113.7',
    };

    expect([
      readTrustedClientAddress(hostile, DECLARED),
      readTrustedClientAddress(hostile, { TRUSTED_CLIENT_IP_HEADER: 'constructor' }),
      readTrustedClientAddress(hostile, { TRUSTED_CLIENT_IP_HEADER: '__proto__' }),
      readTrustedClientAddress(hostile, { TRUSTED_CLIENT_IP_HEADER: 'tostring' }),
      readTrustedClientAddress({}, { TRUSTED_CLIENT_IP_HEADER: undefined }),
    ]).toEqual([null, '203.0.113.7', null, null, null]);
  });
});

describe('the declaration constants', () => {
  it('trusted-client-address.md: the header-name pattern is lowercase, and the two forbidden names are named', () => {
    // These are the values the boot assertion and the read both key on. Pinned once so the
    // two cannot drift apart from each other or from the contract's fence.
    expect({
      env: TRUSTED_CLIENT_IP_HEADER_ENV,
      pattern: TRUSTED_CLIENT_IP_HEADER_PATTERN.source,
      forbidden: [...FORBIDDEN_TRUSTED_HEADERS],
      boundaries: [...CLIENT_TRUST_BOUNDARIES],
      accepts: ['fly-client-ip', 'cf-connecting-ip', 'x-test-client-ip'].every((name) =>
        TRUSTED_CLIENT_IP_HEADER_PATTERN.test(name),
      ),
      rejects: ['X-Real-IP', '-leading', '', 'a'.repeat(65), 'with space'].some((name) =>
        TRUSTED_CLIENT_IP_HEADER_PATTERN.test(name),
      ),
    }).toEqual({
      env: 'TRUSTED_CLIENT_IP_HEADER',
      pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
      forbidden: ['x-forwarded-for', 'forwarded'],
      boundaries: ['proxy', 'direct'],
      accepts: true,
      rejects: false,
    });
  });
});
