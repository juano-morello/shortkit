/**
 * Contract: design/contracts/rate-limit.md ("Which address the client IP means")
 * ADR: adr-0014-web-session-handling.md, adr-0012, adr-0013
 * Produced by: TASK-009 (wave 2 — the Express IP buckets need it immediately)
 * Consumed by: TASK-009 (authRateLimit middleware), TASK-051 (RateLimitGuard)
 *
 * ============================================================================
 * F-031. THE ONLY SITE THAT MAKES THE TRUSTED-PROXY DECISION.
 * ============================================================================
 *
 * Under ADR-0014's BFF topology the browser never talks to Fly: every browser-
 * originated request to /api arrives from Vercel's egress, so Fly-Client-IP is THE
 * SAME VALUE FOR EVERY USER. Keying any IP bucket on it collapses all four buckets
 * into one — 3 signups per hour and 10 sign-ins per 5 minutes across the entire
 * product. The BFF therefore forwards the browser's address, authenticated by a
 * shared secret, and this function is the single place that decides whether to
 * trust it.
 *
 * Every IP-keyed rate-limit bucket — the three Express auth buckets (TASK-009) and
 * the @Public() bucket in RateLimitGuard (TASK-051) — obtains its principal from
 * THIS FUNCTION and from nowhere else. Do not inline the header reads, and do not
 * write a second resolver.
 *
 * ============================================================================
 * NOT click-events.md's trustedClientIp(). DO NOT MERGE THE TWO.
 * ============================================================================
 *
 * trustedClientIp() (redirect path, ip_hash) is a SEPARATE function with a
 * DIFFERENT rule: the redirect path is served by Fly directly — custom domains
 * CNAME to fly.dev and never traverse the BFF — so it must NEVER honour a
 * forwarded address, secret or no secret. Merging the two resolvers, or having the
 * redirect path call this one, would put an attacker-settable value into ip_hash
 * and reopen F-009 on the append-only click store. One resolver per trust domain.
 *
 * ============================================================================
 * F-033. THE RESOLUTION RULE. Normative, including the never-reached clauses.
 * ============================================================================
 *
 * Return the trusted-proxy value, headers[BFF_CLIENT_IP_HEADER], ONLY when ALL of:
 *
 *   1. BFF_PROXY_SECRET (process.env) is set and non-empty. If it is unset or
 *      empty, the trusted-proxy branch is DISABLED UNCONDITIONALLY: the
 *      comparison in rule 3 is NEVER REACHED, not merely never equal.
 *   2. headers[BFF_PROXY_AUTH_HEADER] is present and non-empty. An absent or
 *      empty header NEVER matches — again the comparison is never reached.
 *      Rules 1 and 2 exist because the naive implementation compares
 *      header === process.env.BFF_PROXY_SECRET, and for a direct anonymous
 *      request with the variable unset that is undefined === undefined — a
 *      match, handing an unauthenticated attacker a self-chosen principal and
 *      voiding every IP-keyed limit.
 *   3. A CONSTANT-TIME comparison (crypto.timingSafeEqual over equal-length
 *      buffers) of the header against BFF_PROXY_SECRET matches.
 *   4. headers[BFF_CLIENT_IP_HEADER] parses as an IPv4 or IPv6 address:
 *      net.isIP(value.trim()) !== 0. Anything else — absent, empty, a list, a
 *      16 KiB blob — falls through. This is what keeps the value bounded before
 *      it becomes a Redis key segment and a LocalAuthRateLimiter map key.
 *
 * Otherwise return Fly-Client-IP (platform-set, for anything reaching Fly
 * directly). The leftmost X-Forwarded-For entry is never used, for any purpose.
 *
 * FAIL-OPEN-WITH-SIGNAL, NOT FAIL-TO-BOOT, NOT SILENT (F-033):
 *   - A present BFF_PROXY_AUTH_HEADER that fails rule 1, 2 or 3 increments
 *     bff_proxy_auth_mismatch_total and logs at warn, once per minute. This is
 *     what makes the collapsed-bucket state observable instead of surfacing as
 *     users complaining that signup is broken.
 *   - A valid secret with a rule-4 failure (non-IP value) also increments the
 *     counter and warns: it means the BFF is sending garbage, which is a defect.
 *   - The resolver itself never throws and never rejects the request. Ignoring
 *     the forwarded header (rather than 4xx-ing) is deliberate: probing for the
 *     trusted-proxy mechanism reveals nothing.
 *   - Failing boot on a mismatch is the wrong posture: the same Fly process
 *     serves the redirect path, which carries the strictest availability
 *     constraint in the design (GC-8, AC-86). A rate-limiter secret must not be
 *     able to take down redirects. "Matches" cannot be verified locally anyway.
 *
 * BOOT-TIME ASSERTION — "set", which IS locally checkable:
 * assertBffProxySecretConfigured() throws when NODE_ENV === 'production' and
 * BFF_PROXY_SECRET is unset or empty. TASK-009 calls it in main.ts beside the
 * auth mount. This catches the common misconfiguration (variable forgotten on the
 * Fly side) without coupling boot to the other deployable. BFF_PROXY_SECRET is
 * REQUIRED configuration on both deployables: Fly (here) and Vercel (TASK-004,
 * web-api-client.md).
 */

/** Lowercase, as Node presents incoming header names. Set by the BFF (TASK-012). */
export const BFF_CLIENT_IP_HEADER = 'x-shortkit-client-ip';
export const BFF_PROXY_AUTH_HEADER = 'x-shortkit-proxy-auth';
export const FLY_CLIENT_IP_HEADER = 'fly-client-ip';

/** Both headers are in REDACT_PATHS (logging-and-headers.md, F-032). Never log either. */
export const BFF_PROXY_MISMATCH_COUNTER = 'bff_proxy_auth_mismatch_total';

/** Shape-compatible with Express's req.headers (IncomingHttpHeaders). */
export type RateLimitRequestHeaders = Record<string, string | string[] | undefined>;

export function resolveRateLimitPrincipal(_headers: RateLimitRequestHeaders): string {
  throw new Error('not implemented');
}

/**
 * Production-only. Asserts BFF_PROXY_SECRET is SET AND NON-EMPTY — not that it
 * matches the BFF's copy, which no local check can establish.
 */
export function assertBffProxySecretConfigured(_env: Record<string, string | undefined>): void {
  throw new Error('not implemented');
}
