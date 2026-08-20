/**
 * Fixture for the credential-auth suite: the environment the API child process needs,
 * an HTTP client shaped like a browser, and reads of the four Better Auth tables.
 *
 * ⚠ THIS FILE IS sdlc-test-architect'S. `apps/api/test/support/**` appears in no
 * TASK's paths and belongs to it under routing rule 0 (F-077, F-100). TASK-009 and
 * TASK-058 both write tests that use it; neither edits it.
 *
 * Three decisions worth knowing before changing anything here.
 *
 * 1. **Requests carry an `Origin` header.** `better-auth@1.6.26` answers a
 *    state-changing auth request that has none with `403 MISSING_OR_NULL_ORIGIN`
 *    (`dist/api/middlewares/origin-check.mjs:107`, reproduced against the pinned
 *    release). A browser always sends one; `fetch` in a test does not. Sending the
 *    server's own origin is the browser-faithful thing to do, and it agrees with
 *    Better Auth's default trusted-origin list whether the implementation configures
 *    `baseURL` from `BETTER_AUTH_URL` below or lets it be inferred from the request.
 *
 * 2. **Column names are discovered, not spelled.** The four auth tables are generated
 *    by the Better Auth CLI and checked in (ADR-0013), and nothing in `design/**` or
 *    `tasks/**` fixes whether the generated column is `emailVerified` or
 *    `email_verified`. A fixture that guessed would fail on a naming choice rather
 *    than on behaviour. The table names are safe to spell: `apps/api/scripts/
 *    check-policies.mts` already names `user`, `session`, `account` and `verification`
 *    as the Better Auth exemptions.
 *
 * 3. **The catalog read is `pg_attribute`, not `information_schema`.** That is F-213's
 *    ruling, for the same reason: `information_schema` is filtered by privilege and
 *    answers zero rows for a relation the connected role cannot see, which reads
 *    identically to "the column is absent".
 */
import { request as httpRequest } from 'node:http';

import { migrationDsn } from './rls-fixture';
import { execSql, querySql } from './psql';
import type { ApiServer } from './api-server';

/**
 * A password comfortably above any policy this product could adopt. AC-16 says "a
 * password meeting the stated policy" and no artifact states one; see
 * `TOO_SHORT_PASSWORD`.
 */
export const POLICY_COMPLIANT_PASSWORD = 'quilted-harbour-19-lantern';

/**
 * One character. **No artifact in this repository states a password policy** — not
 * `STORY-005`, not ADR-0013, not `docs/contracts/auth-tokens.md` — so the only
 * policy of record is the pinned release's own floor, which probing
 * `better-auth@1.6.26` puts at 8 characters (7 answers `400 PASSWORD_TOO_SHORT`, 8 is
 * accepted). A single character fails that floor and every policy anyone could state
 * on top of it, so the AC's clause is asserted without this fixture inventing a
 * boundary the design never set. Raising the floor later does not touch this value.
 */
export const TOO_SHORT_PASSWORD = 'x';

/**
 * Better Auth's sign-up endpoint **requires** `name` in 1.6.26: a body without it
 * answers 400. `docs/contracts/auth-tokens.md:47` writes the body as
 * `{ email, password, name?, invitationToken? }`, with `name` optional. The fixture
 * sends one so no test depends on which of the two is corrected.
 */
export const SIGNUP_NAME = 'Integration Fixture';

/**
 * Environment for the API child process.
 *
 * Every name here is **decided by this fixture**, exactly as `src/health/health.spec.ts`
 * decides `GIT_COMMIT_SHA` and says so (written when no `.env.example` named them;
 * `apps/api/.env.example` lists `GIT_COMMIT_SHA` and the auth mount's variables since
 * TASK-009, and the fixture still decides its own values). `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET`
 * are `better-auth`'s own conventions; `BFF_PROXY_SECRET` is named in
 * `docs/contracts/rate-limit.md:129` and is here because TASK-009 adds
 * `assertBffProxySecretConfigured()` to `main.ts`, which refuses to boot without it.
 * If an implementer picks other names, this function is the single edit.
 *
 * `GIT_COMMIT_SHA` is here for the same reason `BFF_PROXY_SECRET` is: ADR-0027 makes
 * `main.ts` refuse to boot without a full 40-character lowercase hex value, one refusal
 * earlier than `assertBffProxySecretConfigured()` in the boot sequence. The value below
 * is not this repository's HEAD and does not need to be — ADR-0027 only requires the
 * *format*, and nothing in the spawned process computes a SHA to compare it against.
 */
export function authServerEnv(baseUrl: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: dsnOrThrow('DATABASE_URL', 'shortkit_app'),
    DATABASE_AUTH_URL: dsnOrThrow('DATABASE_AUTH_URL', 'shortkit_auth'),
    GIT_COMMIT_SHA: '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b',
    BETTER_AUTH_URL: baseUrl,
    BETTER_AUTH_SECRET: 'integration-fixture-better-auth-secret-not-a-real-key',
    /**
     * base64url, unpadded, 43 characters — the format `apps/web/scripts/
     * assert-no-inlined-secrets.mjs` enforces on the Vercel half (F-169). A fixture
     * value for a throwaway process; nothing signs anything real with it.
     */
    BFF_PROXY_SECRET: 'FIXTURE-bff-proxy-secret_not_a_real_value_00',
  };
}

/**
 * One reader for both DSNs the API child needs, so the two remedy messages cannot say a
 * different number of variables to each other (F-052). Read the way `rls-fixture.ts`'s
 * `dsn()` reads `DATABASE_URL`/`DATABASE_MIGRATION_URL`, so the remedy stays in one
 * shape across both files: no fallback from `DATABASE_AUTH_URL` to `DATABASE_URL`,
 * because a fallback here would spawn the API child connecting to Better Auth's tables
 * as `shortkit_app` — exactly the role ADR-0050's split exists to keep off them.
 */
function dsnOrThrow(variable: 'DATABASE_URL' | 'DATABASE_AUTH_URL', role: string): string {
  const value = process.env[variable];

  if (value === undefined || value === '') {
    throw new Error(
      `${variable} is not set. The integration suite needs a live Postgres: start it ` +
        'with `docker compose -f docker-compose.test.yml up -d` and export DATABASE_URL ' +
        '(shortkit_app), DATABASE_MIGRATION_URL (shortkit_migrator) and DATABASE_AUTH_URL ' +
        `(shortkit_auth) — see that file's header for the exact export lines. This call ` +
        `needed ${variable} (${role}).`,
    );
  }

  return value;
}

export interface AuthResponse {
  readonly status: number;
  /** Parsed JSON when the body is JSON, otherwise the raw text. */
  readonly body: unknown;
  readonly raw: string;
  /** `name=value; name=value`, ready to send back as a `Cookie` header. */
  readonly cookie: string;
  /**
   * Every `Set-Cookie` header verbatim, attributes included.
   *
   * ADDED 2026-08-16, wave 2. `cookie` above is built for ROUND-TRIPPING a session back to
   * the server, so it strips every attribute — which means nothing that reads it can see
   * `Secure`, `HttpOnly`, `SameSite`, `Max-Age` or the `__Secure-` name prefix, and
   * `auth-config-surface.md`'s cookie table is exactly a statement about those. Exposed
   * here rather than parsed out of a raw `Response` in a spec, so one parser serves every
   * caller (F-077: this directory is the test architect's).
   */
  readonly setCookie: readonly string[];
}

/**
 * One `Set-Cookie` header, split into its name, its value and its attributes.
 *
 * Attribute names are lower-cased; a valueless attribute (`Secure`, `HttpOnly`) maps to the
 * empty string, so presence is `key in attributes` and a value is `attributes[key]`.
 */
export interface ParsedCookie {
  readonly name: string;
  readonly value: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export function parseSetCookie(header: string): ParsedCookie {
  const [pair, ...rest] = header.split(';');
  const separator = pair.indexOf('=');

  const attributes: Record<string, string> = {};
  for (const part of rest) {
    const trimmed = part.trim();
    const at = trimmed.indexOf('=');

    attributes[(at === -1 ? trimmed : trimmed.slice(0, at)).toLowerCase()] =
      at === -1 ? '' : trimmed.slice(at + 1);
  }

  return {
    name: separator === -1 ? pair : pair.slice(0, separator),
    value: separator === -1 ? '' : pair.slice(separator + 1),
    attributes,
  };
}

/**
 * The session-token cookie a response set, or `undefined` when it set none.
 *
 * Matched on the name ENDING in `better-auth.session_token` rather than equalling it,
 * because `advanced.useSecureCookies` renames every cookie with a `__Secure-` prefix
 * (`cookies/index.mjs:20,30`) — so a caller asserting on the prefix has to be able to find
 * the cookie whichever name it carries.
 */
export function sessionTokenCookie(response: AuthResponse): ParsedCookie | undefined {
  return response.setCookie
    .map(parseSetCookie)
    .find((cookie) => cookie.name.endsWith('better-auth.session_token') && cookie.value !== '');
}

/**
 * One request to the auth surface.
 *
 * The body is read as text before it is parsed, so a non-JSON response fails an
 * assertion in a test rather than throwing out of `response.json()` and reporting a
 * parse error instead of the status the route answered with — the same reason
 * `src/health/health.spec.ts` does it.
 */
export async function authRequest(
  server: ApiServer,
  method: 'GET' | 'POST',
  path: string,
  options: { readonly body?: unknown; readonly cookie?: string } = {},
): Promise<AuthResponse> {
  const response = await fetch(`${server.baseUrl}/api/auth${path}`, {
    method,
    headers: {
      // TASK-1b-10 (a review finding). NO KEEP-ALIVE ON A FIXTURE SOCKET. undici pools the
      // socket to the child across calls, and the child's `keepAliveTimeout` (5 s) closes it
      // from the other end; a caller that comes back to it after a long gap — the isolation
      // harness re-mints a token per attempt after psql resets and censuses, sometimes minutes
      // after the previous auth call — can pick the socket up in the instant the child's FIN
      // lands and get `fetch failed: other side closed` on a request that never arrived.
      // `connection: close` is honoured by undici (measured on Node 24: the header arrives
      // and the server closes after the response), so every auth call opens its own socket.
      // One header, no behavioural change for any assertion: nothing here keys on a socket.
      connection: 'close',
      origin: server.baseUrl,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie === undefined || options.cookie === ''
        ? {}
        : { cookie: options.cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  const setCookie = response.headers.getSetCookie();

  const cookie = setCookie
    .map((header) => header.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');

  return { status: response.status, body, raw, cookie, setCookie };
}

/**
 * One request to the auth surface carrying a `Host` header this fixture chooses.
 *
 * ============================================================================
 * `fetch` CANNOT DO THIS, WHICH IS THE ONLY REASON THIS FUNCTION EXISTS.
 * ============================================================================
 *
 * `Host` is a forbidden header name, and undici DROPS it silently rather than refusing:
 * measured against Node 24.19 through a loopback `http.createServer`, `fetch(url, {
 * headers: { host: 'evil.test' } })` arrives with `req.headers.host` equal to the real
 * authority, with no error anywhere. A test written on `authRequest` would therefore assert
 * that the issuer does not follow a header it never sent, and would pass against the exact
 * configuration `auth-config-surface.md` invariant 2 exists to forbid.
 *
 * `node:http` sets it verbatim (measured the same way: `req.headers.host` reads
 * `evil.test`), so this is the raw client. Everything else matches `authRequest`: the
 * `Origin` header is the server's own, the body is read as text before it is parsed, and
 * the same `AuthResponse` comes back.
 */
export async function authRequestWithHost(
  server: ApiServer,
  method: 'GET' | 'POST',
  path: string,
  options: { readonly host: string; readonly body?: unknown; readonly cookie?: string },
): Promise<AuthResponse> {
  const target = new URL(`${server.baseUrl}/api/auth${path}`);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);

  return new Promise<AuthResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: {
          host: options.host,
          origin: server.baseUrl,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.cookie === undefined || options.cookie === ''
            ? {}
            : { cookie: options.cookie }),
        },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (raw += chunk));
        response.on('end', () => {
          let body: unknown = raw;
          try {
            body = JSON.parse(raw) as unknown;
          } catch {
            /* left as the raw text */
          }

          const setCookie = response.headers['set-cookie'] ?? [];

          resolve({
            status: response.statusCode ?? 0,
            body,
            raw,
            cookie: setCookie
              .map((header) => header.split(';')[0])
              .filter((pair) => !pair.endsWith('='))
              .join('; '),
            setCookie,
          });
        });
      },
    );

    request.on('error', reject);

    if (payload !== undefined) {
      request.write(payload);
    }

    request.end();
  });
}

export async function signUp(
  server: ApiServer,
  email: string,
  password: string,
): Promise<AuthResponse> {
  return authRequest(server, 'POST', '/sign-up/email', {
    body: { email, password, name: SIGNUP_NAME },
  });
}

export async function signIn(
  server: ApiServer,
  email: string,
  password: string,
): Promise<AuthResponse> {
  return authRequest(server, 'POST', '/sign-in/email', { body: { email, password } });
}

export async function signOut(server: ApiServer, cookie: string): Promise<AuthResponse> {
  return authRequest(server, 'POST', '/sign-out', { body: {}, cookie });
}

export async function getSession(server: ApiServer, cookie: string): Promise<AuthResponse> {
  return authRequest(server, 'GET', '/get-session', { cookie });
}

/** `GET /api/auth/token` — the mint, and the request ADR-0014's BFF makes to refresh. */
export async function mintToken(server: ApiServer, cookie: string): Promise<AuthResponse> {
  return authRequest(server, 'GET', '/token', { cookie });
}

/** The claim set of a JWT, without verifying it: the tests assert on claims, not on trust. */
export function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];

  if (payload === undefined) {
    throw new Error(`not a JWT: ${token}`);
  }

  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

/**
 * The column of `table` whose name matches `pattern`, read from `pg_attribute`.
 * Throws with the remedy when the table has not been migrated yet.
 */
function columnMatching(table: string, pattern: string): string {
  const rows = querySql<{ attname: string }>(
    migrationDsn(),
    `SELECT attname
       FROM pg_attribute
      WHERE attrelid = to_regclass('public.${table}')
        AND attnum > 0
        AND NOT attisdropped
        AND attname ~* '${pattern}'`,
  );

  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one column matching /${pattern}/i on "${table}", found ` +
        `${String(rows.length)}. If the table does not exist yet, apply migrations: ` +
        '`pnpm --filter @shortkit/api db:migrate` with DATABASE_MIGRATION_URL set.',
    );
  }

  return rows[0].attname;
}

export interface UserRow extends Record<string, unknown> {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

/**
 * Every `user` row for an address, with the id and the verification flag.
 *
 * A separate read from `accountsFor` rather than a widening of it: that one is TASK-009's,
 * its callers assert on a row shape carrying exactly `emailVerified`, and adding a column
 * to a shared reader is how a fixture change breaks a suite it was not written for.
 *
 * ⚠ NO POLICY GATES THIS. `relrowsecurity` is false on all five Better Auth tables
 * (ADR-0056, measured), so this is an unfiltered read and the count it returns is the whole
 * table's. The `tenants` reader below is the opposite case and says so.
 */
export function usersFor(email: string): UserRow[] {
  const verified = columnMatching('user', '^email_?verified$');

  return querySql<UserRow>(
    migrationDsn(),
    `SELECT id, email, "${verified}" AS "emailVerified"
       FROM "user"
      WHERE lower(email) = lower(:'email')`,
    { variables: { email } },
  );
}

/** How many `user` rows exist in total. No policy filters it; see `usersFor`. */
export function countUsers(): number {
  const rows = querySql<{ total: number }>(
    migrationDsn(),
    'SELECT count(*)::int AS total FROM "user"',
  );

  return rows[0]?.total ?? 0;
}

export interface MembershipRow extends Record<string, unknown> {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: string;
}

/**
 * Every `tenant_memberships` row belonging to a user, across every tenant.
 *
 * ============================================================================
 * READ THROUGH `app.membership_lookup_user`, WHICH IS A POLICY AND NOT A WHERE CLAUSE.
 * ============================================================================
 *
 * `tenant_memberships` carries FORCE ROW LEVEL SECURITY, so `shortkit_migrator` is subject
 * to its policies even though it owns the table (migration `0001`). Two policies can admit
 * a read: `tenant_memberships_tenant_isolation`, which needs the tenant id the caller is
 * asking FOR, and `tenant_memberships_membership_lookup` (ADR-0045), which admits exactly
 * the rows whose `user_id` equals this flag — across every tenant, which is the direction a
 * "did signup write exactly one membership, anywhere?" assertion needs.
 *
 * So a caller that knows only a user id can still ask, and the answer is the whole truth
 * for that user rather than the truth inside one tenant.
 */
export function membershipsFor(userId: string): MembershipRow[] {
  return querySql<MembershipRow>(
    migrationDsn(),
    `SELECT id, tenant_id AS "tenantId", user_id AS "userId", role
       FROM tenant_memberships
      WHERE user_id = :'user_id'`,
    { variables: { user_id: userId }, flags: { 'app.membership_lookup_user': userId } },
  );
}

export interface TenantRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
}

/**
 * The `tenants` row with this id, or `undefined` when none is visible.
 *
 * ============================================================================
 * THERE IS NO WAY TO COUNT `tenants` FROM THE SUITE, AND THAT IS DELIBERATE UPSTREAM.
 * ============================================================================
 *
 * `tenants_self_select` is `USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)`
 * and the table is FORCE ROW LEVEL SECURITY, so **one context sees at most one row** — its
 * own. Every DSN the integration suite is given is NOBYPASSRLS on purpose
 * (`docker-compose.test.yml`: "a superuser is exempt from every policy and would make
 * AC-8..AC-11 vacuous"), so no reader here can produce `SELECT count(*) FROM tenants`.
 *
 * A caller therefore asserts on the tenant it can NAME — the one its membership row points
 * at — and cannot assert that no OTHER tenant row was written. That residual is stated on
 * the assertion that needs it, in `test/auth/signup-creates-tenant.int-spec.ts`.
 */
export function tenantRow(tenantId: string): TenantRow | undefined {
  return querySql<TenantRow>(
    migrationDsn(),
    `SELECT id, name FROM tenants WHERE id = :'tenant_id'::uuid`,
    { tenantId, variables: { tenant_id: tenantId } },
  )[0];
}

/**
 * Deletes one user's membership row, leaving the `user` row and its tenant in place.
 *
 * ============================================================================
 * THIS PRODUCES A STATE NO SHIPPED CODE PATH PRODUCES. STORY-001 SAYS SO (Concern 2).
 * ============================================================================
 *
 * AC-4 is stated over "a `user` row that has no `tenant_memberships` row". In this
 * initiative that state arises only from ADR-0015's invited branch, which is out of scope,
 * or from ADR-0054's residue, which needs a write to fail. So the fixture constructs it,
 * and the AC is still worth having because `tenantIdForUser` throwing is the primary stop
 * ADR-0015 names.
 *
 * BOTH FLAGS, and the second is not decoration — the same measurement `rls-fixture.ts`
 * records: `tenant_memberships_privileged_erase` is `FOR DELETE` and grants no read, so a
 * `DELETE ... WHERE user_id = ...` references a column, PostgreSQL applies the SELECT
 * policies to it, and with no readable context the statement finds no row and reports
 * `DELETE 0` with no error at all.
 */
export function deleteMembershipFor(userId: string, tenantId: string): void {
  execSql(
    migrationDsn(),
    `DELETE FROM tenant_memberships WHERE user_id = :'user_id'`,
    {
      variables: { user_id: userId },
      flags: { 'app.privileged_erase': tenantId, 'app.tenant_id': tenantId },
    },
  );
}

/**
 * Erases a tenant row, and with it every tenant-scoped row that cascades from it.
 *
 * `tenants_privileged_erase` is the only DELETE path on the table (F-005) and needs
 * `app.tenant_id` as well, for the reason `deleteMembershipFor` above states: the `WHERE`
 * references `id`, so the SELECT policies apply to the DELETE.
 */
export function eraseTenant(tenantId: string): void {
  execSql(migrationDsn(), `DELETE FROM tenants WHERE id = :'tenant_id'::uuid`, {
    variables: { tenant_id: tenantId },
    flags: { 'app.privileged_erase': tenantId, 'app.tenant_id': tenantId },
  });
}

/**
 * Takes an address back to "the tables are empty" — the state AC-1 is stated over.
 *
 * ORDER IS LOAD-BEARING. The tenants a signup created are only reachable through that
 * user's membership rows, so they have to be erased BEFORE `clearAuthTables()` removes the
 * `user` row that leads to them. Reversed, the tenant rows are stranded: nothing in the
 * suite can enumerate `tenants` (see `tenantRow`), so nothing could ever find them again.
 */
export function clearSignupState(...emails: readonly string[]): void {
  // VARIADIC, and it has to be: `clearAuthTables()` empties `user` for EVERY address, so
  // calling this once per address in a loop would delete the second address's user row on
  // the first pass and then have no way to find the tenants it led to.
  for (const email of emails) {
    for (const user of usersFor(email)) {
      for (const membership of membershipsFor(user.id)) {
        eraseTenant(membership.tenantId);
      }
    }
  }

  clearAuthTables();
}

export interface AccountRow extends Record<string, unknown> {
  readonly emailVerified: boolean;
}

/** Every account row for an address, case-insensitively. */
export function accountsFor(email: string): AccountRow[] {
  const verified = columnMatching('user', '^email_?verified$');

  return querySql<AccountRow>(
    migrationDsn(),
    `SELECT "${verified}" AS "emailVerified"
       FROM "user"
      WHERE lower(email) = lower(:'email')`,
    { variables: { email } },
  );
}

/**
 * Marks an account verified by writing the column the verification flow would.
 *
 * AC-20 and AC-21 are stated against a **verified** account, and the only other way to
 * reach that state is the verification email — TASK-010, one wave after this one. The
 * write goes through the migrator role because `shortkit_app` is the API's identity,
 * not the fixture's.
 */
export function markEmailVerified(email: string): void {
  const verified = columnMatching('user', '^email_?verified$');

  execSql(
    migrationDsn(),
    `UPDATE "user" SET "${verified}" = true WHERE lower(email) = lower(:'email')`,
    { variables: { email } },
  );
}

export interface SessionRow extends Record<string, unknown> {
  readonly id: string;
  /** ISO 8601, as text: the comparison the tests make is ordering, not equality. */
  readonly expiresAt: string;
}

/** Every session row belonging to an address, oldest expiry first. */
export function sessionsFor(email: string): SessionRow[] {
  const expiresAt = columnMatching('session', '^expires_?at$');
  const userId = columnMatching('session', '^user_?id$');

  return querySql<SessionRow>(
    migrationDsn(),
    `SELECT s.id, s."${expiresAt}"::text AS "expiresAt"
       FROM "session" s
       JOIN "user" u ON u.id = s."${userId}"
      WHERE lower(u.email) = lower(:'email')
      ORDER BY s."${expiresAt}"`,
    { variables: { email } },
  );
}

/**
 * Deletes every session belonging to an address.
 *
 * Signup signs the new account in and sign-in opens a second session, so an address
 * normally holds two and "the session" is ambiguous. A test that needs to speak about
 * one specific session clears them first and then opens exactly one — verified
 * ambiguous by probe, not assumed.
 *
 * The rows go by SQL rather than through `revoke-session`, so nothing here depends on
 * the endpoint under test in the same file.
 */
export function deleteSessionsFor(email: string): void {
  const userId = columnMatching('session', '^user_?id$');

  execSql(
    migrationDsn(),
    `DELETE FROM "session"
      WHERE "${userId}" IN (SELECT id FROM "user" WHERE lower(email) = lower(:'email'))`,
    { variables: { email } },
  );
}

/** How many session rows exist in total. Tests read it as a before/after delta. */
export function countSessions(): number {
  const rows = querySql<{ total: number }>(
    migrationDsn(),
    'SELECT count(*)::int AS total FROM "session"',
  );

  return rows[0]?.total ?? 0;
}

/**
 * Moves every session's expiry to `seconds` from now.
 *
 * This is what makes a session-refresh observable inside a test. Better Auth refreshes
 * a session on `get-session` when `expiresAt - expiresIn + updateAge <= now`
 * (`better-auth/dist/api/routes/session.mjs:207`), which for any sane configuration is
 * days away from a session that was just created. Pulling the expiry to a minute from
 * now satisfies the predicate whatever `expiresIn` and `updateAge` are configured to,
 * while leaving the session live. The refresh then writes a **later** `expiresAt`,
 * which is how the test proves a refresh actually happened rather than asserting
 * across a no-op.
 */
export function bringSessionExpiryForward(seconds: number): void {
  const expiresAt = columnMatching('session', '^expires_?at$');

  execSql(
    migrationDsn(),
    `UPDATE "session" SET "${expiresAt}" = now() + make_interval(secs => ${String(seconds)})`,
  );
}

/**
 * Empties the four Better Auth tables so a re-run starts from the same place.
 *
 * Deliberately tolerant of tables that do not exist: they do not, until TASK-009
 * lands, and a fixture that threw here would make every test in the suite fail on
 * setup instead of on its own assertion — which is the one failure mode a red run must
 * not have.
 */
export function clearAuthTables(): void {
  execSql(
    migrationDsn(),
    `DO $$
     DECLARE t text;
     BEGIN
       FOREACH t IN ARRAY ARRAY['session', 'account', 'verification', 'user'] LOOP
         IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
           EXECUTE format('DELETE FROM %I', t);
         END IF;
       END LOOP;
     END $$;`,
  );
}
