/**
 * Contract: docs/contracts/workspaces.md, tenant-context.md, isolation-coverage.md
 * ADR: adr-0002-tenant-context-binding.md, adr-0003-rls-policy-template-and-roles.md,
 *      adr-0020-isolation-suite-enumeration.md
 * Produced by: TASK-011; TASK-1b-06 (`listForUser`, the membership join)
 *
 * The first repository class in `apps/api/src`, and the shape every later one copies.
 *
 * IT REACHES THE DATABASE THROUGH `tenantDb()` AND NOTHING ELSE. `tenantDb()` returns the
 * ambient handle of the open tenant transaction and THROWS `TenantContextMissingError`
 * outside one, which is what turns an accidental unscoped read into a crash rather than
 * a leak. It takes no client argument, so no caller can hand it a connection that has
 * set no flag, and it never imports `databaseTransaction` from `db/client.ts` — that
 * export carries an enumerated caller list and a repository is not on it.
 *
 * EVERY STATEMENT IS OWNER-QUALIFIED EVEN THOUGH THE POLICY ALREADY SCOPES IT. Every
 * WHERE carries `tenant_id = currentTenantId()` and the insert sets `tenant_id`
 * explicitly. The isolation harness's round-2 finding (F-302) is the reason: PostgreSQL
 * routes an owner-qualified write through the SELECT policy and reports zero rows however
 * wide open the UPDATE policy is, so a repository relying on the policy alone issues
 * statements whose refusal proves less than it appears to. Two independent scopes — the
 * policy and the predicate — have to BOTH be wrong for a row to cross a tenant boundary
 * through this class. The unit spec compiles every statement and asserts the
 * qualification; the isolation suite attempts every method across tenants.
 *
 * `@TenantScopedRepository()` marks it for ADR-0020's repository enumeration: TASK-056's
 * DiscoveryService finds providers carrying the key and enumerates their public methods
 * as isolation subjects. Until then `test/isolation/registrations.ts` registers the same
 * five methods by hand, under this class's name.
 *
 * NOT-FOUND SEMANTICS. `rename` and `archive` throw `WorkspaceNotFoundError` (`not_found`,
 * 404) when the id names no workspace the current tenant owns; `findById` returns null.
 * A row belonging to another tenant is invisible to both the policy and the predicate,
 * so it gets the same answer as a row that does not exist — on purpose.
 *
 * ARCHIVE IS IDEMPOTENT. `archived_at` records the FIRST archival and a second call
 * leaves it where it was: `coalesce(archived_at, now())`. Renaming an archived workspace
 * is permitted here; whether a route allows it is TASK-012's contract, not this class's.
 *
 * `listForUser` (TASK-1b-06, D-10) IS THE MEMBERSHIP-FILTERED LIST `GET /api/workspaces`
 * ANSWERS: an inner join on `memberships` for one user, carrying the caller's role out with
 * each row. It is owner-qualified on BOTH tables — `workspaces.tenant_id = current` and
 * `memberships.tenant_id = current` in the WHERE, and the join itself pairs
 * `(workspace_id, tenant_id)` — so a membership row and a workspace row have to agree on
 * the tenant AND both be the current one, over and above the two tables' policies. `list`
 * stays: the isolation suite attempts it as a repository subject and nothing in the routes
 * calls it any more.
 */
import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { asWorkspaceRole } from '@shortkit/contracts';
import type { WorkspaceRole } from '@shortkit/contracts';

import { memberships, workspaces } from '../db/schema';
import { currentTenantId, tenantDb, TenantScopedRepository } from '../tenancy/tenant-context';

import { WorkspaceNotFoundError } from './workspace-not-found.error';

/**
 * The row shape, and the shape TASK-012's contract mirrors. `archivedAt` null means
 * active (docs/contracts/workspaces.md).
 */
export interface Workspace {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A row of `listForUser`: the workspace and the listed user's role in it, branded. */
export interface WorkspaceWithRole extends Workspace {
  readonly role: WorkspaceRole;
}

export interface CreateWorkspaceInput {
  readonly name: string;
}

export interface ListWorkspacesOptions {
  /** Default false: an archived workspace leaves the ordinary list (AC-23). */
  readonly includeArchived: boolean;
}

/**
 * The same shape `assertUuid` in tenant-context.ts accepts. A workspace id that is not
 * a uuid names no row this tenant owns, so it is answered as not-found here rather than
 * reaching Postgres and raising 22P02 — which the exception filter would turn into a 500
 * for what is a client's malformed reference. Route-level validation is TASK-012's; this
 * is the repository's own floor.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres's clock rather than Node's, so `updated_at` agrees with the column defaults. */
const NOW = sql`now()`;

@TenantScopedRepository()
@Injectable()
export class WorkspaceRepository {
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    // `tenant_id` set explicitly from the context rather than left to any default:
    // the policy's WITH CHECK would refuse a wrong one, and the predicate says which one.
    const [row] = await tenantDb()
      .insert(workspaces)
      .values({ tenantId: currentTenantId(), name: input.name })
      .returning();

    if (row === undefined) {
      // RETURNING on a row the WITH CHECK admitted always yields it; reaching here means
      // the driver answered something this class does not understand.
      throw new Error('workspaces insert returned no row.');
    }

    return row;
  }

  async list(options: ListWorkspacesOptions): Promise<Workspace[]> {
    const owned = eq(workspaces.tenantId, currentTenantId());

    return tenantDb()
      .select()
      .from(workspaces)
      .where(options.includeArchived ? owned : and(owned, isNull(workspaces.archivedAt)))
      // Creation order, then id, so two workspaces created in one transaction — which
      // share a `now()` — still list deterministically.
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
  }

  /**
   * The workspaces `userId` holds a membership in, with the role, in `list`'s order. What
   * `GET /api/workspaces` answers (D-10). A user with no memberships lists nothing, whatever
   * the tenant holds; a membership naming another tenant's workspace cannot exist (the
   * composite foreign key) and would be invisible here if it did (both predicates, both
   * policies).
   */
  async listForUser(userId: string, options: ListWorkspacesOptions): Promise<WorkspaceWithRole[]> {
    const tenantId = currentTenantId();
    const owned = and(
      eq(workspaces.tenantId, tenantId),
      eq(memberships.tenantId, tenantId),
      eq(memberships.userId, userId),
    );

    const rows = await tenantDb()
      .select({
        id: workspaces.id,
        tenantId: workspaces.tenantId,
        name: workspaces.name,
        archivedAt: workspaces.archivedAt,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        role: memberships.role,
      })
      .from(workspaces)
      .innerJoin(
        memberships,
        and(eq(memberships.workspaceId, workspaces.id), eq(memberships.tenantId, workspaces.tenantId)),
      )
      .where(options.includeArchived ? owned : and(owned, isNull(workspaces.archivedAt)))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id));

    return rows.map((row) => ({ ...row, role: asWorkspaceRole(row.role) }));
  }

  async findById(id: string): Promise<Workspace | null> {
    if (!UUID.test(id)) {
      return null;
    }

    const [row] = await tenantDb()
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), eq(workspaces.tenantId, currentTenantId())))
      .limit(1);

    return row ?? null;
  }

  async rename(id: string, name: string): Promise<Workspace> {
    if (!UUID.test(id)) {
      throw new WorkspaceNotFoundError();
    }

    const [row] = await tenantDb()
      .update(workspaces)
      .set({ name, updatedAt: NOW })
      .where(and(eq(workspaces.id, id), eq(workspaces.tenantId, currentTenantId())))
      .returning();

    if (row === undefined) {
      throw new WorkspaceNotFoundError();
    }

    return row;
  }

  async archive(id: string): Promise<Workspace> {
    if (!UUID.test(id)) {
      throw new WorkspaceNotFoundError();
    }

    const [row] = await tenantDb()
      .update(workspaces)
      // Idempotent: the first archival's timestamp survives a second call.
      .set({ archivedAt: sql`coalesce(${workspaces.archivedAt}, now())`, updatedAt: NOW })
      .where(and(eq(workspaces.id, id), eq(workspaces.tenantId, currentTenantId())))
      .returning();

    if (row === undefined) {
      throw new WorkspaceNotFoundError();
    }

    return row;
  }
}
