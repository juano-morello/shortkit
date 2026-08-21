/**
 * Contract: docs/contracts/invitation-tokens.md ("The single entry point", "Normative
 *           sequence", "State and error mapping", "Acceptance is one transaction"),
 *           tenant-context.md (invariant 5), workspace-authorization.md
 * ADR: adr-0021-tenant-routing-capability-tokens.md, adr-0015-user-tenant-cardinality.md,
 *      adr-0003-rls-policy-template-and-roles.md, adr-0029-credentials-are-never-constructible-into-error-text.md
 * Produced by: TASK-1b-04
 * Consumed by: TASK-1b-08 (`POST /api/invitations/lookup`, `POST /api/invitations/accept`),
 *              TASK-1b-09 (`hooks.before` on sign-up, the invited `onUserCreated` branch)
 *
 * ============================================================================
 * THE ONLY TWO FUNCTIONS THAT OPEN A TENANT TRANSACTION FROM A TOKEN (GC-L, D-17).
 * ============================================================================
 *
 * An anonymous caller (or a Better Auth hook, which runs outside the Nest graph and can
 * inject nothing) reaches tenant data through `findInvitationByCapabilityToken` and
 * `acceptInvitationByCapabilityToken` and through nothing else. Both are plain async
 * functions rather than providers for that reason; the Nest `InvitationsService` calls the
 * same two. `capability-lookup.spec.ts` greps `apps/api/src` for `parseCapabilityToken(`
 * callers and for files that import from `./tokens/` AND call `withTenantTransaction(`,
 * and asserts both sets are exactly what this header says.
 *
 * ============================================================================
 * THE SEQUENCE, AND WHY EACH STEP IS WHERE IT IS (ADR-0021, normative).
 * ============================================================================
 *
 *   1. `parseCapabilityToken(raw)`. Malformed → `null` (find) / `InvitationNotFoundError`
 *      (accept). The same answer an unknown token gets, decided without a statement.
 *   2. IF A TENANT CONTEXT IS ACTIVE AND ITS ID DIFFERS FROM THE TOKEN'S PREFIX, THROW
 *      `InvitationTenantConflictError` BEFORE ANY STATEMENT (D-04). The authenticated
 *      accept route runs inside the interceptor's transaction on the caller's `tid`; a
 *      token naming another tenant is ADR-0015's "already belongs to another tenant" and
 *      is answered 409 without opening anything. `TenantContextMissingError` from
 *      `currentTenantId()` means none is active (the public route and the hooks), and
 *      is the ordinary case, not an error.
 *   3. `withTenantTransaction(<prefix>, ...)`. When a matching context is active this
 *      JOINS it (tenant-context.md invariant 5) and the consume commits with the route's
 *      transaction; otherwise it opens one. The tenant id reaching `set_config` here is
 *      ADR-0021's third sanctioned source, and this file is where that source is used.
 *   4. FIRST STATEMENT: `SELECT ... FROM invitations WHERE token_digest = $1 AND
 *      tenant_id = <current>`. Owner-qualified as every repository statement is (F-302),
 *      RLS-scoped by step 3, indexed by `invitations_token_digest_unique`. Nothing else
 *      may run before it: the caller chose the tenant id, and this row is the only proof
 *      they may act in it.
 *   5. `timingSafeEqual(stored, computed)`. The SQL equality in step 4 already compared
 *      the digests; it is safe there because the digest is SHA-256 of 256 random bits:
 *      a timing oracle on the index comparison could at most leak digest bytes, and a
 *      digest yields no token. This step is the contract's step 4, done in code where the
 *      comparison the caller can observe happens, and it is what a defective index or a
 *      collation surprise cannot bypass. Mismatch or no row → 404 path.
 *   6. State. `accepted` → 409, `revoked` → 410, `expires_at < now()` (evaluated in SQL
 *      on Postgres's clock, alongside the row) → 410 `invitation_expired`. The row is NOT
 *      rewritten on expiry (D-11: `expired` is never written by 1b).
 *   7. find: the tenant name and the grants joined to `workspaces.name`, then return. It
 *      NEVER WRITES. accept: `UPDATE invitations SET state = 'accepted' ... WHERE id = $1
 *      AND tenant_id = <current> AND state = 'pending' AND expires_at >= now() RETURNING
 *      id`: zero rows is the concurrent-accept race (AC-1b-27): a second transaction
 *      blocks on the row lock, re-evaluates the WHERE after the first commits, finds
 *      `state = 'accepted'` and reports nothing to update. Then one `memberships` row per
 *      grant, `INSERT ... ON CONFLICT (workspace_id, user_id) DO NOTHING` (D-12: the
 *      existing role wins; never `DO UPDATE`, F-341), and for `tenantMembership:
 *      'create'` the `tenant_memberships` row at `INVITEE_TENANT_ROLE`, one transaction
 *      with the consume, so no membership exists whose token was not consumed.
 *
 * `tenantMembership: 'require'` (the signed-in accept) verifies, before the consume, that
 * the user already holds a `tenant_memberships` row in THIS tenant, and answers 409
 * `invitation_tenant_conflict` otherwise. Under the authenticated route that row is what
 * minted the caller's `tid`, so the check is one indexed statement that always finds it;
 * it exists so the function fails closed for any caller that reaches it without step 2
 * having had a context to compare against. `'create'` inserts `ON CONFLICT (user_id) DO
 * NOTHING`; zero rows means a membership already exists, this tenant's (idempotent) or
 * another tenant's (409), and the same check decides which.
 *
 * ============================================================================
 * 404 IS ONE BODY. THE TOKEN IS IN NO STRING THIS FILE BUILDS (GC-K, ADR-0029).
 * ============================================================================
 *
 * Malformed, unknown and wrong-tenant all reach `null` / `InvitationNotFoundError` with
 * one fixed message; wrong-tenant means the lookup under the CLAIMED prefix found nothing,
 * which is exactly what RLS plus the predicate guarantee. No log line is written here at
 * all: the exception filter logs the DomainError's name and code, never a value.
 */
import { timingSafeEqual } from 'node:crypto';

import { and, asc, eq, sql } from 'drizzle-orm';
import { asWorkspaceRole, INVITEE_TENANT_ROLE } from '@shortkit/contracts';
import type { InvitationStateValue, WorkspaceRole } from '@shortkit/contracts';

import {
  invitations,
  invitationWorkspaces,
  memberships,
  tenantMemberships,
  tenants,
  workspaces,
} from '../db/schema';
import {
  currentTenantId,
  TenantContextMissingError,
  withTenantTransaction,
} from '../tenancy/tenant-context';
import type { TenantDb } from '../tenancy/tenant-context';

import {
  InvitationAlreadyAcceptedError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationRevokedError,
  InvitationTenantConflictError,
} from './errors';
import { digestOf, MalformedCapabilityToken, parseCapabilityToken } from './tokens/capability-token';
import type { CapabilityToken } from './tokens/capability-token';

export interface VerifiedInvitationWorkspace {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceRole: WorkspaceRole;
}

/**
 * What a verified lookup hands back: enough for the public preview
 * (`invitationPreviewContract` is a projection of it) and for the hooks. NO DIGEST, NO
 * TOKEN. `tenantId` is the ROW's: the value ADR-0021 step 5 says an invited signup takes
 * its tenant from, never the string the caller supplied.
 */
export interface VerifiedInvitation {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly state: InvitationStateValue;
  readonly expiresAt: Date;
  readonly workspaces: readonly VerifiedInvitationWorkspace[];
  readonly invitedByUserId: string;
  readonly inviterEmail: string;
  readonly tenantName: string;
}

export interface AcceptGrant {
  readonly userId: string;
  /**
   * `'create'`: the invited signup; the user is new and gets a `tenant_memberships` row at
   * `INVITEE_TENANT_ROLE`. `'require'`: the signed-in accept; the row must already exist in
   * this tenant, and only workspace memberships are written.
   */
  readonly tenantMembership: 'create' | 'require';
}

export interface AcceptedInvitation {
  readonly tenantId: string;
  /** The workspaces the invitation NAMED, whether or not each membership row was new (D-12). */
  readonly workspaces: ReadonlyArray<{
    readonly workspaceId: string;
    readonly workspaceRole: WorkspaceRole;
  }>;
}

/**
 * The @Public() lookup and the hooks' validation read. Opens (or joins) the token's tenant
 * transaction, verifies the digest as the first statement, then reads the preview fields.
 * `null` for malformed, unknown and wrong-tenant alike; throws the state errors.
 */
export async function findInvitationByCapabilityToken(
  raw: string,
): Promise<VerifiedInvitation | null> {
  const token = parseOrNull(raw);

  if (token === null) {
    return null;
  }

  assertNoTenantConflict(token.tenantId);

  return withTenantTransaction(token.tenantId, async (db) => {
    const row = await verifiedRow(db, token);

    if (row === null) {
      return null;
    }

    const [tenant] = await db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, currentTenantId()))
      .limit(1);

    if (tenant === undefined) {
      // `invitations.tenant_id` references `tenants(id)` and `tenants_self_select` admits
      // exactly the current context's row, so a verified invitation without a readable
      // tenant is a broken invariant, not a caller condition.
      throw new Error('The verified invitation names a tenant that could not be read.');
    }

    const grants = await db
      .select({
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
          eq(invitationWorkspaces.invitationId, row.id),
          eq(invitationWorkspaces.tenantId, currentTenantId()),
        ),
      )
      .orderBy(asc(workspaces.name), asc(invitationWorkspaces.workspaceId));

    return {
      id: row.id,
      tenantId: row.tenantId,
      email: row.email,
      state: row.state,
      expiresAt: row.expiresAt,
      workspaces: grants.map((grant) => ({
        workspaceId: grant.workspaceId,
        workspaceName: grant.workspaceName,
        workspaceRole: asWorkspaceRole(grant.workspaceRole),
      })),
      invitedByUserId: row.invitedByUserId,
      inviterEmail: row.inviterEmail,
      tenantName: tenant.name,
    };
  });
}

/**
 * The authenticated accept and the invited `onUserCreated` branch. Same first four steps as
 * the lookup, then the single-use consume and the membership writes, all in one transaction.
 * Malformed, unknown and wrong-tenant → `InvitationNotFoundError`.
 */
export async function acceptInvitationByCapabilityToken(
  raw: string,
  grant: AcceptGrant,
): Promise<AcceptedInvitation> {
  const token = parseOrNull(raw);

  if (token === null) {
    throw new InvitationNotFoundError();
  }

  assertNoTenantConflict(token.tenantId);

  return withTenantTransaction(token.tenantId, async (db) => {
    const row = await verifiedRow(db, token);

    if (row === null) {
      throw new InvitationNotFoundError();
    }

    const tenantId = currentTenantId();

    if (grant.tenantMembership === 'require') {
      await assertMemberOfCurrentTenant(db, grant.userId);
    }

    // THE CONSUME. `state = 'pending'` in the WHERE is what makes the token single-use
    // under concurrency (AC-1b-27); `expires_at >= now()` is the same clock step 6 read.
    const consumed = await db
      .update(invitations)
      .set({ state: 'accepted', acceptedAt: sql`now()`, acceptedByUserId: grant.userId })
      .where(
        and(
          eq(invitations.id, row.id),
          eq(invitations.tenantId, tenantId),
          eq(invitations.state, 'pending'),
          sql`${invitations.expiresAt} >= now()`,
        ),
      )
      .returning({ id: invitations.id });

    if (consumed.length === 0) {
      throw new InvitationAlreadyAcceptedError();
    }

    const grants = await db
      .select({
        workspaceId: invitationWorkspaces.workspaceId,
        workspaceRole: invitationWorkspaces.role,
      })
      .from(invitationWorkspaces)
      .where(
        and(
          eq(invitationWorkspaces.invitationId, row.id),
          eq(invitationWorkspaces.tenantId, tenantId),
        ),
      )
      .orderBy(asc(invitationWorkspaces.workspaceId));

    for (const named of grants) {
      // D-12: DO NOTHING, never DO UPDATE; an existing membership's role wins, and
      // `DO UPDATE` would route through the UPDATE policy (F-341).
      await db
        .insert(memberships)
        .values({
          tenantId,
          workspaceId: named.workspaceId,
          userId: grant.userId,
          role: named.workspaceRole,
        })
        .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] });
    }

    if (grant.tenantMembership === 'create') {
      const inserted = await db
        .insert(tenantMemberships)
        .values({ tenantId, userId: grant.userId, role: INVITEE_TENANT_ROLE })
        .onConflictDoNothing({ target: tenantMemberships.userId })
        .returning({ id: tenantMemberships.id });

      if (inserted.length === 0) {
        // `UNIQUE (user_id)`: a row exists somewhere. This tenant's is fine; another
        // tenant's is ADR-0015's conflict, and the whole transaction rolls back.
        await assertMemberOfCurrentTenant(db, grant.userId);
      }
    }

    return {
      tenantId,
      workspaces: grants.map((named) => ({
        workspaceId: named.workspaceId,
        workspaceRole: asWorkspaceRole(named.workspaceRole),
      })),
    };
  });
}

/** Step 1. Only `MalformedCapabilityToken` is absorbed; anything else is a defect and propagates. */
function parseOrNull(raw: string): CapabilityToken | null {
  try {
    return parseCapabilityToken(raw);
  } catch (error) {
    if (error instanceof MalformedCapabilityToken) {
      return null;
    }

    throw error;
  }
}

/** Step 2. Decided before any statement; no context active is the ordinary case. */
function assertNoTenantConflict(tokenTenantId: string): void {
  let active: string | undefined;

  try {
    active = currentTenantId();
  } catch (error) {
    if (!(error instanceof TenantContextMissingError)) {
      throw error;
    }
  }

  if (active !== undefined && active !== tokenTenantId) {
    throw new InvitationTenantConflictError();
  }
}

interface VerifiedRow {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly state: InvitationStateValue;
  readonly expiresAt: Date;
  readonly invitedByUserId: string;
  readonly inviterEmail: string;
}

/**
 * Steps 4 to 6. The FIRST statement inside the transaction, the constant-time compare, and
 * the state mapping. `null` for no row or a digest mismatch; throws the state errors.
 */
async function verifiedRow(db: TenantDb, token: CapabilityToken): Promise<VerifiedRow | null> {
  const digest = digestOf(token.secret);

  const [row] = await db
    .select({
      id: invitations.id,
      tenantId: invitations.tenantId,
      email: invitations.email,
      tokenDigest: invitations.tokenDigest,
      state: invitations.state,
      expiresAt: invitations.expiresAt,
      // Postgres's clock, read with the row, so "expired" and the consume's
      // `expires_at >= now()` agree with each other and with the column defaults.
      expired: sql<boolean>`${invitations.expiresAt} < now()`,
      invitedByUserId: invitations.invitedByUserId,
      inviterEmail: invitations.inviterEmail,
    })
    .from(invitations)
    .where(and(eq(invitations.tokenDigest, digest), eq(invitations.tenantId, currentTenantId())))
    .limit(1);

  if (row === undefined) {
    return null;
  }

  const stored = Buffer.isBuffer(row.tokenDigest) ? row.tokenDigest : Buffer.from(String(row.tokenDigest));

  // `timingSafeEqual` throws on unequal lengths; unequal lengths are a mismatch.
  if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) {
    return null;
  }

  switch (row.state) {
    case 'accepted':
      throw new InvitationAlreadyAcceptedError();
    case 'revoked':
      throw new InvitationRevokedError();
    case 'expired':
      throw new InvitationExpiredError();
    case 'pending':
      break;
  }

  if (row.expired) {
    throw new InvitationExpiredError();
  }

  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    state: row.state,
    expiresAt: row.expiresAt,
    invitedByUserId: row.invitedByUserId,
    inviterEmail: row.inviterEmail,
  };
}

/** One indexed, owner-qualified read; absent → 409 `invitation_tenant_conflict` (ADR-0015). */
async function assertMemberOfCurrentTenant(db: TenantDb, userId: string): Promise<void> {
  const [member] = await db
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .where(
      and(eq(tenantMemberships.tenantId, currentTenantId()), eq(tenantMemberships.userId, userId)),
    )
    .limit(1);

  if (member === undefined) {
    throw new InvitationTenantConflictError();
  }
}
