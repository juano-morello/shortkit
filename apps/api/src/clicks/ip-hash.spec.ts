/**
 * AC-2-36 (the three trusted-address cases, verbatim from `click-events.md`), AC-2-37 (the
 * tenant salt and the boot refusal). TASK-2-09, wave 4.
 *
 * Contract: `docs/contracts/click-events.md` ("Client IP: the declared trusted value only",
 * "`ip_hash`"), `trusted-client-address.md` (normative for the read itself, restated
 * nowhere). ADR-0010, ADR-0040; D-2-17.
 *
 * THE HASH IS ASSERTED AGAINST AN INDEPENDENT COMPUTATION, not against a recorded literal:
 * a golden string would go green for a `clickIpHash` that stopped salting with the tenant,
 * as long as the literal was regenerated with it.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CLICK_IP_HASH_KEY_ENV,
  CLICK_IP_HASH_KEY_LENGTH_BYTES,
  ClickIpHashKeyError,
  assertClickIpHashKeyConfigured,
  clickIpHash,
  clickIpHashKeyFor,
  readClickIpHashKey,
} from './ip-hash';
import { UNKNOWN_IP_SENTINEL, trustedClientIp } from './trusted-client-ip';

/**
 * 32 bytes, base64url, generated once for this file. Either hashes nothing but test input.
 *
 * THE TWO DIFFER BEFORE THE LAST CHARACTER, WHICH IS NOT COSMETIC: 43 base64url characters
 * carry 258 bits and a 32-byte key is 256, so the final character's low two bits are dropped
 * on decode. Two "different" keys differing only there decode to the SAME key, which is how
 * this pair was first written and what turned the keyed-ness assertion below green for the
 * wrong reason.
 */
const KEY = 'FIXTURE-click-ip-hash-key-not-a-real-value0';
const OTHER_KEY = 'FIXTURE-click-ip-hash-key-not-another-value';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const VISITOR_IP = '203.0.113.7';

/** The one message shape `ip_hash` is: base64url of an HMAC, truncated to 22 characters. */
function expectedHash(key: string, tenantId: string, ip: string): string {
  return createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(`${tenantId}:${ip}`)
    .digest('base64url')
    .slice(0, 22);
}

describe('clickIpHash (click-events.md, "`ip_hash`")', () => {
  it('is base64url of HMAC-SHA256 over `${tenantId}:${ip}`, truncated to 22 characters', () => {
    const hash = clickIpHash(readClickIpHashKey({ [CLICK_IP_HASH_KEY_ENV]: KEY }) as Buffer, TENANT_A, VISITOR_IP);

    expect(hash).toBe(expectedHash(KEY, TENANT_A, VISITOR_IP));
    expect(hash).toHaveLength(22);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('AC-2-37: the same visitor under two tenants produces two different hashes', () => {
    const key = clickIpHashKeyFor({ [CLICK_IP_HASH_KEY_ENV]: KEY });

    expect(clickIpHash(key, TENANT_A, VISITOR_IP)).not.toBe(clickIpHash(key, TENANT_B, VISITOR_IP));
  });

  it('is keyed: the same tenant and address under two keys produce two different hashes', () => {
    const a = clickIpHashKeyFor({ [CLICK_IP_HASH_KEY_ENV]: KEY });
    const b = clickIpHashKeyFor({ [CLICK_IP_HASH_KEY_ENV]: OTHER_KEY });

    expect(clickIpHash(a, TENANT_A, VISITOR_IP)).not.toBe(clickIpHash(b, TENANT_A, VISITOR_IP));
  });

  it('never returns the address it was given, in any part of the output', () => {
    const key = clickIpHashKeyFor({ [CLICK_IP_HASH_KEY_ENV]: KEY });

    expect(clickIpHash(key, TENANT_A, VISITOR_IP)).not.toContain('203');
  });
});

describe('assertClickIpHashKeyConfigured (D-2-17: a declared binding, refused at boot)', () => {
  function refusalFor(env: NodeJS.ProcessEnv): ClickIpHashKeyError | null {
    try {
      assertClickIpHashKeyConfigured(env);

      return null;
    } catch (error: unknown) {
      return error instanceof ClickIpHashKeyError ? error : null;
    }
  }

  it('accepts 32 bytes of base64url', () => {
    expect(refusalFor({ [CLICK_IP_HASH_KEY_ENV]: KEY })).toBeNull();
  });

  it('AC-2-37: refuses when the variable is unset, empty or whitespace', () => {
    expect(refusalFor({})).toBeInstanceOf(ClickIpHashKeyError);
    expect(refusalFor({ [CLICK_IP_HASH_KEY_ENV]: '' })).toBeInstanceOf(ClickIpHashKeyError);
    expect(refusalFor({ [CLICK_IP_HASH_KEY_ENV]: '   ' })).toBeInstanceOf(ClickIpHashKeyError);
  });

  it('refuses a value that decodes to fewer than 32 bytes, and one that is not base64url', () => {
    expect(refusalFor({ [CLICK_IP_HASH_KEY_ENV]: 'too-short' })).toBeInstanceOf(ClickIpHashKeyError);
    expect(refusalFor({ [CLICK_IP_HASH_KEY_ENV]: `${'a'.repeat(42)}+` })).toBeInstanceOf(
      ClickIpHashKeyError,
    );
  });

  it('carries boot_precondition `click_ip_hash_key` and never quotes the value (ADR-0029)', () => {
    const refusal = refusalFor({ [CLICK_IP_HASH_KEY_ENV]: KEY.slice(0, 20) });

    expect(refusal?.binding).toBe('click_ip_hash_key');
    expect(refusal?.message).not.toContain(KEY.slice(0, 20));
    expect(refusal?.message).toContain(String(CLICK_IP_HASH_KEY_LENGTH_BYTES));
  });

  it('reads no NODE_ENV (GC-B): the refusal is the same whatever it says', () => {
    expect(refusalFor({ NODE_ENV: 'production' })).toBeInstanceOf(ClickIpHashKeyError);
    expect(refusalFor({ NODE_ENV: 'test' })).toBeInstanceOf(ClickIpHashKeyError);
    expect(refusalFor({ NODE_ENV: 'production', [CLICK_IP_HASH_KEY_ENV]: KEY })).toBeNull();
  });
});

describe('clickIpHashKeyFor (absence lands on a key that can do no harm, loudly)', () => {
  it('returns the declared key when one is declared', () => {
    expect(clickIpHashKeyFor({ [CLICK_IP_HASH_KEY_ENV]: KEY })).toEqual(
      Buffer.from(KEY, 'base64url'),
    );
  });

  /**
   * Boot refuses without the variable (`assertClickIpHashKeyConfigured`), so this branch is
   * reachable only by a module graph compiled outside `main.ts`: `app.module.spec.ts`, the
   * integration suites that build `AppModule` in-process. It must never fall back to a
   * CONSTANT: a constant key is a reversible hash on every deployment that shares it.
   */
  it('mints a random 32-byte key per process when the variable is absent, never a constant', () => {
    const first = clickIpHashKeyFor({});
    const second = clickIpHashKeyFor({});

    expect(first).toHaveLength(CLICK_IP_HASH_KEY_LENGTH_BYTES);
    expect(second).toHaveLength(CLICK_IP_HASH_KEY_LENGTH_BYTES);
    expect(first.equals(second)).toBe(false);
  });
});

describe('trustedClientIp (click-events.md; AC-2-36)', () => {
  const declared = { TRUSTED_CLIENT_IP_HEADER: 'x-test-client-ip' };

  it('AC-2-36 case 1: X-Forwarded-For with no declared header resolves to the sentinel', () => {
    expect(trustedClientIp({ 'x-forwarded-for': VISITOR_IP }, {})).toBe(UNKNOWN_IP_SENTINEL);
  });

  it('AC-2-36 case 2: a declared header, only X-Forwarded-For sent, resolves to the sentinel', () => {
    expect(trustedClientIp({ 'x-forwarded-for': VISITOR_IP }, declared)).toBe(UNKNOWN_IP_SENTINEL);
  });

  /** The one assertion separating this resolver from `resolveRateLimitPrincipal` (F-031). */
  it('AC-2-36 case 3: the BFF pair, with a matching proxy-auth secret, resolves to the sentinel', () => {
    const resolved = trustedClientIp(
      { 'x-shortkit-client-ip': VISITOR_IP, 'x-shortkit-proxy-auth': 'the-shared-secret' },
      { ...declared, BFF_PROXY_SECRET: 'the-shared-secret', BFF_TRUST_BOUNDARY: 'bff' },
    );

    expect(resolved).toBe(UNKNOWN_IP_SENTINEL);
  });

  it('returns the declared header value when the deployment declared one and it is an address', () => {
    expect(trustedClientIp({ 'x-test-client-ip': VISITOR_IP }, declared)).toBe(VISITOR_IP);
  });

  it('returns the sentinel for a repeated declared header, which is what an appending proxy makes', () => {
    expect(trustedClientIp({ 'x-test-client-ip': [VISITOR_IP, '198.51.100.9'] }, declared)).toBe(
      UNKNOWN_IP_SENTINEL,
    );
  });

  it('never throws, whatever the header bag holds (invariant 4)', () => {
    expect(() => trustedClientIp({ 'x-test-client-ip': undefined }, declared)).not.toThrow();
    expect(() => trustedClientIp(Object.create(null) as Record<string, string>, declared)).not.toThrow();
  });

  it('the sentinel is not an address, so it can collide with no visitor', () => {
    expect(UNKNOWN_IP_SENTINEL).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
