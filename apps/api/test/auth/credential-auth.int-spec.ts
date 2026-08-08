/**
 * STORY-005 — AC-16 (account half), AC-20, AC-21. TASK-009.
 *
 * Integration only. The subject is the auth surface as a client meets it: a built API
 * process, a real socket, a real Postgres. ADR-0013 mounts Better Auth's node handler
 * on the Express instance in `main.ts`, ahead of the body parsers and outside the Nest
 * module graph, so nothing in this file imports anything from `src/auth/**` — there is
 * no in-graph seam to reach for, and a test that resolved a module would fail on
 * resolution rather than on behaviour before the implementation exists
 * (`test-strategy.md:239-246`). `test/support/api-server.ts` holds the boot and says
 * why it is a child process.
 *
 * ---------------------------------------------------------------------------
 * **AC-16 is split across two waves** (ruled by Juano 2026-08-06, `TASK-009.md:208`).
 * The AC reads "an account exists in an unverified state **and** exactly one
 * verification email is dispatched". Only the account half is here. The fake mail
 * sender the second clause needs is TASK-010's, one wave later, and declaring a mail
 * port in this wave would design a boundary TASK-010 owns. **TASK-009 does not satisfy
 * AC-16 on its own, and the gate should be told so.**
 *
 * **AC-112 has no test here, deliberately.** `test-strategy.md:136-150` (ruled
 * 2026-08-06) makes it a manifest property plus a report property, both verified by
 * `sdlc-product-auditor`. A test asserting that a report contains four sentences is
 * not a test.
 *
 * **AC-21's wave-2 subject.** The AC says a subsequent request using the prior
 * credential is "rejected with 401". The authenticated API surface that answers 401 is
 * `AuthGuard`, which is TASK-011 in wave 3, and `GET /api/auth/get-session` answers
 * `200 null` for a dead credential rather than 401 (probed against the pinned release).
 * The endpoint that does reject it is `GET /api/auth/token`, the mint —
 * `auth-tokens.md:51` lists it as session-authenticated, and ADR-0014 makes it the
 * request the BFF repeats roughly twelve times an hour to refresh. So "the prior
 * credential is rejected with 401" is asserted where a logged-out browser's next
 * request actually lands today.
 * ---------------------------------------------------------------------------
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiServer } from '../support/api-server';
import { startApiServer } from '../support/api-server';
import type { AuthResponse } from '../support/auth-fixture';
import {
  accountsFor,
  authServerEnv,
  bringSessionExpiryForward,
  clearAuthTables,
  countSessions,
  deleteSessionsFor,
  getSession,
  jwtClaims,
  markEmailVerified,
  mintToken,
  POLICY_COMPLIANT_PASSWORD,
  sessionsFor,
  signIn,
  signOut,
  signUp,
  TOO_SHORT_PASSWORD,
} from '../support/auth-fixture';

/** One address per test: the suite shares a database and never resets between tests. */
const CREATES_ACCOUNT = 'ac16-creates-account@shortkit.test';
const UNVERIFIED = 'ac16-unverified@shortkit.test';
const DUPLICATE = 'ac16-duplicate@shortkit.test';
const WEAK_PASSWORD = 'ac16-weak-password@shortkit.test';
const SIGNS_IN = 'ac20-signs-in@shortkit.test';
const WRONG_PASSWORD = 'ac20-wrong-password@shortkit.test';
const NO_SESSION_ISSUED = 'ac20-no-session-issued@shortkit.test';
const SIGNS_OUT = 'ac21-signs-out@shortkit.test';
const REFRESHES = 'ac21-refreshes@shortkit.test';

/** Wrong, and long enough that nothing rejects it for its length instead. */
const NOT_THE_PASSWORD = 'quilted-harbour-19-lantern-WRONG';

/** Far enough ahead to leave the session live, near enough to force a refresh. */
const REFRESH_WINDOW_SECONDS = 60;

let server: ApiServer;

beforeAll(async () => {
  clearAuthTables();
  server = await startApiServer({ env: authServerEnv });
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

/** The body as an object, or a failed assertion naming what arrived instead. */
function jsonBody(response: AuthResponse): Record<string, unknown> {
  expect(
    typeof response.body === 'object' && response.body !== null,
    `not a JSON object (status ${String(response.status)}): ${response.raw}`,
  ).toBe(true);

  return response.body as Record<string, unknown>;
}

function userIn(response: AuthResponse): Record<string, unknown> {
  const user = jsonBody(response).user;

  expect(
    typeof user === 'object' && user !== null,
    `no user in (status ${String(response.status)}): ${response.raw}`,
  ).toBe(true);

  return user as Record<string, unknown>;
}

/**
 * Arrange: an account that exists and is verified, which is the premise AC-20 and
 * AC-21 are both stated against. The `expect` here is a precondition rather than the
 * subject — it fails loudly and says so, instead of leaving a later assertion to
 * report something misleading.
 */
async function verifiedAccount(email: string): Promise<void> {
  const created = await signUp(server, email, POLICY_COMPLIANT_PASSWORD);

  expect(
    created.status,
    `arrange: POST /api/auth/sign-up/email for ${email} answered ${created.raw}`,
  ).toBe(200);

  markEmailVerified(email);
}

describe('POST /api/auth/sign-up/email', () => {
  /**
   * Breaks if: the handler is not mounted, or is mounted under another path; the mount
   * runs after `express.json` so Better Auth reads a consumed stream and the body
   * arrives empty; the account is never persisted.
   */
  it('AC-16: signup with an unused address and a policy-compliant password creates one account', async () => {
    const created = await signUp(server, CREATES_ACCOUNT, POLICY_COMPLIANT_PASSWORD);

    expect(created.status, `body was ${created.raw}`).toBe(200);
    expect(accountsFor(CREATES_ACCOUNT)).toHaveLength(1);
  }, 60_000);

  /**
   * Breaks if: signup marks the address verified without the verification flow having
   * run — which would make AC-17's 403 and AC-18's transition unreachable, and would do
   * it silently, since every other assertion in this file passes either way.
   */
  it('AC-16: the account signup creates is not email-verified', async () => {
    const created = await signUp(server, UNVERIFIED, POLICY_COMPLIANT_PASSWORD);

    expect(created.status, `body was ${created.raw}`).toBe(200);

    const accounts = accountsFor(UNVERIFIED);

    expect(accounts).toHaveLength(1);
    expect(accounts[0].emailVerified).toBe(false);
  }, 60_000);

  /**
   * Breaks if: the address uniqueness constraint is missing, so the second signup
   * creates a second account for one address and whichever row a later login resolves
   * to decides whose data the visitor sees. A 5xx fails it too: rejecting by crashing
   * leaves the caller unable to distinguish "taken" from "broken".
   */
  it('AC-16: a second signup for an address that already has an account is rejected', async () => {
    const first = await signUp(server, DUPLICATE, POLICY_COMPLIANT_PASSWORD);

    expect(first.status, `arrange: first sign-up answered ${first.raw}`).toBe(200);

    const second = await signUp(server, DUPLICATE, POLICY_COMPLIANT_PASSWORD);

    expect(second.status, `body was ${second.raw}`).toBeGreaterThanOrEqual(400);
    expect(second.status, `body was ${second.raw}`).toBeLessThan(500);
    expect(accountsFor(DUPLICATE)).toHaveLength(1);
  }, 60_000);

  /**
   * Breaks if: the password policy is disabled or its floor is dropped to one
   * character; or the rejection happens after the account row is written, which would
   * leave an account nobody can sign in to occupying the address.
   *
   * The second signup is how "no account was created" is observed without reaching for
   * a table: had the rejected attempt created one, this attempt would be the duplicate
   * the test above proves is refused.
   */
  it('AC-16: a password below the policy floor is rejected and leaves the address unused', async () => {
    const rejected = await signUp(server, WEAK_PASSWORD, TOO_SHORT_PASSWORD);

    expect(rejected.status, `body was ${rejected.raw}`).toBeGreaterThanOrEqual(400);
    expect(rejected.status, `body was ${rejected.raw}`).toBeLessThan(500);

    const reusing = await signUp(server, WEAK_PASSWORD, POLICY_COMPLIANT_PASSWORD);

    expect(
      reusing.status,
      `the address should still be unused, but signing up with a valid password ` +
        `answered ${reusing.raw}`,
    ).toBe(200);
  }, 60_000);
});

describe('POST /api/auth/sign-in/email', () => {
  /**
   * Breaks if: sign-in is not mounted; it answers without setting a session cookie; or
   * it sets one the surface does not then accept — the three ways "a session is issued"
   * can be true of the response and false of the system.
   */
  it('AC-20: correct credentials for a verified account issue a session that identifies the account', async () => {
    await verifiedAccount(SIGNS_IN);

    const signedIn = await signIn(server, SIGNS_IN, POLICY_COMPLIANT_PASSWORD);

    expect(signedIn.status, `body was ${signedIn.raw}`).toBe(200);

    const session = await getSession(server, signedIn.cookie);

    expect(session.status, `body was ${session.raw}`).toBe(200);
    expect(userIn(session).email).toBe(SIGNS_IN);
  }, 60_000);

  /**
   * Breaks if: a wrong password answers 400, 403 or 500 instead. The BFF branches on
   * the status (ADR-0014, `web-api-client.md`), so anything but 401 shows the visitor a
   * generic error where "wrong email or password" belongs.
   */
  it('AC-20: an incorrect password is rejected with 401', async () => {
    await verifiedAccount(WRONG_PASSWORD);

    const rejected = await signIn(server, WRONG_PASSWORD, NOT_THE_PASSWORD);

    expect(rejected.status, `body was ${rejected.raw}`).toBe(401);
  }, 60_000);

  /**
   * Breaks if: the session row is written before the password is checked, or on the
   * failure path as well as the success path. An attacker would then mint a session row
   * per guess against any known address — unauthenticated, and invisible to the status
   * assertion above.
   */
  it('AC-20: a rejected sign-in issues no session', async () => {
    await verifiedAccount(NO_SESSION_ISSUED);

    const before = countSessions();
    const rejected = await signIn(server, NO_SESSION_ISSUED, NOT_THE_PASSWORD);

    expect(rejected.status, `body was ${rejected.raw}`).toBe(401);
    expect(countSessions()).toBe(before);
  }, 60_000);
});

describe('POST /api/auth/sign-out', () => {
  /**
   * Breaks if: sign-out only clears the browser's cookies and leaves the session live,
   * which is the shape a hand-rolled logout usually takes and which every client-side
   * assertion would call a success.
   */
  it('AC-21: after sign-out, a request carrying the prior credential is rejected with 401', async () => {
    await verifiedAccount(SIGNS_OUT);

    const signedIn = await signIn(server, SIGNS_OUT, POLICY_COMPLIANT_PASSWORD);

    expect(signedIn.status, `arrange: sign-in answered ${signedIn.raw}`).toBe(200);

    const signedOut = await signOut(server, signedIn.cookie);

    expect(signedOut.status, `body was ${signedOut.raw}`).toBe(200);

    const reused = await mintToken(server, signedIn.cookie);

    expect(reused.status, `body was ${reused.raw}`).toBe(401);
  }, 60_000);

  /**
   * F-231. ADR-0013 revokes by `jti: session.id` (F-227), and that rests on an
   * assumption the architect recorded as **unproven**: that Better Auth does not rotate
   * a session row's id when `get-session` refreshes it. If it rotated, a token minted
   * before the refresh would carry a stale `jti`, sign-out would revoke the new id, and
   * the old token would **survive the logout** — AC-21 failing in the one way the test
   * above cannot see, because that test replays a credential the refresh never touched.
   *
   * Two assertions, and both are load-bearing. `jti` equal across the refresh is the
   * property TASK-009's constraint names; `jti` equal to the **session row's id** is
   * what stops it being vacuous, since a `definePayload` that omits `jti` altogether —
   * the exact defect F-227 was filed for, `better-auth` sets the claim only when the
   * payload carries one — would make both tokens carry `undefined` and satisfy an
   * equality check on its own.
   *
   * The expiry assertion is the third: without it the test could pass across a refresh
   * that never happened.
   *
   * Breaks if: `definePayload` returns no `jti`; `jti` is a per-token random, which
   * sign-out cannot revoke because it holds a session and no token; or a Better Auth
   * upgrade starts rotating the row id, in which case the design changes and TASK-011's
   * revocation step changes with it.
   */
  it('AC-21: tokens minted before and after a session refresh carry the same jti, and it is the session id', async () => {
    await verifiedAccount(REFRESHES);

    // Signup signed this account in already; clearing first is what makes "the
    // session" below unambiguous.
    deleteSessionsFor(REFRESHES);

    const signedIn = await signIn(server, REFRESHES, POLICY_COMPLIANT_PASSWORD);

    expect(signedIn.status, `arrange: sign-in answered ${signedIn.raw}`).toBe(200);

    const before = await mintToken(server, signedIn.cookie);

    expect(before.status, `body was ${before.raw}`).toBe(200);

    const sessionsBefore = sessionsFor(REFRESHES);

    expect(sessionsBefore, 'arrange: expected exactly one open session').toHaveLength(1);

    const sessionBefore = sessionsBefore[0];

    bringSessionExpiryForward(REFRESH_WINDOW_SECONDS);

    const refreshed = await getSession(server, signedIn.cookie);

    expect(refreshed.status, `body was ${refreshed.raw}`).toBe(200);

    const sessionsAfter = sessionsFor(REFRESHES);

    expect(sessionsAfter, 'the refresh should not open a second session').toHaveLength(1);

    const sessionAfter = sessionsAfter[0];

    expect(
      Date.parse(sessionAfter.expiresAt),
      'the session was not refreshed, so this test would assert nothing',
    ).toBeGreaterThan(Date.now() + REFRESH_WINDOW_SECONDS * 1000);

    const after = await mintToken(server, signedIn.cookie);

    expect(after.status, `body was ${after.raw}`).toBe(200);

    const claimsBefore = jwtClaims(jsonBody(before).token as string);
    const claimsAfter = jwtClaims(jsonBody(after).token as string);

    expect(claimsBefore.jti).toBe(sessionBefore.id);
    expect(claimsAfter.jti).toBe(sessionBefore.id);
  }, 60_000);
});
