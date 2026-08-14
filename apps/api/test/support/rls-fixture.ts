/**
 * The two-tenant fixture STORY-003's acceptance criteria are stated against:
 * tenants A and B, each owning exactly one row in an RLS-protected table.
 *
 * Contracts: design/contracts/rls-policy-template.md, design/contracts/tenant-context.md
 * ADRs: ADR-0002, ADR-0003
 *
 * Two decisions worth knowing before you change anything here.
 *
 * 1. The protected table's policies come from the production template,
 *    `tenantScopedPolicies()` in `src/db/rls.ts` — not from SQL written in this
 *    file. If the fixture wrote its own policies it would be testing its own SQL:
 *    AC-10 in particular would then exercise no production code at all and would
 *    pass on an empty implementation.
 *
 * 2. Rows are seeded BEFORE the policies are applied, so setting up the fixture
 *    never depends on the `WITH CHECK` clause that AC-9 is asserting. A broken
 *    template fails a test, not the setup.
 *
 * ⚠ THE EDITS IN THIS FILE ARE sdlc-test-architect'S — `apps/api/test/support/**` is in
 * no TASK's paths and belongs to it under routing rule 0. What TASK-005 owes is the
 * artifacts the edits depend on, and nothing inside this file (F-077, F-100):
 *   - `docker-compose.test.yml`, which stands up a database already holding the
 *     `shortkit_migrator` and `shortkit_app` roles from rls-policy-template.md, and
 *     exports `DATABASE_URL` / `DATABASE_MIGRATION_URL` for them. This fixture reads
 *     those two variables and nothing else.
 *   - the migration runner, which is what made the change below possible.
 *
 * ---------------------------------------------------------------------------
 * 3. `tenants` IS NO LONGER CREATED HERE (TASK-006, 2026-08-08).
 * ---------------------------------------------------------------------------
 *
 * Until now this file created `tenants` itself, as raw DDL and with no policies, and
 * its own header recorded that sdlc-test-architect would replace that with the real
 * migration "once TASK-005's migration runner exists". It exists, so this is that
 * replacement, and TASK-006 is what needed it: an isolation harness cannot assert
 * isolation on a table the fixture deliberately left unprotected.
 *
 * `tenants` now comes from `apps/api/drizzle/0000_*.sql` by way of `db:migrate`, with
 * the bespoke four-policy set that migration hand-appends — so this file writes NO
 * policy SQL for it, the same rule note 1 above states for the tenant-scoped table.
 * The fixture only seeds and erases rows, and it does both through the policies:
 *
 *   - seeding sets `app.tenant_id` to the row's own id, because `tenants_self_insert`
 *     admits exactly the tenant whose context the insert runs in (ADR-0021);
 *   - erasing sets `app.privileged_erase`, because `tenants_privileged_erase` is the
 *     only DELETE path the table has (F-005) — even for the owning role, since the
 *     migration also applies FORCE ROW LEVEL SECURITY.
 *
 * TWO CONSEQUENCES WORTH KNOWING.
 *
 * The integration suite now REQUIRES `pnpm --filter @shortkit/api db:migrate` to have
 * run against `DATABASE_MIGRATION_URL`. `assertTenantsIsMigrated()` below says so with
 * the remedy rather than failing later inside a test; `test/support/auth-fixture.ts`
 * already had the same requirement, so this adds no step to the local flow that was
 * not there already. CI's `integration` job migrates before the suite (TASK-002).
 *
 * And schema `public` is no longer left holding an unprotected `tenants` after a run,
 * which is the state ci.yml's "ORDER IS LOAD-BEARING" note describes. That order is
 * still right — `db:check-policies` should run against the migrated database — but the
 * damage it was ordered around is gone.
 */
import { TENANT_ID_COLUMN_SQL, tenantScopedPolicies } from '../../src/db/rls';

import { execSql, querySql } from './psql';

/**
 * A table this suite owns, shaped exactly like every tenant-scoped table the
 * later schema TASKs will add. Using a fixture table rather than a real one keeps
 * STORY-003 independent of tables that do not exist yet, and exercises the
 * reusable template that is TASK-005's actual deliverable.
 */
export const RLS_FIXTURE_TABLE = 'rls_fixture_rows';

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';

/**
 * A third tenant id that is NEVER seeded. TASK-006's harness needs a tenant the actor
 * demonstrably does not own for the one attempt whose row identity IS its owner: an
 * insert into `tenants` carrying B's id collides on the primary key, and a 23505 would
 * be indistinguishable from the 42501 the policy is supposed to raise. This id exists
 * so that attempt tests the policy rather than the index.
 *
 * Declared here rather than in `test/isolation/` because `createRlsFixture()` erases it
 * too: an attempt that WRONGLY succeeded leaves the row behind, and the next test would
 * then run against a `tenants` table the previous failure had edited.
 */
export const TENANT_C_NEVER_SEEDED = '33333333-3333-4333-8333-333333333333';

export const TENANT_A_NAME = 'Tenant A';
export const TENANT_B_NAME = 'Tenant B';

export const TENANT_A_LABEL = 'row-owned-by-tenant-a';
export const TENANT_B_LABEL = 'row-owned-by-tenant-b';

/**
 * Exported since TASK-006's r2 rework: the isolation suite's positive control states the
 * expected ownership census as four hand-derived literals, and the row ids are half of
 * each line. A census that reads `id=` anything else is a fixture that seeded something
 * other than what the assertion describes.
 */
export const TENANT_A_ROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TENANT_B_ROW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function dsn(variable: 'DATABASE_URL' | 'DATABASE_MIGRATION_URL'): string {
  const value = process.env[variable];

  if (value === undefined || value === '') {
    throw new Error(
      `${variable} is not set. The integration suite needs a live Postgres: ` +
        'start it with `docker compose -f docker-compose.test.yml up -d` and export ' +
        'DATABASE_URL (shortkit_app), DATABASE_MIGRATION_URL (shortkit_migrator) and ' +
        "DATABASE_AUTH_URL (shortkit_auth) — see that file's header for the exact " +
        'export lines.',
    );
  }

  return value;
}

/** The runtime role. RLS applies to it, which is what makes these assertions mean anything. */
export function appDsn(): string {
  return dsn('DATABASE_URL');
}

/** The owner role. Runs the fixture's DDL and seeds. */
export function migrationDsn(): string {
  return dsn('DATABASE_MIGRATION_URL');
}

/**
 * Without this, every assertion in STORY-003 passes vacuously: a superuser or a
 * `BYPASSRLS` role is exempt from every policy, so a correct implementation and a
 * missing one look identical. ADR-0003 forbids both for `shortkit_app`.
 *
 * This is a fixture guard rather than a test — it protects the tests' premise. The
 * production equivalent is `assertRuntimeRoleCannotBypassRls()`, a boot check that
 * TASK-005 owns and TASK-056 covers.
 */
export function assertAppRoleCannotBypassRls(): void {
  const [role] = querySql<{ role: string; superuser: boolean; bypassrls: boolean }>(
    appDsn(),
    `SELECT current_user                       AS role,
            current_setting('is_superuser') = 'on' AS superuser,
            rolbypassrls                      AS bypassrls
       FROM pg_roles
      WHERE rolname = current_user`,
  );

  if (role === undefined) {
    throw new Error('DATABASE_URL connected as a role that pg_roles does not list.');
  }

  if (role.superuser || role.bypassrls) {
    throw new Error(
      `DATABASE_URL connects as '${role.role}', which is exempt from row-level security ` +
        `(superuser=${String(role.superuser)}, bypassrls=${String(role.bypassrls)}). ` +
        'Every isolation assertion would pass without proving anything. ' +
        'Connect as shortkit_app (ADR-0003).',
    );
  }
}

/**
 * Every tenant id this fixture is allowed to leave behind, so a rebuild removes the
 * rows a previous test wrote AND the rows a previous FAILURE wrote.
 */
const FIXTURE_TENANT_IDS = [TENANT_A, TENANT_B, TENANT_C_NEVER_SEEDED] as const;

/**
 * `tenants_privileged_erase` is the only DELETE path on `tenants` (F-005), and FORCE
 * ROW LEVEL SECURITY subjects the owning role to it as well, so this is how the
 * fixture — running as `shortkit_migrator` — takes its own rows out again. The cascade
 * on `tenant_id` takes the tenant-scoped rows with them.
 *
 * ⚠ BOTH FLAGS, AND THE SECOND ONE IS NOT DECORATION. `app.tenant_id` is set here as
 * well as `app.privileged_erase`, because a `DELETE ... WHERE id = ...` REFERENCES A
 * COLUMN, and PostgreSQL applies the SELECT policies to any UPDATE or DELETE that does.
 * `tenants_privileged_erase` is `FOR DELETE` and, as rls-policy-template.md puts it,
 * "grants no read" — so with `app.tenant_id` unset the statement can see no row to
 * delete and reports `DELETE 0` with no error at all. Measured, not reasoned:
 *
 *   DELETE ... WHERE tenant_id = A, app.privileged_erase only  -> DELETE 0
 *   DELETE FROM <t>  (no WHERE),   app.privileged_erase only  -> DELETE 1
 *   DELETE ... WHERE tenant_id = A, both flags set            -> DELETE 1
 *
 * Filed by TASK-006 against ADR-0019 and TASK-054: the eraser written the obvious way
 * erases nothing and reports success. Nothing in this fixture depends on which repair
 * is chosen — it sets both flags, which is the form that works with a WHERE clause.
 */
const eraseFixtureTenants = FIXTURE_TENANT_IDS.map(
  (id) =>
    `SELECT set_config('app.privileged_erase', '${id}', false) \\g /dev/null\n` +
    `SELECT set_config('app.tenant_id', '${id}', false) \\g /dev/null\n` +
    `DELETE FROM tenants WHERE id = '${id}';`,
).join('\n');

/**
 * `tenants_self_insert` admits exactly the tenant whose context the insert runs in, so
 * each row is written under its own id (ADR-0021). Two rows, two contexts — a single
 * INSERT ... VALUES with both would be refused, which is the policy working.
 */
const seedFixtureTenants = [
  [TENANT_A, TENANT_A_NAME],
  [TENANT_B, TENANT_B_NAME],
]
  .map(
    ([id, name]) =>
      `SELECT set_config('app.tenant_id', '${id}', false) \\g /dev/null\n` +
      `INSERT INTO tenants (id, name) VALUES ('${id}', '${name}');`,
  )
  .join('\n');

let cachedAppRole: string | null = null;

/**
 * The role `DATABASE_URL` connects as, read once. Memoised because the fixture is
 * rebuilt per test and per cross-tenant attempt, and every `psql` here is a process
 * spawn — or, with no client on PATH, a `docker run`.
 */
export function appRoleName(): string {
  if (cachedAppRole !== null) {
    return cachedAppRole;
  }

  const [connection] = querySql<{ role: string }>(appDsn(), 'SELECT current_user AS role');

  if (connection === undefined) {
    throw new Error('DATABASE_URL did not answer `SELECT current_user`.');
  }

  cachedAppRole = connection.role;

  return cachedAppRole;
}

interface TenantsTableState extends Record<string, unknown> {
  role: string;
  database: string;
  database_owner: string;
  row_security: boolean;
  force_row_security: boolean;
  policies: number;
}

let tenantsChecked = false;

/**
 * The fixture's premise since TASK-006: `tenants` is the MIGRATED table, carrying the
 * four policies `apps/api/drizzle/0000_*.sql` hand-appends. Seeding below sets
 * `app.tenant_id` and erasing sets `app.privileged_erase` because those policies are
 * what admit the statements — against an unmigrated or unprotected `tenants` both
 * would still succeed, and every isolation assertion about `tenants` would pass
 * without proving anything.
 *
 * ---------------------------------------------------------------------------
 * F-191: THE MIGRATOR-OWNS-THE-DATABASE INVARIANT, LOCALLY
 * ---------------------------------------------------------------------------
 *
 * `.github/scripts/provision-test-database.sql` carries three `DO` blocks the Compose
 * file's inline `configs:` block does not. Two of them assert `rolbypassrls OR rolsuper`
 * over both roles, and `assertAppRoleCannotBypassRls()` above already recovers the
 * app-role half locally. The third — `pg_get_userbyid(datdba)`, migrator ownership of
 * `shortkit_test` — had NO local equivalent at all, and F-191 routed that gap here.
 *
 * This is that equivalent. The invariant is load-bearing for the two
 * `ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator` statements: they grant nothing
 * unless the identity running the DDL is the one they name, so a database owned by
 * anyone else leaves `shortkit_app` with no privileges on newly migrated tables. That
 * surfaces as a permission error in the middle of an unrelated test rather than at
 * provisioning time, which is exactly what the CI block exists to convert into a clear
 * failure. Checked as part of this query rather than as its own, because every `psql`
 * here is a process spawn.
 *
 * It does not make the two provisioning files one artifact — they still have to change
 * together, and each says so in its header. It makes the local side FAIL THE SAME WAY
 * when they diverge.
 */
export function assertTenantsIsMigrated(): void {
  if (tenantsChecked) {
    return;
  }

  const [state] = querySql<TenantsTableState>(
    migrationDsn(),
    `SELECT current_user          AS role,
            current_database()    AS database,
            (SELECT pg_get_userbyid(datdba)
               FROM pg_database
              WHERE datname = current_database()) AS database_owner,
            c.relrowsecurity      AS row_security,
            c.relforcerowsecurity AS force_row_security,
            (SELECT count(*)::int
               FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = 'tenants') AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'tenants'`,
  );

  if (state === undefined) {
    throw new Error(
      'Table "tenants" does not exist. The integration suite runs against a MIGRATED ' +
        'database: run `pnpm --filter @shortkit/api db:migrate` with ' +
        'DATABASE_MIGRATION_URL set, then re-run the suite.',
    );
  }

  if (state.database_owner !== state.role) {
    throw new Error(
      `DATABASE_MIGRATION_URL connects as '${state.role}', but '${state.database}' is owned ` +
        `by '${state.database_owner}'. The two ALTER DEFAULT PRIVILEGES statements in ` +
        'docker-compose.test.yml are scoped to the identity shortkit_migrator, so every ' +
        'table migrated by a different owner grants shortkit_app nothing and fails later, ' +
        'inside an unrelated test. Re-create the database with ' +
        '`docker compose -f docker-compose.test.yml down -v && up -d --wait` (F-191).',
    );
  }

  if (!state.row_security || !state.force_row_security || state.policies === 0) {
    throw new Error(
      `Table "tenants" exists but is not protected (row_security=${String(state.row_security)}, ` +
        `force_row_security=${String(state.force_row_security)}, policies=${String(state.policies)}). ` +
        'Every isolation assertion about tenants would pass without proving anything. ' +
        'Re-create the database and run `pnpm --filter @shortkit/api db:migrate`.',
    );
  }

  tenantsChecked = true;
}

/**
 * Rebuilds the two-tenant fixture. Called per test — and by TASK-006's harness before
 * each cross-tenant attempt — so that a write which should have been refused, or a
 * transaction that should have rolled back, cannot carry into the next assertion.
 *
 * `tenants` is not dropped: it is the migrated table, and the two fixture rows are
 * erased and re-seeded through its own policies instead.
 */
export function createRlsFixture(): void {
  assertTenantsIsMigrated();

  execSql(
    migrationDsn(),
    `DROP TABLE IF EXISTS ${RLS_FIXTURE_TABLE};

     ${eraseFixtureTenants}
     ${seedFixtureTenants}

     CREATE TABLE ${RLS_FIXTURE_TABLE} (
       id    uuid PRIMARY KEY,
       ${TENANT_ID_COLUMN_SQL},
       label text NOT NULL
     );

     GRANT SELECT, INSERT, UPDATE, DELETE ON ${RLS_FIXTURE_TABLE} TO :"app_role";

     INSERT INTO ${RLS_FIXTURE_TABLE} (id, tenant_id, label) VALUES
       ('${TENANT_A_ROW_ID}', '${TENANT_A}', '${TENANT_A_LABEL}'),
       ('${TENANT_B_ROW_ID}', '${TENANT_B}', '${TENANT_B_LABEL}');`,
    { variables: { app_role: appRoleName() } },
  );

  execSql(migrationDsn(), tenantScopedPolicies(RLS_FIXTURE_TABLE).statements.join('\n'));
}

/**
 * Takes the fixture back out. `tenants` survives — it is migrated, not fixture-owned —
 * so `db:check-policies` run after the suite still sees the protected table.
 */
export function dropRlsFixture(): void {
  execSql(
    migrationDsn(),
    `DROP TABLE IF EXISTS ${RLS_FIXTURE_TABLE};
     ${eraseFixtureTenants}`,
  );
}
