/**
 * Contract: `docs/contracts/rate-limit.md` ("Scope", "Which address the client IP means",
 *           "What a `null` principal does to each bucket", "Response on limit", "What the
 *           implementer must guarantee"), `docs/contracts/trusted-client-address.md`
 *           ("Signal"), `docs/contracts/error-envelope.md` (the 429 body),
 *           `docs/contracts/tenant-context.md` (`PUBLIC_ROUTE_METADATA`)
 * ADR: adr-0012 (degradation posture), adr-0040 (a `null` principal), adr-0013, adr-0024
 * Produced by: TASK-1b-07 (wave 1 of item 1b), closing F-018. Registered as `APP_GUARD` in
 *              `rate-limit.module.ts`, imported by `AppModule` AFTER `AuthModule`.
 *
 * ============================================================================
 * THE `@Public()` PER-IP BUCKET, CHECKED BEFORE ANY TOKEN IS PARSED.
 * ============================================================================
 *
 * F-018: an anonymous caller looping capability-token guesses at a `@Public()` invitation
 * route opened a Postgres transaction per request on the pool the redirect hot path shares.
 * This guard is what makes that loop cost one bucket increment and no connection: Nest runs
 * every guard before any interceptor and before the handler, so a refused request never
 * reaches `TenantTransactionInterceptor` (which exempts `@Public()` anyway) and never reaches
 * the handler that would open `withTenantTransaction(<prefix>)` from the token.
 *
 * WHICH ROUTES. A route carrying `PUBLIC_ROUTE_METADATA` (handler first, then class — the same
 * `getAllAndOverride` read `AuthGuard` performs, presence-only) whose request path is under
 * the `/api` prefix. Every method, `GET` included: a public `GET` opens a tenant transaction
 * as a `POST` does (`rate-limit.md`, "Scope"). The path test is what leaves `GET /health`
 * unlimited: it is `@Public('platform probe')` and it is registered OUTSIDE the `/api` prefix
 * (`main.ts` excludes it, ADR-0006), as is the redirect controller AC-86 keeps unlimited at any
 * rate. The exemption is by route, never by the justification text.
 *
 * WHICH KEY. `resolveRateLimitPrincipal(req.headers, process.env)` — the one site that makes
 * the trusted-proxy decision (F-031); no inlined header read, and `process.env` read per
 * request so the boot assertion and this read see one environment. A `null` principal is a
 * real state: THE BUCKET DOES NOT RUN AND THE REQUEST PROCEEDS. It is never keyed on a
 * sentinel, `''` or the peer address, because a shared sentinel bucket lets one caller exhaust
 * an allowance every other caller falls into (ADR-0040). The counter
 * `trusted_client_ip_unresolved_total` is warned once per minute, and ONLY where a header was
 * declared and the read still failed — silent where nothing is declared, which is compose, CI
 * and local dev today (`trusted-client-address.md`, "Signal"). Same policy, same wording as
 * `authRateLimit`; that file exports no shared helper, so the helper is replicated here with
 * its own once-per-minute state.
 *
 * THE AUTHENTICATED BRANCH IS A DOCUMENTED NO-OP (D-08). The contract's Scope table has a
 * second row — "authenticated routes under `/api` | `tenantId` | `POST`, `PATCH`, `PUT`,
 * `DELETE` | 120 / 60 s" — and it is TASK-051's, with `RedisAuthRateLimiter`, `redisClient` and
 * `checkTenant`. This guard passes such a request, charging nothing; the port declares no
 * `checkTenant` so nothing here can be mistaken for it. When TASK-051 lands, this is the
 * branch it fills, reading `tenantId` from the `RequestContext` `AuthGuard` wrote — which is
 * why the guard is registered AFTER `AuthGuard` (`rate-limit.md`, "What the implementer must
 * guarantee"). On a `@Public()` route `AuthGuard` returns at its step 1 without touching the
 * request, so for the branch that is real today the order is immaterial and the ruling is
 * pinned for the branch that is not (`app.module.spec.ts`).
 *
 * THE REFUSAL. A `DomainError('rate_limited', …)` carrying `Retry-After` in its `headers`, so
 * `ApiExceptionFilter` writes the header before the envelope (its "invariant 7" comment):
 * `429`, `Retry-After: <delta-seconds ≥ 1>`, body `{ code: 'rate_limited', message }`. The
 * message is fixed and safe to show a stranger; it says to retry shortly rather than implying
 * the link is broken, because the bucket is shared by everyone behind one NAT
 * (`rate-limit.md`, "Accepted costs").
 *
 * NEVER A 5xx FROM THE LIMITER (ADR-0012, invariant 5). A port rejection is a store failure,
 * not a refusal: the request proceeds and a warn line says so. The local store cannot fail, so
 * today that line is unreachable; it is the posture the Redis-backed port TASK-051 binds
 * inherits without an edit here.
 *
 * NO PATH LOGS A PRINCIPAL OR A HEADER NAME. Every line below carries `msg` and, on the
 * store-failure path, the error fields, and nothing else (`logging-and-headers.md`).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { resolveRateLimitPrincipal } from '../../auth/resolve-rate-limit-principal';
import { errorLogFields, logger } from '../../observability/logger';
import { PUBLIC_ROUTE_METADATA } from '../../tenancy/tenant-context';
import { DomainError } from '../errors/domain-error';
import { TRUSTED_CLIENT_IP_HEADER_ENV, TRUSTED_CLIENT_IP_UNRESOLVED_COUNTER } from '../net/trusted-client-address';
import type { TrustedAddressHeaders } from '../net/trusted-client-address';
import { RATE_LIMIT_PORT } from './rate-limit.types';
import type { RateLimitPort } from './rate-limit.types';

/**
 * The 429 body's message. Fixed, so nothing of the request reaches it, and phrased for the
 * NAT case the contract records: several invitees behind one address can 429 each other, and
 * the copy must not read as "the link is broken".
 */
export const RATE_LIMITED_MESSAGE = 'Too many requests from this address. Try again shortly.';

/**
 * The global prefix `main.ts` sets, as a path segment. Routes outside it — `GET /health`, the
 * redirect controller — are outside this guard entirely (`rate-limit.md`, "Scope").
 */
const API_PREFIX = '/api';

/** Once per minute, for the reason `resolve-rate-limit-principal.ts` gives for its sibling. */
const UNRESOLVED_WARN_INTERVAL_MS = 60_000;

let lastUnresolvedWarnAt = Number.NEGATIVE_INFINITY;

/** What this guard reads from the request. Named, like `AuthGuard` names its members. */
interface RateLimitedRequest {
  readonly path: string;
  readonly headers: TrustedAddressHeaders;
}

/**
 * `/api` itself or anything below it, and nothing that merely starts with those letters —
 * COMPARED CASE-INSENSITIVELY, BECAUSE THAT IS HOW EXPRESS ROUTES. Express 5 has
 * `case sensitive routing` off by default (Nest does not turn it on), so `GET /API/x` and
 * `/Api/x` reach the handler registered at `/api/x`, while `req.path` keeps the client's
 * casing. A case-sensitive `startsWith('/api/')` would classify `/API/...` as outside the
 * prefix and skip the bucket, and an anonymous caller could vary the case per request to
 * escape the limit entirely; the reader must agree with the router. Measured (2026-08-18):
 * `/API/probe/x` → 200 with `req.path === '/API/probe/x'`; `//api/probe/x`, `/api//probe/x`
 * and `/%61pi/probe/x` → 404, so slashes and percent-encoding open no second gap; dot
 * segments are collapsed by the client before they arrive.
 */
export function isUnderApiPrefix(path: string): boolean {
  const lower = path.toLowerCase();

  return lower === API_PREFIX || lower.startsWith(`${API_PREFIX}/`);
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  /** `@Inject(Reflector)` written out for the reason `AuthGuard` gives (`consistent-type-imports`, ADR-0001). */
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_PORT) private readonly port: RateLimitPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const publicJustification = this.reflector.getAllAndOverride<unknown>(PUBLIC_ROUTE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (publicJustification === undefined) {
      // The authenticated branch: TASK-051's tenant-keyed write bucket. A documented no-op
      // that charges nothing — see the docblock.
      return true;
    }

    const request = context.switchToHttp().getRequest<RateLimitedRequest>();

    if (!isUnderApiPrefix(request.path)) {
      // `GET /health` and every other public route registered outside the prefix.
      return true;
    }

    const principal = resolveRateLimitPrincipal(request.headers, process.env);

    if (principal === null) {
      signalUnresolved(process.env);
      return true;
    }

    let decision;
    try {
      decision = await this.port.checkPublicIp(principal);
    } catch (error: unknown) {
      logger.warn(
        errorLogFields(error, { includeMessage: false }),
        'the @Public() rate-limit store failed to answer; the request proceeded without a limit',
      );
      return true;
    }

    if (decision.allowed) {
      return true;
    }

    throw new DomainError('rate_limited', RATE_LIMITED_MESSAGE, {
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
}

/**
 * The counter every IP-keyed bucket increments on `null`, as a warn line once per minute and
 * ONLY where a header was declared and the read still failed. Silent where nothing is
 * declared: that environment is in a stated condition, and one warn per request in
 * `docker compose up` trains a developer to ignore the channel. Neither the header's name nor
 * its value is on the line.
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
        'to a @Public() route under /api resolved no address from it (absent, repeated, ' +
        'comma-joined, or not an IP), so its IP-keyed bucket did not run and the request ' +
        'proceeded (docs/contracts/trusted-client-address.md, ADR-0040). Suppressed for the next minute.',
    );
  }
}
