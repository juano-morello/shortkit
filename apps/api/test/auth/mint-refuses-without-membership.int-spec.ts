import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  authServerEnv,
  clearSignupState,
  deleteMembershipFor,
  getSession,
  membershipsFor,
  mintToken,
  signIn,
  signUp,
  usersFor,
} from '../support/auth-fixture';
import { assertTenantsIsMigrated } from '../support/rls-fixture';

/**
 * STORY-001 — AC-4's MINT LEG. TASK-003, wave 2.
 *
 * Contract: `docs/contracts/auth-config-surface.md` ("Error cases", invariant 7).
 * ADR-0055, ADR-0015, ADR-0013.
 *
 * AC-4: "Given a `user` row that has no `tenant_memberships` row, when a JWT is minted for a
 * session belonging to that user, then minting fails with `NoTenantMembershipError`, no JWT
 * is returned, and the caller receives an error rather than a token with an absent `tid`."
 *
 * ============================================================================
 * TASK-002 DISCHARGED HALF OF THIS AC. THIS IS THE OTHER HALF.
 * ============================================================================
 *
 * `test/auth/tenant-memberships.int-spec.ts` asserts that `tenantIdForUser` rejects with
 * `NoTenantMembershipError` rather than resolving `null` or `''` — the primary stop ADR-0015
 * names. What it cannot reach is the clause "no JWT is returned, and the caller receives an
 * error": that is the MINT PATH, and the mint path is `definePayload` inside the composed
 * instance. AC-4 was green on a partial proof until this file existed. Recorded on
 * TASK-003's card, which is why AC-4 is claimed by two TASKs and `plan.md`'s "each AC
 * claimed by exactly one" is deliberately broken for it.
 *
 * ============================================================================
 * THE FIXTURE CONSTRUCTS A STATE NO SHIPPED CODE PATH PRODUCES, AND STORY-001 SAYS SO.
 * ============================================================================
 *
 * Concern 2 of that STORY's Definition of Ready: an orphaned `user` row arises from
 * ADR-0015's invited branch, which is out of scope here, or from ADR-0054's residue, which
 * needs a write to fail. So the test signs up normally and then deletes the membership row
 * through `tenant_memberships_privileged_erase`. That is stated rather than hidden, and the
 * AC is still worth having because nothing else exercises the stop at all.
 *
 * ============================================================================
 * THE FAILURE IS RAISED BEFORE A PAYLOAD IS SIGNED, WHICH IS WHY THE STATUS IS ASSERTED.
 * ============================================================================
 *
 * GC-D fixes the claim set and `definePayload` must return `jti`, so AC-4 cannot be
 * satisfied by omitting a claim from a token that is nevertheless issued. ADR-0055 traced
 * what happens to a throw from there: `dispatch.mjs:231-238` rethrows anything that is not
 * an `APIError`, better-auth's router `onError` returns `undefined`, and better-call answers
 * `500` WITH A NULL BODY while writing the whole error and its stack through a
 * `console.error` one package below the logger ADR-0052 binds. So "an error rather than a
 * token" has a decided shape — 403 and a `code` — and asserting only "no token came back"
 * would pass over the body-less 500 that ADR-0055 exists to prevent.
 */

const ORPHANED_EMAIL = 'wave2-orphan@example.com';

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

/** The membership-less user's session cookie. Signed up, stripped, then signed in. */
async function signInWithNoMembership(): Promise<string> {
  const signedUp = await signUp(server, ORPHANED_EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);

  const [user] = usersFor(ORPHANED_EMAIL);
  expect(user, `signup wrote no user row for ${ORPHANED_EMAIL}`).toBeDefined();

  const [membership] = membershipsFor(user.id);
  expect(membership, 'signup wrote no membership row to remove').toBeDefined();

  deleteMembershipFor(user.id, membership.tenantId);

  // THE PREMISE, ASSERTED RATHER THAN ASSUMED. `tenant_memberships_privileged_erase` grants
  // no read, so a `DELETE ... WHERE user_id = …` with no readable context finds no row and
  // reports `DELETE 0` WITH NO ERROR AT ALL — measured, and recorded on `rls-fixture.ts`.
  // Without this line, a fixture that silently deleted nothing would leave every assertion
  // below testing a perfectly ordinary account.
  expect(membershipsFor(user.id), 'the membership row was not removed').toEqual([]);

  const signedIn = await signIn(server, ORPHANED_EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);

  return signedIn.cookie;
}

beforeAll(() => {
  serverBoot = startApiServer({ env: authServerEnv });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;

  assertTenantsIsMigrated();
  clearSignupState(ORPHANED_EMAIL);
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

describe('minting a JWT for a user with no tenant membership', () => {
  it('AC-4: GET /api/auth/token answers 403 with code NO_TENANT_MEMBERSHIP', async () => {
    // 403 AND NOT 401 (ADR-0055): the session is valid and the credential is not the
    // problem, so telling the BFF to re-authenticate sends it into a loop that cannot
    // terminate. The `code` is asserted beside the status because a caller branching on
    // status alone cannot tell this from any other forbidden — `auth-tokens.md` records that
    // these bodies are Better Auth's native `{ message, code }` and not `ErrorEnvelope`, and
    // TASK-008 maps them by `code` at the web client boundary.
    //
    // A body-less 500 — what a non-`APIError` throw produces — fails this assertion as
    // `{ status: 500, code: undefined }`, which is the exact shape ADR-0055 was written to
    // stop and which a "no token was returned" assertion would have passed.
    const cookie = await signInWithNoMembership();

    const minted = await mintToken(server, cookie);
    const body = minted.body as { code?: unknown };

    expect({ status: minted.status, code: body.code }).toEqual({
      status: 403,
      code: 'NO_TENANT_MEMBERSHIP',
    });
  });

  it('AC-4: no token is returned, so nothing is issued carrying an absent tid', async () => {
    // The clause AC-4 states in its own words. Asserted separately from the status because
    // they are different defects: a 403 that nevertheless carried a token would be the worse
    // one, and the alternative ADR-0055 rejected — "return a payload with a sentinel `tid`
    // and let `AuthGuard` reject it" — produces exactly that. A signed token for an account
    // with no tenant is valid to anything that verifies the signature without reading `tid`.
    const cookie = await signInWithNoMembership();

    const minted = await mintToken(server, cookie);
    const body = minted.body as { token?: unknown };

    expect({ token: body.token, mentionsAToken: minted.raw.includes('eyJ') }).toEqual({
      token: undefined,
      mentionsAToken: false,
    });
  });

  it('ADR-0055: GET /api/auth/get-session still answers 200 for that same user', async () => {
    // ============================================================================
    // THIS IS WHAT PINS `disableSettingJwtHeader: true`, AND IT IS THE REASON THE KEY EXISTS.
    // ============================================================================
    //
    // `dist/plugins/jwt/index.mjs:185-188` mints a token from the `/get-session` after-hook
    // and sets it as `set-auth-jwt` unless the key is set — so without it, `definePayload`
    // throwing breaks `get-session` as well as `/token`. Those are OPPOSITE answers: "you
    // have a session" is true and must be answerable, "you may have a token" is false.
    // Failing both collapses the distinction and leaves the BFF unable to tell a signed-out
    // visitor from a broken account, so both render as signed out and the account is
    // unreachable rather than merely unusable.
    const cookie = await signInWithNoMembership();

    const session = await getSession(server, cookie);

    expect(session.status, session.raw).toBe(200);
  });
});
