/**
 * Contract: docs/contracts/workspace-authorization.md (Form B: `assert(workspaceId, min)`,
 *           `assertTenant(min)`; no caller argument), tenant-context.md (`RequestContext`)
 * ADR: adr-0002 (the interceptor chain is where per-request ambient state is established)
 * Produced by: TASK-1b-05
 *
 * WHO IS ASKING, FOR THE IMPERATIVE FORM. `WorkspaceAuthorizer.assert(workspaceId, min)` is
 * called from inside a handler or a service, which is one or two calls away from the request
 * object the guard wrote the `RequestContext` to, and the contract's signature takes no
 * caller. So the `WorkspaceAuthorizationInterceptor` (a global interceptor, hence on every
 * authenticated route in the graph) makes the request's `RequestContext` visible through
 * `AsyncLocalStorage` for the handler's duration, the same mechanism `tenant-context.ts`
 * uses for the transaction, and the authorizer reads it here.
 *
 * FAIL CLOSED. `currentActor()` outside a request throws; it never answers a default or an
 * empty user. A Form B call from a place no request reaches (a Better Auth hook, a boot
 * script) is a 500 and a finding, not a pass. Plain `Error`, not `DomainError`: this is a
 * programming error, never a refusal a client can act on.
 *
 * NOT A SECOND SOURCE OF THE TENANT ID. The tenant transaction is still opened from
 * `RequestContext.tenantId` by `TenantTransactionInterceptor`; nothing reads `tenantId` from
 * here to open one. What is read is `userId` (the subject of a membership lookup) and the
 * fields the authorization interceptor sets (`workspaceId`, `workspaceRole`, `tenantRole`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { RequestContext } from '../../tenancy/tenant-context';

export class ActorContextMissingError extends Error {
  constructor() {
    super(
      'No request actor is active. WorkspaceAuthorizer runs inside an authenticated request ' +
        'under WorkspaceAuthorizationInterceptor; a call from anywhere else has no caller to authorise.',
    );
    this.name = 'ActorContextMissingError';
  }
}

/** Module-private; reached only through the two functions below. */
const actorStorage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `actor` as the ambient caller. The interceptor's, and a spec's. */
export function runAsActor<T>(actor: RequestContext, fn: () => T): T {
  return actorStorage.run(actor, fn);
}

/** The ambient caller. Throws `ActorContextMissingError` outside `runAsActor`. */
export function currentActor(): RequestContext {
  const actor = actorStorage.getStore();

  if (actor === undefined) {
    throw new ActorContextMissingError();
  }

  return actor;
}
