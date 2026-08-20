/**
 * Contract: docs/contracts/tenant-context.md ("What the implementer must guarantee":
 *           registered as `APP_INTERCEPTOR`, runs after `AuthGuard`, skips `@Public()` and
 *           `@NoTenantTransaction()`), docs/contracts/error-envelope.md (a refusal is a
 *           `DomainError`; 401 for `unauthenticated`)
 * ADR: adr-0002-tenant-context-binding.md (the interceptor runs after authentication and
 *      before the handler; third-party I/O goes in `afterCommit`, never in the body),
 *      adr-0013 (why no community package registers a competing global guard), adr-0024
 *      (a refusal is a `DomainError`)
 * Produced by: TASK-006 (wave 5). Registered as `APP_INTERCEPTOR` in `app.module.ts`.
 *
 * ============================================================================
 * THE SEAM EVERY LATER HANDLER INHERITS: ONE TENANT TRANSACTION PER AUTHENTICATED REQUEST.
 * ============================================================================
 *
 * `AuthGuard` (TASK-005) writes a `RequestContext` to `request[REQUEST_CONTEXT_KEY]` from the
 * token's claims. This interceptor reads it and opens `withTenantTransaction(tenantId, ...)`
 * around the handler, so that every statement a handler or a repository issues runs under
 * `set_config` of the caller's tenant with no handler having to say so. The transaction
 * commits when the handler resolves and rolls back (rethrowing the original error) when it
 * throws; both are `withTenantTransaction`'s own semantics and nothing here re-implements
 * them (AC-14).
 *
 * NESTING IS THE HELPER'S, NOT THIS FILE'S. A repository method that opens its own
 * `withTenantTransaction` under this interceptor JOINS the request's transaction (same
 * tenant, no savepoint) and a call for a different tenant throws `TenantContextMismatchError`.
 * That is what lets TASK-011's repository be written without knowing whether an interceptor
 * is above it, and it is why there is no "am I already inside one?" check here.
 *
 * TWO SKIPS, READ EXACTLY AS THE GUARD READS ITS KEY: handler first, then class, presence
 * only. `PUBLIC_ROUTE_METADATA`: the guard let the request through with no token, there is
 * no context and no tenant, and a `@Public()` route reaches tenant data only through a
 * capability-token entry point of its own (ADR-0021). `NO_TENANT_TRANSACTION_METADATA`: the
 * guard ran and the context exists, and the handler opens its own transactions because one
 * enclosing transaction is the wrong shape for it (`tenant-context.md`, "Routes that open
 * their own transaction").
 *
 * FAIL CLOSED WHEN THE CONTEXT IS MISSING. On a guarded route the context is absent only if
 * the guard did not run (a misconfigured module, a bypass, a route registered outside the
 * graph), and the two candidate responses are "open a transaction with no tenant" and
 * "refuse". The first is GC-5's hole; the second is a 401 `unauthenticated`, a `DomainError`
 * so that the filter answers the envelope rather than a 500 that reads as a crash. It is a
 * 401 and not a 500 because from the client's side the request IS unauthenticated: nothing
 * established who is asking.
 *
 * ============================================================================
 * `next.handle()` IS CALLED INSIDE THE TRANSACTION CALLBACK, AND THAT IS LOAD-BEARING.
 * ============================================================================
 *
 * `withTenantTransaction` makes the context visible through `AsyncLocalStorage`, and Nest's
 * `InterceptorsConsumer` (11.1.28) captures the async context with `AsyncResource.bind` AT THE
 * MOMENT `next.handle()` IS CALLED, not when the observable it returns is subscribed. So the
 * handler runs under whatever store was active when `handle()` was invoked, and calling it
 * outside the callback and merely subscribing inside would run the handler with NO tenant
 * context: `currentTenantId()` throws, `tenantDb()` throws, and a repository's own
 * `withTenantTransaction` opens a SECOND transaction on a second pooled connection instead of
 * joining. `defer` keeps the whole thing lazy (nothing opens until Nest subscribes), and
 * `lastValueFrom` holds the transaction open until the handler's observable completes, which
 * is the same reduction Nest itself applies to an observable-returning HTTP handler.
 *
 * The response is written after COMMIT returns, because `from(promise)` emits only once
 * `withTenantTransaction` has resolved. A handler's `afterCommit` hooks have run by then too.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defer, from, lastValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';

import { UNAUTHENTICATED_MESSAGE } from '../auth/auth-claims';
import { REQUEST_CONTEXT_KEY } from '../auth/auth.guard';
import { DomainError } from '../common/errors/domain-error';
import {
  NO_TENANT_TRANSACTION_METADATA,
  PUBLIC_ROUTE_METADATA,
  withTenantTransaction,
} from './tenant-context';
import type { RequestContext } from './tenant-context';

/** What this interceptor reads from the request: the one property the guard wrote. */
interface ContextCarryingRequest {
  [REQUEST_CONTEXT_KEY]?: RequestContext;
}

@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  /**
   * `@Inject(Reflector)` written out for the reason `auth.guard.ts` gives: the repository's
   * `consistent-type-imports` rule would turn a type-only constructor parameter into an
   * `import type`, which erases the `design:paramtypes` entry the injector reads.
   */
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.isExempt(context)) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<ContextCarryingRequest>();
    const requestContext = request[REQUEST_CONTEXT_KEY];

    if (requestContext === undefined) {
      // The guard did not run for a route that is not public. Refuse; never open a
      // transaction with no tenant. Thrown synchronously: Nest's consumer invokes
      // `intercept` inside an async chain and the filter answers the envelope.
      throw new DomainError('unauthenticated', UNAUTHENTICATED_MESSAGE);
    }

    // `tenantId` is the `tid` claim, already uuid-checked and lower-cased by the guard
    // (auth-claims.ts); `withTenantTransaction` checks it again before `set_config` because
    // it must for its other callers, and the double check costs a regex.
    return defer(() =>
      from(
        withTenantTransaction(requestContext.tenantId, () =>
          // See the header: `next.handle()` must be CALLED here, under the active store.
          lastValueFrom(next.handle(), { defaultValue: undefined }),
        ),
      ),
    );
  }

  /**
   * Handler first, then class, presence only: the same reading `AuthGuard` gives
   * `PUBLIC_ROUTE_METADATA`, so a route the guard treats as public is one this interceptor
   * treats as public, with no room for the two to disagree on a class-level marker.
   */
  private isExempt(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    return (
      this.reflector.getAllAndOverride<unknown>(PUBLIC_ROUTE_METADATA, targets) !== undefined ||
      this.reflector.getAllAndOverride<unknown>(NO_TENANT_TRANSACTION_METADATA, targets) !==
        undefined
    );
  }
}
