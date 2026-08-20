/**
 * Contract: `docs/contracts/rate-limit.md` ("The email bucket runs inside Better Auth, not in
 *           Express", "`ctx.body` is unvalidated at hook time", "The email key is normalised,
 *           and both failure modes are tested", "Response on limit"),
 *           `docs/contracts/auth-config-surface.md` (invariants 3, 4, 5)
 * ADR: adr-0013 (the `hooks.before` registry; F-019, F-025, F-027, F-228), adr-0012 (the
 *      degradation posture), adr-0055 (an `APIError` and nothing else), adr-0040
 * Produced by: TASK-1b-09 (item 1b, wave 3; D-15). Appended FIRST to `beforeHooks` by
 *              `auth.config.ts`; bound to the port by `main.ts` beside the mount.
 *
 * ============================================================================
 * THE ONE BUCKET ON THE AUTH SURFACE THAT IS KEYED ON THE BODY, SO IT LIVES INSIDE THE
 * FRAMEWORK THAT OWNS THE BODY (F-019).
 * ============================================================================
 *
 * `authRateLimit` in Express reads headers only: reading the JSON body there consumes the
 * stream Better Auth needs. So the email-keyed sign-in bucket (5 per 15 minutes) runs as a
 * `hooks.before` middleware, where `ctx.body` has already been parsed, and it runs FIRST
 * in the registry, ahead of invitation validation, so an attacker cannot use invitation
 * probing to bypass it (ADR-0013's ordering rule, D-15).
 *
 * ============================================================================
 * TWO WAYS THIS BUCKET FAILS SILENTLY, AND WHAT PINS EACH (F-025).
 * ============================================================================
 *
 * (a) THE KEY. It is computed over the same normalised form Better Auth uses for its account
 *     lookup (`trim()` then `toLowerCase()`, nothing else), and then hashed, so the keyspace
 *     holds no addresses and `Foo@x.com` / `foo@x.com` share one allowance. No dot-removal,
 *     no `+tag` removal: two addresses differing that way may be two real accounts at some
 *     providers, and collapsing them lets one user's failures lock out another's.
 * (b) THE PREDICATE. `ctx.path === '/sign-in/email'` is base-path-relative inside Better
 *     Auth. If that assumption were wrong the hook would return on every request and the
 *     bucket would silently not exist, which is why `test/auth/sign-in-email-bucket.int-spec.ts`
 *     drives six real sign-ins through the child and asserts the sixth is 429.
 *
 * ============================================================================
 * `ctx.body` IS UNVALIDATED HERE, AND THIS HOOK NEVER THROWS ANYTHING BUT `APIError` (F-228).
 * ============================================================================
 *
 * `hooks.before` runs AHEAD of the endpoint's zod validation. Probes against 1.6.26
 * delivered `ctx.body.email` as an object, as a number, and `ctx.body` as `undefined`.
 * `normaliseEmailForKey` accepts `unknown` and answers `null` for every non-string and for
 * a string that trims to empty; on `null` the hook RETURNS WITHOUT CHARGING and the endpoint
 * answers the 400 it would have answered anyway. It does not key on a sentinel: a shared
 * sentinel bucket lets one caller's malformed traffic exhaust an allowance every other caller
 * falls into. A `TypeError` from `.trim()` on a number would be rethrown by
 * `dispatch.mjs:86-89` as a body-less 500, uncharged, ahead of every later hook: an
 * unauthenticated 500 generator on the credential surface.
 *
 * ============================================================================
 * THE PORT IS BOUND, NOT CONSTRUCTED. ONE LIMITER, ONE MAP.
 * ============================================================================
 *
 * `main.ts` resolves `AUTH_RATE_LIMIT_PORT` from the Nest graph and hands it to
 * `authRateLimit`; the same instance is handed here through `bindEmailRateLimitPort` beside
 * the mount. A second `LocalAuthRateLimiter` for this hook is rejected: two instances are
 * two maps with two memory bounds. The hooks run outside the Nest graph and can inject
 * nothing (ADR-0013), which is why this is a module-scope binding rather than a provider.
 * UNBOUND: the unit tier composes `auth.config.ts` without ever running `main.ts`: the
 * hook degrades OPEN with a warn line once per minute, the same posture the Express
 * middleware takes when its store fails (ADR-0012, rate-limit.md invariant 5). Nothing on
 * that line names the address or the key.
 *
 * ============================================================================
 * THE BUCKET COUNTS FAILED ATTEMPTS: A SUCCESS RELEASES ITS CHARGE (architect ruling, 2026-08-18).
 * ============================================================================
 *
 * `rate-limit.md`'s stated consequence is "five FAILED attempts per fifteen minutes"; charging
 * successes would lock out an operator who signs in six times in a window. The before hook
 * cannot know the outcome, so it always charges, and `emailRateLimitReleaseHook` (the one
 * `afterHooks` entry) releases the charge on `/sign-in/email` when the endpoint returned
 * WITHOUT an `APIError` (`ctx.context.returned` is the endpoint's value on success and the
 * thrown `APIError` on failure, measured on 1.6.26; the numeric status is not on the context).
 * A 401, a 400, a 403 all stay charged; a 429 from this hook never reaches the after hooks at
 * all. So the sixth attempt after five failures is refused whatever the password is: the
 * account is locked for the rest of the window, which is the DoS cost the contract accepts,
 * and a success costs nothing durable. `release` is idempotent, floors at zero, and a store
 * failure there degrades open with a warn: the un-released charge expires with the window.
 *
 * ============================================================================
 * THE 429 CARRIES `retryAfterSeconds` IN THE BODY (F-027), AND ITS MESSAGE IS FIXED (F-216).
 * ============================================================================
 *
 * The mount sits outside Nest, so this refusal never passes the exception filter; the web
 * client's `mapBetterAuthError` reads `Retry-After` first and the body field second. The
 * header is set on the `APIError` as well, best effort (the framework does not guarantee
 * it survives), and the body field is the one the contract requires. The message reaches
 * `console` uncensored through better-auth's package logger (F-216), so it is a constant
 * that names no value.
 */
import { createHash } from 'node:crypto';

import { APIError, isAPIError } from 'better-auth/api';

import { errorLogFields, logger } from '../observability/logger';
import type { AuthAfterHook, AuthBeforeHook } from './before-hook';
import { AuthRateLimitExceededError } from './ports/auth-rate-limit.port';
import type { AuthRateLimitBucket, AuthRateLimitCharge, AuthRateLimitPort } from './ports/auth-rate-limit.port';

/**
 * The base-path-relative endpoint path Better Auth reports on `ctx.path` for
 * `POST /api/auth/sign-in/email`. Asserted against a real request by the integration test,
 * because a wrong literal here is a limiter that quietly does not exist (F-025 b).
 */
export const SIGN_IN_EMAIL_PATH = '/sign-in/email';

/** The bucket this hook charges. Named once, so the port and the hook cannot disagree. */
export const EMAIL_RATE_LIMIT_BUCKET: AuthRateLimitBucket = 'signInPerEmail';

/**
 * A FIXED STRING (F-216, GC-K). It reaches `console` through better-auth's package-level
 * logger on the `onError` path and the response body verbatim; nothing is interpolated.
 */
export const EMAIL_RATE_LIMITED_MESSAGE =
  'Too many sign-in attempts for this account. Try again shortly.';

/**
 * The `code` on the 429 body, `rate-limit.md` "Response on limit". The web's
 * `mapBetterAuthError` keys on the status for a 429, so this is for the human reading the
 * body and for the contract's table, not for the client's branch.
 */
export const EMAIL_RATE_LIMITED_CODE = 'rate_limited';

/** How often the unbound-port / store-failure warn line is written. Once a minute. */
const DEGRADED_WARN_INTERVAL_MS = 60_000;

/**
 * The bucket's key form: `email.trim().toLowerCase()`, or `null` for anything that is not a
 * non-empty string after trimming. Accepts `unknown` because `ctx.body` is unvalidated
 * (F-228) and NEVER THROWS.
 *
 * | Input | Returns |
 * |---|---|
 * | a string that trims to non-empty | `email.trim().toLowerCase()` |
 * | a string that trims to empty | `null` |
 * | any non-string: `undefined`, `null`, numbers, objects, arrays | `null` |
 */
export function normaliseEmailForKey(email: unknown): string | null {
  if (typeof email !== 'string') {
    return null;
  }

  const normalised = email.trim().toLowerCase();

  return normalised === '' ? null : normalised;
}

/**
 * The key the bucket is charged under: hex SHA-256 of the normalised address, so the
 * limiter's keyspace (and any store behind a future port) holds no addresses.
 */
export function emailRateLimitKey(normalisedEmail: string): string {
  return createHash('sha256').update(normalisedEmail, 'utf8').digest('hex');
}

let boundPort: AuthRateLimitPort | undefined;
let lastDegradedWarnAt = Number.NEGATIVE_INFINITY;

/**
 * The charge the before hook made, carried to the after hook of THE SAME REQUEST. Keyed on
 * `ctx.context`: the per-request `AuthContext` copy `dispatchAuthEndpoint` builds
 * (`internalContext.context`, measured on 1.6.26) and hands to both hooks by reference, so
 * nothing is written onto the framework's object and an entry dies with the request. Why the
 * charge travels rather than being recomputed (review of TASK-1b-09): a release computed
 * from "now" could land in a NEWER window when the window rolled between the charge and the
 * release, and decrement an unrelated attempt's charge there. `release` acts only on the
 * charged window. If the framework ever stopped sharing the reference the after hook would
 * find no charge and release nothing: a refund that fails safe, and one
 * `sign-in-email-bucket.int-spec.ts`'s six-successes test would report.
 */
const pendingCharges = new WeakMap<object, AuthRateLimitCharge>();

/**
 * Hands the hook the ONE `AuthRateLimitPort` instance the process has. Called from `main.ts`
 * beside the mount, after `AUTH_RATE_LIMIT_PORT` is resolved and before the server listens.
 * Calling it again replaces the binding; the unit tier does that with a fake.
 */
export function bindEmailRateLimitPort(port: AuthRateLimitPort): void {
  boundPort = port;
}

/**
 * The first entry of `beforeHooks`. Applies to `/sign-in/email` only; charges
 * `signInPerEmail` under the hashed normalised address; refuses with a 429 `APIError`
 * carrying `retryAfterSeconds`; degrades open, with signal, on an unbound port or a store
 * failure. Throws an `APIError` and nothing else.
 */
export const emailRateLimitHook: AuthBeforeHook = async (ctx) => {
  if (ctx.path !== SIGN_IN_EMAIL_PATH) {
    return;
  }

  const normalised = normaliseEmailForKey(readEmail(ctx.body));

  if (normalised === null) {
    // F-228: not charged, not refused. The endpoint's own validation answers the 400.
    return;
  }

  const port = boundPort;

  if (port === undefined) {
    signalDegraded(
      'the email-keyed sign-in bucket has no bound limiter, so a sign-in proceeded without ' +
        'it (auth/email-rate-limit-hook.ts, bindEmailRateLimitPort). Suppressed for the next minute.',
    );
    return;
  }

  try {
    const charge = await port.check(EMAIL_RATE_LIMIT_BUCKET, emailRateLimitKey(normalised));
    const requestScope = requestScopeOf(ctx);

    if (requestScope !== undefined) {
      pendingCharges.set(requestScope, charge);
    }
  } catch (error: unknown) {
    if (error instanceof AuthRateLimitExceededError) {
      throw new APIError(
        'TOO_MANY_REQUESTS',
        {
          code: EMAIL_RATE_LIMITED_CODE,
          message: EMAIL_RATE_LIMITED_MESSAGE,
          retryAfterSeconds: error.retryAfterSeconds,
        },
        { 'Retry-After': String(error.retryAfterSeconds) },
      );
    }

    // Never a 5xx from the limiter (ADR-0012, rate-limit.md invariant 5). The local store
    // cannot fail, so today this line is unreachable; it is the posture a store-backed port
    // inherits, and the line is what makes the degradation visible. No message on the line:
    // the values in scope are an address and its hash.
    logger.warn(
      errorLogFields(error, { includeMessage: false }),
      'the auth rate-limit store failed to answer; the request proceeded without a limit',
    );
  }
};

/**
 * The one entry of `afterHooks`. Applies to `/sign-in/email` only; when the endpoint returned
 * without an `APIError`, gives back the charge the before hook made under the same key. NEVER
 * THROWS: a throw here would turn a completed sign-in into a 500, so every failure (an
 * unbound port, a store rejection) is a warn line and a charge that expires with the window.
 */
export const emailRateLimitReleaseHook: AuthAfterHook = async (ctx) => {
  if (ctx.path !== SIGN_IN_EMAIL_PATH) {
    return;
  }

  const normalised = normaliseEmailForKey(readEmail(ctx.body));

  if (normalised === null) {
    // Nothing was charged for a non-string address (F-228), so there is nothing to release.
    return;
  }

  const requestScope = requestScopeOf(ctx);
  const charge = requestScope === undefined ? undefined : pendingCharges.get(requestScope);

  if (requestScope !== undefined) {
    pendingCharges.delete(requestScope);
  }

  if (!signInSucceeded(ctx)) {
    // A failed attempt is exactly what the bucket counts. The charge stands.
    return;
  }

  if (charge === undefined) {
    // Nothing was charged for this request (unbound port, or no charge reached this hook), so
    // there is nothing to release. Never a decrement computed from "now".
    return;
  }

  const port = boundPort;

  if (port === undefined) {
    // Unreachable in practice: a charge exists only if a port was bound when it was made.
    return;
  }

  try {
    await port.release(EMAIL_RATE_LIMIT_BUCKET, emailRateLimitKey(normalised), charge);
  } catch (error: unknown) {
    logger.warn(
      errorLogFields(error, { includeMessage: false }),
      'the auth rate-limit store failed to answer a release; the sign-in succeeded and the charge stands until the window ends',
    );
  }
};

/**
 * "The endpoint returned without an `APIError`". Measured on 1.6.26 (`api/dispatch.mjs`):
 * `dispatchAuthEndpoint` stores the endpoint's return value on `context.returned` and, when
 * the endpoint threw an `APIError`, stores THAT ERROR there instead, then runs the after
 * hooks. The numeric status is not exposed to the hook, so this is the success signal, and it
 * reads defensively because the context is a large structural type (F-228's posture).
 */
function signInSucceeded(ctx: { readonly context?: unknown }): boolean {
  const context = ctx.context;

  if (typeof context !== 'object' || context === null) {
    return false;
  }

  const returned: unknown = (context as { readonly returned?: unknown }).returned;

  return returned !== undefined && !isAPIError(returned);
}

/** The per-request object both hooks share (`ctx.context`), or `undefined` if it is not one. */
function requestScopeOf(ctx: { readonly context?: unknown }): object | undefined {
  const context = ctx.context;

  return typeof context === 'object' && context !== null ? context : undefined;
}

/**
 * `body.email` off an unvalidated body, or `undefined` for anything that is not an object
 * with that key. Never throws: `ctx.body` is whatever the client sent (F-228).
 */
function readEmail(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  return (body as { readonly email?: unknown }).email;
}

/** One warn line a minute, fixed text, nothing about the request on it. */
function signalDegraded(message: string): void {
  const now = Date.now();

  if (now - lastDegradedWarnAt >= DEGRADED_WARN_INTERVAL_MS) {
    lastDegradedWarnAt = now;
    logger.warn(message);
  }
}
