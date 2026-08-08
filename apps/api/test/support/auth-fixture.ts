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
 * `STORY-005`, not ADR-0013, not `design/contracts/auth-tokens.md` — so the only
 * policy of record is the pinned release's own floor, which probing
 * `better-auth@1.6.26` puts at 8 characters (7 answers `400 PASSWORD_TOO_SHORT`, 8 is
 * accepted). A single character fails that floor and every policy anyone could state
 * on top of it, so the AC's clause is asserted without this fixture inventing a
 * boundary the design never set. Raising the floor later does not touch this value.
 */
export const TOO_SHORT_PASSWORD = 'x';

/**
 * Better Auth's sign-up endpoint **requires** `name` in 1.6.26: a body without it
 * answers 400. `design/contracts/auth-tokens.md:47` writes the body as
 * `{ email, password, name?, invitationToken? }`, with `name` optional. The fixture
 * sends one so no test depends on which of the two is corrected.
 */
export const SIGNUP_NAME = 'Integration Fixture';

/**
 * Environment for the API child process.
 *
 * Every name here is **decided by this fixture**, exactly as `src/health/health.spec.ts`
 * decides `GIT_COMMIT_SHA` and says so: no ADR, contract, `.env.example` or workflow
 * names the variables the auth mount reads. `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET`
 * are `better-auth`'s own conventions; `BFF_PROXY_SECRET` is named in
 * `design/contracts/rate-limit.md:129` and is here because TASK-009 adds
 * `assertBffProxySecretConfigured()` to `main.ts`, which refuses to boot without it.
 * If an implementer picks other names, this function is the single edit.
 */
export function authServerEnv(baseUrl: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: appDsnOrThrow(),
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
 * The runtime role's DSN, read the way `rls-fixture.ts` reads it so the remedy
 * message stays in one place. The API child connects as `shortkit_app`, which is
 * F-122's rule: checking as the migrator would prove nothing about the DSN the API
 * actually uses.
 */
function appDsnOrThrow(): string {
  const value = process.env.DATABASE_URL;

  if (value === undefined || value === '') {
    throw new Error(
      'DATABASE_URL is not set. The integration suite needs a live Postgres: start it ' +
        'with `docker compose -f docker-compose.test.yml up -d` and export DATABASE_URL ' +
        '(shortkit_app) and DATABASE_MIGRATION_URL (shortkit_migrator).',
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

  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');

  return { status: response.status, body, raw, cookie };
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
