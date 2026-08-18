/**
 * Contract: docs/contracts/workspace-authorization.md ("Status rules"),
 *           docs/contracts/error-envelope.md (invariants 5 and 6; `ERROR_CODES` is not edited)
 * ADR: adr-0024-domain-error-transport.md
 * Produced by: TASK-1b-05
 *
 * The four refusals the authorization surface can make, each a `DomainError` so the filter
 * answers the envelope with the code's one status. No new code: `not_found`,
 * `insufficient_workspace_role`, `insufficient_tenant_role` and `workspace_id_required` all
 * exist in `ERROR_CODES` (GC-M).
 *
 * ============================================================================
 * THE 404 BODY IS BYTE-EQUAL TO `WorkspaceNotFoundError`'s. THAT IS THE POINT OF IT.
 * ============================================================================
 *
 * A non-member asking about a workspace, a member of tenant B naming tenant A's workspace,
 * a malformed id and an id no row carries all answer the same body as `WorkspaceRepository`
 * gives a workspace that does not exist (`workspaces/workspace-not-found.error.ts`). If the
 * two bodies differed by one character, the difference would say which of "no such
 * workspace" and "a workspace you may not see" applies, and that is existence disclosure
 * (error-envelope.md invariant 5). `workspace-authorizer.spec.ts` asserts the equality
 * against the real `WorkspaceNotFoundError` rather than trusting this comment; the class is
 * declared here rather than imported so `common/` does not depend on a feature directory.
 *
 * Every message is a fixed string. None carries the id the caller supplied: it may be
 * another tenant's (GC-9).
 */
import { DomainError } from '../errors/domain-error';

/** Same message as `WorkspaceNotFoundError`; the spec pins it. */
export const WORKSPACE_NOT_FOUND_MESSAGE = 'Workspace not found.';

/**
 * No membership in the workspace, a workspace of another tenant (invisible under RLS, so the
 * lookup answers nothing and the two are indistinguishable by construction), or a non-uuid.
 */
export class WorkspaceAccessNotFoundError extends DomainError {
  constructor() {
    super('not_found', WORKSPACE_NOT_FOUND_MESSAGE);
  }
}

/**
 * A `RequireTenantRole` / `assertTenant` check for a caller with NO `tenant_memberships` row
 * in the tenant the token names. Reachable only inside a token's 300 s life after the row is
 * removed (mint refuses without a membership); still a 404 and not a 403, because the 403
 * codes are only for a member whose role is too low (error-envelope.md invariant 6).
 */
export class TenantMembershipNotFoundError extends DomainError {
  constructor() {
    super('not_found', 'The requested resource was not found.');
  }
}

/** A member whose workspace role ranks below the minimum. */
export class InsufficientWorkspaceRoleError extends DomainError {
  constructor() {
    super('insufficient_workspace_role', 'Your role in this workspace does not permit this.');
  }
}

/** A tenant member whose tenant role ranks below the minimum. */
export class InsufficientTenantRoleError extends DomainError {
  constructor() {
    super('insufficient_tenant_role', 'Your role in this tenant does not permit this.');
  }
}

/** Form A with a workspace minimum and no `workspaceId` in params, body or query. */
export class WorkspaceIdRequiredError extends DomainError {
  constructor() {
    super('workspace_id_required', 'A workspaceId is required.');
  }
}

/**
 * A route that carries `@RequireWorkspaceRole` / `@RequireTenantRole` together with
 * `@NoTenantTransaction()` or `@Public()`. There is no tenant transaction (or no caller) for
 * the lookup to run in, and the contract forbids the combination outright
 * (`tenant-context.md`, "Authorization moves into the handler", rule 1). A PLAIN `Error`, so
 * the filter answers 500 and logs it: this is a programming error found at the first request,
 * never a refusal a client can act on. TASK-056's static assertion is what finds it before
 * that; it is not built here.
 */
export class AuthorizationMisconfiguredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AuthorizationMisconfiguredError';
  }
}
