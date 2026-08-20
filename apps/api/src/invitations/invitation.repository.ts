/**
 * Contract: docs/contracts/invitation-tokens.md, workspace-authorization.md (D-09 rows),
 *           tenant-context.md (invariant 4), isolation-coverage.md
 * ADR: adr-0002-tenant-context-binding.md, adr-0003-rls-policy-template-and-roles.md,
 *      adr-0020-isolation-suite-enumeration.md, adr-0021-tenant-routing-capability-tokens.md
 * Produced by: TASK-1b-04
 * Consumed by: TASK-1b-08 (the create / list / revoke routes), TASK-1b-10 (isolation subjects)
 *
 * The authenticated half of the invitation surface, in `WorkspaceRepository`'s shape:
 * `tenantDb()` and nothing else, every statement owner-qualified (F-302), a malformed id
 * answered as not-found without reaching Postgres, `@TenantScopedRepository()` for
 * ADR-0020's enumeration.
 *
 * ============================================================================
 * IT NEVER PARSES A TOKEN AND NEVER RETURNS A DIGEST (GC-K, GC-L).
 * ============================================================================
 *
 * `create` takes the DIGEST the service obtained from `issueCapabilityToken` and stores it;
 * the raw token never enters this class. `InvitationRow` has no `tokenDigest` field, so no
 * read here can hand a caller anything to compare a token against — the only comparison
 * in the system is `capability-lookup.ts`'s, under the token's own tenant. Looking an
 * invitation up BY token is that file's job and not a method here, on purpose: a
 * `findByToken` on an ambient-context repository would be the digest-skipping read
 * ADR-0021 forbids.
 *
 * NOT-FOUND SEMANTICS. `revoke` throws `InvitationNotFoundError` for an id the current
 * tenant does not own, for a non-uuid, and for another tenant's row — one answer, as
 * `WorkspaceRepository` gives. `findById` returns null. `listForWorkspace` returns `[]`
 * for a non-uuid without a query.
 *
 * REVOKE. Idempotent on `revoked` (`revoked_at` keeps its first value); refuses `accepted`
 * with 409 `invitation_already_accepted`; an expired-but-pending row is revoked anyway
 * (D-09). The UPDATE's WHERE excludes `accepted`, so a revoke that races an accept sees
 * zero rows and re-reads to say which of "gone" and "accepted" it met.
 *
 * WHAT A NAMED WORKSPACE OF ANOTHER TENANT DOES HERE. `invitation_workspaces` carries
 * `FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces (id, tenant_id)` (ADR-0062),
 * so `create` with such a workspace — or with a workspace id that exists nowhere — is
 * refused 23503 by the database. The route's Form B check answers 404 long before this is
 * reached (D-09); the constraint is the floor, and `create` maps that 23503 to
 * `WorkspaceNotFoundError` (`not_found`, the same body Form B gives) so a bypassed check
 * is still a 404 and never a 500 that says a row exists somewhere. Only the grant insert
 * is caught; a 23503 on the invitation row itself (`invited_by_user_id`) is a programming
 * error and propagates.
 */
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import { asWorkspaceRole } from '@shortkit/contracts';
import type { InvitationStateValue, WorkspaceRole, WorkspaceRoleValue } from '@shortkit/contracts';

import { postgresErrorCode } from '../db/client';
import { invitations, invitationWorkspaces, workspaces } from '../db/schema';
import { currentTenantId, tenantDb, TenantScopedRepository } from '../tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../workspaces/workspace-not-found.error';

import { InvitationAlreadyAcceptedError, InvitationNotFoundError } from './errors';

export interface InvitationRowWorkspace {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceRole: WorkspaceRole;
}

/** The row shape `invitationContract` mirrors (minus `tenantId`). NO `tokenDigest`, ever. */
export interface InvitationRow {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly state: InvitationStateValue;
  readonly workspaces: readonly InvitationRowWorkspace[];
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly invitedByUserId: string;
  readonly inviterEmail: string;
  readonly acceptedByUserId: string | null;
}

export interface CreateInvitationInput {
  /** Already normalised by `invitationEmailContract` (trimmed, lower-cased). */
  readonly email: string;
  readonly workspaces: ReadonlyArray<{
    readonly workspaceId: string;
    readonly workspaceRole: WorkspaceRoleValue;
  }>;
  readonly invitedByUserId: string;
  readonly inviterEmail: string;
  /** From `issueCapabilityToken`. The raw token is not an argument and never will be. */
  readonly digest: Buffer;
  readonly expiresAt: Date;
}

/** SQLSTATE 23503, read through `postgresErrorCode` (tenant-context.md, "Driver errors inside `fn`"). */
const FOREIGN_KEY_VIOLATION = '23503';

/** The same shape `assertUuid` accepts; a non-uuid names no row this tenant owns. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The columns of `invitations` a row carries. `token_digest` is deliberately absent. */
const ROW_COLUMNS = {
  id: invitations.id,
  tenantId: invitations.tenantId,
  email: invitations.email,
  state: invitations.state,
  expiresAt: invitations.expiresAt,
  createdAt: invitations.createdAt,
  acceptedAt: invitations.acceptedAt,
  revokedAt: invitations.revokedAt,
  invitedByUserId: invitations.invitedByUserId,
  inviterEmail: invitations.inviterEmail,
  acceptedByUserId: invitations.acceptedByUserId,
} as const;

type BareRow = Omit<InvitationRow, 'workspaces'>;

@TenantScopedRepository()
@Injectable()
export class InvitationRepository {
  async create(input: CreateInvitationInput): Promise<InvitationRow> {
    const tenantId = currentTenantId();

    const [row] = await tenantDb()
      .insert(invitations)
      .values({
        tenantId,
        email: input.email,
        tokenDigest: input.digest,
        expiresAt: input.expiresAt,
        invitedByUserId: input.invitedByUserId,
        inviterEmail: input.inviterEmail,
      })
      .returning(ROW_COLUMNS);

    if (row === undefined) {
      throw new Error('invitations insert returned no row.');
    }

    if (input.workspaces.length > 0) {
      try {
        await tenantDb()
          .insert(invitationWorkspaces)
          .values(
            input.workspaces.map((grant) => ({
              tenantId,
              invitationId: row.id,
              workspaceId: grant.workspaceId,
              role: grant.workspaceRole,
            })),
          );
      } catch (error) {
        // The composite FK refused a (workspace_id, tenant_id) pair `workspaces` does not
        // hold: another tenant's workspace, or none. Same answer as Form B's 404 (D-09).
        if (postgresErrorCode(error) === FOREIGN_KEY_VIOLATION) {
          throw new WorkspaceNotFoundError();
        }

        throw error;
      }
    }

    const [withGrants] = await this.attachGrants([row]);

    if (withGrants === undefined) {
      throw new Error('invitations create could not read back its grants.');
    }

    return withGrants;
  }

  /** Every invitation naming `workspaceId`, all states, newest first (D-09). */
  async listForWorkspace(workspaceId: string): Promise<InvitationRow[]> {
    if (!UUID.test(workspaceId)) {
      return [];
    }

    const tenantId = currentTenantId();

    const rows = await tenantDb()
      .select(ROW_COLUMNS)
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          exists(
            tenantDb()
              .select({ one: sql`1` })
              .from(invitationWorkspaces)
              .where(
                and(
                  eq(invitationWorkspaces.invitationId, invitations.id),
                  eq(invitationWorkspaces.workspaceId, workspaceId),
                  eq(invitationWorkspaces.tenantId, tenantId),
                ),
              ),
          ),
        ),
      )
      // Newest first, then id, so two created in one transaction still list deterministically.
      .orderBy(desc(invitations.createdAt), desc(invitations.id));

    return this.attachGrants(rows);
  }

  async findById(id: string): Promise<InvitationRow | null> {
    if (!UUID.test(id)) {
      return null;
    }

    const [row] = await tenantDb()
      .select(ROW_COLUMNS)
      .from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.tenantId, currentTenantId())))
      .limit(1);

    if (row === undefined) {
      return null;
    }

    const [withGrants] = await this.attachGrants([row]);

    return withGrants ?? null;
  }

  async revoke(id: string): Promise<InvitationRow> {
    if (!UUID.test(id)) {
      throw new InvitationNotFoundError();
    }

    const tenantId = currentTenantId();

    const [row] = await tenantDb()
      .update(invitations)
      // Idempotent: the first revocation's timestamp survives a second call.
      .set({ state: 'revoked', revokedAt: sql`coalesce(${invitations.revokedAt}, now())` })
      .where(
        and(
          eq(invitations.id, id),
          eq(invitations.tenantId, tenantId),
          sql`${invitations.state} <> 'accepted'`,
        ),
      )
      .returning(ROW_COLUMNS);

    if (row === undefined) {
      // Zero rows: not owned, or accepted. One more owner-qualified read says which.
      const [existing] = await tenantDb()
        .select({ state: invitations.state })
        .from(invitations)
        .where(and(eq(invitations.id, id), eq(invitations.tenantId, tenantId)))
        .limit(1);

      if (existing?.state === 'accepted') {
        throw new InvitationAlreadyAcceptedError();
      }

      throw new InvitationNotFoundError();
    }

    const [withGrants] = await this.attachGrants([row]);

    if (withGrants === undefined) {
      throw new Error('invitations revoke could not read back its grants.');
    }

    return withGrants;
  }

  /**
   * One owner-qualified read of the grants for a set of rows, joined to `workspaces.name`
   * (name at read time; the workspace may have been renamed since). Empty input issues no
   * statement.
   */
  private async attachGrants(rows: readonly BareRow[]): Promise<InvitationRow[]> {
    if (rows.length === 0) {
      return [];
    }

    const tenantId = currentTenantId();

    const grants = await tenantDb()
      .select({
        invitationId: invitationWorkspaces.invitationId,
        workspaceId: invitationWorkspaces.workspaceId,
        workspaceName: workspaces.name,
        workspaceRole: invitationWorkspaces.role,
      })
      .from(invitationWorkspaces)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, invitationWorkspaces.workspaceId),
          eq(workspaces.tenantId, invitationWorkspaces.tenantId),
        ),
      )
      .where(
        and(
          inArray(
            invitationWorkspaces.invitationId,
            rows.map((row) => row.id),
          ),
          eq(invitationWorkspaces.tenantId, tenantId),
        ),
      )
      .orderBy(asc(workspaces.name), asc(invitationWorkspaces.workspaceId));

    const byInvitation = new Map<string, InvitationRowWorkspace[]>();

    for (const grant of grants) {
      const list = byInvitation.get(grant.invitationId) ?? [];
      list.push({
        workspaceId: grant.workspaceId,
        workspaceName: grant.workspaceName,
        workspaceRole: asWorkspaceRole(grant.workspaceRole),
      });
      byInvitation.set(grant.invitationId, list);
    }

    return rows.map((row) => ({ ...row, workspaces: byInvitation.get(row.id) ?? [] }));
  }
}
