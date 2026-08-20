/**
 * Contract: `docs/contracts/rate-limit.md` ("`/api/auth/*` is covered by a separate
 *           limiter", "Ownership and injection order", "Response on limit")
 * ADR: adr-0013-better-auth-in-nestjs.md, adr-0012, adr-0011 (the port shape)
 * Produced by: TASK-004 (wave 3). Bound to `LocalAuthRateLimiter` in `auth.module.ts`.
 *              `signInPerEmail` added by TASK-1b-09 (item 1b, wave 3). Rebound to a Redis
 *              implementation by TASK-051 (wave 10) without touching the call sites.
 *
 * The auth surface's limiter is reached through this token and never through a store client
 * directly (F-024). That is what lets a wave-3 mount be built against a dependency
 * (`redisClient`, TASK-030) that does not exist yet, and it is why the process-local
 * implementation is bound here rather than the surface left unlimited: from wave 3 the auth
 * surface is limited by the in-process bucket, which is the same implementation ADR-0012
 * already requires for Redis-unavailable degradation. There is no unprotected window and no
 * no-op default.
 *
 * ============================================================================
 * REQUIRED AT BOOT, NOT `@Optional()`. AN UNBOUND TOKEN FAILS STARTUP.
 * ============================================================================
 *
 * ADR-0011's branding port is optional because an absent branding is cosmetic. An absent
 * limiter opens the credential surface, so `main.ts` resolves this token with `app.get()` and
 * a module graph that has not bound it refuses to boot.
 */

export const AUTH_RATE_LIMIT_PORT = Symbol('AUTH_RATE_LIMIT_PORT');

/**
 * ADR-0013's IP-keyed limits, pre-auth and therefore tighter than the 120-per-60s tenant
 * bucket. Fixed windows (`rate-limit.md`, "Limits"): a window boundary admits up to twice the
 * limit across two adjacent windows, documented rather than fixed.
 *
 * THE EMAIL-KEYED SIGN-IN BUCKET (5 per 15 min) IS THE FOURTH ROW, AND IT IS NOT CHARGED
 * FROM EXPRESS. Added 2026-08-18 (TASK-1b-09, D-15). The email is in the body and reading
 * the body from Express consumes the stream Better Auth needs (F-019), so `signInPerEmail`
 * is charged by `emailRateLimitHook` in `auth/email-rate-limit-hook.ts`: the first entry
 * of `beforeHooks`, inside Better Auth, where the framework that owns the body has already
 * parsed it. The key is `sha256(normaliseEmailForKey(email))`, never the address
 * (rate-limit.md, "The email bucket runs inside Better Auth"). Same port, same
 * `LocalAuthRateLimiter` instance as the three IP buckets: `main.ts` hands the resolved
 * port to the hook through `bindEmailRateLimitPort` beside the mount, because a second
 * limiter instance would be a second map with its own memory bound.
 */
export const AUTH_RATE_LIMIT_BUCKETS = {
  /** `POST /api/auth/sign-in/email`, keyed by client IP. */
  signInPerIp: { limit: 10, windowSeconds: 300 },
  /** `POST /api/auth/sign-in/email`, keyed by `sha256(normalised email)`, in `hooks.before`. */
  signInPerEmail: { limit: 5, windowSeconds: 900 },
  /** `POST /api/auth/sign-up/email`, keyed by client IP. */
  signUpPerIp: { limit: 3, windowSeconds: 3600 },
  /** Everything else under `/api/auth/*`, keyed by client IP. */
  otherPerIp: { limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, AuthRateLimitRule>;

export interface AuthRateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export type AuthRateLimitBucket = keyof typeof AUTH_RATE_LIMIT_BUCKETS;

/**
 * The refusal. `check` rejects with this and only this when a bucket is exhausted; the
 * Express middleware maps it to `429` with `Retry-After` and the body `rate-limit.md` fixes for
 * this surface. Any OTHER rejection from `check` is a store failure, and the middleware
 * degrades with signal rather than answering 5xx (ADR-0012).
 *
 * `retryAfterSeconds` is delta-seconds, at least 1, so a client that reads it can wait
 * rather than retrying into the same window.
 */
export class AuthRateLimitExceededError extends Error {
  readonly bucket: AuthRateLimitBucket;
  readonly retryAfterSeconds: number;

  constructor(bucket: AuthRateLimitBucket, retryAfterSeconds: number) {
    super(`auth rate limit exceeded on ${bucket}; retry after ${String(retryAfterSeconds)}s`);
    this.name = 'AuthRateLimitExceededError';
    this.bucket = bucket;
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

/**
 * What `check` charged: the fixed window (its start, epoch milliseconds) the charge landed in.
 * Opaque to callers except `release`, which acts only on that same window. Added 2026-08-18
 * (TASK-1b-09 review): a release computed from "now" could decrement a NEWER window's
 * unrelated charge when the window rolled between the charge and the release.
 */
export interface AuthRateLimitCharge {
  readonly windowStart: number;
}

export interface AuthRateLimitPort {
  /**
   * Charges one request to `key` in `bucket`. Resolves with the charge's window when the
   * request is admitted; rejects with `AuthRateLimitExceededError` when the bucket is
   * exhausted for that key. Callers that never release may ignore the value.
   *
   * `key` is a principal `resolveRateLimitPrincipal` established (never a client-supplied
   * value and never a sentinel) or, for `signInPerEmail`, the hex SHA-256 of the
   * normalised address (`normaliseEmailForKey`), never the address itself. A caller holding
   * `null` does not call this at all: the bucket does not run and the request proceeds
   * (ADR-0040, `trusted-client-address.md`; F-228 for the email hook).
   */
  check(bucket: AuthRateLimitBucket, key: string): Promise<AuthRateLimitCharge>;

  /**
   * Gives back the one charge `check` made against `key` in `bucket`, in `charge`'s window
   * and only there. Added 2026-08-18 (TASK-1b-09, architect ruling): the email-keyed sign-in
   * bucket counts FAILED attempts (`rate-limit.md`'s consequence is "five failed attempts
   * per fifteen minutes"), and the only place the outcome is known is Better Auth's
   * `hooks.after`, so a successful sign-in releases the charge its before hook made.
   *
   * IDEMPOTENT AND NEVER BELOW ZERO: releasing a key whose current entry is not `charge`'s
   * window (the window rolled; an unrelated attempt may have opened the new one) is a NO-OP,
   * as is releasing a key with no entry. NEVER REJECTS THE CALLER'S FLOW in intent: a store
   * failure is the same degrade-open posture `check` has (ADR-0012): the caller logs and
   * proceeds, and the un-released charge expires with the window. The local implementation
   * cannot fail.
   */
  release(bucket: AuthRateLimitBucket, key: string, charge: AuthRateLimitCharge): Promise<void>;
}
