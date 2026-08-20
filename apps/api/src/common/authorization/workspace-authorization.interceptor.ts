/**
 * Contract: docs/contracts/workspace-authorization.md ("The two enforcement forms", Form A;
 *           "Status rules"; "What the implementer must guarantee": runs after `AuthGuard`,
 *           inside the tenant transaction, fails closed, never returns pass),
 *           docs/contracts/tenant-context.md ("Authorization moves into the handler", rules 1
 *           and 3), docs/contracts/error-envelope.md (invariants 5 and 6)
 * ADR: adr-0002 (interceptor order; the tenant transaction is the seam), adr-0015, adr-0062
 *      (one interceptor reading one table under its policy), adr-0024 (a refusal is a
 *      `DomainError`)
 * Produced by: TASK-1b-05. Registered as the THIRD `APP_INTERCEPTOR` in `app.module.ts`.
 *
 * ============================================================================
 * THE CONTRACT SAYS "WorkspaceGuard, a guard". THIS IS AN INTERCEPTOR, AND HERE IS WHY (D-05).
 * ============================================================================
 *
 * Nest runs every guard before any interceptor. `TenantTransactionInterceptor` opens the
 * request's tenant transaction, so a `CanActivate` cannot run inside it — and "its lookup is
 * under RLS", "with no active context it throws" are the load-bearing properties of the
 * contract's text; the noun is not. So the workspace check is an interceptor registered
 * AFTER the tenant one: RequestLog → TenantTransaction → WorkspaceAuthorization. The tenant
 * interceptor calls `next.handle()` INSIDE `withTenantTransaction`, and Nest invokes this
 * interceptor's `intercept()` from that `handle()` — under the ambient store, so `tenantDb()`
 * answers here, the membership lookup joins the request's transaction under `app.tenant_id`,
 * and `intercept()` may `await` the lookup before it returns `next.handle()` (Nest awaits a
 * `Promise<Observable>` from an interceptor). The handler is bound to the async context
 * current when THIS `next.handle()` is called (`AsyncResource.bind` at that moment), which
 * is still the transaction's — that is what `tenant-transaction.interceptor.ts`'s header
 * calls load-bearing, and it holds one layer down.
 *
 * WHAT IT DOES, IN ORDER, FOR A ROUTE CARRYING `RequireWorkspaceRole` OR `RequireTenantRole`
 * (read handler first, then class — the reading `@Public()` gets):
 *
 *   1. `@NoTenantTransaction()` or `@Public()` beside either key is a programming error:
 *      throw `AuthorizationMisconfiguredError` (500) at the first request. There is no
 *      transaction for the lookup on the first, no caller on the second, and the contract
 *      forbids the combination (rule 1). TASK-056's static assertion is not built here.
 *   2. Resolve the workspace id, when a workspace minimum is declared: `params.workspaceId`,
 *      then `body.workspaceId`, then `query.workspaceId`; a non-string is "absent". None →
 *      400 `workspace_id_required`. A tenant-only route resolves nothing.
 *   3. Look the caller up: workspace role through `MembershipRepository.roleFor`, tenant role
 *      through `TenantMembershipRepository.roleFor`, each only when its minimum is declared.
 *      Both read through `tenantDb()`, so WITH NO ACTIVE CONTEXT THEY THROW
 *      `TenantContextMissingError` (500) BEFORE ANY ROW IS READ. This interceptor never
 *      catches that and never returns pass without a lookup — rule 3, fail closed.
 *   4. The status table, 404 before 403: no membership (which is also another tenant's
 *      workspace, invisible under the policy, and a non-uuid) → 404 `not_found` with the
 *      body `WorkspaceRepository` gives a workspace that does not exist; no tenant row →
 *      404; then rank, through `requireWorkspaceRank` / `requireTenantRank` — the one place
 *      a rank is compared — 403 `insufficient_workspace_role` / `insufficient_tenant_role`.
 *   5. Record what was found on the `RequestContext` (`workspaceId`, `workspaceRole`,
 *      `tenantRole`), make the context the ambient actor (`actor-context.ts`, for Form B
 *      calls the handler makes) and hand over to the handler.
 *
 * A ROUTE WITH NEITHER KEY IS UNTOUCHED: no lookup, no statement, no refusal. The one thing
 * done for it is making the guard's `RequestContext` the ambient actor around `next.handle()`,
 * so `WorkspaceAuthorizer.assert(...)` (Form B) inside its handler knows who is asking. A
 * `@Public()` route has no context and gets nothing.
 *
 * NOTHING HERE LOGS. Not the workspace id, not the role, not the user (GC-G: `workspace_id`
 * is not a loggable field, and this file writes no line at all). A refusal is a `DomainError`
 * the filter records under `request_id` and `code`.
 *
 * NO CACHE. Every decorated request reads the row (workspace-authorization.md invariant 6,
 * AC-1b-21): a role changed in the table applies to the next request.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import type { AuthorisingTenantRole, WorkspaceRole } from '@shortkit/contracts';

import { REQUEST_CONTEXT_KEY } from '../../auth/auth.guard';
import { MembershipRepository } from '../../memberships/membership.repository';
import { TenantMembershipRepository } from '../../memberships/tenant-membership.repository';
import { NO_TENANT_TRANSACTION_METADATA, PUBLIC_ROUTE_METADATA } from '../../tenancy/tenant-context';
import type { RequestContext } from '../../tenancy/tenant-context';
import { runAsActor } from './actor-context';
import {
  AuthorizationMisconfiguredError,
  TenantMembershipNotFoundError,
  WorkspaceAccessNotFoundError,
  WorkspaceIdRequiredError,
} from './errors';
import { TENANT_ROLE_METADATA, WORKSPACE_ROLE_METADATA } from './roles';
import { requireTenantRank, requireWorkspaceRank } from './workspace-authorizer';

/** What this interceptor reads from the request: the guard's context and the three id carriers. */
interface AuthorizedRequest {
  [REQUEST_CONTEXT_KEY]?: RequestContext;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, unknown>>;
}

/**
 * Form A's resolution order, `workspace-authorization.md`. A value that is not a non-empty
 * string (an array from a repeated query key, a number in a body) counts as absent, so the
 * next carrier is tried and, with none left, the answer is 400 rather than a lookup on a
 * value that could never be a uuid.
 */
function resolveWorkspaceId(request: AuthorizedRequest): string {
  const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : undefined;

  for (const carrier of [request.params, body, request.query]) {
    const candidate = carrier?.workspaceId;

    if (typeof candidate === 'string' && candidate !== '') {
      return candidate;
    }
  }

  throw new WorkspaceIdRequiredError();
}

@Injectable()
export class WorkspaceAuthorizationInterceptor implements NestInterceptor {
  /** `@Inject(...)` written out for the reason `auth.guard.ts` gives (`consistent-type-imports`). */
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Inject(TenantMembershipRepository) private readonly tenantMemberships: TenantMembershipRepository,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const targets = [context.getHandler(), context.getClass()];
    const workspaceMin = this.reflector.getAllAndOverride<WorkspaceRole | undefined>(WORKSPACE_ROLE_METADATA, targets);
    const tenantMin = this.reflector.getAllAndOverride<AuthorisingTenantRole | undefined>(TENANT_ROLE_METADATA, targets);

    const request = context.switchToHttp().getRequest<AuthorizedRequest>();
    const actor = request[REQUEST_CONTEXT_KEY];

    if (workspaceMin === undefined && tenantMin === undefined) {
      // Untouched — see the header. The actor is made ambient for Form B and nothing else.
      return actor === undefined ? next.handle() : runAsActor(actor, () => next.handle());
    }

    // 1. The forbidden combinations. Checked before anything is resolved or read.
    if (this.reflector.getAllAndOverride<unknown>(NO_TENANT_TRANSACTION_METADATA, targets) !== undefined) {
      throw new AuthorizationMisconfiguredError(
        '@RequireWorkspaceRole / @RequireTenantRole on a @NoTenantTransaction() route: there is no ' +
          'tenant transaction for the membership lookup. Authorise inside the handler through ' +
          'WorkspaceAuthorizer (workspace-authorization.md, Form C).',
      );
    }

    if (this.reflector.getAllAndOverride<unknown>(PUBLIC_ROUTE_METADATA, targets) !== undefined) {
      throw new AuthorizationMisconfiguredError(
        '@RequireWorkspaceRole / @RequireTenantRole on a @Public() route: there is no caller to authorise.',
      );
    }

    if (actor === undefined) {
      // A decorated, non-public route with no RequestContext: AuthGuard did not run for it.
      // The tenant interceptor refuses this as 401 before it reaches here in the shipped
      // graph; outside it, fail closed rather than look anything up for nobody.
      throw new AuthorizationMisconfiguredError(
        'a role-decorated route reached the authorization interceptor with no RequestContext.',
      );
    }

    // 2.
    const workspaceId = workspaceMin === undefined ? undefined : resolveWorkspaceId(request);

    // 3. Each lookup runs through tenantDb(): no active transaction, no row read, a throw.
    const workspaceRole =
      workspaceMin === undefined || workspaceId === undefined
        ? undefined
        : await this.memberships.roleFor(workspaceId, actor.userId);
    const tenantRole = tenantMin === undefined ? undefined : await this.tenantMemberships.roleFor(actor.userId);

    // 4. 404 before 403: every absence is decided before any rank is compared, so a route
    // carrying both keys never tells a non-member of the workspace that their tenant role
    // is too low.
    if (workspaceMin !== undefined && workspaceRole === null) {
      throw new WorkspaceAccessNotFoundError();
    }

    if (tenantMin !== undefined && tenantRole === null) {
      throw new TenantMembershipNotFoundError();
    }

    if (workspaceMin !== undefined && workspaceRole !== undefined) {
      actor.workspaceRole = requireWorkspaceRank(workspaceRole, workspaceMin);
      actor.workspaceId = workspaceId;
    }

    if (tenantMin !== undefined && tenantRole !== undefined) {
      actor.tenantRole = requireTenantRank(tenantRole, tenantMin);
    }

    // 5.
    return runAsActor(actor, () => next.handle());
  }
}
