/**
 * Contract: docs/contracts/workspaces.md ("Endpoints", "The repository"), error-envelope.md,
 *           workspace-authorization.md ("Minimum role per surface")
 * ADR: adr-0024-domain-error-transport.md, adr-0062-workspace-membership-is-a-second-table.md
 * Produced by: TASK-012; TASK-1b-06 (roles: the creator's membership, the filtered list,
 *              `get`, `workspaceRole` on the wire)
 *
 * The five workspace operations over `WorkspaceRepository` and `MembershipRepository`, and
 * the one place a repository row becomes the client shape `@shortkit/contracts` declares.
 *
 * IT OPENS NO TRANSACTION AND COMPARES NO RANK. Every method runs inside the tenant
 * transaction `TenantTransactionInterceptor` opened around the handler, so both
 * repositories' `tenantDb()` are already bound to the caller's tenant; and the rank check
 * for the single-row routes ran in `WorkspaceAuthorizationInterceptor` (Form A) before the
 * handler was reached — this service reads what it found on the `RequestContext`
 * (`workspaceRole`) and never looks a role up itself. What is the caller's is taken from
 * the `RequestContext` the controller hands in (`actor`), never from the body.
 *
 * WHO SEES WHAT (D-10). `create` writes the workspace AND the creator's `workspace_admin`
 * membership, in the one transaction — a workspace with no admin would be reachable by
 * nobody, since there is no implicit tenant-owner bypass. `list` answers the workspaces the
 * caller holds a membership in, and only those: `listForUser` joins `memberships` on the
 * caller, owner-qualified on both tables. A tenant `owner` who is not a member of a
 * workspace does not see it — the contract's status table is unconditional.
 *
 * `workspaceRole` ON THE WAY OUT: the literal `workspace_admin` for `create` (what was just
 * written), the joined `memberships.role` for each `list` row, `RequestContext.workspaceRole`
 * for `get`/`rename`/`archive` — set by the interceptor on a route carrying
 * `@RequireWorkspaceRole`. A single-row call that arrives WITHOUT one is a route missing its
 * decorator, and `roleOf` throws a plain `Error` (500) rather than answer a role it did not
 * establish: fail closed, the same rule the interceptor keeps.
 *
 * NOTHING HERE CATCHES. `WorkspaceNotFoundError` is a `DomainError` and the filter answers
 * its code only if it arrives unwrapped (ADR-0024: the filter does not walk `cause`). The
 * transaction interceptor rolls back and rethrows the original, so letting it propagate is
 * the whole of the error handling — and a membership insert that fails rolls the workspace
 * insert back with it.
 *
 * `tenantId` IS DROPPED ON THE WAY OUT, BY AN EXPLICIT FIELD LIST. `toClientWorkspace`
 * names the fields it returns rather than spreading the row, so a column added to the
 * table later reaches the wire only when someone adds it to the contract and here.
 */
import { Inject, Injectable } from '@nestjs/common';
import { WORKSPACE_ROLE } from '@shortkit/contracts';
import type {
  CreateWorkspaceRequest,
  ListWorkspacesQuery,
  RenameWorkspaceRequest,
  Workspace,
  WorkspaceListResponse,
  WorkspaceRole,
} from '@shortkit/contracts';

import { MembershipRepository } from '../memberships/membership.repository';
import type { RequestContext } from '../tenancy/tenant-context';
import { WorkspaceNotFoundError } from './workspace-not-found.error';
import { WorkspaceRepository } from './workspace.repository';
import type { Workspace as WorkspaceRow } from './workspace.repository';

/**
 * Row to client shape: `Date` to ISO string, `archivedAt` null kept null, no `tenantId`, and
 * the caller's role — a branded value in, the unbranded wire value out (it is the same
 * string; the brand is compile-time only, ADR-0048).
 */
export function toClientWorkspace(row: WorkspaceRow, role: WorkspaceRole): Workspace {
  return {
    id: row.id,
    name: row.name,
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    workspaceRole: role,
  };
}

/**
 * The role the authorization interceptor established for this request's workspace. Absent
 * means the route reached the service without `@RequireWorkspaceRole` — a programming
 * error, answered 500, never a default.
 */
function roleOf(actor: RequestContext): WorkspaceRole {
  if (actor.workspaceRole === undefined) {
    throw new Error(
      'WorkspacesService: a workspace-scoped operation ran with no workspaceRole on the ' +
        'RequestContext. The route is missing @RequireWorkspaceRole (workspace-authorization.md, Form A).',
    );
  }

  return actor.workspaceRole;
}

@Injectable()
export class WorkspacesService {
  /**
   * `@Inject(...)` written out for the reason `auth.guard.ts` gives: the repository's
   * `consistent-type-imports` rule would turn a type-only constructor parameter into an
   * `import type`, which erases the `design:paramtypes` entry the injector reads.
   */
  constructor(
    @Inject(WorkspaceRepository) private readonly repository: WorkspaceRepository,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * The workspace and the creator's `workspace_admin` membership, in this order, in the
   * ambient transaction (D-10, AC-1b-17). The membership insert names the row just created;
   * a failure there rolls the workspace back with it.
   */
  async create(actor: RequestContext, input: CreateWorkspaceRequest): Promise<Workspace> {
    const created = await this.repository.create({ name: input.name });

    await this.memberships.create({
      workspaceId: created.id,
      userId: actor.userId,
      role: WORKSPACE_ROLE.workspace_admin,
    });

    return toClientWorkspace(created, WORKSPACE_ROLE.workspace_admin);
  }

  /**
   * The caller's workspaces — those they hold a membership in — each with their role
   * (AC-1b-18). `includeArchived` absent means false: the default list is the active
   * workspaces (AC-23).
   */
  async list(actor: RequestContext, query: ListWorkspacesQuery): Promise<WorkspaceListResponse> {
    const rows = await this.repository.listForUser(actor.userId, {
      includeArchived: query.includeArchived ?? false,
    });

    return { items: rows.map((row) => toClientWorkspace(row, row.role)) };
  }

  /**
   * One workspace by id. The interceptor already answered 404 for a non-member, another
   * tenant's id and a non-uuid; the repository's `null` — unreachable once a membership row
   * exists, since the composite foreign key ties it to the workspace — is the same 404.
   */
  async get(actor: RequestContext, workspaceId: string): Promise<Workspace> {
    const role = roleOf(actor);
    const row = await this.repository.findById(workspaceId);

    if (row === null) {
      throw new WorkspaceNotFoundError();
    }

    return toClientWorkspace(row, role);
  }

  /**
   * Renaming an archived workspace is allowed: the repository does not consult the archive
   * state and this route does not either (docs/contracts/workspaces.md, "Endpoints").
   */
  async rename(actor: RequestContext, workspaceId: string, input: RenameWorkspaceRequest): Promise<Workspace> {
    const role = roleOf(actor);

    return toClientWorkspace(await this.repository.rename(workspaceId, input.name), role);
  }

  /** Idempotent: a second archive returns the row with the first archival's timestamp. */
  async archive(actor: RequestContext, workspaceId: string): Promise<Workspace> {
    const role = roleOf(actor);

    return toClientWorkspace(await this.repository.archive(workspaceId), role);
  }
}
