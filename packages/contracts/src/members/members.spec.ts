/**
 * STORY-001 — AC-8. TASK-001.
 *
 * Contract: docs/contracts/auth-contracts.md
 * ADR: adr-0048-role-brands-are-applied-after-parsing.md, adr-0015-user-tenant-cardinality.md,
 *      adr-0023-branded-role-types.md
 *
 * ============================================================================
 * THE SUBJECT IS THE TWO-STEP SHAPE, NOT THE BRAND.
 * ============================================================================
 *
 * A brand is erased at runtime, so `expect(parsed.role).toBeBranded()` cannot exist and a
 * test that asserted the INFERRED type is branded would pass the one implementation
 * ADR-0048 refuses: `role: z.enum(TENANT_ROLES).transform(asTenantRole)` inside the
 * contract. What is observable is the shape: a wire contract that parses, and a separately
 * exported step that brands — with `asTenantRole` re-checking membership so the brand keeps
 * meaning "checked" rather than "cast".
 *
 * The compile-time half is carried by the two `@ts-expect-error` directives below. THEY DO
 * NOT RUN UNDER `pnpm test` — vitest transpiles with swc and never typechecks. They are
 * assertions against `pnpm typecheck`, which is AC-8's own second clause, and each fails
 * that command with "Unused '@ts-expect-error' directive" the day the wire type starts
 * carrying a brand.
 */
import { describe, expect, it } from 'vitest';

import { isZodError, toValidationDetails } from '../errors';
import type { TenantRole } from '../roles';

import {
  brandTenantMembership,
  parseTenantMembership,
  tenantMembershipContract,
} from './index';

/**
 * ADR-0015's five fields. `userId` is Better Auth's own id and is deliberately not a uuid —
 * the one non-uuid foreign key in the schema.
 */
const WIRE_MEMBERSHIP = {
  id: '44444444-4444-4444-8444-444444444444',
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: 'nZ8kQpR2xLmT4vB6',
  role: 'owner',
  createdAt: '2026-08-13T09:00:00.000Z',
} as const;

describe('tenantMembershipContract', () => {
  it('AC-8 (ADR-0015): the five fields survive a parse', () => {
    expect(tenantMembershipContract.parse({ ...WIRE_MEMBERSHIP })).toEqual({
      id: '44444444-4444-4444-8444-444444444444',
      tenantId: '11111111-1111-4111-8111-111111111111',
      userId: 'nZ8kQpR2xLmT4vB6',
      role: 'owner',
      createdAt: '2026-08-13T09:00:00.000Z',
    });
  });

  it("AC-8 (ADR-0015): userId accepts Better Auth's non-uuid id", () => {
    // Declaring `userId` as `idContract` — the obvious symmetry with `id` and `tenantId` —
    // fails here, and would otherwise fail at the first real sign-up rather than at review.
    expect(tenantMembershipContract.parse({ ...WIRE_MEMBERSHIP, userId: 'x9' }).userId).toBe(
      'x9',
    );
  });

  it('AC-8 (ADR-0015): tenantId must still be a uuid', () => {
    expect(
      tenantMembershipContract.safeParse({ ...WIRE_MEMBERSHIP, tenantId: 'tenant-a' }).success,
    ).toBe(false);
  });

  it('AC-8: a role outside TENANT_ROLES is refused and keys an issue under role', () => {
    const outcome = tenantMembershipContract.safeParse({
      ...WIRE_MEMBERSHIP,
      role: 'workspace_admin',
    });

    expect(outcome.success).toBe(false);

    if (outcome.success) {
      return;
    }

    expect(toValidationDetails(outcome.error).fieldErrors.role?.length ?? 0).toBeGreaterThan(0);
  });

  it('AC-8 (ADR-0048): the inferred wire role is unbranded, so it is not assignable to TenantRole', () => {
    const wire = tenantMembershipContract.parse({ ...WIRE_MEMBERSHIP });

    // @ts-expect-error a brand in an inferred contract type is what roles.ts:150-156 refuses
    const laundered: TenantRole = wire.role;

    expect(laundered).toBe('owner');
  });
});

describe('parseTenantMembership', () => {
  it('AC-8 (ADR-0048): it returns the parsed value with the role branded through asTenantRole', () => {
    const membership = parseTenantMembership({ ...WIRE_MEMBERSHIP });

    expect(membership).toEqual({
      id: '44444444-4444-4444-8444-444444444444',
      tenantId: '11111111-1111-4111-8111-111111111111',
      userId: 'nZ8kQpR2xLmT4vB6',
      role: 'owner',
      createdAt: '2026-08-13T09:00:00.000Z',
    });
  });

  it('AC-8 (ADR-0048): the parse runs before the brand, so a bad role throws a ZodError', () => {
    let thrown: unknown;

    try {
      parseTenantMembership({ ...WIRE_MEMBERSHIP, role: 'superuser' });
    } catch (error) {
      thrown = error;
    }

    // A ZodError and not the plain Error `asTenantRole` throws: the contract is what the
    // API filter maps onto `validation_failed` with `fieldErrors`, and branding a value
    // before validating it would produce an unmapped 500 instead.
    expect(isZodError(thrown)).toBe(true);
  });

});

describe('brandTenantMembership', () => {
  /**
   * Both directions in one assertion. A bare `expect(...).toThrow()` for the refused row
   * is satisfied by the `not implemented` stub, so it would report green today and prove
   * nothing.
   */
  function roleOrThrows(role: string): string {
    const wire = tenantMembershipContract.parse({ ...WIRE_MEMBERSHIP });

    try {
      // @ts-expect-error the wire type already excludes this; the runtime check is the point
      return brandTenantMembership({ ...wire, role }).role;
    } catch {
      return 'throws';
    }
  }

  it('AC-8 (ADR-0048): it brands an already-parsed role and refuses one outside TENANT_ROLES', () => {
    // Refusing is what keeps the brand meaning "this value was checked" rather than "this
    // value was cast", which is the whole of ADR-0023's claim.
    expect([roleOrThrows('owner'), roleOrThrows('superuser')]).toEqual(['owner', 'throws']);
  });
});
