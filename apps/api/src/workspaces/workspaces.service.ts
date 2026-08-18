/**
 * Contract: docs/contracts/workspaces.md ("Endpoints", "The repository"), error-envelope.md
 * ADR: adr-0024-domain-error-transport.md
 * Produced by: TASK-012
 *
 * The four workspace operations over `WorkspaceRepository`, and the one place a repository
 * row becomes the client shape `@shortkit/contracts` declares.
 *
 * IT OPENS NO TRANSACTION AND CHECKS NO ROLE. Every method runs inside the tenant transaction
 * `TenantTransactionInterceptor` opened around the handler, so the repository's `tenantDb()`
 * is already bound to the caller's tenant; and authorization in this initiative is tenancy
 * and nothing else — no `WorkspaceGuard`, no membership lookup, no role (that is item 1b).
 * A caller reaching another tenant's workspace is stopped by row-level security and by the
 * repository's own `tenant_id` predicate, and what they get back is the same
 * `WorkspaceNotFoundError` a missing id gets: a 404 that never says which it was.
 *
 * NOTHING HERE CATCHES. `WorkspaceNotFoundError` is a `DomainError` and the filter answers
 * its code only if it arrives unwrapped (ADR-0024: the filter does not walk `cause`). The
 * transaction interceptor rolls back and rethrows the original, so letting it propagate is
 * the whole of the error handling.
 *
 * `tenantId` IS DROPPED ON THE WAY OUT, BY AN EXPLICIT FIELD LIST. `toClientWorkspace`
 * names the five fields it returns rather than spreading the row, so a column added to the
 * table later reaches the wire only when someone adds it to the contract and here.
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateWorkspaceRequest,
  ListWorkspacesQuery,
  RenameWorkspaceRequest,
  Workspace,
  WorkspaceListResponse,
} from '@shortkit/contracts';

import { WorkspaceRepository } from './workspace.repository';
import type { Workspace as WorkspaceRow } from './workspace.repository';

/** Row to client shape: `Date` to ISO string, `archivedAt` null kept null, no `tenantId`. */
export function toClientWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class WorkspacesService {
  /**
   * `@Inject(WorkspaceRepository)` written out for the reason `auth.guard.ts` gives: the
   * repository's `consistent-type-imports` rule would turn a type-only constructor parameter
   * into an `import type`, which erases the `design:paramtypes` entry the injector reads.
   */
  constructor(@Inject(WorkspaceRepository) private readonly repository: WorkspaceRepository) {}

  async create(input: CreateWorkspaceRequest): Promise<Workspace> {
    return toClientWorkspace(await this.repository.create({ name: input.name }));
  }

  /** `includeArchived` absent means false: the default list is the active workspaces (AC-23). */
  async list(query: ListWorkspacesQuery): Promise<WorkspaceListResponse> {
    const rows = await this.repository.list({ includeArchived: query.includeArchived ?? false });

    return { items: rows.map(toClientWorkspace) };
  }

  /**
   * Renaming an archived workspace is allowed: the repository does not consult the archive
   * state and this route does not either (docs/contracts/workspaces.md, "Endpoints").
   */
  async rename(id: string, input: RenameWorkspaceRequest): Promise<Workspace> {
    return toClientWorkspace(await this.repository.rename(id, input.name));
  }

  /** Idempotent: a second archive returns the row with the first archival's timestamp. */
  async archive(id: string): Promise<Workspace> {
    return toClientWorkspace(await this.repository.archive(id));
  }
}
