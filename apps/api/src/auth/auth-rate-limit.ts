/**
 * Contract: `docs/contracts/rate-limit.md` ("`/api/auth/*` is covered by a separate
 *           limiter", "`LocalAuthRateLimiter` is bounded, per bucket", "Response on limit"),
 *           `docs/contracts/trusted-client-address.md` ("What a `null` principal means to each
 *           bucket", "Signal")
 * ADR: adr-0013-better-auth-in-nestjs.md, adr-0012 (degradation posture), adr-0040
 * Produced by: TASK-004 (wave 3). `authRateLimit` is registered once in `main.ts` between
 *              `authBodyCap` and `toNodeHandler(auth)`; `LocalAuthRateLimiter` is bound to
 *              `AUTH_RATE_LIMIT_PORT` in `auth.module.ts`.
 *
 * ============================================================================
 * IP-KEYED ONLY: HEADERS, NEVER THE BODY.
 * ============================================================================
 *
 * Reading the email out of the body from Express middleware would consume the stream Better
 * Auth needs (F-019), so the email-keyed bucket lives inside Better Auth as a `hooks.before`
 * middleware and is item 1b's. This middleware needs only headers: the route to pick a bucket
 * and the principal `resolveRateLimitPrincipal` establishes from `X-Shortkit-Client-IP` under
 * an authenticated BFF or from the declared platform header (F-031, ADR-0040).
 *
 * A `null` PRINCIPAL IS A REAL STATE. The bucket does not run and the request proceeds; it is
 * never keyed on a sentinel, `''` or the peer address, because a shared sentinel bucket lets
 * one caller exhaust an allowance every other caller falls into. In every environment that
 * exists today — compose, CI, local dev — no header is declared, so NO IP-KEYED LIMIT BINDS
 * ANYWHERE. That is ADR-0040's accepted cost, and `authBodyCap` is what still bounds the
 * credential surface there.
 *
 * ============================================================================
 * THE STORE IS PROCESS-LOCAL, AND IT IS THE FLOOR RATHER THAN A STAND-IN.
 * ============================================================================
 *
 * No Redis client exists in this repository (`redisClient` is TASK-030, wave 6). ADR-0012
 * already requires an in-process bucket as the Redis-unavailable degradation, so binding it
 * from wave 3 is the same implementation arriving early: same algorithm, same limits, per
 * machine rather than per fleet. TASK-051 rebinds the token to a Redis implementation and
 * keeps this one as the degraded fallback. `docker compose` runs one `api` container, so per
 * machine and per fleet are the same number today (ADR-0030).
 *
 * NO PATH LOGS A PRINCIPAL. A client IP is a raw IP and is not in `LOGGABLE_FIELDS`
 * (`logging-and-headers.md`, "What may never appear in a log line"); the three warn lines
 * below carry `msg` and, on the store-failure path, the error fields, and nothing else. No
 * field was added to the allowlist for this file: the counters the contracts name are
 * carried in `msg`, because there is no metrics pipeline to increment yet.
 */
import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { RequestHandler } from 'express';

import { TRUSTED_CLIENT_IP_HEADER_ENV, TRUSTED_CLIENT_IP_UNRESOLVED_COUNTER } from '../common/net/trusted-client-address';
import { errorLogFields, logger } from '../observability/logger';
import { AUTH_RATE_LIMIT_BUCKETS, AuthRateLimitExceededError } from './ports/auth-rate-limit.port';
import type { AuthRateLimitBucket, AuthRateLimitPort, AuthRateLimitRule } from './ports/auth-rate-limit.port';
import { resolveRateLimitPrincipal } from './resolve-rate-limit-principal';

/**
 * Per bucket, not total (F-028). Principals here are client IPs, chosen by an
 * UNAUTHENTICATED caller, and an IPv6 /64 is free — so without a cap one live entry per
 * request with nothing to reap it, and an attacker converts a Redis outage into an OOM
 * restart loop while the redirect path is already on its Postgres fallback.
 */
export const LOCAL_AUTH_LIMITER_MAX_PRINCIPALS = 10_000;

/** The sweep is what bounds `signUpPerIp`, whose one-hour window would otherwise hold an hour of distinct IPs. */
export const LOCAL_AUTH_LIMITER_SWEEP_MS = 60_000;

const LOCAL_FORCED_EVICTION_COUNTER = 'local_rate_limit_forced_eviction_total';

const MILLISECONDS_PER_SECOND = 1000;

/** Once per minute, for the reason `resolve-rate-limit-principal.ts` gives for its sibling. */
const UNRESOLVED_WARN_INTERVAL_MS = 60_000;

let lastUnresolvedWarnAt = Number.NEGATIVE_INFINITY;

/**
 * Which bucket a request charges. Method AND path, both exact: `sign-in/email` and
 * `sign-up/email` are Better Auth's own route names, base-path-relative under `/api/auth`,
 * and anything else under the mount — `/token`, `/get-session`, `/sign-out`, `/jwks`, an
 * unknown path Better Auth will 404 — is the general bucket. A `GET` on a sign-in path is
 * not a sign-in attempt and is charged as "other".
 */
function bucketFor(method: string, path: string): AuthRateLimitBucket {
  if (method === 'POST' && path === '/api/auth/sign-in/email') {
    return 'signInPerIp';
  }

  if (method === 'POST' && path === '/api/auth/sign-up/email') {
    return 'signUpPerIp';
  }

  return 'otherPerIp';
}

/**
 * The Express middleware. Resolves a principal, charges the bucket through the port, and on
 * refusal answers the 429 `rate-limit.md` fixes for this surface: `Retry-After` in
 * delta-seconds and a body of `{ code: 'rate_limited', message, retryAfterSeconds }` — the
 * retry value in the body as well as the header, because this surface is mounted outside
 * Nest and `apiClient` normalises both (F-027).
 *
 * `process.env` is read per request rather than captured, so the read and the boot
 * assertion see the same environment and a test can stub it.
 */
export function authRateLimit(port: AuthRateLimitPort): RequestHandler {
  return (req, res, next) => {
    const principal = resolveRateLimitPrincipal(req.headers, process.env);

    if (principal === null) {
      signalUnresolved(process.env);
      next();
      return;
    }

    const bucket = bucketFor(req.method, req.path);

    port.check(bucket, principal).then(
      () => {
        next();
      },
      (error: unknown) => {
        if (error instanceof AuthRateLimitExceededError) {
          res
            .status(429)
            .set('Retry-After', String(error.retryAfterSeconds))
            .json({
              code: 'rate_limited',
              message: 'Too many requests from this address. Try again shortly.',
              retryAfterSeconds: error.retryAfterSeconds,
            });
          return;
        }

        // Never a 5xx from the limiter (ADR-0012, rate-limit.md invariant 5). The local store
        // cannot fail, so today this line is unreachable; it is the posture a store-backed
        // port inherits, and the line is what makes the degradation visible.
        logger.warn(
          errorLogFields(error, { includeMessage: false }),
          'the auth rate-limit store failed to answer; the request proceeded without a limit',
        );
        next();
      },
    );
  };
}

/**
 * The counter every IP-keyed bucket increments on `null`, as a warn line once per minute and
 * ONLY where a header was declared and the read still failed (rules 3 or 4, or a malformed
 * declaration under `direct`). Silent where nothing is declared: that environment is in a
 * stated condition, and one warn per request in `docker compose up` trains a developer to
 * ignore the channel. Neither the header's name nor its value is on the line.
 */
function signalUnresolved(env: Record<string, string | undefined>): void {
  const declared = env[TRUSTED_CLIENT_IP_HEADER_ENV];

  if (declared === undefined || declared.trim() === '') {
    return;
  }

  const now = Date.now();

  if (now - lastUnresolvedWarnAt >= UNRESOLVED_WARN_INTERVAL_MS) {
    lastUnresolvedWarnAt = now;
    logger.warn(
      `${TRUSTED_CLIENT_IP_UNRESOLVED_COUNTER}: a trusted client header is declared and a request ` +
        'under /api/auth resolved no address from it (absent, repeated, comma-joined, or not an ' +
        'IP), so its IP-keyed bucket did not run and the request proceeded ' +
        '(docs/contracts/trusted-client-address.md, ADR-0040). Suppressed for the next minute.',
    );
  }
}

interface Entry {
  /** The fixed window this count belongs to, as its start in epoch milliseconds. */
  windowStart: number;
  count: number;
}

/**
 * The process-local store. Fixed windows aligned to the epoch, one `Map` per bucket, each
 * bounded by F-028's three rules:
 *
 *   - entries whose window has elapsed are dead: dropped lazily on access and by a sweep
 *     every `LOCAL_AUTH_LIMITER_SWEEP_MS`;
 *   - at the cap, eviction takes the least recently used entry that is UNDER its limit. That
 *     order closes the bypass the cap would otherwise open: an attacker who has exhausted a
 *     principal's allowance could churn 10,000 fresh principals to evict that entry and reset
 *     its count. Skipping at-or-over-limit entries makes the attack require 10,000
 *     SIMULTANEOUSLY LIMITED principals, each of which had to pass the buckets first;
 *   - if every entry is at its limit and the cap is reached, the oldest is evicted anyway,
 *     counted on `local_rate_limit_forced_eviction_total` and warned. Memory is bounded
 *     absolutely; failing closed for new principals instead would let an attacker lock out
 *     every new user.
 *
 * LRU order is `Map` insertion order, maintained by deleting and re-inserting on every hit.
 *
 * The sweep timer is `unref()`ed so an idle process — or a unit suite that compiled
 * `AppModule` — is not held open by it, and `onModuleDestroy` clears it when Nest closes the
 * container. There is no constructor argument, deliberately: Nest instantiates this class
 * for the token, and a clock parameter would be read as an injection.
 */
@Injectable()
export class LocalAuthRateLimiter implements AuthRateLimitPort, OnModuleDestroy {
  private readonly buckets = new Map<AuthRateLimitBucket, Map<string, Entry>>();

  private readonly sweep: NodeJS.Timeout;

  constructor() {
    this.sweep = setInterval(() => {
      this.sweepExpired(Date.now());
    }, LOCAL_AUTH_LIMITER_SWEEP_MS);
    this.sweep.unref();
  }

  async check(bucket: AuthRateLimitBucket, key: string): Promise<void> {
    const rule = AUTH_RATE_LIMIT_BUCKETS[bucket];
    const entries = this.entries(bucket);
    const now = Date.now();
    const windowMs = rule.windowSeconds * MILLISECONDS_PER_SECOND;
    const windowStart = Math.floor(now / windowMs) * windowMs;

    let entry = entries.get(key);

    if (entry !== undefined) {
      entries.delete(key);

      if (entry.windowStart !== windowStart) {
        entry = undefined;
      }
    }

    if (entry === undefined) {
      if (entries.size >= LOCAL_AUTH_LIMITER_MAX_PRINCIPALS) {
        evictOne(entries, rule);
      }

      entry = { windowStart, count: 0 };
    }

    entry.count += 1;
    entries.set(key, entry);

    if (entry.count > rule.limit) {
      const retryAfterSeconds = Math.ceil((windowStart + windowMs - now) / MILLISECONDS_PER_SECOND);

      throw new AuthRateLimitExceededError(bucket, retryAfterSeconds);
    }
  }

  /** How many principals a bucket currently holds. For the spec's bounding assertions. */
  size(bucket: AuthRateLimitBucket): number {
    return this.buckets.get(bucket)?.size ?? 0;
  }

  onModuleDestroy(): void {
    clearInterval(this.sweep);
  }

  private entries(bucket: AuthRateLimitBucket): Map<string, Entry> {
    let entries = this.buckets.get(bucket);

    if (entries === undefined) {
      entries = new Map<string, Entry>();
      this.buckets.set(bucket, entries);
    }

    return entries;
  }

  private sweepExpired(now: number): void {
    for (const [bucket, entries] of this.buckets) {
      const windowMs = AUTH_RATE_LIMIT_BUCKETS[bucket].windowSeconds * MILLISECONDS_PER_SECOND;

      for (const [key, entry] of entries) {
        if (entry.windowStart + windowMs <= now) {
          entries.delete(key);
        }
      }
    }
  }
}

/**
 * Removes one entry from a full bucket map: the least recently used entry under its limit,
 * or — when every entry is at or over the limit — the least recently used entry outright,
 * with the forced eviction counted and warned. No key is on the line: it is a client IP.
 */
function evictOne(entries: Map<string, Entry>, rule: AuthRateLimitRule): void {
  for (const [key, entry] of entries) {
    if (entry.count < rule.limit) {
      entries.delete(key);
      return;
    }
  }

  const oldest = entries.keys().next();

  if (!oldest.done) {
    entries.delete(oldest.value);
    logger.warn(
      `${LOCAL_FORCED_EVICTION_COUNTER}: an auth rate-limit bucket reached ` +
        `${String(LOCAL_AUTH_LIMITER_MAX_PRINCIPALS)} principals with every entry at its limit, ` +
        'and the oldest was evicted to admit a new one (docs/contracts/rate-limit.md, F-028). ' +
        'The limiter is under pressure.',
    );
  }
}
