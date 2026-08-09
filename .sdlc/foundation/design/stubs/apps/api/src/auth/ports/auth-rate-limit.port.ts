/**
 * Contract: design/contracts/rate-limit.md
 * ADR: adr-0013-better-auth-in-nestjs.md, adr-0012, adr-0011 (same port pattern)
 * Produced by: TASK-009 (port + call sites + LocalAuthRateLimiter)
 * Implemented by: TASK-051 (RedisAuthRateLimiter, bound in app.module.ts)
 *
 * ============================================================================
 * F-024. THE INJECTION ORDER. This port exists to solve a wave-ordering problem.
 * ============================================================================
 *
 * The email hook lives inside betterAuth() in apps/api/src/auth/** — TASK-009's files,
 * wave 2. `redisClient` does not exist until TASK-030, wave 6. TASK-051, wave 10,
 * cannot write TASK-009's files. Nobody owned the bucket and nothing said how a wave-2
 * mount reaches a wave-6 dependency, so the predictable outcome was that it never got
 * built — landing back on F-019's failure of 10,000 guesses per 5 minutes against one
 * account with every IP bucket satisfied.
 *
 * THE AUTH MODULE DECLARES THE PORT, exactly as the redirect module declares its
 * branding port (ADR-0011). The mount and the hook call through the token and never
 * touch redisClient.
 *
 *   wave 2   TASK-009  declares this port, wires all three call sites to it, binds
 *                      LocalAuthRateLimiter — a REAL in-process token bucket, same
 *                      algorithm, same limits, per machine rather than per fleet.
 *   wave 6   TASK-030  produces redisClient.
 *   wave 10  TASK-051  binds RedisAuthRateLimiter to the same token. The local one
 *                      stays bound as the degraded fallback ADR-0012 already requires.
 *
 * THERE IS NO UNPROTECTED WINDOW AND NO NO-OP DEFAULT. TASK-051 upgrades the bucket
 * from per-machine to per-fleet; it does not introduce it.
 *
 * NOT @Optional(). Unlike ADR-0011's branding port, an unbound token FAILS AT BOOT:
 * an absent limiter is a security failure, not a cosmetic one.
 */
import type { RateLimitDecision } from '../../common/rate-limit/rate-limit.types';

export const AUTH_RATE_LIMIT_PORT = Symbol('AUTH_RATE_LIMIT_PORT');

export type AuthRateLimitBucket =
  | 'signInPerIp'
  | 'signInPerEmail'
  | 'signUpPerIp'
  | 'otherPerIp';

export interface AuthRateLimitPort {
  /**
   * `principal` is the platform-trusted client IP for the IP buckets, and
   * sha256(normalisedEmail) for the email bucket. Never a raw address.
   */
  check(bucket: AuthRateLimitBucket, principal: string): Promise<RateLimitDecision>;
}

/**
 * F-025(a). The email key is computed over THE SAME NORMALISED FORM BETTER AUTH USES
 * FOR THE CREDENTIAL LOOKUP, not the raw submitted string.
 *
 * Better Auth lowercases the address for its account lookup, so Foo@x.com and
 * foo@x.com are ONE account. Hashing the raw string mints a fresh allowance per casing
 * and an attacker varying the case of the local part never binds.
 *
 * Case folding and surrounding whitespace ONLY. Nothing else is stripped: no
 * dot-removal, no +tag removal. Two addresses differing that way may be two real
 * accounts at some providers, and collapsing them would let one user's failed logins
 * lock out another's.
 *
 * ============================================================================
 * F-228. THE PARAMETER IS `unknown` AND THE RETURN IS NULLABLE. DO NOT NARROW IT.
 * ============================================================================
 *
 * The only caller is the `hooks.before` email bucket, and `hooks.before` runs BEFORE
 * better-auth's zod validation. Probed against better-auth@1.6.26, the hook received
 * `ctx.body.email` as an object, as a number, and `ctx.body` itself as `undefined` —
 * each time BEFORE the endpoint returned its 400.
 *
 * `.trim()` on any of those throws a TypeError, and
 * better-auth/dist/api/dispatch.mjs:86-89 RETHROWS anything from a before hook that is
 * not an APIError. So the request aborts before the endpoint runs, the attempt is never
 * charged to the bucket, the caller gets a 500 instead of a 400, and no later entry in
 * `beforeHooks` executes. That hands an unauthenticated caller an unlimited 500
 * generator on the credential surface with the email bucket charging nothing.
 *
 *   non-string, including undefined and null  -> null
 *   string that trims to empty                -> null
 *   otherwise                                 -> email.trim().toLowerCase()
 *
 * The hook RETURNS on null. It does not throw a 429 and it does not key on a sentinel:
 * a shared sentinel bucket lets one caller's malformed traffic exhaust an allowance
 * that legitimate callers fall into. The IP bucket still counts the request and the
 * endpoint still rejects it with the 400 it would have returned anyway.
 */
export function normaliseEmailForKey(_email: unknown): string | null {
  throw new Error('not implemented');
}
