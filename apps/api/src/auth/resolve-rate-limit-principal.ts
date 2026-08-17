/**
 * Contract: `docs/contracts/rate-limit.md` ("Which address the client IP means, under the
 *           BFF" — normative for the BFF branch; "The BFF trust boundary" — the exact strings)
 *           `docs/contracts/trusted-client-address.md` ("The two callers", the declared-header
 *           fallback and what `null` means)
 * ADR: adr-0040-trusted-client-address-is-declared-and-may-be-absent.md, adr-0014 (the BFF
 *      topology that makes the branch necessary), adr-0013
 * Produced by: TASK-004 (wave 3). Consumed by: `auth-rate-limit.ts` (TASK-004), the
 *              `@Public()` bucket in `RateLimitGuard` (TASK-051).
 *
 * ============================================================================
 * THE ONLY SITE THAT MAKES THE TRUSTED-PROXY DECISION (F-031). NOTHING ELSE READS THESE.
 * ============================================================================
 *
 * Under ADR-0014 the browser never talks to this API: `/api/auth/*` arrives from the Next.js
 * BFF, so the peer address — and any platform header a hop in front might set — is the BFF's
 * egress address FOR EVERY USER. Keyed on that, the four IP buckets collapse into one shared
 * bucket, which is a product outage rather than a limiter (F-031, measured on paper: 3
 * signups per hour across the entire product). So the BFF forwards the browser's address in
 * `X-Shortkit-Client-IP` and authenticates itself with `X-Shortkit-Proxy-Auth`, and this
 * function honours the forwarded address ONLY when all four of F-033's rules hold.
 *
 * `trustedClientIp` in the click path (TASK-033) NEVER honours the forwarded address, secret
 * or no secret: custom domains CNAME straight to the API and never traverse the BFF, so a
 * shared resolver would put an attacker-settable value into `ip_hash`. The two resolvers share
 * `readTrustedClientAddress` and nothing else, and they are not to be merged.
 *
 * FAIL-OPEN-WITH-SIGNAL, NOT FAIL-TO-BOOT, NOT SILENT (F-033). A secret mismatch degrades to
 * the declared-header fallback or to no principal, and shows up as a counter rather than as
 * users reporting that signup is broken. An unauthenticated forwarded header is ignored, never
 * rejected, so probing reveals nothing. What IS locally checkable is asserted at boot:
 * `assertBffProxySecretConfigured` in `boot-assertions.ts` refuses when `BFF_TRUST_BOUNDARY`
 * is `bff` and the secret is absent, keyed on that declared variable and never on `NODE_ENV`
 * (F-385).
 *
 * NEITHER HEADER'S VALUE, NOR THE SECRET, IS EVER LOGGED. The warn below carries `msg` only.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import { readTrustedClientAddress } from '../common/net/trusted-client-address';
import type { TrustedAddressHeaders } from '../common/net/trusted-client-address';
import { logger } from '../observability/logger';

/** Set by the BFF to the browser's address, from `x-vercel-forwarded-for`. Lower-cased as Node presents it. */
export const BFF_CLIENT_IP_HEADER = 'x-shortkit-client-ip';

/** Set by the BFF to `BFF_PROXY_SECRET`. Lower-cased as Node presents it. */
export const BFF_PROXY_AUTH_HEADER = 'x-shortkit-proxy-auth';

export const BFF_PROXY_SECRET_ENV = 'BFF_PROXY_SECRET';

export const BFF_TRUST_BOUNDARY_ENV = 'BFF_TRUST_BOUNDARY';

/** Unset is read as 'direct'. Anything outside this set fails boot, everywhere. */
export const BFF_TRUST_BOUNDARIES = ['bff', 'direct'] as const;
export type BffTrustBoundary = (typeof BFF_TRUST_BOUNDARIES)[number];

export const BFF_TRUST_BOUNDARY_INVALID_MESSAGE =
  'BFF_TRUST_BOUNDARY must be "bff" or "direct", or unset. It is not NODE_ENV and it is not a boolean.';

export const BFF_PROXY_SECRET_UNSET_MESSAGE =
  'BFF_TRUST_BOUNDARY is "bff" but BFF_PROXY_SECRET is not set. A BFF-fronted deployment must carry the shared secret on both sides. See docs/contracts/rate-limit.md.';

/**
 * The counter a present-but-unusable `X-Shortkit-Proxy-Auth` increments (F-033). Carried in
 * `msg` for the reason `TRUSTED_CLIENT_IP_UNRESOLVED_COUNTER` gives: no metrics pipeline yet,
 * and the name on the line is what an operator greps for.
 */
export const BFF_PROXY_AUTH_MISMATCH_COUNTER = 'bff_proxy_auth_mismatch_total';

/**
 * Once per minute (F-033). The BFF sends the header on EVERY request, so a mismatch is not
 * one event but a stream of them, and one warn per request trains an operator to ignore the
 * channel. Process-wide, which is the granularity the counter has.
 */
const MISMATCH_WARN_INTERVAL_MS = 60_000;

let lastMismatchWarnAt = Number.NEGATIVE_INFINITY;

/**
 * The rate-limit principal for a request: the browser's address when the BFF vouched for
 * it, the declared platform header's value otherwise, and `null` where neither establishes
 * one. NEVER a client-supplied value; never `X-Forwarded-For` or `Forwarded` at any position.
 *
 * `null` is a real return (ADR-0040): the IP-keyed bucket does not run and the request
 * proceeds. It is never coerced to a sentinel, the empty string or the peer address, because
 * a shared sentinel bucket would let one caller exhaust an allowance every other caller falls
 * into — the collapsed-bucket outage by a different road.
 *
 * Never throws: a throw here lands inside Express middleware ahead of Better Auth and turns
 * a header an attacker chose into a 500 on the credential surface.
 */
export function resolveRateLimitPrincipal(
  headers: TrustedAddressHeaders,
  env: Record<string, string | undefined>,
): string | null {
  const forwarded = bffForwardedAddress(headers, env);

  if (forwarded !== null) {
    return forwarded;
  }

  return readTrustedClientAddress(headers, env);
}

/**
 * F-033's four rules, in order, and the reason the order matters is written into rules 1
 * and 2: the naive `header === process.env.BFF_PROXY_SECRET` is `undefined === undefined`
 * for a direct anonymous request with the variable unset, so an absent secret and an absent
 * header must never REACH the comparison rather than merely never equal.
 *
 *   1. `BFF_PROXY_SECRET` is set and non-empty on the API side.
 *   2. `X-Shortkit-Proxy-Auth` is present, a single string, and non-empty.
 *   3. A constant-time comparison of the header against the secret matches.
 *   4. `X-Shortkit-Client-IP` parses as an IPv4 or IPv6 address (`net.isIP`), which bounds
 *      the value before it becomes a Redis key segment or a local map key.
 *
 * A PRESENT header that fails rule 1, 2 or 3, and a valid secret whose forwarded value fails
 * rule 4, is a mismatch and is signalled. An ABSENT header is a direct request and is
 * silent — under `BFF_TRUST_BOUNDARY=direct` that is every request.
 */
function bffForwardedAddress(
  headers: TrustedAddressHeaders,
  env: Record<string, string | undefined>,
): string | null {
  const proxyAuth = own(headers, BFF_PROXY_AUTH_HEADER);

  if (proxyAuth === undefined) {
    return null;
  }

  const secret = env[BFF_PROXY_SECRET_ENV];

  if (secret === undefined || secret.trim() === '') {
    return mismatch();
  }

  if (typeof proxyAuth !== 'string' || proxyAuth === '') {
    return mismatch();
  }

  if (!constantTimeEqual(proxyAuth, secret)) {
    return mismatch();
  }

  const clientIp = own(headers, BFF_CLIENT_IP_HEADER);

  if (typeof clientIp !== 'string') {
    return mismatch();
  }

  const trimmed = clientIp.trim();

  if (trimmed === '' || isIP(trimmed) === 0) {
    return mismatch();
  }

  return trimmed;
}

/** Signals the mismatch and returns the fall-through value, so every failing rule reads the same. */
function mismatch(): null {
  const now = Date.now();

  if (now - lastMismatchWarnAt >= MISMATCH_WARN_INTERVAL_MS) {
    lastMismatchWarnAt = now;
    logger.warn(
      `${BFF_PROXY_AUTH_MISMATCH_COUNTER}: a request carried the BFF proxy-auth header and ` +
        'the BFF branch did not accept it (secret unset, header empty, secret mismatch, or ' +
        'an unparseable forwarded address). The request proceeded under the declared-header ' +
        'fallback or under no principal. Rotate by setting BFF_PROXY_SECRET on both sides ' +
        '(docs/contracts/rate-limit.md, F-033). Suppressed for the next minute.',
    );
  }

  return null;
}

/**
 * `timingSafeEqual` requires equal lengths, so both sides are hashed first: the comparison
 * then runs over two 32-byte digests whatever the inputs' lengths, and a length difference
 * is not observable as an early return.
 */
function constantTimeEqual(presented: string, secret: string): boolean {
  const left = createHash('sha256').update(presented).digest();
  const right = createHash('sha256').update(secret).digest();

  return timingSafeEqual(left, right);
}

/**
 * An own property of the header record or `undefined`. A header record is a plain object, so
 * a lookup that fell through to the prototype could read `constructor` as a value; nothing
 * here does, but the guard is what makes "never throws" a property rather than a hope.
 */
function own(headers: TrustedAddressHeaders, name: string): string | string[] | undefined {
  return Object.hasOwn(headers, name) ? headers[name] : undefined;
}
