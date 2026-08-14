/**
 * STORY-001 — AC-8. TASK-001.
 *
 * ADR: adr-0048-role-brands-are-applied-after-parsing.md, adr-0023-branded-role-types.md,
 *      adr-0015-user-tenant-cardinality.md
 *
 * `asTenantRole` and `tenantRoleRank` have thrown `not implemented` since `roles.ts`
 * shipped, because nothing had a caller for them. `parseTenantMembership` is that caller
 * (ADR-0048), so TASK-001 implements both — and only both. `asWorkspaceRole` and `roleRank`
 * stay throwing: workspace membership is out of scope and a function with no caller has
 * nothing to assert against, so nothing here pins their stub form either.
 *
 * ============================================================================
 * TABLE-DRIVEN, BECAUSE A BARE `toThrow()` PASSES AGAINST THE STUB.
 * ============================================================================
 *
 * `expect(() => asTenantRole('nonsense')).toThrow()` is satisfied by
 * `throw new Error('not implemented')`, so on its own it would report green today and
 * prove nothing. Each table below states the accepted and the refused values in one
 * assertion, so no row can be satisfied by a function that refuses everything.
 */
import { describe, expect, it } from 'vitest';

import type { TenantRole } from './roles';
import { TENANT_ROLE, asTenantRole, meetsTenantRole, tenantRoleRank } from './roles';

/** The marker a table row carries where the call is required to throw. */
const THROWS = 'throws';

function brandedOrThrows(value: string): string {
  try {
    return asTenantRole(value);
  } catch {
    return THROWS;
  }
}

function rankOrThrows(role: TenantRole | 'not-a-role'): number | typeof THROWS {
  try {
    // `as never` rather than `as TenantRole`: the brand is what keeps a bare string out of
    // this function in production code, and the unknown-key row is the one place a test has
    // to supply one anyway.
    return tenantRoleRank(role as never);
  } catch {
    return THROWS;
  }
}

describe('asTenantRole', () => {
  it('AC-8 (ADR-0048): it brands the three tenant roles and refuses every other value', () => {
    const cases = [
      'owner',
      'admin',
      'member',
      // In WORKSPACE_ROLES and not in TENANT_ROLES. A validator written against "is a known
      // role name" brands this `tenant`, which is the laundering ADR-0023 exists to stop.
      'viewer',
      'nonsense',
      'OWNER',
      '',
    ];

    expect(cases.map(brandedOrThrows)).toEqual([
      'owner',
      'admin',
      'member',
      THROWS,
      THROWS,
      THROWS,
      THROWS,
    ]);
  });
});

describe('tenantRoleRank', () => {
  it('AC-8: it answers the rank table for each tenant role and throws on an unknown key', () => {
    const cases = [
      TENANT_ROLE.member,
      TENANT_ROLE.admin,
      TENANT_ROLE.owner,
      'not-a-role' as const,
    ];

    // `member` is 0 and grants nothing at tenant level (Amendment A-8). A rank function
    // returning `undefined` for an unknown key would make every `>=` comparison against it
    // false rather than loud.
    expect(cases.map(rankOrThrows)).toEqual([0, 10, 20, THROWS]);
  });
});

describe('meetsTenantRole', () => {
  it('AC-8: an admin does not meet a minimum of owner', () => {
    expect(meetsTenantRole(TENANT_ROLE.admin, TENANT_ROLE.owner)).toBe(false);
  });

  it('AC-8: an owner meets a minimum of admin', () => {
    expect(meetsTenantRole(TENANT_ROLE.owner, TENANT_ROLE.admin)).toBe(true);
  });

  it('AC-8 (Amendment A-8): a member meets neither minimum, because member is rank 0', () => {
    expect([
      meetsTenantRole(TENANT_ROLE.member, TENANT_ROLE.admin),
      meetsTenantRole(TENANT_ROLE.member, TENANT_ROLE.owner),
    ]).toEqual([false, false]);
  });
});
