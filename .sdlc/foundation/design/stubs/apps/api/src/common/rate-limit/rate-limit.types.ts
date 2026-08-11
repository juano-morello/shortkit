/**
 * Contract: design/contracts/rate-limit.md
 * ADR: adr-0012-redis-client-and-rate-limit-degradation.md, adr-0006
 * Produced by: TASK-051
 * Consumed by: TASK-052, TASK-056
 */

export const RATE_LIMIT_WINDOW_S = 60;
export const RATE_LIMIT_MAX_WRITES = 120;

/**
 * Keyed by TENANT, never a global bucket (AC-84).
 * Fixed window: up to 240 writes can land across a window boundary. Documented,
 * not fixed; a sliding window buys precision nobody measures.
 *
 * F-015: every key carries an environment segment. See redirect-cache.md.
 */
export function rateLimitKey(env: string, tenantId: string, nowEpochS: number): string {
  return `sk:${env}:rl:v1:${tenantId}:${Math.floor(nowEpochS / RATE_LIMIT_WINDOW_S)}`;
}

/**
 * ============================================================================
 * F-004. /api/auth/* is NOT covered by RateLimitGuard.
 * ============================================================================
 *
 * Better Auth is mounted on the raw Express instance ahead of Nest (ADR-0013), so
 * RateLimitGuard can neither see nor key a pre-auth request: it keys on tenantId from
 * AuthGuard, which has not run. Without this, the unauthenticated credential surface
 * had no throttle at all — unlimited credential stuffing, and unlimited signup, each
 * creating a tenant row and dispatching a verification email until Resend's 100/day
 * free tier is exhausted and every legitimate signup silently fails.
 *
 * Express middleware, registered in front of toNodeHandler. Reuses redisClient (GC-3)
 * and carries ADR-0012's degradation posture: local bucket on Redis error, never
 * fail-open, never 5xx.
 *
 * F-030: these buckets are the ONLY limiter on this surface. Better Auth's built-in
 * limiter (enabled in production by default) is DISABLED — TASK-009 sets
 * `rateLimit: { enabled: false }` in the betterAuth() config (ADR-0013) and owns a
 * unit test asserting the COMPOSED config carries it, because that default degrades
 * silently and only in production. Invariant 3's enumeration of every 429 source
 * depends on this disable.
 */
export const AUTH_RATE_LIMITS = {
  signInPerIp: { limit: 10, windowS: 300 },
  /** F-019: enforced INSIDE Better Auth, not in Express. See below. */
  signInPerEmail: { limit: 5, windowS: 900 },
  signUpPerIp: { limit: 3, windowS: 3600 },
  otherPerIp: { limit: 60, windowS: 60 },
} as const;

/**
 * ============================================================================
 * F-018. @Public() routes under /api are IP-keyed, on ALL METHODS.
 * ============================================================================
 *
 * RateLimitGuard previously skipped @Public() routes and authRateLimit is mounted only
 * on /api/auth/*, so the two capability-token invitation routes were covered by
 * NOTHING. An attacker looping POST /api/invitations/<uuid>.<garbage>/accept opened a
 * Postgres transaction per request, on the pooled connection set shared with the
 * redirect hot path that GC-1 constrains and GC-8 forbids 5xx on.
 *
 * GET is included: GET /api/invitations/:token opens a tenant transaction exactly as
 * the accept route does. Authenticated GETs remain unlimited, unchanged.
 *
 * Checked BEFORE the handler parses the capability token, so a malformed-token flood
 * costs one Redis INCR and no transaction.
 */
export const PUBLIC_ROUTE_RATE_LIMIT = { limit: 30, windowS: 60 } as const;

export function publicRouteRateLimitKey(
  _env: string,
  _clientIp: string,
  _nowEpochS: number,
): string {
  throw new Error('not implemented');
}

/**
 * ============================================================================
 * F-019. The email bucket runs INSIDE Better Auth, not in Express.
 * ============================================================================
 *
 * The email lives in the JSON body. authRateLimit is Express middleware registered
 * ahead of toNodeHandler, and reading the body there CONSUMES THE STREAM Better Auth
 * needs — the stated reason authBodyCap must not parse. The two rules contradicted each
 * other, and dropping the email bucket would leave only the IP bucket: an attacker
 * across 1,000 IPs then gets 10,000 password guesses per 5 minutes against one account.
 *
 * IP buckets stay in Express (headers only). The email bucket becomes a Better Auth
 * hooks.before middleware, where ctx.body.email is already parsed by the framework that
 * owns the body:
 *
 *   betterAuth({ hooks: { before: createAuthMiddleware(async (ctx) => {
 *     if (ctx.path !== '/sign-in/email') return;              // F-025(b): TESTED
 *     const principal = sha256(normaliseEmailForKey(ctx.body.email));  // F-025(a)
 *     await authRateLimit.check('signInPerEmail', principal); // throws APIError 429
 *   }) } })
 *
 * Same Redis client, same key format, same degradation posture. NOTHING BUFFERS OR
 * RE-EMITS A REQUEST STREAM.
 *
 * F-025: BOTH failure modes here are SILENT, unlike the adjacent ones (an undefined
 * ctx.body gives a 500 on every sign-in, which nobody misses).
 *   (a) an unnormalised key: a case-varied address mints a fresh allowance
 *   (b) a wrong ctx.path predicate: the hook returns on every request and the bucket
 *       silently does not exist
 * REQUIRED integration test, owned by TASK-009, pinning key + predicate + 429 together:
 *   six sign-in attempts for one address from SIX DIFFERENT client IPs (so no IP bucket
 *   can fire) -> the sixth returns 429 with code 'rate_limited'.
 * Plus: the same six with the address case-varied still 429 on the sixth; and a
 * DIFFERENT address from the same six IPs succeeds.
 *
 * Reached through AUTH_RATE_LIMIT_PORT, not through redisClient directly — see
 * apps/api/src/auth/ports/auth-rate-limit.port.ts for the wave-ordering reason (F-024).
 */

/**
 * F-031. The client IP for EVERY IP-keyed bucket comes from
 * resolveRateLimitPrincipal(headers) in apps/api/src/auth/resolve-rate-limit-principal.ts
 * — THE ONLY SITE that decides whether to trust the BFF's forwarded address. It returns
 * `string | null`. The full rule lives there and in rate-limit.md; the trust rule behind
 * it lives in design/contracts/trusted-client-address.md. Not restated here (F-320).
 *
 * WHAT THIS FILE MUST NOT GET WRONG:
 *   - ON null THE IP-KEYED BUCKET DOES NOT RUN and the request proceeds. Never key on a
 *     sentinel, '', or req.socket.remoteAddress: one shared bucket for unidentified
 *     callers is the collapsed-bucket outage F-031 exists to prevent (ADR-0040).
 *   - DO NOT reuse click-events.md's trustedClientIp() here, and DO NOT let the redirect
 *     path call the resolver: the redirect path never traverses the BFF and must never
 *     honour a forwarded address, or F-009 reopens on the append-only click store.
 *   - X-Forwarded-For is never read, at any position, for any purpose.
 *
 * The email is NORMALISED then hashed before it becomes a key (F-025):
 * sha256(email.trim().toLowerCase()), matching the form Better Auth uses for the
 * credential lookup. Hashing the raw string would mint a fresh allowance per casing.
 * See normaliseEmailForKey in apps/api/src/auth/ports/auth-rate-limit.port.ts.
 * The keyspace holds no addresses.
 */
export function authRateLimitKey(
  _env: string,
  _bucket: keyof typeof AUTH_RATE_LIMITS,
  _principal: string,
  _nowEpochS: number,
): string {
  throw new Error('not implemented');
}

/**
 * F-027. A 429 from /api/auth/* does NOT pass the Nest exception filter, so it does not
 * get an ErrorEnvelope, and header control from inside a Better Auth hook is not
 * guaranteed by the framework. The retry value therefore travels IN THE BODY too.
 *
 *   throw new APIError(429, {
 *     code: 'rate_limited',
 *     message: 'Too many sign-in attempts for this account. Try again shortly.',
 *     retryAfterSeconds: decision.retryAfterSeconds,
 *   });
 *
 * apiClient prefers the Retry-After header and falls back to this field, so TASK-052's
 * central 429 rendering works on the login screen — the one 429 a user is most likely
 * to see — without a special case.
 */
export interface AuthRateLimitErrorBody {
  code: 'rate_limited';
  message: string;
  retryAfterSeconds: number;
}

/**
 * 32 KiB, rejecting with 413.
 *
 * DOES NOT PARSE. express.json({ limit }) would consume the stream Better Auth needs,
 * which is the whole reason for bodyParser: false. Rejects on Content-Length above the
 * cap and, for chunked requests, counts bytes as they pass and destroys the socket.
 */
export const AUTH_BODY_MAX_BYTES = 32 * 1024;

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Delta-seconds, at least 1. Sent as the Retry-After header. */
  readonly retryAfterSeconds: number;
  /** True when the decision came from the local fallback because Redis failed. */
  readonly degraded: boolean;
}

/**
 * Redis-backed TENANT bucket (rateLimitKey + RATE_LIMIT_LUA). The @Public() IP bucket
 * on the Redis path uses publicRouteRateLimitKey + RATE_LIMIT_LUA with a principal
 * from resolveRateLimitPrincipal (F-031); it does not go through this interface, and
 * needs no F-028-style bound because Redis keys expire on their own.
 */
export interface RateLimiter {
  check(tenantId: string): Promise<RateLimitDecision>;
}

/**
 * In-process fallback for RateLimitGuard. Same limits, same windows.
 *
 * NEITHER fail-open NOR fail-closed: on a Redis error or a 50 ms timeout, the limit
 * STILL APPLIES, per machine instead of per fleet.
 *
 * ============================================================================
 * F-034. TWO MAPS, TWO KEY SPACES. Matches ADR-0012 (revised 2026-08-04).
 * ============================================================================
 *
 * The guard covers tenant-keyed authenticated writes AND IP-keyed @Public() routes,
 * and its principals must not share one map: tenant ids are produced only by
 * AUTHENTICATED callers, while @Public() IPs are chosen by ANONYMOUS ones. In a
 * shared map, an attacker churning ~10,000 addresses across @Public() routes during
 * a Redis outage evicts a tenant's write bucket and resets its 120/60s window at
 * will — during exactly the window when the redirect path is already on its
 * Postgres fallback (GC-1, GC-8).
 *
 *   - checkTenant: its own map, plain LRU capped at LOCAL_LIMITER_MAX_TENANTS.
 *     Keys are authenticated tenant ids, so F-028's extra rules are not needed;
 *     the cap is unreachable at this scale (ADR-0012).
 *   - checkPublicIp: its own map, capped at LOCAL_LIMITER_MAX_PUBLIC_IPS, with
 *     ALL THREE F-028 rules — lazy expiry PLUS a sweep every
 *     LOCAL_AUTH_LIMITER_SWEEP_MS, and EVICTION SKIPS ENTRIES AT OR OVER THEIR
 *     LIMIT (forced eviction increments local_rate_limit_forced_eviction_total
 *     and warns, as in LocalAuthRateLimiter).
 *
 * ACCEPTED GAP: with N machines the degraded limit is N * the configured limit.
 * Fly runs one machine at launch. Revisit before enabling more.
 */
export interface LocalRateLimiter {
  /** Authenticated writes. Tenant-keyed map. */
  checkTenant(tenantId: string): RateLimitDecision;
  /**
   * @Public() routes. SEPARATE IP-keyed map (F-034); principal from
   * resolveRateLimitPrincipal. NEVER called when that returned null — the caller skips
   * the bucket rather than passing a stand-in (F-320).
   */
  checkPublicIp(clientIp: string): RateLimitDecision;
}

export const LOCAL_LIMITER_MAX_TENANTS = 10_000;
export const LOCAL_LIMITER_MAX_PUBLIC_IPS = 10_000;

/**
 * ============================================================================
 * F-028. LocalAuthRateLimiter's bound. PER BUCKET, not total.
 * ============================================================================
 *
 * The sibling above is keyed on tenant ids, which only an AUTHENTICATED caller
 * produces. This one is keyed on client IP and sha256(email), both chosen by an
 * UNAUTHENTICATED caller. An IPv6 /64 is free, so without a cap there is one live map
 * entry per request and nothing to reap it.
 *
 * Live during the whole wave-2..wave-10 interval when the local limiter is the only
 * auth limiter, and during any Redis outage when ADR-0012 routes every auth decision
 * here — converting that outage into an API OOM-restart loop WHILE the redirect path is
 * already degraded onto its Postgres fallback (GC-1, GC-8).
 *
 * Rules, all three load-bearing:
 *   1. one map per bucket, each capped at LOCAL_AUTH_LIMITER_MAX_PRINCIPALS
 *   2. entries whose window has elapsed are dropped lazily on access AND by a sweep
 *      every LOCAL_AUTH_LIMITER_SWEEP_MS — the sweep is what bounds signUpPerIp, whose
 *      one-hour window would otherwise hold an hour of distinct IPs
 *   3. EVICTION SKIPS ENTRIES AT OR OVER THEIR LIMIT. LRU otherwise.
 *      Without rule 3 the cap is itself a bypass: an attacker who has exhausted an
 *      account's 5 attempts churns 10,000 principals to evict that entry and reset it.
 *
 * If every entry is over its limit and the cap is reached: evict the oldest anyway,
 * increment local_rate_limit_forced_eviction_total, log at warn. Memory is bounded
 * absolutely. Failing closed for new principals would let an attacker lock out every
 * new user.
 */
export const LOCAL_AUTH_LIMITER_MAX_PRINCIPALS = 10_000;
export const LOCAL_AUTH_LIMITER_SWEEP_MS = 60_000;

/** INCR then EXPIRE, atomically. */
export const RATE_LIMIT_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/**
 * Applies to EVERY route under the /api prefix (F-018):
 *   authenticated  -> keyed by tenantId, POST/PATCH/PUT/DELETE only, 120/60s
 *   @Public()      -> keyed by client IP, ALL METHODS including GET, 30/60s
 *
 * NOT applied to: GET /health; and the redirect controller, which is registered
 * OUTSIDE the /api prefix and therefore outside this guard entirely (AC-86).
 * Redirect traffic is never limited at any rate. Neither exception opens a tenant
 * transaction.
 *
 * Ordering: after AuthGuard (needs tenantId), before TenantTransactionInterceptor
 * (a rejected request must not open a transaction). On a @Public() route AuthGuard
 * returns at step 0 without populating RequestContext, so the guard falls back to the
 * IP key rather than reading a tenant that is not there.
 *
 * F-031: the IP key comes from resolveRateLimitPrincipal(headers)
 * (apps/api/src/auth/resolve-rate-limit-principal.ts), never from a header read
 * directly and never from X-Forwarded-For at any position. It returns `string | null`;
 * on null the @Public() bucket DOES NOT RUN and the request proceeds (F-320, ADR-0040).
 * See the block above authRateLimitKey.
 */
export declare class RateLimitGuard {
  canActivate(context: unknown): Promise<boolean>;
}
