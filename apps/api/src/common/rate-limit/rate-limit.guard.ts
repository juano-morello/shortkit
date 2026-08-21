/**
 * Contract: `docs/contracts/rate-limit.md` ("Scope", "Which address the client IP means",
 *           "What a `null` principal does to each bucket", "Response on limit", "What the
 *           implementer must guarantee"), `docs/contracts/trusted-client-address.md`
 *           ("Signal"), `docs/contracts/error-envelope.md` (the 429 body),
 *           `docs/contracts/tenant-context.md` (`PUBLIC_ROUTE_METADATA`)
 * ADR: adr-0012 (degradation posture), adr-0040 (a `null` principal), adr-0013, adr-0024,
 *      adr-0038 (anything not `GET`/`HEAD` is mutating)
 * Produced by: TASK-1b-07 (wave 1 of item 1b), closing F-018; debt sweep D1 (2026-08-19),
 *              the tenant-keyed write branch. Registered as `APP_GUARD` in
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
 * WHICH ROUTES. A route carrying `PUBLIC_ROUTE_METADATA` (handler first, then class; the same
 * `getAllAndOverride` read `AuthGuard` performs, presence-only) whose request path is under
 * the `/api` prefix. Every method, `GET` included: a public `GET` opens a tenant transaction
 * as a `POST` does (`rate-limit.md`, "Scope"). The path test is what leaves `GET /health`
 * unlimited: it is `@Public('platform probe')` and it is registered OUTSIDE the `/api` prefix
 * (`main.ts` excludes it, ADR-0006), as is the redirect controller AC-86 keeps unlimited at any
 * rate. The exemption is by route, never by the justification text.
 *
 * WHICH KEY. `resolveRateLimitPrincipal(req.headers, process.env)`: the one site that makes
 * the trusted-proxy decision (F-031); no inlined header read, and `process.env` read per
 * request so the boot assertion and this read see one environment. A `null` principal is a
 * real state: THE BUCKET DOES NOT RUN AND THE REQUEST PROCEEDS. It is never keyed on a
 * sentinel, `''` or the peer address, because a shared sentinel bucket lets one caller exhaust
 * an allowance every other caller falls into (ADR-0040). The counter
 * `trusted_client_ip_unresolved_total` is warned once per minute, and ONLY where a header was
 * declared and the read still failed: silent where nothing is declared, which is compose, CI
 * and local dev today (`trusted-client-address.md`, "Signal"). Same policy, same wording as
 * `authRateLimit`; that file exports no shared helper, so the helper is replicated here with
 * its own once-per-minute state.
 *
 * THE AUTHENTICATED BRANCH: THE TENANT-KEYED WRITE BUCKET (debt sweep D1, 2026-08-19;
 * previously TASK-051's documented no-op, D-08). The contract's Scope table's first row
 * ("authenticated routes under `/api` | `tenantId` | `POST`, `PATCH`, `PUT`, `DELETE` |
 * 120 / 60 s") now runs here, process-local through the same port. Which methods: anything
 * that is not `GET` or `HEAD`, ADR-0038's rule, which is the contract's four-method list
 * closed against unexpected methods: a method the list does not name must fail toward being
 * limited, not toward being free. Authenticated `GET`s stay unlimited, deliberately
 * (`rate-limit.md`, "Scope"). Which key: the `RequestContext` `AuthGuard` wrote to the
 * request (a claim from the verified token, never a client-chosen value), which is why the
 * guard is registered AFTER `AuthGuard` (`rate-limit.md`, "What the implementer must
 * guarantee"; `app.module.spec.ts` pins the order). On a `@Public()` route `AuthGuard`
 * returns at its step 1 without touching the request and the branch below charges the IP
 * bucket INSTEAD: the two branches are exclusive, so no request is charged twice.
 *
 * This bucket is also what bounds invitation mail volume (finding 1b-W3-07): a
 * `workspace_admin` scripting `POST /api/invitations` was limited by nothing but the mail
 * transport, and every invitation the API accepts now costs one charge of its tenant's 120
 * writes per minute, mail included. What remains TASK-051's: rebinding `RATE_LIMIT_PORT` to
 * the Redis implementation (per-fleet rather than per-machine, `LocalRateLimiter` kept as
 * the degraded fallback) and the `rate_limit_degraded_total` counter.
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

import { REQUEST_CONTEXT_KEY } from '../../auth/auth.guard';
import { resolveRateLimitPrincipal } from '../../auth/resolve-rate-limit-principal';
import { errorLogFields, logger } from '../../observability/logger';
import { PUBLIC_ROUTE_METADATA } from '../../tenancy/tenant-context';
import type { RequestContext } from '../../tenancy/tenant-context';
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
 * The tenant bucket's 429 body message. Fixed, like its sibling, and phrased for the caller
 * it refuses: an authenticated operator (or their script) writing faster than 120 changes a
 * minute, not a stranger behind a NAT, so it does not mention an address.
 */
export const TENANT_WRITE_RATE_LIMITED_MESSAGE =
  'Too many changes in a short time. Try again shortly.';

/**
 * The global prefix `main.ts` sets, as a path segment. Routes outside it (`GET /health`, the
 * redirect controller) are outside this guard entirely (`rate-limit.md`, "Scope").
 */
const API_PREFIX = '/api';

/** Once per minute, for the reason `resolve-rate-limit-principal.ts` gives for its sibling. */
const UNRESOLVED_WARN_INTERVAL_MS = 60_000;

let lastUnresolvedWarnAt = Number.NEGATIVE_INFINITY;

/** What this guard reads from the request. Named, like `AuthGuard` names its members. */
interface RateLimitedRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: TrustedAddressHeaders;
  readonly [REQUEST_CONTEXT_KEY]?: RequestContext;
}

/**
 * `/api` itself or anything below it, and nothing that merely starts with those letters:
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

/**
 * ADR-0038: anything that is not `GET` or `HEAD` is mutating. A negation rather than the
 * contract's four-method allowlist because the two failure directions are not symmetric: a
 * method the predicate does not recognise must land in the limited branch, not escape it.
 * Uppercased first for the reason the ADR measured on the Fetch spec: `PATCH` is absent from
 * its normalise list, so a lowercase spelling can arrive as sent.
 */
function isMutatingMethod(method: string): boolean {
  const upper = method.toUpperCase();

  return upper !== 'GET' && upper !== 'HEAD';
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

    const request = context.switchToHttp().getRequest<RateLimitedRequest>();

    if (!isUnderApiPrefix(request.path)) {
      // Routes registered outside the prefix (`GET /health`, the redirect controller) are
      // outside this guard entirely, on both branches (`rate-limit.md`, "Scope", AC-86).
      return true;
    }

    if (publicJustification === undefined) {
      // The authenticated branch: the tenant-keyed write bucket (debt sweep D1; see the
      // docblock). `GET` and `HEAD` stay unlimited; everything else charges the tenant.
      return this.checkTenantWrite(request);
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

  /** The authenticated branch: charge the tenant's write bucket, or pass a non-mutating request. */
  private async checkTenantWrite(request: RateLimitedRequest): Promise<boolean> {
    if (!isMutatingMethod(request.method)) {
      return true;
    }

    const requestContext = request[REQUEST_CONTEXT_KEY];

    if (requestContext === undefined) {
      // Unreachable behind `AuthGuard`, which either populated the context or answered 401
      // before this guard ran (`app.module.spec.ts` pins the order). Kept as a pass rather
      // than a throw so a misordered graph degrades open like every other limiter failure
      // here, instead of turning every authenticated write into a 5xx (ADR-0012's posture).
      return true;
    }

    let decision;
    try {
      decision = await this.port.checkTenant(requestContext.tenantId);
    } catch (error: unknown) {
      logger.warn(
        errorLogFields(error, { includeMessage: false }),
        'the tenant write rate-limit store failed to answer; the request proceeded without a limit',
      );
      return true;
    }

    if (decision.allowed) {
      return true;
    }

    throw new DomainError('rate_limited', TENANT_WRITE_RATE_LIMITED_MESSAGE, {
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
