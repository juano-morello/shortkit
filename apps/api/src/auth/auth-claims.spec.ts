import { randomUUID } from 'node:crypto';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JSONWebKeySet, JWTPayload } from 'jose';
import { describe, expect, it, beforeAll } from 'vitest';

import { isDomainError } from '../common/errors/domain-error';
import { ACCEPTED_JWT_ALGORITHMS, assertClaimShape, verifyAndReadClaims } from './auth-claims';

/**
 * STORY-002 — AC-11, AC-12, AC-13, at the claim layer. TASK-005, wave 4.
 *
 * Contract: `docs/contracts/auth-tokens.md` ("Verification, performed by `AuthGuard`",
 * steps 2 to 6; "Invariants a caller may rely on", 3 and 4). ADR-0013, ADR-0015 (F-029).
 *
 * Tokens are signed IN THE TEST with a key pair generated here, and the key set handed to
 * `verifyAndReadClaims` is that pair's public half — the same `{ keys: [...] }` shape
 * `GET /api/auth/jwks` serves, algorithm included. `better-auth@1.6.26` signs `EdDSA` over
 * `Ed25519` by default (`dist/plugins/jwt/utils.mjs:21-23`) and `auth.config.ts` sets no
 * `keyPairConfig`, so that is the pair generated here. The wire-level 401s these map to are
 * `auth.guard.spec.ts`'s; a real token from a real sign-in is `test/auth/auth-guard.int-spec.ts`'s.
 */

const ISSUER = 'http://127.0.0.1:43111';
const ENV: NodeJS.ProcessEnv = { BETTER_AUTH_URL: ISSUER };

const TENANT_ID = '3f2a9c1e-7b4d-4e8a-9c6f-1d2e3f4a5b6c';
const SESSION_ID = 'sess_1c9f0b7e2d4a6c8b';

let signingKey: CryptoKey;
let keySet: JSONWebKeySet;

/** A second pair the key set does not carry: what a token signed by someone else looks like. */
let strangerKey: CryptoKey;

/** The claim set `auth.config.ts`'s `definePayload` plus better-auth's own `sign.mjs` produce. */
function wellFormedClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    sub: 'user_7d3e2f1a0b9c8d7e',
    tid: TENANT_ID,
    email: 'operator@example.com',
    ev: false,
    jti: SESSION_ID,
    ...overrides,
  };
}

interface SignOptions {
  readonly key?: CryptoKey;
  readonly issuer?: string | null;
  readonly audience?: string | null;
  /** Seconds relative to now. Negative is already expired. Null omits `exp`. */
  readonly expiresIn?: number | null;
}

async function sign(claims: JWTPayload, options: SignOptions = {}): Promise<string> {
  const jwt = new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' }).setIssuedAt();

  if (options.expiresIn !== null) {
    jwt.setExpirationTime(Math.floor(Date.now() / 1000) + (options.expiresIn ?? 300));
  }

  if (options.issuer !== null) {
    jwt.setIssuer(options.issuer ?? ISSUER);
  }

  if (options.audience !== null) {
    jwt.setAudience(options.audience ?? ISSUER);
  }

  return jwt.sign(options.key ?? signingKey);
}

/** The refusal, as the code the filter would render, or `'accepted'`. */
async function outcome(token: string): Promise<string> {
  try {
    await verifyAndReadClaims(token, keySet, ENV);
    return 'accepted';
  } catch (error: unknown) {
    if (isDomainError(error)) {
      return error.code;
    }

    throw error;
  }
}

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  signingKey = pair.privateKey;

  const publicJwk = await exportJWK(pair.publicKey);
  keySet = { keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'test-key' }] };

  strangerKey = (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey;
});

describe('verifyAndReadClaims', () => {
  it('accepts a well-formed token signed by a key in the set and returns its claims', async () => {
    const claims = await verifyAndReadClaims(await sign(wellFormedClaims()), keySet, ENV);

    expect(claims).toMatchObject({
      sub: 'user_7d3e2f1a0b9c8d7e',
      tid: TENANT_ID,
      email: 'operator@example.com',
      ev: false,
      jti: SESSION_ID,
      iss: ISSUER,
      aud: ISSUER,
    });
    expect(typeof claims.exp).toBe('number');
    expect(typeof claims.iat).toBe('number');
  });

  it('only accepts the algorithm the issuer signs with', () => {
    expect(ACCEPTED_JWT_ALGORITHMS).toEqual(['EdDSA']);
  });

  it('AC-11: a signature by a key outside the set is unauthenticated', async () => {
    expect(await outcome(await sign(wellFormedClaims(), { key: strangerKey }))).toBe('unauthenticated');
  });

  it('AC-11: a token whose payload was altered after signing is unauthenticated', async () => {
    const token = await sign(wellFormedClaims());
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify(wellFormedClaims({ tid: randomUUID(), iss: ISSUER, aud: ISSUER, exp: Math.floor(Date.now() / 1000) + 300 }))).toString('base64url');

    expect(await outcome(`${header}.${forged}.${signature}`)).toBe('unauthenticated');
  });

  it('a string that is not a JWT at all is unauthenticated, not a 500', async () => {
    expect(await outcome('not-a-token')).toBe('unauthenticated');
    expect(await outcome('')).toBe('unauthenticated');
  });

  it('AC-12: a validly signed token whose exp has passed is token_expired', async () => {
    expect(await outcome(await sign(wellFormedClaims(), { expiresIn: -5 }))).toBe('token_expired');
  });

  it('AC-12: an expired token signed by a stranger is unauthenticated, because the signature is checked first', async () => {
    // Invariant 4: `token_expired` means the signature verified. Refreshing is the wrong
    // response to a forgery, so the codes have to be distinguishable in this order.
    expect(await outcome(await sign(wellFormedClaims(), { key: strangerKey, expiresIn: -5 }))).toBe('unauthenticated');
  });

  it('a token with no exp at all is unauthenticated', async () => {
    expect(await outcome(await sign(wellFormedClaims(), { expiresIn: null }))).toBe('unauthenticated');
  });

  it('a wrong issuer is unauthenticated', async () => {
    expect(await outcome(await sign(wellFormedClaims(), { issuer: 'http://127.0.0.1:1' }))).toBe('unauthenticated');
    expect(await outcome(await sign(wellFormedClaims(), { issuer: null }))).toBe('unauthenticated');
  });

  it('a wrong audience is unauthenticated', async () => {
    expect(await outcome(await sign(wellFormedClaims(), { audience: 'http://127.0.0.1:1' }))).toBe('unauthenticated');
    expect(await outcome(await sign(wellFormedClaims(), { audience: null }))).toBe('unauthenticated');
  });

  it('an expired token with the wrong issuer is token_expired, because exp is checked before iss', async () => {
    // Step 3 before step 4 in the card's order. jose validates `iss` before `exp` when both
    // are passed as options, so this pins that the implementation does not delegate the
    // order to the library.
    expect(await outcome(await sign(wellFormedClaims(), { issuer: 'http://127.0.0.1:1', expiresIn: -5 }))).toBe('token_expired');
  });

  it('AC-13: an absent, empty or non-uuid tid is unauthenticated', async () => {
    expect(await outcome(await sign(wellFormedClaims({ tid: undefined })))).toBe('unauthenticated');
    expect(await outcome(await sign(wellFormedClaims({ tid: '' })))).toBe('unauthenticated');
    expect(await outcome(await sign(wellFormedClaims({ tid: 'tenant-1' })))).toBe('unauthenticated');
    expect(await outcome(await sign(wellFormedClaims({ tid: 42 })))).toBe('unauthenticated');
  });

  it('AC-13: an upper-cased tid is accepted and returned in canonical lower case', async () => {
    const claims = await verifyAndReadClaims(await sign(wellFormedClaims({ tid: TENANT_ID.toUpperCase() })), keySet, ENV);

    expect(claims.tid).toBe(TENANT_ID);
  });

  it('a missing or empty sub is unauthenticated', async () => {
    expect(await outcome(await sign(wellFormedClaims({ sub: undefined })))).toBe('unauthenticated');
    expect(await outcome(await sign(wellFormedClaims({ sub: '' })))).toBe('unauthenticated');
  });

  it('a non-boolean ev is unauthenticated', async () => {
    expect(await outcome(await sign(wellFormedClaims({ ev: 'true' })))).toBe('unauthenticated');
    expect(await outcome(await sign(wellFormedClaims({ ev: undefined })))).toBe('unauthenticated');
  });

  it('a missing or empty jti is unauthenticated, so the revocation check never receives an empty handle', async () => {
    expect(await outcome(await sign(wellFormedClaims({ jti: undefined })))).toBe('unauthenticated');
    expect(await outcome(await sign(wellFormedClaims({ jti: '' })))).toBe('unauthenticated');
  });

  it('never carries a claim value in the refusal message', async () => {
    const token = await sign(wellFormedClaims({ tid: 'LEAKED-TID', sub: 'LEAKED-SUB', email: 'leaked@example.com' }));

    try {
      await verifyAndReadClaims(token, keySet, ENV);
      expect.unreachable('a malformed tid must be refused');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('LEAKED');
      expect(message).not.toContain('leaked@');
      expect(message).not.toContain(token);
    }
  });
});

describe('assertClaimShape', () => {
  it('narrows a well-formed claim set', () => {
    const claims: unknown = { ...wellFormedClaims(), iss: ISSUER, aud: ISSUER, iat: 1, exp: 2 };

    expect(() => assertClaimShape(claims)).not.toThrow();
  });

  it('refuses a non-object', () => {
    for (const value of [null, undefined, 'claims', 42, []]) {
      expect(() => assertClaimShape(value)).toThrow();
    }
  });

  it('refuses with unauthenticated, never with the tenancy module error', () => {
    try {
      assertClaimShape({ ...wellFormedClaims({ tid: 'not-a-uuid' }), iss: ISSUER, aud: ISSUER, iat: 1, exp: 2 });
      expect.unreachable();
    } catch (error: unknown) {
      expect(isDomainError(error) && error.code === 'unauthenticated').toBe(true);
    }
  });
});
