/**
 * Contract: `docs/contracts/auth-tokens.md` ("Claim set", "Verification, performed by
 *           `AuthGuard`" steps 2 to 6, "Invariants a caller may rely on" 3 to 5a),
 *           `docs/contracts/error-envelope.md` (`unauthenticated` and `token_expired` are
 *           both 401, and `token_expired` is the one a client branches on)
 * ADR: adr-0013-better-auth-in-nestjs.md (the claim set, stateless verification against a
 *      cached JWKS), adr-0015 (F-029: the claim-shape backstop), adr-0024 (a refusal is a
 *      `DomainError` and nothing else reaches the filter with a status)
 * Produced by: TASK-005 (wave 4). Called by `auth.guard.ts` and by nothing else.
 *
 * ============================================================================
 * SIGNATURE, THEN EXPIRY, THEN ISSUER AND AUDIENCE, THEN SHAPE. THE ORDER IS THE CONTRACT.
 * ============================================================================
 *
 * `auth-tokens.md` invariant 4: "`token_expired` means the signature verified and the clock
 * passed `exp`. Refreshing is the correct response. `unauthenticated` means it is not, and
 * re-login is." A forged token that also happens to be expired must therefore answer
 * `unauthenticated`, which is only true if the signature is checked before `exp`; jose does
 * that. And an expired token whose `iss` is also wrong must answer `token_expired`, which
 * jose does NOT do on its own: `jwt_claims_set.js` validates `iss` and `aud` before `exp`
 * when they are passed as options. So `iss` and `aud` are checked here, after `jwtVerify`
 * returns, and are never passed to it. `auth-claims.spec.ts` pins both orders.
 *
 * ============================================================================
 * THE ALGORITHM LIST IS CLOSED, AND IT IS THE ONE THE ISSUER USES.
 * ============================================================================
 *
 * `better-auth@1.6.26` signs `EdDSA` over `Ed25519` unless `jwks.keyPairConfig` says
 * otherwise (`dist/plugins/jwt/utils.mjs:21-23`, `sign.mjs:44`), and `auth.config.ts` sets
 * no `keyPairConfig`. Passing `algorithms` to jose closes the alg-confusion class outright:
 * a token whose header names anything else is refused before a key is looked up, whatever
 * the key set carries. A later change to the issuer's algorithm has to change this list in
 * the same commit, and the wave-4 spec that signs `EdDSA` will say so loudly.
 *
 * ============================================================================
 * NO REFUSAL MESSAGE CARRIES A CLAIM VALUE, AND NOTHING HERE LOGS.
 * ============================================================================
 *
 * A `DomainError`'s message goes to the body verbatim and to the log with
 * `includeMessage: true` (`exception-filter.ts`), and `msg` is the one key
 * `LOGGABLE_FIELDS` cannot censor. Every message below is a fixed string. jose's own
 * errors quote nothing from the payload in their messages either, but they are wrapped
 * anyway: as `cause`, which never reaches the body, and reaches a log line only where the
 * filter chooses to log a refusal at all (today it does not log an ordinary 401), so a
 * library upgrade cannot change what a stranger sees.
 */
import { createLocalJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import type { JSONWebKeySet, JWTPayload } from 'jose';
import type { ShortkitJwtClaims } from '@shortkit/contracts';

import { DomainError } from '../common/errors/domain-error';
import { InvalidTenantIdError, assertUuid } from '../tenancy/tenant-context';

/** The one algorithm the issuer signs with; see the docblock. */
export const ACCEPTED_JWT_ALGORITHMS: readonly string[] = ['EdDSA'];

/**
 * The messages, as fixed strings. A client renders per code and never branches on these
 * (`error-envelope.md` invariant 3); they exist so a human reading a body sees which of the
 * two 401s it is.
 */
export const UNAUTHENTICATED_MESSAGE = 'Authentication is required.';
export const TOKEN_EXPIRED_MESSAGE = 'The access token has expired.';

/**
 * Steps 2 to 6 of `auth-tokens.md`'s verification, in that order, and the shape check that
 * makes the return type honest.
 *
 * `keySet` is the JSON the process's own `/api/auth/jwks` served, handed in by the guard
 * from `jwks-cache.ts`; nothing here fetches. `env` is where the expected `iss` and `aud`
 * come from: `BETTER_AUTH_URL`, normalised to its origin exactly as
 * `boot-assertions.ts`'s `betterAuthUrl()` normalises it (`new URL(value).origin`), because
 * that is the value `auth.config.ts` writes into both claims. The guard passes `process.env`;
 * a spec passes its own. Boot has already refused an unset or malformed value before a
 * request can reach here, so a bad `env` is a programming error rather than a caller fault
 * and is thrown as one (a plain `Error`, so a 500 and not a 401).
 *
 * Throws `DomainError('token_expired')` when the signature verified and `exp` has passed,
 * and `DomainError('unauthenticated')` for every other refusal. Anything that is not a
 * refusal (a `keySet` that is not a key set, a missing binding) propagates as itself.
 */
export async function verifyAndReadClaims(
  token: string,
  keySet: JSONWebKeySet,
  env: NodeJS.ProcessEnv,
): Promise<ShortkitJwtClaims> {
  const expectedOrigin = declaredOrigin(env);

  // Outside the `try`: a key set that is not a key set is `jwks-cache.ts`'s failure, not a
  // verdict on the token, and jose reports it as a `JWKSInvalid` that would otherwise be
  // read as a refusal below.
  const keys = createLocalJWKSet(keySet);

  let payload: JWTPayload;
  try {
    // `requiredClaims: ['exp']`: jose treats a missing `exp` as "no expiry to check", which
    // would let a token with no `exp` live forever. The issuer always sets one (`sign.mjs`,
    // `setExpirationTime`), so its absence is a forgery or a bug and is refused either way.
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: [...ACCEPTED_JWT_ALGORITHMS],
      requiredClaims: ['exp'],
    }));
  } catch (error: unknown) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new DomainError('token_expired', TOKEN_EXPIRED_MESSAGE, { cause: error });
    }

    if (isJoseRefusal(error)) {
      throw new DomainError('unauthenticated', UNAUTHENTICATED_MESSAGE, { cause: error });
    }

    // Not a verdict on the token: a key set that is not a key set, a `TypeError` from a
    // malformed JWK, an internal failure. The filter's branch 4 answers 500 for it, which is
    // the honest status for "could not verify" (F-245's rule: not the same as "verified bad").
    throw error;
  }

  // Step 4: after `exp`, see the docblock. `aud` is a single string on every token this
  // issuer mints (`sign.mjs:45`, one `setAudience` value; `packages/contracts` note 3), so an
  // array is refused rather than searched.
  if (payload.iss !== expectedOrigin || payload.aud !== expectedOrigin) {
    throw new DomainError('unauthenticated', UNAUTHENTICATED_MESSAGE);
  }

  assertClaimShape(payload);

  // The canonical form: `assertUuid` accepts either case and returns lower case, and every
  // later comparison against a row's `tenant_id` is a string equality (F-130). Returned as a
  // fresh object so nothing downstream holds jose's payload.
  return { ...payload, tid: assertUuid(payload.tid) };
}

/**
 * Step 6 of `auth-tokens.md`'s verification: the backstop ADR-0015's F-029 correction added.
 * Without it a tid-less or malformed-tid token passes the guard and is stopped one layer down
 * by `withTenantTransaction`'s own uuid validation, surfacing as a 500 instead of a 401.
 *
 * ============================================================================
 * THE `tid` PREDICATE IS `assertUuid`, DELIBERATELY, AND NOT `shortkitJwtClaimsContract`.
 * ============================================================================
 *
 * This check exists to pre-empt `withTenantTransaction`'s check, so it has to be THE SAME
 * predicate: a value this accepts must be one `assertUuid` accepts, or the 500 comes back
 * for the values in the gap. `z.string().uuid()` in the contract is stricter (it enforces the
 * RFC variant bits) and would be fine for every tenant `randomUUID()` mints, but "fine for
 * every value we mint today" is not the same property as "the same predicate as the layer
 * below". The other reason not to `safeParse` the whole contract here is `email`: it is
 * validated at signup by better-auth's own zod and re-validating its FORMAT on every request
 * makes a disagreement between two zod builds lock a real account out of every route. What
 * the card asks for is asserted (`tid` uuid-shaped, `sub` non-empty, `ev` boolean) plus
 * the structural presence of the rest, which is what `asserts claims is ShortkitJwtClaims`
 * promises. `jti` non-empty is load-bearing: `revocation-store.md` gives `''` its own row,
 * and this is what keeps the guard from ever asking about it.
 *
 * Refuses with `unauthenticated`. `InvalidTenantIdError` never escapes: it is the tenancy
 * module's error and would render as a 500.
 */
export function assertClaimShape(claims: unknown): asserts claims is ShortkitJwtClaims {
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    throw new DomainError('unauthenticated', UNAUTHENTICATED_MESSAGE);
  }

  const record = claims as Record<string, unknown>;

  const wellFormed =
    isNonEmptyString(record.sub) &&
    isNonEmptyString(record.tid) &&
    typeof record.email === 'string' &&
    typeof record.ev === 'boolean' &&
    isNonEmptyString(record.jti) &&
    typeof record.iat === 'number' &&
    typeof record.exp === 'number' &&
    isNonEmptyString(record.iss) &&
    isNonEmptyString(record.aud);

  if (!wellFormed) {
    throw new DomainError('unauthenticated', UNAUTHENTICATED_MESSAGE);
  }

  try {
    assertUuid(record.tid as string);
  } catch (error: unknown) {
    if (error instanceof InvalidTenantIdError) {
      // `cause` reaches the log's `err_*` fields, and `InvalidTenantIdError`'s message quotes
      // at most eight characters of the value (its own REPORTED_PREFIX_LENGTH), which is the
      // bound that module already accepted for exactly this reason.
      throw new DomainError('unauthenticated', UNAUTHENTICATED_MESSAGE, { cause: error });
    }

    throw error;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Every jose error class is a verdict on the token (malformed compact serialisation, an
 * unknown `kid`, an algorithm off the list, a signature that does not verify, a claim
 * check), and all of them are `unauthenticated` except `JWTExpired`, handled before this
 * is asked. Anything else that escapes `jwtVerify` is not a verdict.
 */
function isJoseRefusal(error: unknown): boolean {
  return error instanceof joseErrors.JOSEError;
}

/**
 * The origin `iss` and `aud` must equal. Same normalisation as `betterAuthUrl()`; see the
 * function docblock above for why it is read from `env` here rather than through the
 * accessor.
 */
function declaredOrigin(env: NodeJS.ProcessEnv): string {
  const value = env.BETTER_AUTH_URL;

  if (value === undefined || value.trim() === '') {
    throw new Error('BETTER_AUTH_URL is not set, so no issuer can be verified. Boot should have refused this process.');
  }

  return new URL(value.trim()).origin;
}
