import { ACCESS_TOKEN_LIFETIME_SECONDS, TENANT_ROLE } from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  SIGNUP_NAME,
  authRequestWithHost,
  authServerEnv,
  clearSignupState,
  countUsers,
  jwtClaims,
  membershipsFor,
  mintToken,
  sessionTokenCookie,
  sessionsFor,
  signIn,
  signUp,
  tenantRow,
  usersFor,
} from '../support/auth-fixture';
import type { AuthResponse } from '../support/auth-fixture';
import { assertTenantsIsMigrated } from '../support/rls-fixture';

/**
 * STORY-001 — AC-1 and AC-3. TASK-003, wave 2.
 *
 * Contract: `docs/contracts/auth-config-surface.md` ("What the implementer must
 * guarantee", invariants 2, 12 and 13), `docs/contracts/auth-tokens.md`
 * ("Claim set", amended invariant 8). ADR-0013, ADR-0015, ADR-0054, ADR-0059, ADR-0061.
 *
 * AC-1 asserts three tables, two roles and a link between them; nothing below a real
 * database proves it. AC-3 asserts a claim set on a REAL mint, and `jti` is the Better Auth
 * session id, so it needs a real session row.
 *
 * ============================================================================
 * AC-3's PREMISE WAS AMENDED ON 2026-08-16 AND THIS FILE IS WHY.
 * ============================================================================
 *
 * It read "a session created by a successful sign-up OR sign-in". ADR-0061 takes
 * `emailAndPassword.autoSignIn: false` to close an enumeration oracle and to keep a live
 * credential out of ADR-0054's failure path, so A SUCCESSFUL SIGN-UP NO LONGER CREATES A
 * SESSION and that branch became unsatisfiable. The sign-in branch is unchanged. The
 * premise is asserted in its own test below rather than assumed, because every other
 * assertion in this file is stated over "the one session", and that phrase is only
 * unambiguous while signup creates none.
 *
 * ============================================================================
 * ONE CLAUSE OF AC-1 WAS UNMEASURABLE AND WAS AMENDED RATHER THAN APPROXIMATED.
 * ============================================================================
 *
 * It read "exactly one `tenants` row exists", which is a GLOBAL count that no DSN this suite
 * is given can produce: `tenants` carries FORCE ROW LEVEL SECURITY and `tenants_self_select`
 * admits only the row whose id equals `app.tenant_id`, so one context sees at most one row —
 * its own — and every role the suite connects as is NOBYPASSRLS by design
 * (`docker-compose.test.yml`: "a superuser is exempt from every policy and would make
 * AC-8..AC-11 vacuous"). See `auth-fixture.ts`'s `tenantRow`.
 *
 * Ruled by Juano 2026-08-16: the clause is now "exactly one `tenant_memberships` row exists
 * for that user ACROSS ALL TENANTS, the `tenants` row it names exists". That is what the
 * membership read below asserts, through `app.membership_lookup_user`, so a second
 * membership under a second tenant appears in the count rather than being filtered out of
 * it. THE RESIDUAL THE AMENDMENT ACCEPTS is a second, orphaned `tenants` row with no
 * membership pointing at it — a shape no assertion here can see, recorded on the AC.
 */

/** The account AC-1 and AC-3 are stated over. */
const SIGNUP_EMAIL = 'wave2-owner@example.com';

/** A second address, used only by the response-shape comparison below. */
const FRESH_EMAIL = 'wave2-never-registered@example.com';

const ADDRESSES = [SIGNUP_EMAIL, FRESH_EMAIL] as const;

/** A `Host` this API is not, for the issuer-derivation assertion. */
const SPOOFED_HOST = 'evil.test';

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

/**
 * `token` off `GET /api/auth/token`'s body, with a message rather than a `TypeError` when
 * the mint answered with something else. The mint is the subject of two assertions here and
 * a failure has to name what came back.
 */
function mintedToken(response: AuthResponse): string {
  const body = response.body as { token?: unknown };

  expect(
    typeof body.token === 'string' && body.token !== '',
    `the mint answered ${String(response.status)} with ${response.raw}`,
  ).toBe(true);

  return body.token as string;
}

/** The one `user` row for an address, with a message naming the count when it is not one. */
function theUser(email: string): { readonly id: string; readonly emailVerified: boolean } {
  const rows = usersFor(email);

  expect(rows.length, `expected exactly one user row for ${email}`).toBe(1);

  return rows[0];
}

/**
 * Replaces every value the two signup branches are ALLOWED to differ on with a sentinel, so
 * whole-body equality can be asserted over the rest.
 *
 * `id`, `createdAt` and `updatedAt` are the card's three. `email` is the fourth and it comes
 * from the amended invariant 8 in `auth-tokens.md`: a duplicate response is "byte-identical
 * to a real creation APART FROM THE CALLER'S OWN `email`" — the two branches are probed with
 * two different addresses, so an unnormalised `email` makes the comparison fail for the one
 * reason that proves nothing.
 *
 * Recursive and key-based rather than reaching into `body.user`, because the shape of the
 * body is exactly what is under test: a library change that moves `id` up a level must not
 * quietly stop being normalised.
 */
function normalised(value: unknown): unknown {
  const VOLATILE = new Set(['id', 'createdAt', 'updatedAt', 'email']);

  if (Array.isArray(value)) {
    return value.map(normalised);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        VOLATILE.has(key) ? `<${key}>` : normalised(nested),
      ]),
    );
  }

  return value;
}

beforeAll(() => {
  // Kicked off without awaiting and awaited again in `beforeEach`. `api-server.ts`'s docblock
  // explains why: a rejection awaited only in `beforeAll` makes Vitest 3.2.7 report every
  // test in the file SKIPPED beside a summary that still says "N passed", which is how
  // ADR-0027's boot refusal once read as a green run.
  serverBoot = startApiServer({ env: authServerEnv });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;

  // The migrated `tenants`, with its four policies. Every read below goes through them, so a
  // fixture running against an unprotected or unmigrated table would see rows it should not
  // and pass without proving anything.
  assertTenantsIsMigrated();

  clearSignupState(...ADDRESSES);
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

describe('signup provisions a tenant', () => {
  it('AC-1: a signup against empty tables answers 200', async () => {
    const response = await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    expect(response.status, response.raw).toBe(200);
  });

  it('AC-1: it writes one user, one owner membership, and the tenant that membership names', async () => {
    // ONE ASSERTION FOR THE WHOLE CONJUNCTION, for the reason F-134 records on
    // `tenant-memberships.int-spec.ts`: AC-1 is one sentence about the state after one
    // signup, and splitting the counts from the links lets each half pass over a fixture the
    // other half already contradicted.
    //
    // The membership read is keyed on `app.membership_lookup_user`, so it returns this user's
    // rows ACROSS EVERY TENANT — a second membership under a second tenant appears in the
    // count rather than being filtered out of it, which is what makes "exactly one" a
    // statement.
    await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    const user = theUser(SIGNUP_EMAIL);
    const memberships = membershipsFor(user.id);
    const tenant = memberships[0] === undefined ? undefined : tenantRow(memberships[0].tenantId);

    expect({
      users: countUsers(),
      memberships: memberships.length,
      userId: memberships[0]?.userId,
      role: memberships[0]?.role,
      tenantExists: tenant !== undefined,
      tenantIdMatches: tenant?.id === memberships[0]?.tenantId,
    }).toEqual({
      users: 1,
      memberships: 1,
      userId: user.id,
      role: TENANT_ROLE.owner,
      tenantExists: true,
      tenantIdMatches: true,
    });
  });

  it('F-198: the tenant is named with the name the operator typed, verbatim', async () => {
    // ============================================================================
    // THE ONLY TIER THAT CAN SEE THIS. `tenants.name` IS A ROW, NOT A RETURN VALUE.
    // ============================================================================
    //
    // `createTenantForNewUser` resolves `{ tenantId, membershipId }` and never returns the
    // name, so `src/auth/on-user-created.spec.ts` has nothing to read: the claim is about
    // what landed in the column, and reaching the column means reaching the database through
    // `tenants_self_select`. That is why this test is here and not there.
    //
    // Ruled by Juano 2026-08-16 on F-198, which this Test phase raised: `tenants.name` is
    // `text NOT NULL` and NO ARTIFACT SAID WHAT SIGNUP WRITES THERE, while
    // `createTenantForNewUser` took an `email` whose only plausible use was that column. The
    // ruling is the name, verbatim — nothing derived, nothing parsed, no placeholder — and
    // `email` left the signature rather than staying in it implying a use it did not have.
    //
    // `SIGNUP_NAME` is what the fixture sends as the signup body's `name`, and it CANNOT BE
    // DERIVED from `wave2-owner@example.com` by any transformation. So the three
    // implementations the ruling forbids each fail here: a name built from the local part or
    // the domain, a constant like "My workspace" or the tenant's own uuid, and an empty
    // string from a `name` the hook never read.
    await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    const user = theUser(SIGNUP_EMAIL);
    const tenantId = membershipsFor(user.id)[0]?.tenantId;

    expect(tenantId === undefined ? undefined : tenantRow(tenantId)?.name).toBe(SIGNUP_NAME);
  });

  it('ADR-0061 invariant 13: a successful signup issues no session row and no Set-Cookie', async () => {
    // THE PREMISE AC-3's AMENDMENT RESTS ON. `autoSignIn: false` stops signup establishing a
    // session, which is what closes the status-code oracle AND what keeps a live credential
    // off ADR-0054's failure path — the 500 for a failed provisioning used to arrive with a
    // session cookie on it. A caller that needs a session signs in.
    // ⚠ THE STATUS IS IN THE ASSERTION AND IS NOT DECORATION. "No session and no cookie" is
    // trivially true of a signup that did not happen — measured on the wave-2 red run, where
    // this was one of two tests in this file that went GREEN against an API with no auth
    // mount at all, because a 404 also creates no session. The clause is about a SUCCESSFUL
    // signup, so the success belongs in the same assertion.
    const response = await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    expect({
      status: response.status,
      sessions: sessionsFor(SIGNUP_EMAIL).length,
      sessionCookie: sessionTokenCookie(response)?.name,
    }).toEqual({ status: 200, sessions: 0, sessionCookie: undefined });
  });
});

describe('the claim set on a token minted for a sign-in session', () => {
  it('AC-3: sub, tid, email, ev and jti are the signup’s own values and exp minus iat is 300', async () => {
    // ONE ASSERTION, SIX CLAUSES, because AC-3 is one sentence about one token. Every
    // expected value is read from the database or is a literal — none is computed by the
    // path that produced the token.
    //
    // `jti` IS THE SESSION ID AND IS NOT A PER-TOKEN NONCE (F-227, `sign.mjs:49` only sets
    // the claim when `definePayload` puts it there). That is what makes one revocation entry
    // cover every token a session ever minted, and it is why sign-out — which holds a session
    // and no token — can revoke at all.
    //
    // `exp - iat` is the clause F-168 would have broken: `expirationTime: 300` as a NUMBER
    // is returned unchanged as the `exp` claim (`utils.mjs:15-19`), so every token would be
    // issued having expired at `1970-01-01T00:05:00Z`. The string form is what makes this
    // 300. This is asserted over a real mint rather than over the option, deliberately.
    await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    const signedIn = await signIn(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);
    expect(signedIn.status, signedIn.raw).toBe(200);

    const user = theUser(SIGNUP_EMAIL);
    const memberships = membershipsFor(user.id);
    const sessions = sessionsFor(SIGNUP_EMAIL);

    expect(sessions.length, 'sign-in should have opened exactly one session').toBe(1);

    const claims = jwtClaims(mintedToken(await mintToken(server, signedIn.cookie)));

    expect({
      sub: claims.sub,
      tid: claims.tid,
      email: claims.email,
      ev: claims.ev,
      jti: claims.jti,
      lifetime: Number(claims.exp) - Number(claims.iat),
    }).toEqual({
      sub: user.id,
      tid: memberships[0]?.tenantId,
      email: SIGNUP_EMAIL,
      ev: user.emailVerified,
      jti: sessions[0].id,
      lifetime: ACCESS_TOKEN_LIFETIME_SECONDS,
    });
  });

  it('auth-config-surface.md invariant 2: iss and aud stay BETTER_AUTH_URL under a spoofed Host', async () => {
    // ============================================================================
    // MEASURED IN THE WAVE-2 SECURITY PASS: ONE SESSION, TWO HOSTS, TWO VALID TOKENS.
    // ============================================================================
    //
    // With `baseURL` unresolved, `create-context.mjs:85` sets it to `''` and
    // `auth/base.mjs:19-27` re-derives an origin PER REQUEST from the request itself;
    // `sign.mjs:16-20` computes `defaultIss` and `defaultAud` from that. Both tokens carried
    // the same `kid`, both verified, and both satisfied `shortkitJwtClaimsContract`, which
    // types `iss` as `z.string().min(1)`. `AuthGuard` step 4 compares `iss` and `aud`
    // against the configured value, so a token minted under an attacker's Host is a token
    // the guard rejects — or accepts, if the guard derives its expectation the same way.
    //
    // The mint goes through `node:http` rather than `fetch`: undici DROPS a `Host` header
    // SILENTLY (measured on Node 24.19), so a test written on `fetch` would assert that the
    // issuer does not follow a header it never sent, and would pass against the exact
    // configuration this exists to forbid. See `authRequestWithHost`.
    await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);
    const signedIn = await signIn(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    const minted = await authRequestWithHost(server, 'GET', '/token', {
      host: SPOOFED_HOST,
      cookie: signedIn.cookie,
    });

    const claims = jwtClaims(mintedToken(minted));

    expect({ iss: claims.iss, aud: claims.aud }).toEqual({
      iss: server.baseUrl,
      aud: server.baseUrl,
    });
  });

  it('ADR-0059: the session cookie sign-in sets is HttpOnly, SameSite=Lax and Path=/', async () => {
    // The cookie's RESOLVED attributes are pinned in `src/auth/auth.config.spec.ts` off
    // `$context.authCookies`; this is the same statement one layer out, on the wire, where a
    // header written by anything other than that resolution would show.
    //
    // `Secure` is deliberately not asserted here and IS asserted in the unit spec: this tier
    // runs on `http://127.0.0.1:<port>`, a loopback origin, so the correct value is `false`
    // and a test that read `Secure` off this response would pin the wrong direction of
    // `useSecureCookies` forever.
    await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    const signedIn = await signIn(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);
    const cookie = sessionTokenCookie(signedIn);

    expect({
      name: cookie?.name,
      httpOnly: cookie !== undefined && 'httponly' in cookie.attributes,
      sameSite: cookie?.attributes.samesite,
      path: cookie?.attributes.path,
    }).toEqual({
      name: 'better-auth.session_token',
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    });
  });
});

describe('a signup against an address that already has an account', () => {
  it('ADR-0061 invariant 12: it answers 200, not the 422 auth-tokens.md records', async () => {
    // `sign-up.mjs:162` computes its generic-duplicate branch from
    // `requireEmailVerification || autoSignIn === false`. With auto-sign-in on, a duplicate
    // answered `422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` and a fresh address answered 200,
    // which is an unauthenticated enumeration oracle on a public route — and
    // `rateLimit: { enabled: false }` removes the library's own brake in the same card while
    // the replacement limiter is IP-keyed and lands a wave later.
    await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    const duplicate = await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    expect(duplicate.status, duplicate.raw).toBe(200);
  });

  it('ADR-0061: it writes no second user row and no second tenant for that account', async () => {
    // The 200 is a SYNTHETIC user (amended invariant 8: "a 200 no longer means a user was
    // created"), so the state assertion is what says the row count did not move. A duplicate
    // that provisioned a second tenant would leave this user holding one membership and the
    // database holding two tenants — and `tenant_memberships_user_unique` would then be the
    // only thing between that and two memberships.
    await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    const first = theUser(SIGNUP_EMAIL);
    const tenantBefore = membershipsFor(first.id)[0]?.tenantId;

    await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    const after = theUser(SIGNUP_EMAIL);
    const membershipsAfter = membershipsFor(after.id);

    expect({
      users: countUsers(),
      userId: after.id,
      memberships: membershipsAfter.length,
      tenantId: membershipsAfter[0]?.tenantId,
    }).toEqual({
      users: 1,
      userId: first.id,
      memberships: 1,
      tenantId: tenantBefore,
    });
  });

  it('ADR-0061 invariant 12: its body is byte-identical to a fresh signup’s after normalising id, createdAt, updatedAt and email', async () => {
    // ============================================================================
    // THIS TEST SETTLES A QUESTION THE DESIGN COULD NOT, AND BOTH OUTCOMES WERE PRE-COMMITTED.
    // ============================================================================
    //
    // ADR-0061 closes the status-code oracle. Whether it closes the ORACLE was undetermined:
    // measured on better-auth's in-memory adapter, an existing address returned a `user`
    // object carrying an `image` key and a fresh one did not — present if and only if the
    // address exists, deterministically, with no timing analysis. Under the real drizzle
    // adapter the two branches may both serialise a stored row and converge, since
    // `user.image` is nullable in migration `0001`.
    //
    // If this passes it is the standing guard. IF IT FAILS, THE EXISTENCE DISCLOSURE IS REAL
    // and gets accepted explicitly with ADR-0061 superseded, rather than left claiming a
    // closure it does not have.
    //
    // WHOLE-BODY EQUALITY, NOT THE ABSENCE OF `image`. The named-key form passes the day the
    // library changes either branch; this shape stays true.
    await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);

    const duplicate = await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);
    const fresh = await signUp(server, FRESH_EMAIL, POLICY_COMPLIANT_PASSWORD);

    // ⚠ THE PREMISE, AND IT IS NOT CEREMONY. Two responses that are equal because BOTH
    // FAILED satisfy the comparison below perfectly — measured on the wave-2 red run, where
    // this test went green against an API with no auth mount, both branches answering the
    // same branded 404. The same hazard `security-headers.int-spec.ts` opens with, for the
    // same reason.
    expect([duplicate.status, fresh.status], 'both signup branches must have run').toEqual([
      200, 200,
    ]);

    expect(normalised(duplicate.body)).toEqual(normalised(fresh.body));
  });
});
