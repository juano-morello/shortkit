/**
 * STORY-1b-02 — AC-1b-7, AC-1b-8, AC-1b-9, AC-1b-10, AC-1b-11 against the CHILD process, plus
 * the ADR-0021 prefix-swap test route enumeration cannot replace and the SC-5 scan of the
 * child's bytes on every refusal. TASK-1b-09 (item 1b, wave 3).
 *
 * Contract: `docs/contracts/invitation-tokens.md` ("The invited-signup branch uses the same
 * entry point"), `docs/contracts/auth-config-surface.md` (the `hooks.before` and
 * `databaseHooks.user.create.after` rows; the error-cases table), `docs/contracts/auth-tokens.md`
 * (the signup body). ADR-0013, ADR-0015, ADR-0021, ADR-0054, ADR-0055, ADR-0061, F-216, F-228,
 * D-01, D-18.
 *
 * ============================================================================
 * TWO PROCESSES. THE HOOKS RUN IN THE CHILD; THE ROWS ARE READ FROM THE DATABASE.
 * ============================================================================
 *
 * `invitationValidationHook` and `provisionForNewUser` run inside Better Auth's handler in
 * `dist/main.js`, which `startApiServer` builds and spawns. Nothing in-process can reach
 * them, so every "no user was created" below is a database read through the migrator DSN,
 * every "the token is not in the logs" is a scan of `server.output()`, and every request goes
 * to the child. The fixture rows — tenant A, the inviter, the workspaces, the invitation — are
 * written from THIS process through the repositories under `withTenantTransaction`, the way
 * `test/invitations/capability-token.int-spec.ts` does, so this file does not depend on the
 * invitation routes (TASK-1b-08, the same wave).
 *
 * The invited signup's "no new tenant" is asserted the way `signup-creates-tenant.int-spec.ts`
 * records for AC-1: `tenants` cannot be counted from any DSN this suite holds (FORCE RLS,
 * `tenants_self_select`), so the measurable statement is "exactly one `tenant_memberships`
 * row across all tenants, and it names tenant A" — read through `app.membership_lookup_user`,
 * which returns the user's rows in EVERY tenant. A second membership under a fresh tenant
 * would appear in that count.
 */
import { INVITATION_TTL_SECONDS, TENANT_ROLE } from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  INVITATION_ALREADY_ACCEPTED_MESSAGE,
  INVITATION_EXPIRED_MESSAGE,
  INVITATION_HOOK_CODES,
  INVITATION_NOT_FOUND_MESSAGE,
  INVITATION_REVOKED_MESSAGE,
} from '../../src/auth/invitation-signup';
import { closeDatabase } from '../../src/db/client';
import { InvitationRepository } from '../../src/invitations/invitation.repository';
import { issueCapabilityToken } from '../../src/invitations/tokens/capability-token';
import { withTenantTransaction } from '../../src/tenancy/tenant-context';
import { WorkspaceRepository } from '../../src/workspaces/workspace.repository';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  SIGNUP_NAME,
  authRequest,
  authServerEnv,
  clearSignupState,
  jwtClaims,
  membershipsFor,
  mintToken,
  signIn,
  usersFor,
} from '../support/auth-fixture';
import type { AuthResponse } from '../support/auth-fixture';
import { execSql, querySql } from '../support/psql';
import {
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
  TENANT_A,
  TENANT_B,
} from '../support/rls-fixture';

/** Better Auth ids are not uuids (auth-schema.md). Fixed, so the cleanup can name it. */
const INVITER_A = 'invSignupInviterA1';
const INVITER_EMAIL = 'invited-signup-inviter@example.test';

/** The addresses the child creates accounts for. Every one is erased before each test. */
const INVITEE_EMAIL = 'invited-signup-invitee-7c1e@example.test';
const SECOND_INVITEE_EMAIL = 'invited-signup-second-9d4a@example.test';
const UNINVITED_EMAIL = 'invited-signup-uninvited-3b2f@example.test';
const ADDRESSES = [INVITEE_EMAIL, SECOND_INVITEE_EMAIL, UNINVITED_EMAIL] as const;

const invitationRepository = new InvitationRepository();
const workspaceRepository = new WorkspaceRepository();

let serverBoot: Promise<ApiServer>;
let server: ApiServer;
let W1: string;
let W3: string;

/** Every raw token this file minted, for the SC-5 scan at the end. */
const mintedTokens: string[] = [];

function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  return withTenantTransaction(tenantId, () => work());
}

/** The inviter's `"user"` row and owner membership in A, through the migrator (ADR-0050). */
function seedInviter(): void {
  execSql(
    migrationDsn(),
    `DELETE FROM "user" WHERE id = :'inviter';
     INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
       (:'inviter', 'Inviter A', :'inviter_email', false, now(), now());
     SELECT set_config('app.tenant_id', :'tenant_a', false) \\g /dev/null
     INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES (:'tenant_a', :'inviter', 'owner');`,
    { variables: { inviter: INVITER_A, inviter_email: INVITER_EMAIL, tenant_a: TENANT_A } },
  );
}

/** Creates a pending invitation in A through the repository, the way the create route will. */
async function invite(
  tenantId: string,
  grants: ReadonlyArray<{ workspaceId: string; workspaceRole: 'workspace_admin' | 'member' | 'viewer' }>,
  ttlSeconds: number = INVITATION_TTL_SECONDS,
): Promise<{ raw: string; id: string }> {
  const { raw, digest } = issueCapabilityToken(tenantId);
  mintedTokens.push(raw);

  const row = await asTenant(tenantId, () =>
    invitationRepository.create({
      email: INVITEE_EMAIL,
      workspaces: grants,
      invitedByUserId: INVITER_A,
      inviterEmail: INVITER_EMAIL,
      digest,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    }),
  );

  return { raw, id: row.id };
}

/** `POST /api/auth/sign-up/email` with the token in the body, exactly as `auth-tokens.md` writes it. */
async function signUpWith(email: string, invitationToken: unknown): Promise<AuthResponse> {
  return authRequest(server, 'POST', '/sign-up/email', {
    body: { email, password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME, invitationToken },
  });
}

interface WorkspaceMembershipRow extends Record<string, unknown> {
  workspace_id: string;
  role: string;
}

/** `memberships` rows for a user in one tenant, read under that tenant's flag. */
function workspaceMembershipsIn(tenantId: string, userId: string): WorkspaceMembershipRow[] {
  return querySql<WorkspaceMembershipRow>(
    migrationDsn(),
    `SELECT workspace_id, role FROM memberships
      WHERE tenant_id = :'tenant'::uuid AND user_id = :'user'
      ORDER BY workspace_id`,
    { tenantId, variables: { tenant: tenantId, user: userId } },
  );
}

/** How many `tenant_memberships` rows a tenant holds, read under its own flag. */
function tenantMembershipCountIn(tenantId: string): number {
  return (
    querySql<{ total: number }>(
      migrationDsn(),
      `SELECT count(*)::int AS total FROM tenant_memberships WHERE tenant_id = :'tenant'::uuid`,
      { tenantId, variables: { tenant: tenantId } },
    )[0]?.total ?? 0
  );
}

/** How many `memberships` rows a tenant holds, read under its own flag. */
function workspaceMembershipCountIn(tenantId: string): number {
  return (
    querySql<{ total: number }>(
      migrationDsn(),
      `SELECT count(*)::int AS total FROM memberships WHERE tenant_id = :'tenant'::uuid`,
      { tenantId, variables: { tenant: tenantId } },
    )[0]?.total ?? 0
  );
}

interface InvitationStateRow extends Record<string, unknown> {
  state: string;
  accepted_by_user_id: string | null;
}

function invitationState(id: string): InvitationStateRow | undefined {
  return querySql<InvitationStateRow>(
    migrationDsn(),
    `SELECT state, accepted_by_user_id FROM invitations WHERE id = :'id'::uuid AND tenant_id = :'tenant'::uuid`,
    { tenantId: TENANT_A, variables: { id, tenant: TENANT_A } },
  )[0];
}

function expireNow(id: string): void {
  execSql(
    migrationDsn(),
    `UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = :'id'::uuid AND tenant_id = :'tenant'::uuid`,
    { tenantId: TENANT_A, variables: { id, tenant: TENANT_A } },
  );
}

/** The one `user` row for an address, with a message naming the count when it is not one. */
function theUser(email: string): { readonly id: string } {
  const rows = usersFor(email);

  expect(rows.length, `expected exactly one user row for ${email}`).toBe(1);

  return rows[0];
}

/** `{ status, code, message }` off a Better Auth error body, for one-assertion refusals. */
function refusal(response: AuthResponse): { status: number; code: unknown; message: unknown } {
  const body = response.body as { code?: unknown; message?: unknown };

  return { status: response.status, code: body.code, message: body.message };
}

beforeAll(() => {
  assertAppRoleCannotBypassRls();
  // Kicked off without awaiting and awaited again in `beforeEach` (`api-server.ts`'s docblock).
  serverBoot = startApiServer({ env: authServerEnv });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;

  // ORDER: erase the tenants the child's signups created (reachable only through the users'
  // membership rows) BEFORE the auth tables are emptied; then rebuild A and B, which cascades
  // every invitation, workspace and membership row from the previous test.
  clearSignupState(...ADDRESSES);
  createRlsFixture();
  seedInviter();
  W1 = (await asTenant(TENANT_A, () => workspaceRepository.create({ name: 'W1' }))).id;
  W3 = (await asTenant(TENANT_A, () => workspaceRepository.create({ name: 'W3' }))).id;
}, 180_000);

afterAll(async () => {
  clearSignupState(...ADDRESSES);
  dropRlsFixture();
  await closeDatabase();
  await server?.stop();
});

describe('a new address signs up with the token (AC-1b-7)', () => {
  it('answers 200, lands in tenant A as member with exactly the named workspace roles, consumes the invitation, and creates NO tenant', async () => {
    const { raw, id } = await invite(TENANT_A, [
      { workspaceId: W1, workspaceRole: 'member' },
      { workspaceId: W3, workspaceRole: 'viewer' },
    ]);

    const response = await signUpWith(INVITEE_EMAIL, raw);

    expect(response.status, response.raw).toBe(200);

    const user = theUser(INVITEE_EMAIL);
    const tenantMemberships = membershipsFor(user.id);

    // ONE ASSERTION FOR THE WHOLE CONJUNCTION (F-134's reasoning on AC-1): the memberships,
    // the roles, the consumed invitation and "no new tenant" are one statement about the
    // state after one signup. `membershipsFor` is read across EVERY tenant, so a tenant
    // created for the invitee would appear here as a second row.
    expect({
      tenantMemberships: tenantMemberships.map((row) => ({ tenantId: row.tenantId, role: row.role })),
      workspaceMemberships: workspaceMembershipsIn(TENANT_A, user.id).map((row) => ({ workspaceId: row.workspace_id, role: row.role })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
      invitation: invitationState(id),
    }).toEqual({
      tenantMemberships: [{ tenantId: TENANT_A, role: TENANT_ROLE.member }],
      workspaceMemberships: [
        { workspaceId: W1, role: 'member' },
        { workspaceId: W3, role: 'viewer' },
      ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
      invitation: { state: 'accepted', accepted_by_user_id: user.id },
    });
  });

  it('then signs in, and the minted JWT carries tid = tenant A', async () => {
    const { raw } = await invite(TENANT_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
    await signUpWith(INVITEE_EMAIL, raw);

    const session = await signIn(server, INVITEE_EMAIL, POLICY_COMPLIANT_PASSWORD);
    expect(session.status, session.raw).toBe(200);

    const mint = await mintToken(server, session.cookie);
    expect(mint.status, mint.raw).toBe(200);

    const token = (mint.body as { token?: unknown }).token;
    expect(typeof token).toBe('string');
    expect(jwtClaims(token as string).tid).toBe(TENANT_A);
  });

  it('D-01: the link is the capability — an address other than invitations.email accepts the same way', async () => {
    // `invite` writes INVITEE_EMAIL on the row; SECOND_INVITEE_EMAIL signs up with it.
    const { raw, id } = await invite(TENANT_A, [{ workspaceId: W3, workspaceRole: 'viewer' }]);

    const response = await signUpWith(SECOND_INVITEE_EMAIL, raw);

    expect(response.status, response.raw).toBe(200);
    const user = theUser(SECOND_INVITEE_EMAIL);
    expect(membershipsFor(user.id).map((row) => row.tenantId)).toEqual([TENANT_A]);
    expect(invitationState(id)).toEqual({ state: 'accepted', accepted_by_user_id: user.id });
  });

  it('a second signup with the SAME token, from another fresh address, is 409 INVITATION_ALREADY_ACCEPTED and creates no user', async () => {
    const { raw } = await invite(TENANT_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
    await signUpWith(INVITEE_EMAIL, raw);

    const replay = await signUpWith(SECOND_INVITEE_EMAIL, raw);

    expect(refusal(replay)).toEqual({
      status: 409,
      code: INVITATION_HOOK_CODES.alreadyAccepted,
      message: INVITATION_ALREADY_ACCEPTED_MESSAGE,
    });
    expect(usersFor(SECOND_INVITEE_EMAIL)).toEqual([]);
    expect(tenantMembershipCountIn(TENANT_A)).toBe(2); // the inviter and the first invitee
  });
});

describe('a token that would not accept creates no user (AC-1b-8, AC-1b-9)', () => {
  it('malformed → 404 INVITATION_NOT_FOUND with the fixed message, no user', async () => {
    for (const malformed of ['not-a-token', 'x'.repeat(80), `${TENANT_A}.`, `${TENANT_A}.${'!'.repeat(43)}`]) {
      const response = await signUpWith(INVITEE_EMAIL, malformed);

      expect(refusal(response), malformed).toEqual({
        status: 404,
        code: INVITATION_HOOK_CODES.notFound,
        message: INVITATION_NOT_FOUND_MESSAGE,
      });
    }

    expect(usersFor(INVITEE_EMAIL)).toEqual([]);
  });

  it('well-formed but unknown → 404 with the same body, no user', async () => {
    const { raw } = issueCapabilityToken(TENANT_A); // never stored
    mintedTokens.push(raw);

    const response = await signUpWith(INVITEE_EMAIL, raw);

    expect(refusal(response)).toEqual({
      status: 404,
      code: INVITATION_HOOK_CODES.notFound,
      message: INVITATION_NOT_FOUND_MESSAGE,
    });
    expect(usersFor(INVITEE_EMAIL)).toEqual([]);
  });

  it("ADR-0021's required test: A's secret under B's prefix → 404, no user, and no membership row of any kind in B", async () => {
    const { raw } = await invite(TENANT_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
    const swapped = `${TENANT_B}${raw.slice(TENANT_A.length)}`;
    mintedTokens.push(swapped);

    const response = await signUpWith(INVITEE_EMAIL, swapped);

    expect({
      refusal: refusal(response),
      users: usersFor(INVITEE_EMAIL).length,
      tenantMembershipsInB: tenantMembershipCountIn(TENANT_B),
      workspaceMembershipsInB: workspaceMembershipCountIn(TENANT_B),
    }).toEqual({
      refusal: { status: 404, code: INVITATION_HOOK_CODES.notFound, message: INVITATION_NOT_FOUND_MESSAGE },
      users: 0,
      tenantMembershipsInB: 0,
      workspaceMembershipsInB: 0,
    });
  });

  it('expired → 410 INVITATION_EXPIRED, no user, the row still pending', async () => {
    const { raw, id } = await invite(TENANT_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
    expireNow(id);

    const response = await signUpWith(INVITEE_EMAIL, raw);

    expect(refusal(response)).toEqual({
      status: 410,
      code: INVITATION_HOOK_CODES.expired,
      message: INVITATION_EXPIRED_MESSAGE,
    });
    expect(usersFor(INVITEE_EMAIL)).toEqual([]);
    expect(invitationState(id)?.state).toBe('pending');
  });

  it('revoked → 410 INVITATION_REVOKED, no user', async () => {
    const { raw, id } = await invite(TENANT_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
    await asTenant(TENANT_A, () => invitationRepository.revoke(id));

    const response = await signUpWith(INVITEE_EMAIL, raw);

    expect(refusal(response)).toEqual({
      status: 410,
      code: INVITATION_HOOK_CODES.revoked,
      message: INVITATION_REVOKED_MESSAGE,
    });
    expect(usersFor(INVITEE_EMAIL)).toEqual([]);
  });
});

describe('a token that is present but not a string is an uninvited signup (AC-1b-10)', () => {
  it.each([
    ['an object', { ne: null }],
    ['a number', 12345],
    ['an empty string', ''],
    ['null', null],
    ['an array', ['x']],
  ])('%s → 200, a tenant of its own as owner, and never a 500', async (_label, invitationToken) => {
    const response = await signUpWith(UNINVITED_EMAIL, invitationToken);

    expect(response.status, response.raw).toBe(200);

    const user = theUser(UNINVITED_EMAIL);
    const memberships = membershipsFor(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe(TENANT_ROLE.owner);
    expect(memberships[0]?.tenantId).not.toBe(TENANT_A);
    expect(memberships[0]?.tenantId).not.toBe(TENANT_B);

    clearSignupState(UNINVITED_EMAIL);
  });

  it('and a signup with no invitationToken key at all still creates a tenant (the uninvited branch is untouched)', async () => {
    const response = await authRequest(server, 'POST', '/sign-up/email', {
      body: { email: UNINVITED_EMAIL, password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME },
    });

    expect(response.status, response.raw).toBe(200);
    const user = theUser(UNINVITED_EMAIL);
    expect(membershipsFor(user.id).map((row) => row.role)).toEqual([TENANT_ROLE.owner]);
  });
});

describe('an address that already has an account (AC-1b-11)', () => {
  it("answers ADR-0061's generic 200, creates nothing, and leaves the invitation pending", async () => {
    // The uninvited signup first, so the address exists with its own tenant.
    const first = await authRequest(server, 'POST', '/sign-up/email', {
      body: { email: INVITEE_EMAIL, password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME },
    });
    expect(first.status, first.raw).toBe(200);
    const user = theUser(INVITEE_EMAIL);
    const before = membershipsFor(user.id);

    const { raw, id } = await invite(TENANT_A, [{ workspaceId: W1, workspaceRole: 'member' }]);
    const duplicate = await signUpWith(INVITEE_EMAIL, raw);

    expect({
      status: duplicate.status,
      users: usersFor(INVITEE_EMAIL).length,
      memberships: membershipsFor(user.id),
      workspaceMembershipsInA: workspaceMembershipsIn(TENANT_A, user.id),
      invitation: invitationState(id),
    }).toEqual({
      status: 200,
      users: 1,
      memberships: before,
      workspaceMembershipsInA: [],
      invitation: { state: 'pending', accepted_by_user_id: null },
    });
  });
});

describe('SC-5 on the child’s bytes (F-216, GC-K)', () => {
  it('after every refusal above, the captured output holds neither a token nor the invited address', () => {
    const output = server.output();

    // Non-vacuity: the child wrote SOMETHING while this file ran (Better Auth's `onError`
    // writes each refusal's fixed message through its package logger, and pino writes the
    // request lines), so "not in zero bytes" is not what is being asserted.
    expect(output.length).toBeGreaterThan(0);
    expect(mintedTokens.length).toBeGreaterThan(0);

    for (const token of mintedTokens) {
      expect(output).not.toContain(token);
      expect(output).not.toContain(token.slice(TENANT_A.length + 1)); // the secret half alone
    }

    for (const address of [...ADDRESSES, INVITER_EMAIL]) {
      expect(output).not.toContain(address);
    }
  });
});
