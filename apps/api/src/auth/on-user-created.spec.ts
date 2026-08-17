import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STORY-001 — AC-1's failure branch. TASK-003, wave 2.
 *
 * Contract: `docs/contracts/auth-config-surface.md` (the `createTenantForNewUser` row and
 * its error case). ADR-0015, ADR-0054, ADR-0055, ADR-0052 (GC-G).
 *
 * AC-1, as amended 2026-08-16: "…the response status is 200, exactly one `user` row exists,
 * exactly one `tenant_memberships` row exists for that user **across all tenants**, the
 * `tenants` row it names exists, that membership's `user_id` is the new user's id, its
 * `tenant_id` is that tenant's id, and its `role` is `owner`."
 *
 * ============================================================================
 * AC-1's SUCCESS PATH IS NOT HERE AND IS NOT MOCKED. IT IS TWO POLICIES AND A CASCADE.
 * ============================================================================
 *
 * `createTenantForNewUser` writes a `tenants` row that `tenants_self_insert` must admit —
 * which requires the transaction's own `app.tenant_id` to equal the id being written — and a
 * `tenant_memberships` row that `tenant_memberships_tenant_isolation`'s `WITH CHECK` must
 * admit in the same context. Neither is a property of this function's code; both are
 * properties of the migrated policies meeting it. `test/auth/signup-creates-tenant.int-spec.ts`
 * asserts them against the real database.
 *
 * A `vi.mock` of `withTenantTransaction` here would pin the call shape this file happens to
 * use while proving nothing about whether the rows land, and a wrong-context write would
 * satisfy it. That is the ruling `auth/tenant-id-for-user.spec.ts` already records for
 * TASK-002's half of the same boundary, and nothing in `apps/api/src` mocks a module today.
 *
 * ============================================================================
 * WHAT IS HERE IS THE FAILURE BRANCH, WHICH IS THE HALF THAT DECIDES A CONTRACT.
 * ============================================================================
 *
 * ADR-0054, decision part 2: "the hook does not swallow". The reason is exact — signup is
 * not atomic across the two writes, the `user` row is already committed by `shortkit_auth`
 * on the auth pool before this runs as `shortkit_app` on the application pool, and a
 * swallowed failure hands the caller a 200 over an account that can never obtain a `tid`
 * claim and therefore cannot authenticate anywhere. `auth.config.ts` turns the propagated
 * failure into `500 TENANT_PROVISIONING_FAILED` (ADR-0055); it has nothing to turn if this
 * resolves.
 *
 * The failure is produced by pointing the application DSN at an address nothing listens on,
 * so the `pg` error is real rather than injected. No mock, no double, no fake transaction.
 */

/** Better Auth generates its own ids and they are not uuids (`auth-schema.md`). */
const USER_ID = 'nZ8kQpR2xLmT4vB6';

/**
 * The display name the operator typed at signup, which F-198 ruled is the `tenants.name`
 * this function writes VERBATIM — nothing derived, nothing parsed, no placeholder.
 *
 * `email` was dropped from the signature by the same ruling: it was in the parameter shape
 * implying a use nothing specified, and the only plausible use was this column. So the one
 * caller-supplied value this function now holds is arbitrary operator-typed text — Better
 * Auth accepts `name: ""` and its body schema ends in `.and(z.record(z.string(), z.any()))`
 * — which is why the GC-G test below still has something to say.
 */
const OPERATOR_TYPED_NAME = 'Lovelace & Babbage Consulting';

/** A syntactically valid address of nothing: port 1 on loopback refuses immediately. */
const UNREACHABLE_DSN = 'postgres://shortkit_app:app@127.0.0.1:1/shortkit_unreachable';

/**
 * The rejection `createTenantForNewUser` produced, or `{ resolved: … }` when it did not
 * reject at all — which is the defect ADR-0054 part 2 forbids, and which reads here as a
 * resolved value rather than as a passing test.
 */
async function provisioningOutcome(): Promise<
  { readonly resolved: unknown } | { readonly rejectedWith: string; readonly message: string }
> {
  const { createTenantForNewUser } = await import('./on-user-created');

  return createTenantForNewUser({ id: USER_ID, name: OPERATOR_TYPED_NAME }).then(
    (resolved) => ({ resolved }),
    (error: unknown) => ({
      rejectedWith: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

beforeEach(() => {
  // `db/client.ts` memoises its pool at first use, so the DSN has to be in place before the
  // module graph is loaded and the graph has to be reloaded per test. The dynamic import in
  // `provisioningOutcome` is the same reason `src/health/health.spec.ts:62-69` imports
  // `AppModule` dynamically: a static import is hoisted above `vi.stubEnv`.
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', UNREACHABLE_DSN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createTenantForNewUser', () => {
  it('ADR-0054: a failed tenant write propagates rather than resolving over a broken account', async () => {
    // Asserted as "it did not resolve", not as "it threw something": the whole content of
    // the decision is that the caller LEARNS. An implementation that catches the `pg` error
    // and resolves `{ tenantId, membershipId }` with ids nothing wrote passes every other
    // test in this wave and gives every failed signup a 200, a user row, and an account that
    // fails on the next request at a different layer with a different error.
    const outcome = await provisioningOutcome();

    expect('rejectedWith' in outcome, `it resolved with ${JSON.stringify(outcome)}`).toBe(true);
  });

  it('GC-G: the rejection carries neither the operator-typed name nor the whole user id', async () => {
    // The failure is raised where a user id and arbitrary caller-supplied text are both in
    // scope, and the message reaches a log line — ADR-0054 puts the original error on
    // `logger.error({ code: 'tenant_provisioning_failed', ...errorLogFields(error) })`.
    // `LOGGABLE_FIELDS` has a name for neither.
    //
    // REPHRASED AFTER F-198, and the concern survives the signature change rather than
    // dissolving with it. The previous form checked for an EMAIL, which this function can no
    // longer see: Juano dropped `email` from the parameter shape because nothing specified a
    // use for it. What replaced it is `name`, and that is not a safer value — it is
    // unvalidated text the caller chose, Better Auth accepts `name: ""` and lets any extra
    // field ride along on the same body, and a signup form is the one place a user can put
    // an address into a field that is not an address field.
    //
    // The mutation this catches is the natural one: an implementer adding context to a bare
    // driver error — `could not provision a tenant for ${user.name}` — because an
    // ECONNREFUSED on its own says nothing about which signup it belongs to. F-132 ruled the
    // same question for `NoTenantMembershipError` and allowed an eight-character prefix and
    // a length there, because a user id is a system-generated opaque value; operator-typed
    // text has no permitted prefix at all.
    const outcome = await provisioningOutcome();
    const message = 'message' in outcome ? outcome.message : '';

    expect({
      carriesTheName: message.includes(OPERATOR_TYPED_NAME),
      carriesAFragmentOfIt: message.includes('Lovelace'),
      carriesTheWholeUserId: message.includes(USER_ID),
    }).toEqual({
      carriesTheName: false,
      carriesAFragmentOfIt: false,
      carriesTheWholeUserId: false,
    });
  });
});
