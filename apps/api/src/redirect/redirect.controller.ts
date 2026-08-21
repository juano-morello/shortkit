/**
 * Contract: docs/contracts/redirect-resolution.md ("Response headers", "Decision order"
 *           step 7, invariants 1 and 7), logging-and-headers.md ("Two deliberate exceptions
 *           on the redirect path"), click-events.md, tenant-context.md (`@Public`)
 * ADR: adr-0006-http-surface-partitioning.md, adr-0010-click-event-write-path.md,
 *      adr-0018-ci-performance-gate.md (`Server-Timing` is the number it aggregates);
 *      D-2-10, D-2-13, D-2-14
 * Produced by: TASK-2-06
 *
 * ============================================================================
 * THE VISITOR SURFACE. ONE 302 OR ONE 404, AND NEVER A 5xx (GC-O, INVARIANT 1).
 * ============================================================================
 *
 * The whole body is inside a catch. That is not defensive habit: F-152 measured that a
 * connection-acquisition timeout carries NO SQLSTATE, so nothing downstream can branch on
 * it, and the pool is shared with the management API, so a burst of dashboard traffic is
 * enough to produce one. A visitor who gets a 500 has been told the platform is broken;
 * a visitor who gets the default 404 has been told this link does not work, which is both
 * true and all they can act on. The error goes to the log, not to the response.
 *
 * `@Public('anonymous visitor redirect')`, and the justification is not decoration either:
 * `Public()` refuses an empty one at decoration time, and TASK-056's coverage report prints
 * it beside the route. It exempts the route from `AuthGuard` AND from
 * `TenantTransactionInterceptor`, so no token is read and no tenant transaction is opened
 * for a request that has no tenant. `@NoTenantTransaction()` would be redundant.
 * `RateLimitGuard` leaves the route alone BY PATH (`isUnderApiPrefix`), so AC-2-19's "no 429
 * ever on the redirect surface" needs no code here, and adding a limiter would be a change
 * to `rate-limit.md`.
 *
 * REGISTERED OUTSIDE THE `/api` PREFIX (ADR-0006). `main.ts` excludes this one declared
 * path and `AppModule` imports this module LAST, because Express matches in registration
 * order and `/:slug` matches every one-segment path. `app.module.spec.ts` pins both, and
 * pins the shape of the exclusion, which is subtler than it looks; see that file.
 *
 * ============================================================================
 * WHY THE RESPONSE IS WRITTEN BY HAND (`@Res()`), HEADER BY HEADER.
 * ============================================================================
 *
 * `Location` MUST BE THE STORED DESTINATION BYTE FOR BYTE (AC-2-14). Express's
 * `res.redirect()` puts the value through `res.location()`, which runs `encodeUrl()`: a
 * URL carrying a literal space, a `[` or an already-percent-encoded sequence comes out a
 * different string, and "byte-identical" is an assertion in the integration suite. So the
 * header is set directly and the response is ended directly.
 *
 * Three headers on every response, three more on the 404, one more on the 302, and the two
 * that override helmet are the two `logging-and-headers.md` lists as this path's deliberate
 * exceptions. The CSP is the one that closes F-280's open half: it REPLACES helmet's, and
 * `frame-ancestors` does not fall back to `default-src`, so it carries its own.
 */
import { Controller, Get, Inject, Optional, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { errorLogFields, logger } from '../observability/logger';
import { Public } from '../tenancy/tenant-context';

import { REDIRECT_404_CSP, renderNotFound } from './not-found-page';
import { REDIRECT_CLICK_SINK } from './ports/click-sink.port';
import type { RedirectClickSink } from './ports/click-sink.port';
import { RedirectService } from './redirect.service';
import type { RedirectDecision } from './redirect.types';

/** The route PATTERN, which is what may be logged. The concrete path never is (GC-G). */
const ROUTE_PATTERN = '/:slug';

const MILLISECONDS_PER_NANOSECOND = 1e-6;

@Controller('/')
@Public('anonymous visitor redirect')
export class RedirectController {
  constructor(
    // `@Inject` on a class token is redundant for Nest and load-bearing for lint: it is the
    // value reference that keeps `consistent-type-imports` from rewriting the import into
    // `import type`, which would erase the `design:paramtypes` entry DI resolves from. The
    // links and workspaces controllers carry it for the same reason.
    @Inject(RedirectService) private readonly redirects: RedirectService,
    /**
     * UNBOUND UNTIL TASK-2-09 (D-2-10). Unbound is a no-op with no counter: the redirect
     * answers, and no click row is written, which is wave 3's honest state. The compose
     * end-to-end check that asserts a click row is sequenced after wave 4 for that reason.
     */
    @Optional()
    @Inject(REDIRECT_CLICK_SINK)
    private readonly clicks: RedirectClickSink | null = null,
  ) {}

  @Get(':slug')
  async resolve(@Req() request: Request, @Res() response: Response): Promise<void> {
    const started = process.hrtime.bigint();

    try {
      // Express 5 types a route parameter as `string | string[]` because a repeated
      // parameter name yields an array. `:slug` appears once, so the array arm is
      // unreachable, and it is narrowed rather than asserted, because the empty string
      // fails `SLUG_PATTERN` and lands on the same default 404 as any other bad segment.
      const segment = request.params.slug;

      const decision = await this.redirects.resolve(
        request.headers.host,
        typeof segment === 'string' ? segment : '',
        new Date(),
      );

      // Step 7: exactly once, on `kind === 'redirect'` only, BEFORE the response is
      // written, and never on a fallback or a not-found (`click-events.md`).
      if (decision.kind === 'redirect') {
        this.emitClick(decision.link.id, decision.link.domainId, decision.link.tenantId, request);
      }

      this.write(response, decision, started);
    } catch (error) {
      // Invariant 1. Every failure path ends at a 404, including the ones with no SQLSTATE
      // to recognise (F-152) and the ones from a header value the client chose.
      logger.error(
        {
          code: 'redirect_resolution_failed',
          route: ROUTE_PATTERN,
          ...errorLogFields(error, { includeMessage: false }),
        },
        'the redirect could not be resolved; the default 404 was served',
      );

      // A response already begun cannot be replaced, and writing into it would corrupt it.
      // Nothing above writes before the decision is complete, so this arm is unreachable
      // today and is here because "unreachable" is a claim about code that will change.
      if (!response.headersSent) {
        // THE 302's TWO HEADERS ARE TAKEN BACK BEFORE THE 404 IS RENDERED, and this is not
        // hypothetical tidiness: the throw that lands here can come from `setHeader` itself,
        // on a stored destination carrying a raw CR or CRLF, and by then `Referrer-Policy:
        // unsafe-url` is already on the response object. Left there it would ship the 302's
        // documented exception on a 404, which is a header the contract puts on one status
        // only. Neither header is on a 404 that never attempted a redirect, so removing them
        // is a no-op on every other path through here.
        response.removeHeader('Location');
        response.removeHeader('Referrer-Policy');

        this.write(response, { kind: 'not-found', status: 404, host: null }, started);
      }
    }
  }

  /**
   * `enqueue` cannot throw by contract (AC-2-35) and is guarded anyway. The invariant that
   * matters to the visitor is AC-59's, that a click-event failure never affects the response,
   * and a guard here is what makes it true of code this module does not own.
   */
  private emitClick(linkId: string, domainId: string, tenantId: string, request: Request): void {
    if (this.clicks === null) {
      return;
    }

    try {
      this.clicks.enqueue({
        linkId,
        domainId,
        tenantId,
        occurredAt: new Date(),
        // The header bag, not an address: the trusted read and the HMAC belong to the sink's
        // side, where the key lives (GC-R; see `ports/click-sink.port.ts`).
        headers: request.headers,
      });
    } catch (error) {
      logger.error(
        {
          code: 'click_enqueue_failed',
          route: ROUTE_PATTERN,
          ...errorLogFields(error, { includeMessage: false }),
        },
        'the click sink threw; the redirect was served regardless',
      );
    }
  }

  private write(response: Response, decision: RedirectDecision, started: bigint): void {
    // Measured around the whole handler and set before anything is written, because a
    // header set after the first byte is a header nobody receives. ADR-0018 aggregates this
    // number; TASK-2-11 gates on it.
    const durationMs = Number(process.hrtime.bigint() - started) * MILLISECONDS_PER_NANOSECOND;

    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Server-Timing', `app;dur=${durationMs.toFixed(3)}`);

    if (decision.kind === 'not-found') {
      const page = renderNotFound(decision.host);

      response.setHeader('Content-Type', page.contentType);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Security-Policy', REDIRECT_404_CSP);
      response.status(page.status).end(page.body);

      return;
    }

    // `Location` FIRST, AND THE ORDER IS DELIBERATE. Node validates a header value and
    // throws `ERR_INVALID_CHAR` on a raw CR or LF, which is what stops a stored destination
    // from splitting the response. That throw is the one thing here that can fail, so it
    // happens before any header a 404 would not carry, and the catch above takes back what
    // did get set.
    response.setHeader('Location', decision.location);
    // `unsafe-url` on the 302 and on nothing else: passing the short URL to the destination
    // is the point of an attribution referrer and the link is public. helmet's
    // `no-referrer` is the default this deliberately overrides.
    response.setHeader('Referrer-Policy', 'unsafe-url');
    response.status(decision.status).end();
  }
}
