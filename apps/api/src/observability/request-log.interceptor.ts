/**
 * Contract: docs/contracts/logging-and-headers.md ("Required fields": `request_id` on every
 *           line inside a request, `tenant_id` inside a tenant transaction, `route`, `status`
 *           and `duration_ms` at request completion; `route` is the PATTERN, never the path)
 * ADR: adr-0028 (a field reaches a line only if `LOGGABLE_FIELDS` names it), adr-0022,
 *      adr-0002 (guards run before interceptors, so the `RequestContext` is already written)
 * Produced by: TASK-016 (wave 8). Registered as `APP_INTERCEPTOR` in `app.module.ts`, BEFORE
 *              `TenantTransactionInterceptor`.
 *
 * ============================================================================
 * ONE LINE PER REQUEST, AT `info`, CARRYING FIVE NAMED FIELDS AND NOTHING ELSE.
 * ============================================================================
 *
 * `request_id`, `route`, `status`, `duration_ms`, and `tenant_id` when a `RequestContext`
 * exists. All five were named in `LOGGABLE_FIELDS` by ADR-0028's migration "ahead of the
 * request-log middleware a later TASK adds, so that TASK adds no names" — and this TASK adds
 * none. The `msg` is a fixed string. Nothing from the request body, the headers, the query or
 * the concrete URL is on the record, so nothing here depends on the scan to censor it; the
 * scan is what stands behind a mistake in a later edit, not what this record leans on.
 *
 * ARCHITECT RULINGS RECORDED HERE (TASK-016):
 *
 *   - ORDERING. Registered as `APP_INTERCEPTOR` BEFORE `TenantTransactionInterceptor`, so it
 *     is the OUTERMOST interceptor and `duration_ms` covers the transaction as well as the
 *     handler. Nest runs global interceptors in registration order and the first registered
 *     wraps the rest.
 *   - `tenant_id` IS READ FROM THE `RequestContext` THE GUARD WROTE, not from
 *     `currentTenantId()`: the guard runs before every interceptor, so the context is there
 *     whatever this interceptor's position, and the line is emitted after the transaction's
 *     store has been left. It is present only when a context exists — a `@Public()` route
 *     has none, and the line carries no `tenant_id` key rather than a null.
 *   - NO `method`. The contract's "Required fields" table does not name it, and a field
 *     reaches a line only if it is named (ADR-0028); adding it is a contract amendment first.
 *     Recorded as a follow-up in the TASK report.
 *   - NO USER IDENTIFIER, AND NEVER AN EMAIL. A user id is a Design decision reserved for
 *     the architect; `email` may not join the allowlist under any spelling.
 *   - THE STATUS ON A THROWN ERROR IS READ WHEN THE RESPONSE FINISHES, NOT IN `finalize`.
 *     MEASURED on @nestjs/core 11.1.28 with Express 5.2.1, before this file was written: an
 *     RxJS `finalize` on the handler's observable runs when the observable errors, which is
 *     BEFORE the promise rejection reaches Nest's router proxy and therefore before
 *     `ApiExceptionFilter` writes anything — at that moment `response.statusCode` is still
 *     the Express default `200` for a handler that threw a 404 and for one that threw a 500
 *     (`headersSent` false). On the success path Nest has already applied `@HttpCode` when
 *     the interceptor is entered (a `@Post()` reads `201` before the handler runs), so
 *     `finalize` would have been right for 2xx and wrong for every error. The response's
 *     `'finish'` event fires after the filter has written — measured `404` and `500` there —
 *     so that is the hook, with `'close'` as the fallback for a response the client
 *     abandoned before it finished (Node emits `'close'` after `'finish'` too, so the flag
 *     below keeps it to one line either way).
 *
 * WHAT THIS INTERCEPTOR DOES NOT SEE, stated so the claim is not read wider than it is:
 *
 *   - `/api/auth/*`. Better Auth is mounted on Express outside the Nest module graph
 *     (ADR-0013); no interceptor runs there. `test/observability/no-credentials-in-logs`
 *     scans the WHOLE child process's output during a signup for that reason.
 *   - A request the guard refused (401), and a path no route matched (404 from Nest's
 *     router): Nest runs guards before interceptors, and an interceptor runs only around a
 *     matched handler, so neither produces a line from here. NOR DOES THE FILTER: its
 *     DomainError branch renders the envelope without logging, so a guard-refused 401 (and
 *     every other DomainError refusal) leaves NO line at all today. Repeated credential
 *     failures against the bearer surface are therefore not observable from the log; the
 *     remedy is Express-level middleware in `main.ts`, not an interceptor. Follow-up recorded
 *     in the TASK report.
 *   - A body-parser 400 (malformed JSON): Express middleware, before routing; the filter's
 *     line is the only one.
 *
 * `request_id` IS CHOSEN HERE AND READ BY THE FILTER. `requestIdFor` (`request-id.ts`, the
 * one reading of `x-request-id`) picks the caller's header or a fresh uuid, and the id is
 * stored on the request under `REQUEST_ID_KEY`; `exception-filter.ts` reads that key first,
 * so the request line and the filter's error line for one failed request share an id whether
 * or not the caller sent a header.
 */
import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';

import { REQUEST_CONTEXT_KEY } from '../auth/auth.guard';
import type { RequestContext } from '../tenancy/tenant-context';
import { logger } from './logger';
import type { RequestLogFields } from './logger';
import { REQUEST_ID_KEY, requestIdFor } from './request-id';
import type { RequestIdCarrier } from './request-id';

/** The fixed `msg`. It names the event, and nothing of the request is interpolated into it. */
const REQUEST_COMPLETED = 'request completed';

/**
 * What `route` says when Express has no matched route on the request. Unreachable through
 * Nest — an interceptor runs only around a matched handler, and Express sets `req.route`
 * before the handler stack runs — but a concrete path is what must NEVER be substituted, so
 * the fallback is a fixed word rather than `req.path`.
 */
const NO_ROUTE_PATTERN = 'unmatched';

/**
 * What this interceptor reads from the request: the matched Express route (its `path` is the
 * PATTERN, `/api/workspaces/:id`, global prefix included — measured on Express 5.2.1 under
 * Nest's `setGlobalPrefix`), the header bag and id slot `request-id.ts` reads, and the
 * property the guard wrote. `apps/api` types the request by the members it uses rather than importing Express's
 * type, the way `exception-filter.ts` does.
 */
interface LoggedRequest extends RequestIdCarrier {
  readonly route?: { readonly path?: unknown };
  [REQUEST_CONTEXT_KEY]?: RequestContext;
}

/** The two members of the response this interceptor uses. */
interface LoggedResponse {
  readonly statusCode: number;
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

@Injectable()
export class RequestLogInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<LoggedRequest>();
    const response = http.getResponse<LoggedResponse>();

    const started = performance.now();
    const requestId = requestIdFor(request);
    request[REQUEST_ID_KEY] = requestId;

    // Read now rather than in the listener: the guard has already run (ADR-0002), and the
    // line should describe the context the request was served under, not whatever a later
    // stage left on the object.
    const tenantId = request[REQUEST_CONTEXT_KEY]?.tenantId;

    let written = false;
    const writeLine = (): void => {
      if (written) {
        return;
      }
      written = true;

      const fields: RequestLogFields = {
        request_id: requestId,
        route: routePattern(request),
        status: response.statusCode,
        duration_ms: Math.round(performance.now() - started),
        ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
      };

      logger.info(fields, REQUEST_COMPLETED);
    };

    // See the header: `'finish'` is after the filter has written on the error path, and
    // `'close'` is the one event a response the client abandoned still emits.
    response.once('finish', writeLine);
    response.once('close', writeLine);

    return next.handle();
  }
}

/** The matched pattern, and never the concrete path — see `NO_ROUTE_PATTERN`. */
function routePattern(request: LoggedRequest): string {
  const path = request.route?.path;

  return typeof path === 'string' && path !== '' ? path : NO_ROUTE_PATTERN;
}
