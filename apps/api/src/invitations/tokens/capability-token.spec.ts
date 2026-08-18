/**
 * TASK-1b-04 — the capability token, the parts decidable without a database.
 *
 * Contract: docs/contracts/invitation-tokens.md ("Token format", "Storage", invariant 5).
 * ADR-0021, ADR-0029, GC-K.
 *
 * Format, issue, digest, parse; every malformed shape; and the ADR-0029 property that no
 * string this module builds carries the input — asserted by handing it recognisable bytes
 * and searching the thrown error's message, name and own enumerable properties for them.
 */
import { createHash } from 'node:crypto';

import { capabilityTokenContract } from '@shortkit/contracts';
import { describe, expect, it } from 'vitest';

import {
  digestOf,
  issueCapabilityToken,
  MALFORMED_MESSAGE,
  MalformedCapabilityToken,
  parseCapabilityToken,
} from './capability-token';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SECRET_43 = 'MARKERsecret_9Qb2vR8pL0mN4kJ7hG3fD1sA6zX2cV';
const RAW = `${TENANT}.${SECRET_43}`;

function ownStrings(error: unknown): string {
  const record = error as Record<string, unknown>;

  return JSON.stringify({
    message: (error as Error).message,
    name: (error as Error).name,
    stack: (error as Error).stack,
    ...Object.fromEntries(Object.entries(record)),
  });
}

describe('issueCapabilityToken', () => {
  it('mints <tenantId>.<43 base64url chars>, 80 characters, matching the wire contract', () => {
    const { raw } = issueCapabilityToken(TENANT);

    expect(raw).toHaveLength(80);
    expect(raw.startsWith(`${TENANT}.`)).toBe(true);
    expect(raw.slice(37)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(capabilityTokenContract.safeParse(raw).success).toBe(true);
  });

  it('returns the SHA-256 of the SECRET HALF ONLY as a 32-byte Buffer', () => {
    const { raw, digest } = issueCapabilityToken(TENANT);
    const secret = raw.slice(37);

    expect(Buffer.isBuffer(digest)).toBe(true);
    expect(digest).toHaveLength(32);
    expect(digest.equals(createHash('sha256').update(secret, 'utf8').digest())).toBe(true);
    // Not the whole token: the tenant id is a column already.
    expect(digest.equals(createHash('sha256').update(raw, 'utf8').digest())).toBe(false);
  });

  it('two mints never share a secret or a digest', () => {
    const first = issueCapabilityToken(TENANT);
    const second = issueCapabilityToken(TENANT);

    expect(first.raw).not.toBe(second.raw);
    expect(first.digest.equals(second.digest)).toBe(false);
  });

  it('lower-cases the tenant half and refuses a non-uuid with a message naming no value', () => {
    expect(issueCapabilityToken(TENANT.toUpperCase()).raw.startsWith(`${TENANT}.`)).toBe(true);

    let thrown: unknown;
    try {
      issueCapabilityToken('MARKER-not-a-uuid');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(ownStrings(thrown)).not.toContain('MARKER');
  });
});

describe('digestOf', () => {
  it('is deterministic SHA-256 over the utf8 secret', () => {
    expect(digestOf(SECRET_43).equals(createHash('sha256').update(SECRET_43).digest())).toBe(true);
    expect(digestOf(SECRET_43).equals(digestOf(SECRET_43))).toBe(true);
    expect(digestOf(SECRET_43).equals(digestOf(`${SECRET_43.slice(0, 42)}A`))).toBe(false);
  });
});

describe('parseCapabilityToken', () => {
  it('splits on the first dot into a lower-cased tenant id and the secret', () => {
    expect(parseCapabilityToken(RAW)).toEqual({ tenantId: TENANT, secret: SECRET_43 });
    expect(parseCapabilityToken(`${TENANT.toUpperCase()}.${SECRET_43}`)).toEqual({
      tenantId: TENANT,
      secret: SECRET_43,
    });
  });

  it('round-trips what issueCapabilityToken mints, and the parsed secret digests to the minted digest', () => {
    const { raw, digest } = issueCapabilityToken(TENANT);
    const parsed = parseCapabilityToken(raw);

    expect(parsed.tenantId).toBe(TENANT);
    expect(digestOf(parsed.secret).equals(digest)).toBe(true);
  });

  const MALFORMED: ReadonlyArray<[string, unknown]> = [
    ['empty', ''],
    ['no separator', `${TENANT}${SECRET_43}`],
    ['separator only', '.'],
    ['missing secret', `${TENANT}.`],
    ['missing tenant', `.${SECRET_43}`],
    ['tenant not a uuid', `MARKER-not-a-uuid.${SECRET_43}`],
    ['tenant one char short', `${TENANT.slice(1)}.${SECRET_43}`],
    ['secret 42 chars', `${TENANT}.${SECRET_43.slice(0, 42)}`],
    ['secret 44 chars', `${TENANT}.${SECRET_43}A`],
    ['secret with padding', `${TENANT}.${SECRET_43.slice(0, 42)}=`],
    ['secret with a dot (second separator)', `${TENANT}.${SECRET_43.slice(0, 20)}.${SECRET_43.slice(21)}`],
    ['secret with a plus (base64, not base64url)', `${TENANT}.${SECRET_43.slice(0, 42)}+`],
    ['secret with a slash', `${TENANT}.${SECRET_43.slice(0, 42)}/`],
    ['leading whitespace', ` ${RAW}`],
    ['trailing newline', `${RAW}\n`],
    ['not a string: undefined', undefined],
    ['not a string: null', null],
    ['not a string: number', 42],
    ['not a string: object', { token: RAW }],
    ['not a string: array', [RAW]],
  ];

  it.each(MALFORMED)('%s → MalformedCapabilityToken with the fixed message', (_name, raw) => {
    let thrown: unknown;
    try {
      parseCapabilityToken(raw as string);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MalformedCapabilityToken);
    expect((thrown as Error).message).toBe(MALFORMED_MESSAGE);
    expect((thrown as Error).name).toBe('MalformedCapabilityToken');
  });

  it('ADR-0029: on every malformed input the thrown error carries none of the input (message, name, own properties, stack)', () => {
    for (const [, raw] of MALFORMED) {
      if (typeof raw !== 'string' || raw === '' || raw === '.') {
        continue;
      }

      let thrown: unknown;
      try {
        parseCapabilityToken(raw);
      } catch (error) {
        thrown = error;
      }

      const surface = ownStrings(thrown);
      expect(surface).not.toContain('MARKER');
      expect(surface).not.toContain(SECRET_43.slice(0, 20));
      expect(surface).not.toContain(TENANT.slice(0, 8));
    }
  });

  it('never throws anything but MalformedCapabilityToken, whatever the input', () => {
    for (const raw of [Symbol('x'), 10n, () => RAW, new Date(), Buffer.from(RAW)]) {
      let thrown: unknown;
      try {
        parseCapabilityToken(raw as unknown as string);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(MalformedCapabilityToken);
    }
  });
});
