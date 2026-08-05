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
 * ⚠ Two things this fixture currently fakes. THE EDITS BELOW ARE
 * sdlc-test-architect'S — `apps/api/test/support/**` is in no TASK's paths and
 * belongs to it under routing rule 0. What TASK-005 owes is the two artifacts the
 * edits depend on, and nothing inside this file (F-077, F-100):
 *   - `tenants` is created here as raw DDL. sdlc-test-architect replaces it with the
 *     real migration (and its own four policies, per rls-policy-template.md) once
 *     TASK-005's migration runner exists; this fixture creates it unprotected because
 *     AC-8..AC-11 are asserted against the tenant-scoped table below, not against
 *     `tenants`.
 *   - TASK-005 produces `docker-compose.test.yml`, which must stand up a database
 *     that already holds the `shortkit_migrator` and `shortkit_app` roles from
 *     rls-policy-template.md, and export `DATABASE_URL` / `DATABASE_MIGRATION_URL`
 *     for them. This fixture reads those two variables and nothing else.
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

export const TENANT_A_LABEL = 'row-owned-by-tenant-a';
export const TENANT_B_LABEL = 'row-owned-by-tenant-b';

const TENANT_A_ROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B_ROW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function dsn(variable: 'DATABASE_URL' | 'DATABASE_MIGRATION_URL'): string {
  const value = process.env[variable];

  if (value === undefined || value === '') {
    throw new Error(
      `${variable} is not set. The integration suite needs a live Postgres: ` +
        'start it with `docker compose -f docker-compose.test.yml up -d` and export ' +
        'DATABASE_URL (shortkit_app) and DATABASE_MIGRATION_URL (shortkit_migrator).',
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
 * Drops and rebuilds the two-tenant fixture. Called per test so that a write that
 * should have been refused, or a transaction that should have rolled back, cannot
 * carry into the next assertion.
 */
export function createRlsFixture(): void {
  const [connection] = querySql<{ role: string }>(appDsn(), 'SELECT current_user AS role');

  if (connection === undefined) {
    throw new Error('DATABASE_URL did not answer `SELECT current_user`.');
  }

  execSql(
    migrationDsn(),
    `DROP TABLE IF EXISTS ${RLS_FIXTURE_TABLE};
     DROP TABLE IF EXISTS tenants;

     CREATE TABLE tenants (
       id         uuid PRIMARY KEY,
       name       text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     );

     CREATE TABLE ${RLS_FIXTURE_TABLE} (
       id    uuid PRIMARY KEY,
       ${TENANT_ID_COLUMN_SQL},
       label text NOT NULL
     );

     GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, ${RLS_FIXTURE_TABLE} TO :"app_role";

     INSERT INTO tenants (id, name) VALUES
       ('${TENANT_A}', 'Tenant A'),
       ('${TENANT_B}', 'Tenant B');

     INSERT INTO ${RLS_FIXTURE_TABLE} (id, tenant_id, label) VALUES
       ('${TENANT_A_ROW_ID}', '${TENANT_A}', '${TENANT_A_LABEL}'),
       ('${TENANT_B_ROW_ID}', '${TENANT_B}', '${TENANT_B_LABEL}');`,
    { variables: { app_role: connection.role } },
  );

  execSql(migrationDsn(), tenantScopedPolicies(RLS_FIXTURE_TABLE).statements.join('\n'));
}

export function dropRlsFixture(): void {
  execSql(
    migrationDsn(),
    `DROP TABLE IF EXISTS ${RLS_FIXTURE_TABLE};
     DROP TABLE IF EXISTS tenants;`,
  );
}
