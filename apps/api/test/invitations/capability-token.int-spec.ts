/**
 * STORY-1b-05 — AC-1b-25, AC-1b-26, AC-1b-27 at the function level, and the ADR-0021 test
 * route enumeration cannot replace: a token whose tenant half names another tenant finds
 * nothing there and writes nothing anywhere.
 *
 * Produced by: TASK-1b-04.
 * Contract: docs/contracts/invitation-tokens.md, tenant-context.md, rls-policy-template.md.
 *
 * Integration only, by ADR-0001: row-level security, `now()`, row locks and the unique
 * index cannot be faked. Everything runs against the MIGRATED `invitations`,
 * `invitation_workspaces`, `memberships` and `tenant_memberships` tables as `shortkit_app`
 * (neither SUPERUSER nor BYPASSRLS; the fixture refuses otherwise). Rows that cross the
 * `"user"` grant boundary — the users themselves and tenant B's membership — go in through
 * the migrator DSN, exactly as `test/isolation/registrations.ts` seeds them.
 *
 * WHAT THIS FILE PROVES.
 *
 * - The repository stores SHA-256 of the secret half and NOTHING ELSE of the token: the row
 *   cast to text does not contain the secret, and the digest column equals the hash.
 * - `findInvitationByCapabilityToken` opens the token's tenant transaction, verifies the
 *   digest, and returns the preview fields — never a digest, never the token — and it
 *   joins an already-open matching context (invariant 5).
 * - The single-use race (AC-1b-27): two concurrent accepts of one token → exactly one
 *   `accepted` transition, one set of membership rows, one tenant membership; the loser is
 *   409 and a third try is 409 with nothing added.
 * - Expiry (AC-1b-26) is derived: `expires_at` set back → 410 from both functions, the row
 *   still `pending`, no membership row.
 * - Revocation (AC-1b-25): 410 from both functions, no row; revoke is idempotent, refuses
 *   an accepted row with 409, and answers 404 for another tenant's id.
 * - The prefix swap (ADR-0021's required test): A's secret under B's prefix is `null` /
 *   404, tenant B holds no invitation, and no membership row appears anywhere for the
 *   would-be acceptor.
 * - Tenant conflict (D-04, ADR-0015): B's account meets A's token with 409 whether a B
 *   context is active (decided before any statement) or none is (decided at the
 *   tenant-membership write); A's memberships gain nothing.
 * - D-12: an existing membership's role wins over the invitation's.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { INVITATION_TTL_SECONDS, invitationPreviewContract } from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase } from '../../src/db/client';
import {
  acceptInvitationByCapabilityToken,
  findInvitationByCapabilityToken,
} from '../../src/invitations/capability-lookup';
import {
  InvitationAlreadyAcceptedError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationRevokedError,
  InvitationTenantConflictError,
} from '../../src/invitations/errors';
import { InvitationRepository } from '../../src/invitations/invitation.repository';
import type { InvitationRow } from '../../src/invitations/invitation.repository';
import { issueCapabilityToken } from '../../src/invitations/tokens/capability-token';
import { TenantContextMissingError, withTenantTransaction } from '../../src/tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../../src/workspaces/workspace-not-found.error';
import { WorkspaceRepository } from '../../src/workspaces/workspace.repository';
import { execSql, querySql } from '../support/psql';
import {
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
  TENANT_A,
  TENANT_A_NAME,
  TENANT_B,
} from '../support/rls-fixture';

/** Better Auth ids are not uuids (auth-schema.md). Fixed, so the cleanup can name them. */
const INVITER_A = 'capTokInviterA0001';
const INVITEE = 'capTokInvitee00001';
const EXISTING_A = 'capTokExistingA001';
const USER_B = 'capTokUserB0000001';
const SEEDED_USERS = [INVITER_A, INVITEE, EXISTING_A, USER_B] as const;

const invitationRepository = new InvitationRepository();
const workspaceRepository = new WorkspaceRepository();

function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  return withTenantTransaction(tenantId, () => work());
}

async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to reject, but it resolved');
}

/** `"user"` rows and B's tenant membership, through the migrator (ADR-0050). */
function seedUsers(): void {
  execSql(
    migrationDsn(),
    `DELETE FROM "user" WHERE id IN (:'inviter', :'invitee', :'existing', :'user_b');
     INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
       (:'inviter',  'Inviter A',  :'inviter_email',  false, now(), now()),
       (:'invitee',  'Invitee',    :'invitee_email',  false, now(), now()),
       (:'existing', 'Existing A', :'existing_email', false, now(), now()),
       (:'user_b',   'User B',     :'user_b_email',   false, now(), now());
     SELECT set_config('app.tenant_id', :'tenant_a', false) \\g /dev/null
     INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES (:'tenant_a', :'inviter', 'owner');
     INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES (:'tenant_a', :'existing', 'member');
     SELECT set_config('app.tenant_id', :'tenant_b', false) \\g /dev/null
     INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES (:'tenant_b', :'user_b', 'owner');`,
    {
      variables: {
        inviter: INVITER_A,
        invitee: INVITEE,
        existing: EXISTING_A,
        user_b: USER_B,
        inviter_email: 'inviter-a@example.test',
        invitee_email: 'invitee@example.test',
        existing_email: 'existing-a@example.test',
        user_b_email: 'user-b@example.test',
        tenant_a: TENANT_A,
        tenant_b: TENANT_B,
      },
    },
  );
}

function deleteUsers(): void {
  execSql(migrationDsn(), `DELETE FROM "user" WHERE id = ANY(string_to_array(:'ids', ','))`, {
    variables: { ids: SEEDED_USERS.join(',') },
  });
}

interface MembershipRow extends Record<string, unknown> {
  workspace_id: string;
  user_id: string;
  role: string;
}

/** `memberships` rows in one tenant, read under that tenant's flag through the migrator. */
function membershipsIn(tenantId: string, userId?: string): MembershipRow[] {
  return querySql<MembershipRow>(
    migrationDsn(),
    `SELECT workspace_id, user_id, role FROM memberships
      WHERE tenant_id = :'tenant'::uuid ${userId === undefined ? '' : "AND user_id = :'user'"}
      ORDER BY workspace_id`,
    { tenantId, variables: { tenant: tenantId, ...(userId === undefined ? {} : { user: userId }) } },
  );
}

interface TenantMembershipRow extends Record<string, unknown> {
  tenant_id: string;
  role: string;
}

/** Every `tenant_memberships` row for a user, across tenants (ADR-0045's lookup flag). */
function tenantMembershipsOf(userId: string): TenantMembershipRow[] {
  return querySql<TenantMembershipRow>(
    migrationDsn(),
    `SELECT tenant_id, role FROM tenant_memberships WHERE user_id = :'user' ORDER BY tenant_id`,
    { variables: { user: userId }, flags: { 'app.membership_lookup_user': userId } },
  );
}

interface InvitationStateRow extends Record<string, unknown> {
  state: string;
  accepted_by_user_id: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
}

function invitationStateIn(tenantId: string, id: string): InvitationStateRow | undefined {
  return querySql<InvitationStateRow>(
    migrationDsn(),
    `SELECT state, accepted_by_user_id, accepted_at, revoked_at FROM invitations WHERE id = :'id'::uuid AND tenant_id = :'tenant'::uuid`,
    { tenantId, variables: { id, tenant: tenantId } },
  )[0];
}

function countInvitationsIn(tenantId: string): number {
  return (
    querySql<{ total: number }>(
      migrationDsn(),
      `SELECT count(*)::int AS total FROM invitations WHERE tenant_id = :'tenant'::uuid`,
      { tenantId, variables: { tenant: tenantId } },
    )[0]?.total ?? 0
  );
}

function expireNow(tenantId: string, id: string): void {
  execSql(
    migrationDsn(),
    `UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = :'id'::uuid AND tenant_id = :'tenant'::uuid`,
    { tenantId, variables: { id, tenant: tenantId } },
  );
}

/** Creates an invitation in `tenantId` through the repository, the way the create route will. */
async function invite(
  tenantId: string,
  inviter: string,
  grants: ReadonlyArray<{ workspaceId: string; workspaceRole: 'workspace_admin' | 'member' | 'viewer' }>,
): Promise<{ raw: string; secret: string; row: InvitationRow }> {
  const { raw, digest } = issueCapabilityToken(tenantId);
  const row = await asTenant(tenantId, () =>
    invitationRepository.create({
      email: 'invitee@example.test',
      workspaces: grants,
      invitedByUserId: inviter,
      inviterEmail: 'inviter-a@example.test',
      digest,
      expiresAt: new Date(Date.now() + INVITATION_TTL_SECONDS * 1000),
    }),
  );

  return { raw, secret: raw.slice(37), row };
}

let W1: string;
let W3: string;
let WB: string;

describe('capability tokens: create → lookup → accept, under RLS', () => {
  beforeAll(() => {
    assertAppRoleCannotBypassRls();
  });

  beforeEach(async () => {
    createRlsFixture();
    seedUsers();
    W1 = (await asTenant(TENANT_A, () => workspaceRepository.create({ name: 'W1' }))).id;
    W3 = (await asTenant(TENANT_A, () => workspaceRepository.create({ name: 'W3' }))).id;
    WB = (await asTenant(TENANT_B, () => workspaceRepository.create({ name: 'WB' }))).id;
  });

  afterAll(async () => {
    deleteUsers();
    dropRlsFixture();
    await closeDatabase();
  });

  describe('storage', () => {
    it('stores SHA-256 of the secret half as token_digest and no plaintext of the token anywhere on the row', async () => {
      const { secret, raw, row } = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);

      const [stored] = querySql<{ digest_hex: string; carries_secret: boolean; carries_raw: boolean; is_utf8_secret: boolean }>(
        migrationDsn(),
        `SELECT encode(token_digest, 'hex')                        AS digest_hex,
                position(:'secret' IN i::text) > 0                 AS carries_secret,
                position(:'raw'    IN i::text) > 0                 AS carries_raw,
                token_digest = convert_to(:'secret', 'utf8')       AS is_utf8_secret
           FROM invitations i
          WHERE id = :'id'::uuid AND tenant_id = :'tenant'::uuid`,
        { tenantId: TENANT_A, variables: { secret, raw, id: row.id, tenant: TENANT_A } },
      );

      expect(stored).toEqual({
        digest_hex: createHash('sha256').update(secret, 'utf8').digest('hex'),
        carries_secret: false,
        carries_raw: false,
        is_utf8_secret: false,
      });
      expect(row).not.toHaveProperty('tokenDigest');
      expect(JSON.stringify(row)).not.toContain(secret);
    });

    it('create naming another tenant\'s workspace (or none) is not_found from the composite FK, and writes no row', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';

      for (const workspaceId of [WB, missing]) {
        const failure = await rejectionOf(invite(TENANT_A, INVITER_A, [
          { workspaceId: W1, workspaceRole: 'member' },
          { workspaceId, workspaceRole: 'member' },
        ]));

        expect(failure).toBeInstanceOf(WorkspaceNotFoundError);
        expect((failure as WorkspaceNotFoundError).code).toBe('not_found');
      }

      // The invitations row went in the same transaction as the refused grant: rolled back.
      expect(countInvitationsIn(TENANT_A)).toBe(0);
      expect(countInvitationsIn(TENANT_B)).toBe(0);
    });

    it('two invitations for one address coexist (D-11) and each has its own digest', async () => {
      const first = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
      const second = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'viewer' }]);

      expect(first.row.id).not.toBe(second.row.id);
      await expect(findInvitationByCapabilityToken(first.raw)).resolves.toMatchObject({ id: first.row.id });
      await expect(findInvitationByCapabilityToken(second.raw)).resolves.toMatchObject({ id: second.row.id });
    });
  });

  describe('lookup', () => {
    it('finds the row by digest under the token\'s tenant and returns the preview fields, never a digest', async () => {
      const { raw, secret, row } = await invite(TENANT_A, INVITER_A, [
        { workspaceId: W3, workspaceRole: 'viewer' },
        { workspaceId: W1, workspaceRole: 'member' },
      ]);

      const found = await findInvitationByCapabilityToken(raw);

      expect(found).toEqual({
        id: row.id,
        tenantId: TENANT_A,
        email: 'invitee@example.test',
        state: 'pending',
        expiresAt: row.expiresAt,
        workspaces: [
          { workspaceId: W1, workspaceName: 'W1', workspaceRole: 'member' },
          { workspaceId: W3, workspaceName: 'W3', workspaceRole: 'viewer' },
        ],
        invitedByUserId: INVITER_A,
        inviterEmail: 'inviter-a@example.test',
        tenantName: TENANT_A_NAME,
      });
      expect(found).not.toHaveProperty('tokenDigest');
      expect(JSON.stringify(found)).not.toContain(secret);

      // The preview the public route answers is a projection of this, and it validates.
      const preview = invitationPreviewContract.safeParse({
        email: found?.email,
        tenantName: found?.tenantName,
        inviterEmail: found?.inviterEmail,
        workspaces: found?.workspaces.map(({ workspaceName, workspaceRole }) => ({ workspaceName, workspaceRole })),
        expiresAt: found?.expiresAt.toISOString(),
      });
      expect(preview.success).toBe(true);
    });

    it('joins an already-open transaction for the same tenant (invariant 5) and writes nothing', async () => {
      const { raw, row } = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);

      const found = await withTenantTransaction(TENANT_A, () => findInvitationByCapabilityToken(raw));

      expect(found?.id).toBe(row.id);
      expect(invitationStateIn(TENANT_A, row.id)?.state).toBe('pending');
      expect(membershipsIn(TENANT_A)).toEqual([]);
    });

    it('malformed and unknown tokens are null from find and 404 from accept, with no row written', async () => {
      const unknown = issueCapabilityToken(TENANT_A).raw;

      for (const raw of ['', 'nope', `${TENANT_A}.short`, unknown]) {
        await expect(findInvitationByCapabilityToken(raw)).resolves.toBeNull();
        await expect(
          acceptInvitationByCapabilityToken(raw, { userId: INVITEE, tenantMembership: 'create' }),
        ).rejects.toBeInstanceOf(InvitationNotFoundError);
      }

      expect(membershipsIn(TENANT_A)).toEqual([]);
      expect(tenantMembershipsOf(INVITEE)).toEqual([]);
    });
  });

  describe('the prefix swap (ADR-0021: a token whose tenant half names another tenant)', () => {
    it.each([
      ['A\'s secret under B\'s prefix', TENANT_A, TENANT_B],
      ['B\'s secret under A\'s prefix', TENANT_B, TENANT_A],
    ])('%s → null / 404, nothing in the claimed tenant, nothing written anywhere', async (_name, owner, claimed) => {
      const inviter = owner === TENANT_A ? INVITER_A : USER_B;
      const workspace = owner === TENANT_A ? W1 : WB;
      const { secret, row } = await invite(owner, inviter, [{ workspaceId: workspace, workspaceRole: 'member' }]);
      const swapped = `${claimed}.${secret}`;

      await expect(findInvitationByCapabilityToken(swapped)).resolves.toBeNull();
      await expect(
        acceptInvitationByCapabilityToken(swapped, { userId: INVITEE, tenantMembership: 'create' }),
      ).rejects.toBeInstanceOf(InvitationNotFoundError);

      // The claimed tenant holds no invitation with that digest — the row is the owner's.
      expect(countInvitationsIn(claimed)).toBe(0);
      expect(invitationStateIn(owner, row.id)?.state).toBe('pending');
      expect(membershipsIn(claimed)).toEqual([]);
      expect(membershipsIn(owner)).toEqual([]);
      expect(tenantMembershipsOf(INVITEE)).toEqual([]);
    });
  });

  describe('accept: single use (AC-1b-27)', () => {
    it('two concurrent accepts of one token → exactly one accepted transition, one membership set, one tenant membership', async () => {
      const { raw, row } = await invite(TENANT_A, INVITER_A, [
        { workspaceId: W1, workspaceRole: 'member' },
        { workspaceId: W3, workspaceRole: 'viewer' },
      ]);

      const outcomes = await Promise.all(
        [0, 1].map(() =>
          acceptInvitationByCapabilityToken(raw, { userId: INVITEE, tenantMembership: 'create' }).then(
            (value) => ({ ok: value }),
            (error: unknown) => ({ error }),
          ),
        ),
      );

      const wins = outcomes.filter((outcome) => 'ok' in outcome);
      const losses = outcomes.filter((outcome) => 'error' in outcome);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      expect((losses[0] as { error: unknown }).error).toBeInstanceOf(InvitationAlreadyAcceptedError);
      expect((wins[0] as { ok: unknown }).ok).toEqual({
        tenantId: TENANT_A,
        workspaces: [
          { workspaceId: W1, workspaceRole: 'member' },
          { workspaceId: W3, workspaceRole: 'viewer' },
        ].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
      });

      const state = invitationStateIn(TENANT_A, row.id);
      expect(state?.state).toBe('accepted');
      expect(state?.accepted_by_user_id).toBe(INVITEE);
      expect(state?.accepted_at).not.toBeNull();

      expect(membershipsIn(TENANT_A, INVITEE).map((membership) => [membership.workspace_id, membership.role]).sort()).toEqual(
        [[W1, 'member'], [W3, 'viewer']].sort(),
      );
      expect(tenantMembershipsOf(INVITEE)).toEqual([{ tenant_id: TENANT_A, role: 'member' }]);

      // A third attempt, and the lookup, both say accepted; nothing is added.
      await expect(
        acceptInvitationByCapabilityToken(raw, { userId: INVITEE, tenantMembership: 'create' }),
      ).rejects.toBeInstanceOf(InvitationAlreadyAcceptedError);
      await expect(findInvitationByCapabilityToken(raw)).rejects.toBeInstanceOf(InvitationAlreadyAcceptedError);
      expect(membershipsIn(TENANT_A)).toHaveLength(2);
      expect(tenantMembershipsOf(INVITEE)).toHaveLength(1);
    });

    it('an existing same-tenant account accepts under its own open transaction with \'require\': workspace rows only', async () => {
      const { raw, row } = await invite(TENANT_A, INVITER_A, [{ workspaceId: W3, workspaceRole: 'member' }]);

      // The authenticated route: the interceptor's transaction on the caller's `tid`.
      const accepted = await withTenantTransaction(TENANT_A, () =>
        acceptInvitationByCapabilityToken(raw, { userId: EXISTING_A, tenantMembership: 'require' }),
      );

      expect(accepted).toEqual({ tenantId: TENANT_A, workspaces: [{ workspaceId: W3, workspaceRole: 'member' }] });
      expect(membershipsIn(TENANT_A, EXISTING_A)).toEqual([{ workspace_id: W3, user_id: EXISTING_A, role: 'member' }]);
      expect(tenantMembershipsOf(EXISTING_A)).toEqual([{ tenant_id: TENANT_A, role: 'member' }]);
      expect(invitationStateIn(TENANT_A, row.id)?.accepted_by_user_id).toBe(EXISTING_A);
    });

    it('D-12: an existing membership\'s role wins, and the response still lists the workspace', async () => {
      const first = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'workspace_admin' }]);
      await acceptInvitationByCapabilityToken(first.raw, { userId: INVITEE, tenantMembership: 'create' });

      const second = await invite(TENANT_A, INVITER_A, [
        { workspaceId: W1, workspaceRole: 'viewer' },
        { workspaceId: W3, workspaceRole: 'viewer' },
      ]);
      const accepted = await acceptInvitationByCapabilityToken(second.raw, { userId: INVITEE, tenantMembership: 'create' });

      expect(accepted.workspaces.map((grant) => grant.workspaceId).sort()).toEqual([W1, W3].sort());
      expect(membershipsIn(TENANT_A, INVITEE).map((membership) => [membership.workspace_id, membership.role]).sort()).toEqual(
        [[W1, 'workspace_admin'], [W3, 'viewer']].sort(),
      );
      // 'create' twice for one user is idempotent on the tenant membership.
      expect(tenantMembershipsOf(INVITEE)).toEqual([{ tenant_id: TENANT_A, role: 'member' }]);
    });
  });

  describe('accept: tenant conflict (D-04, ADR-0015)', () => {
    it('B\'s account with a B context active → 409 before any statement; A gains nothing', async () => {
      const { raw, row } = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);

      const fromAccept = await rejectionOf(
        withTenantTransaction(TENANT_B, () =>
          acceptInvitationByCapabilityToken(raw, { userId: USER_B, tenantMembership: 'require' }),
        ),
      );
      const fromFind = await rejectionOf(
        withTenantTransaction(TENANT_B, () => findInvitationByCapabilityToken(raw)),
      );

      expect(fromAccept).toBeInstanceOf(InvitationTenantConflictError);
      expect(fromFind).toBeInstanceOf(InvitationTenantConflictError);
      expect(invitationStateIn(TENANT_A, row.id)?.state).toBe('pending');
      expect(membershipsIn(TENANT_A)).toEqual([]);
      expect(membershipsIn(TENANT_B)).toEqual([]);
    });

    it('B\'s account with NO context, \'require\' and \'create\' alike → 409 at the tenant-membership check; nothing written', async () => {
      const { raw, row } = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);

      await expect(
        acceptInvitationByCapabilityToken(raw, { userId: USER_B, tenantMembership: 'require' }),
      ).rejects.toBeInstanceOf(InvitationTenantConflictError);
      await expect(
        acceptInvitationByCapabilityToken(raw, { userId: USER_B, tenantMembership: 'create' }),
      ).rejects.toBeInstanceOf(InvitationTenantConflictError);

      // The consume rolled back with the rest: still pending, still usable by the invitee.
      expect(invitationStateIn(TENANT_A, row.id)?.state).toBe('pending');
      expect(membershipsIn(TENANT_A)).toEqual([]);
      expect(tenantMembershipsOf(USER_B)).toEqual([{ tenant_id: TENANT_B, role: 'owner' }]);
      await expect(
        acceptInvitationByCapabilityToken(raw, { userId: INVITEE, tenantMembership: 'create' }),
      ).resolves.toMatchObject({ tenantId: TENANT_A });
    });
  });

  describe('expiry (AC-1b-26)', () => {
    it('expires_at in the past → 410 invitation_expired from both functions; state still pending; no row written', async () => {
      const { raw, row } = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
      expireNow(TENANT_A, row.id);

      await expect(findInvitationByCapabilityToken(raw)).rejects.toBeInstanceOf(InvitationExpiredError);
      await expect(
        acceptInvitationByCapabilityToken(raw, { userId: INVITEE, tenantMembership: 'create' }),
      ).rejects.toBeInstanceOf(InvitationExpiredError);

      expect(invitationStateIn(TENANT_A, row.id)?.state).toBe('pending');
      expect(membershipsIn(TENANT_A)).toEqual([]);
      expect(tenantMembershipsOf(INVITEE)).toEqual([]);
    });

    it('an expired-but-pending invitation can still be revoked (D-09)', async () => {
      const { row } = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
      expireNow(TENANT_A, row.id);

      const revoked = await asTenant(TENANT_A, () => invitationRepository.revoke(row.id));

      expect(revoked.state).toBe('revoked');
      expect(revoked.revokedAt).toBeInstanceOf(Date);
    });
  });

  describe('revocation (AC-1b-25)', () => {
    it('a revoked token → 410 invitation_revoked from both functions; no row written; revoke is idempotent', async () => {
      const { raw, row } = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);

      const first = await asTenant(TENANT_A, () => invitationRepository.revoke(row.id));
      const second = await asTenant(TENANT_A, () => invitationRepository.revoke(row.id));

      expect(first.state).toBe('revoked');
      expect(second.revokedAt).toEqual(first.revokedAt);
      expect(first.workspaces).toEqual([{ workspaceId: W1, workspaceName: 'W1', workspaceRole: 'member' }]);

      await expect(findInvitationByCapabilityToken(raw)).rejects.toBeInstanceOf(InvitationRevokedError);
      await expect(
        acceptInvitationByCapabilityToken(raw, { userId: INVITEE, tenantMembership: 'create' }),
      ).rejects.toBeInstanceOf(InvitationRevokedError);

      expect(membershipsIn(TENANT_A)).toEqual([]);
      expect(tenantMembershipsOf(INVITEE)).toEqual([]);
    });

    it('revoking an accepted invitation is 409, and revoking another tenant\'s id or a non-uuid is 404', async () => {
      const { raw, row } = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
      await acceptInvitationByCapabilityToken(raw, { userId: INVITEE, tenantMembership: 'create' });

      await expect(asTenant(TENANT_A, () => invitationRepository.revoke(row.id))).rejects.toBeInstanceOf(
        InvitationAlreadyAcceptedError,
      );
      await expect(asTenant(TENANT_B, () => invitationRepository.revoke(row.id))).rejects.toBeInstanceOf(
        InvitationNotFoundError,
      );
      await expect(asTenant(TENANT_A, () => invitationRepository.revoke('not-a-uuid'))).rejects.toBeInstanceOf(
        InvitationNotFoundError,
      );
      expect(invitationStateIn(TENANT_A, row.id)?.state).toBe('accepted');
    });
  });

  describe('InvitationRepository reads', () => {
    it('listForWorkspace returns the invitations naming that workspace, newest first, with joined names; another tenant\'s workspace id lists nothing', async () => {
      const older = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
      const other = await invite(TENANT_A, INVITER_A, [{ workspaceId: W3, workspaceRole: 'member' }]);
      const newer = await invite(TENANT_A, INVITER_A, [
        { workspaceId: W1, workspaceRole: 'viewer' },
        { workspaceId: W3, workspaceRole: 'viewer' },
      ]);

      const listed = await asTenant(TENANT_A, () => invitationRepository.listForWorkspace(W1));

      expect(listed.map((invitation) => invitation.id)).toEqual([newer.row.id, older.row.id]);
      expect(listed[0]?.workspaces).toEqual([
        { workspaceId: W1, workspaceName: 'W1', workspaceRole: 'viewer' },
        { workspaceId: W3, workspaceName: 'W3', workspaceRole: 'viewer' },
      ]);
      expect(listed.map((invitation) => invitation.id)).not.toContain(other.row.id);
      for (const invitation of listed) {
        expect(invitation).not.toHaveProperty('tokenDigest');
      }

      await expect(asTenant(TENANT_A, () => invitationRepository.listForWorkspace(WB))).resolves.toEqual([]);
      await expect(asTenant(TENANT_B, () => invitationRepository.listForWorkspace(W1))).resolves.toEqual([]);
    });

    it('findById returns the row for the owner and null for the other tenant', async () => {
      const { row } = await invite(TENANT_A, INVITER_A, [{ workspaceId: W1, workspaceRole: 'member' }]);

      await expect(asTenant(TENANT_A, () => invitationRepository.findById(row.id))).resolves.toEqual(row);
      await expect(asTenant(TENANT_B, () => invitationRepository.findById(row.id))).resolves.toBeNull();
    });
  });
});

describe('outside a tenant context', () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it.each([
    ['create', () => invitationRepository.create({ email: 'x@example.test', workspaces: [], invitedByUserId: 'u', inviterEmail: 'i@example.test', digest: Buffer.alloc(32), expiresAt: new Date() })],
    ['listForWorkspace', () => invitationRepository.listForWorkspace('00000000-0000-4000-8000-000000000000')],
    ['findById', () => invitationRepository.findById('00000000-0000-4000-8000-000000000000')],
    ['revoke', () => invitationRepository.revoke('00000000-0000-4000-8000-000000000000')],
  ] as ReadonlyArray<[string, () => Promise<unknown>]>)('InvitationRepository.%s throws TenantContextMissingError', async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('a raw read of invitations with no context sees zero rows (the policy)', async () => {
    // Not through withTenantTransaction: this is what the table answers with no flag set.
    // Measured through an ordinary tenant transaction for tenant C-never-seeded, which is
    // the closest an app-role connection can get without a context.
    const seen = await withTenantTransaction('33333333-3333-4333-8333-333333333333', async (db) => {
      const result = await db.execute<{ total: string }>(sql`select count(*)::text as total from invitations`);

      return result.rows[0]?.total;
    });

    expect(seen).toBe('0');
  });
});
