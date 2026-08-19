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

import type { TenantRole, WorkspaceRole } from './roles';
import {
  TENANT_ROLE,
  WORKSPACE_ROLE,
  asTenantRole,
  meetsTenantRole,
  tenantRoleRank,
} from './roles';

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

  /**
   * ==========================================================================
   * F-090. THESE TWO ARE GREEN ON ARRIVAL, DELIBERATELY. DO NOT DELETE THEM.
   * ==========================================================================
   *
   * `asTenantRole` already refuses already-branded input today — `Unbranded<T>` resolves
   * to `never` for a branded argument, so all three of the reviewer's probes fail TS2345.
   * The defect F-090 records is that NOTHING ASSERTED IT. Every other test in this file
   * and in `members.spec.ts` passes plain strings, and `members.spec.ts:91,138` pin the
   * WIRE type rather than this parameter guard. So a later TASK that hits a brand mismatch
   * could "fix" it by widening the signature to `<T extends string>(_value: T)` and leave
   * the suite green, `pnpm typecheck` green, and every existing directive still used —
   * while `asTenantRole(ctx.workspaceRole)` starts compiling. That is precisely the
   * laundering `roles.ts:81-85` claims is a compile error.
   *
   * These have no failing history because they are pinning shipped behaviour, not driving
   * new behaviour. That makes them look redundant and they are not: measured in a copy of
   * this package, widening the parameter to `T` takes `pnpm typecheck` from two errors to
   * ZERO with these directives removed, and to two "Unused '@ts-expect-error' directive"
   * errors with them present. They are the only thing that fails.
   *
   * THE DIRECTIVE IS THE ASSERTION, and it runs under `pnpm typecheck`, not `pnpm test` —
   * vitest transpiles with swc and never typechecks. An unused `@ts-expect-error` is
   * itself a typecheck error, which is what makes this a live assertion rather than a
   * comment. Same mechanism as `members.spec.ts:91,138`.
   *
   * The reviewer's third probe, `asTenantRole(TENANT_ROLE.owner)`, is deliberately absent:
   * it fails and passes in lockstep with the first one under every mutation tried, and the
   * one break it could have caught alone — the `TENANT_ROLE` constants losing their brand —
   * is already caught by the annotated local below and by `roles.ts:155,158`.
   */
  it('AC-8 (ADR-0023, F-090): it refuses an already-branded TenantRole, so a brand cannot be re-applied', () => {
    const alreadyBranded: TenantRole = TENANT_ROLE.admin;

    // @ts-expect-error Unbranded<T> is `never` for a branded argument (TS2345). Widening
    // the parameter to `T` makes this line legal and this directive unused.
    const rebranded = asTenantRole(alreadyBranded);

    expect(rebranded).toBe('admin');
  });

  it('AC-8 (ADR-0023, F-090): it refuses a branded WorkspaceRole, which is the laundering the brands exist to stop', () => {
    const workspaceRole: WorkspaceRole = WORKSPACE_ROLE.member;

    // @ts-expect-error Unbranded<T> is `never` for a branded argument (TS2345). This is
    // the `assert(wsId, asWorkspaceRole(ctx.tenantRole))` shape roles.ts:81-85 refuses,
    // in the direction this initiative actually has a caller for.
    const laundered = asTenantRole(workspaceRole);

    // AND THE RUNTIME GUARD DOES NOT CATCH IT. `member` is a value in BOTH enums, so
    // `TENANT_ROLES.includes` passes and a workspace-scoped role comes back branded
    // `tenant` — the Form B hole in roles.ts:19-23. The parameter type is the only thing
    // standing between `ctx.workspaceRole` and a tenant-role check.
    expect(laundered).toBe('member');
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
