import { describe, expect, it } from 'vitest';

import { NoTenantMembershipError } from './tenant-id-for-user';

/**
 * STORY-001 — AC-4. TASK-002.
 *
 * Contract: `docs/contracts/tenant-membership-lookup.md` ("`tenantIdForUser`", "Error
 * cases"). ADR-0045, ADR-0015, ADR-0013, ADR-0052.
 *
 * AC-4: "Given a `user` row that has no `tenant_memberships` row, when a JWT is minted for
 * a session belonging to that user, then minting fails with `NoTenantMembershipError`, no
 * JWT is returned, and the caller receives an error rather than a token with an absent
 * `tid`."
 *
 * ============================================================================
 * THE HALF THAT NEEDS NO DATABASE IS HERE. THE OTHER HALF IS NOT MOCKED.
 * ============================================================================
 *
 * `tenantIdForUser` resolving to a tenant id, and rejecting with this error rather than
 * with `null` or `''`, is a property of a live `FOR SELECT` policy on a warm pooled
 * connection — `test/auth/tenant-memberships.int-spec.ts` asserts both. It is not asserted
 * here with a mocked `withMembershipLookup`, for two reasons: nothing in `apps/api/src`
 * mocks a module today (no `vi.mock` anywhere in the tree), and a fake handle would pin the
 * row shape this file's SELECT returns — an internal no contract fixes — while proving
 * nothing about the policy that decides whether the row is visible at all. A membership
 * lookup that returns another tenant's row would satisfy such a mock.
 *
 * What is left is the error's own shape, which is a security property rather than a
 * formality: this is the one path in the system holding a user id and an email address at
 * the same time.
 */

/** Sixteen characters, so an eight-character prefix is visibly a prefix. */
const USER_ID = 'nZ8kQpR2xLmT4vB6';

describe('NoTenantMembershipError', () => {
  it('AC-4: it names itself and carries the full user id for its caller', () => {
    const error = new NoTenantMembershipError(USER_ID);

    // `definePayload` catches by name across a mount that is outside the Nest graph, so a
    // subclass that inherits `Error` as its name is indistinguishable from a driver error.
    expect([error.name, error.userId]).toEqual(['NoTenantMembershipError', USER_ID]);
  });

  it('AC-4 (F-132): the message carries an eight-character prefix and the length, never the whole user id', () => {
    const message = new NoTenantMembershipError(USER_ID).message;

    expect({
      prefix: message.includes('nZ8kQpR2'),
      length: message.includes('16'),
      wholeValue: message.includes(USER_ID),
    }).toEqual({ prefix: true, length: true, wholeValue: false });
  });

  it('AC-4 (GC-G): it carries the user id and no second value, so no email address can reach it', () => {
    const error = new NoTenantMembershipError(USER_ID);

    // `name` is an own property because the constructor assigns it; everything else the
    // error carries is what a caller — or `serializers.err` — can read. `LOGGABLE_FIELDS`
    // has no name for a user identifier and GC-G bans `email` from a log line outright,
    // and this error is thrown inside a dependency's handler (ADR-0052).
    expect(Object.keys(error).filter((key) => key !== 'name')).toEqual(['userId']);
  });

  it('AC-4: it is an Error, so a caller that rethrows keeps a stack', () => {
    expect(new NoTenantMembershipError(USER_ID)).toBeInstanceOf(Error);
  });
});
