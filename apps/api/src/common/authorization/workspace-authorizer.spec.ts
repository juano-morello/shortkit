/**
 * TASK-1b-05 — WorkspaceAuthorizer (Form B), the status table, and the two decorators.
 *
 * Contract: docs/contracts/workspace-authorization.md ("The two enforcement forms", Form B;
 * "Status rules"; invariant 2), docs/contracts/error-envelope.md (invariants 5, 6).
 *
 * The repositories are fakes answering from a map — the SQL they compile is
 * `membership.repository.spec.ts`'s business, and whether RLS scopes it is the integration
 * suite's. What is decided here: no membership is 404 with EXACTLY `WorkspaceNotFoundError`'s
 * body; below rank is 403 with the right code; the rank comparison is the contracts' rank
 * table (every pair asserted); `assertTenant` never sees `member` as a minimum; and a call
 * with no ambient actor throws rather than passes.
 */
import 'reflect-metadata';

import { TENANT_ROLE, WORKSPACE_ROLE, WORKSPACE_ROLES } from '@shortkit/contracts';
import type { AuthorisingTenantRole, TenantRole, WorkspaceRole } from '@shortkit/contracts';
import { describe, expect, it } from 'vitest';

import type { MembershipRepository } from '../../memberships/membership.repository';
import type { TenantMembershipRepository } from '../../memberships/tenant-membership.repository';
import type { RequestContext } from '../../tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../../workspaces/workspace-not-found.error';
import { ActorContextMissingError, runAsActor } from './actor-context';
import {
  InsufficientTenantRoleError,
  InsufficientWorkspaceRoleError,
  TenantMembershipNotFoundError,
  WorkspaceAccessNotFoundError,
  WorkspaceIdRequiredError,
} from './errors';
import { RequireTenantRole, RequireWorkspaceRole, TENANT_ROLE_METADATA, WORKSPACE_ROLE_METADATA } from './roles';
import { WorkspaceAuthorizer, requireTenantRank, requireWorkspaceRank } from './workspace-authorizer';

const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WORKSPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'user_7d3e2f1a0b9c8d7e';
const OTHER_USER = 'user_0000000000000000';

const ACTOR: RequestContext = {
  userId: USER,
  tenantId: '3f2a9c1e-7b4d-4e8a-9c6f-1d2e3f4a5b6c',
  email: 'operator@example.com',
  emailVerified: true,
};

interface Fakes {
  readonly authorizer: WorkspaceAuthorizer;
  readonly lookups: string[];
}

function build(
  workspaceRoles: Readonly<Record<string, WorkspaceRole>> = {},
  tenantRoles: Readonly<Record<string, TenantRole>> = {},
): Fakes {
  const lookups: string[] = [];
  const memberships = {
    roleFor: (workspaceId: string, userId: string): Promise<WorkspaceRole | null> => {
      lookups.push(`workspace:${workspaceId}:${userId}`);
      return Promise.resolve(workspaceRoles[`${workspaceId}:${userId}`] ?? null);
    },
  } as unknown as MembershipRepository;
  const tenantMemberships = {
    roleFor: (userId: string): Promise<TenantRole | null> => {
      lookups.push(`tenant:${userId}`);
      return Promise.resolve(tenantRoles[userId] ?? null);
    },
  } as unknown as TenantMembershipRepository;

  return { authorizer: new WorkspaceAuthorizer(memberships, tenantMemberships), lookups };
}

describe('the status table', () => {
  it('requireWorkspaceRank: no membership is 404 not_found, and its body equals WorkspaceNotFoundError byte for byte', () => {
    let thrown: unknown;
    try {
      requireWorkspaceRank(null, WORKSPACE_ROLE.viewer);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkspaceAccessNotFoundError);
    const refusal = thrown as WorkspaceAccessNotFoundError;
    expect(refusal.status).toBe(404);
    expect(JSON.stringify(refusal.toEnvelope())).toBe(JSON.stringify(new WorkspaceNotFoundError().toEnvelope()));
  });

  it('requireWorkspaceRank: every (actual, minimum) pair follows the rank table, and nothing else', () => {
    const rank = { workspace_admin: 30, member: 20, viewer: 10 } as const;

    for (const actual of WORKSPACE_ROLES) {
      for (const minimum of WORKSPACE_ROLES) {
        const call = (): WorkspaceRole => requireWorkspaceRank(WORKSPACE_ROLE[actual], WORKSPACE_ROLE[minimum]);

        if (rank[actual] >= rank[minimum]) {
          expect(call(), `${actual} >= ${minimum}`).toBe(WORKSPACE_ROLE[actual]);
        } else {
          expect(call, `${actual} < ${minimum}`).toThrow(InsufficientWorkspaceRoleError);
        }
      }
    }
  });

  it('invariant 2: viewer passes a viewer read and fails every write minimum, with insufficient_workspace_role', () => {
    expect(requireWorkspaceRank(WORKSPACE_ROLE.viewer, WORKSPACE_ROLE.viewer)).toBe(WORKSPACE_ROLE.viewer);

    for (const minimum of [WORKSPACE_ROLE.member, WORKSPACE_ROLE.workspace_admin]) {
      let thrown: unknown;
      try {
        requireWorkspaceRank(WORKSPACE_ROLE.viewer, minimum);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InsufficientWorkspaceRoleError);
      expect((thrown as InsufficientWorkspaceRoleError).code).toBe('insufficient_workspace_role');
      expect((thrown as InsufficientWorkspaceRoleError).status).toBe(403);
    }
  });

  it('requireTenantRank: owner passes both minimums, admin passes admin only, member passes neither, no row is 404', () => {
    expect(requireTenantRank(TENANT_ROLE.owner, TENANT_ROLE.owner)).toBe(TENANT_ROLE.owner);
    expect(requireTenantRank(TENANT_ROLE.owner, TENANT_ROLE.admin)).toBe(TENANT_ROLE.owner);
    expect(requireTenantRank(TENANT_ROLE.admin, TENANT_ROLE.admin)).toBe(TENANT_ROLE.admin);
    expect(() => requireTenantRank(TENANT_ROLE.admin, TENANT_ROLE.owner)).toThrow(InsufficientTenantRoleError);
    expect(() => requireTenantRank(TENANT_ROLE.member, TENANT_ROLE.admin)).toThrow(InsufficientTenantRoleError);
    expect(() => requireTenantRank(TENANT_ROLE.member, TENANT_ROLE.owner)).toThrow(InsufficientTenantRoleError);
    expect(() => requireTenantRank(null, TENANT_ROLE.admin)).toThrow(TenantMembershipNotFoundError);

    const insufficient = new InsufficientTenantRoleError();
    expect(insufficient.code).toBe('insufficient_tenant_role');
    expect(insufficient.status).toBe(403);
    expect(new TenantMembershipNotFoundError().status).toBe(404);
  });

  it('every refusal is a fixed message carrying no id', () => {
    for (const error of [
      new WorkspaceAccessNotFoundError(),
      new TenantMembershipNotFoundError(),
      new InsufficientWorkspaceRoleError(),
      new InsufficientTenantRoleError(),
      new WorkspaceIdRequiredError(),
    ]) {
      expect(error.message).not.toMatch(/[0-9a-f]{8}-/);
      expect(error.message).not.toMatch(/user_/);
    }
    expect(new WorkspaceIdRequiredError().status).toBe(400);
  });
});

describe('WorkspaceAuthorizer (Form B)', () => {
  it('assert resolves for a member at or above the minimum, looking up the AMBIENT actor', async () => {
    const { authorizer, lookups } = build({ [`${WORKSPACE}:${USER}`]: WORKSPACE_ROLE.member });

    await expect(
      runAsActor(ACTOR, () => authorizer.assert(WORKSPACE, WORKSPACE_ROLE.member)),
    ).resolves.toBeUndefined();
    await expect(
      runAsActor(ACTOR, () => authorizer.assert(WORKSPACE, WORKSPACE_ROLE.viewer)),
    ).resolves.toBeUndefined();
    expect(lookups).toEqual([`workspace:${WORKSPACE}:${USER}`, `workspace:${WORKSPACE}:${USER}`]);
  });

  it('assert: below the minimum is InsufficientWorkspaceRoleError (403)', async () => {
    const { authorizer } = build({ [`${WORKSPACE}:${USER}`]: WORKSPACE_ROLE.member });

    await expect(
      runAsActor(ACTOR, () => authorizer.assert(WORKSPACE, WORKSPACE_ROLE.workspace_admin)),
    ).rejects.toBeInstanceOf(InsufficientWorkspaceRoleError);
  });

  it('assert: no membership is WorkspaceAccessNotFoundError (404) — another user’s membership in the same workspace does not count', async () => {
    const { authorizer } = build({ [`${WORKSPACE}:${OTHER_USER}`]: WORKSPACE_ROLE.workspace_admin });

    await expect(
      runAsActor(ACTOR, () => authorizer.assert(WORKSPACE, WORKSPACE_ROLE.viewer)),
    ).rejects.toBeInstanceOf(WorkspaceAccessNotFoundError);
    await expect(
      runAsActor(ACTOR, () => authorizer.assert(OTHER_WORKSPACE, WORKSPACE_ROLE.viewer)),
    ).rejects.toBeInstanceOf(WorkspaceAccessNotFoundError);
  });

  it('assertTenant resolves for owner and admin against an admin minimum, refuses member with 403, refuses no row with 404', async () => {
    const owner = build({}, { [USER]: TENANT_ROLE.owner });
    const admin = build({}, { [USER]: TENANT_ROLE.admin });
    const member = build({}, { [USER]: TENANT_ROLE.member });
    const nobody = build({}, {});

    await expect(runAsActor(ACTOR, () => owner.authorizer.assertTenant(TENANT_ROLE.admin))).resolves.toBeUndefined();
    await expect(runAsActor(ACTOR, () => owner.authorizer.assertTenant(TENANT_ROLE.owner))).resolves.toBeUndefined();
    await expect(runAsActor(ACTOR, () => admin.authorizer.assertTenant(TENANT_ROLE.admin))).resolves.toBeUndefined();
    await expect(runAsActor(ACTOR, () => admin.authorizer.assertTenant(TENANT_ROLE.owner))).rejects.toBeInstanceOf(
      InsufficientTenantRoleError,
    );
    await expect(runAsActor(ACTOR, () => member.authorizer.assertTenant(TENANT_ROLE.admin))).rejects.toBeInstanceOf(
      InsufficientTenantRoleError,
    );
    await expect(runAsActor(ACTOR, () => nobody.authorizer.assertTenant(TENANT_ROLE.admin))).rejects.toBeInstanceOf(
      TenantMembershipNotFoundError,
    );
    expect(owner.lookups).toEqual([`tenant:${USER}`, `tenant:${USER}`]);
  });

  it('with no ambient actor both methods throw ActorContextMissingError before any lookup — never a pass', async () => {
    const { authorizer, lookups } = build({ [`${WORKSPACE}:${USER}`]: WORKSPACE_ROLE.workspace_admin }, { [USER]: TENANT_ROLE.owner });

    await expect(authorizer.assert(WORKSPACE, WORKSPACE_ROLE.viewer)).rejects.toBeInstanceOf(ActorContextMissingError);
    await expect(authorizer.assertTenant(TENANT_ROLE.admin)).rejects.toBeInstanceOf(ActorContextMissingError);
    expect(lookups).toEqual([]);
  });

  it('assertTenant’s minimum is AuthorisingTenantRole: TENANT_ROLE.member is not assignable', () => {
    // @ts-expect-error — `member` is rank 0 and excluded from the minimum by type (ADR-0023).
    const minimum: AuthorisingTenantRole = TENANT_ROLE.member;
    expect(minimum).toBe('member');
  });
});

describe('the two decorators', () => {
  it('RequireWorkspaceRole writes the branded minimum under WORKSPACE_ROLE_METADATA on a method and on a class', () => {
    @RequireWorkspaceRole(WORKSPACE_ROLE.member)
    class OnClass {
      @RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)
      write(): void {
        /* probe */
      }
    }

    expect(Reflect.getMetadata(WORKSPACE_ROLE_METADATA, OnClass)).toBe(WORKSPACE_ROLE.member);
    expect(Reflect.getMetadata(WORKSPACE_ROLE_METADATA, OnClass.prototype.write)).toBe(WORKSPACE_ROLE.workspace_admin);
    expect(Reflect.getMetadata(TENANT_ROLE_METADATA, OnClass)).toBeUndefined();
  });

  it('RequireTenantRole writes the branded minimum under TENANT_ROLE_METADATA', () => {
    class Probe {
      @RequireTenantRole(TENANT_ROLE.owner)
      erase(): void {
        /* probe */
      }
    }

    expect(Reflect.getMetadata(TENANT_ROLE_METADATA, Probe.prototype.erase)).toBe(TENANT_ROLE.owner);
    expect(Reflect.getMetadata(WORKSPACE_ROLE_METADATA, Probe.prototype.erase)).toBeUndefined();
  });

  it('a minimum outside the enum fails at decoration time (module load), not at request time', () => {
    expect(() => RequireWorkspaceRole('owner' as unknown as WorkspaceRole)).toThrow(/not a workspace role/);
    expect(() => RequireTenantRole('workspace_admin' as unknown as AuthorisingTenantRole)).toThrow(/not a tenant role/);
  });
});
