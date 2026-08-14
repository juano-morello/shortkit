/**
 * TASK-018 — the wave-0 role split. **No AC, and not exempt** (Juano's ruling,
 * 2026-08-13, against a `test_exempt` marker on the card).
 *
 * ADR-0050 is the decision under test: Better Auth's five tables get their own database
 * role, `shortkit_auth`, and `shortkit_app` is revoked on them. The ADR was written after
 * a security auditor reproduced cross-tenant account takeover from an ordinary
 * `withTenantTransaction` — another tenant's password hash overwritten, a session forged
 * with an attacker-chosen token — and measured it shut behind the split. TASK-002's
 * grant matrix asserts the split a wave later; this file is what asserts that the role it
 * grants to actually exists, and that the guards standing over it are guards rather than
 * guard-shaped comments.
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS, AND ALL FOUR HAVE FAILED HERE BEFORE
 * ---------------------------------------------------------------------------
 *
 * 1. **Three roles come up, at every site that provisions one.** There are three sites and
 *    they are not copies of one file: `.github/scripts/provision-test-database.sql` (CI),
 *    `docker-compose.yml`'s inline init script (dev) and `docker-compose.test.yml`'s
 *    (this suite's own database). Each is run here as itself, against an empty cluster,
 *    and the roles are read back from `pg_roles`.
 * 2. **`shortkit_auth`'s attributes** — `LOGIN`, `NOBYPASSRLS`, not a superuser, owns
 *    nothing. A role with `BYPASSRLS` makes every isolation claim in this system a
 *    tautology; the whole of `test/isolation/` would stay green over it.
 * 3. **The widened `BYPASSRLS` guard fires** on a `shortkit_auth` provisioned with
 *    `BYPASSRLS`. At the two-role form it shipped with (`provision-test-database.sql:57`,
 *    `WHERE rolname IN ('shortkit_app', 'shortkit_migrator')`) it never inspects the new
 *    role at all.
 * 4. **The widened cardinality guard fires** on a two-role database (`:66`, `count(*) <> 2`).
 *
 * ---------------------------------------------------------------------------
 * WHY 3 AND 4 CONSTRUCT A BAD DATABASE INSTEAD OF READING A GOOD ONE
 * ---------------------------------------------------------------------------
 *
 * A guard is a rejection. Asserting that a correctly provisioned database passes the guard
 * is satisfied by a guard that inspects nothing — which is precisely the defect these two
 * tests exist to catch, so that test would be green on the bug. The only assertion that
 * separates the two is: build the database the guard is supposed to refuse, run the guard,
 * and require it to refuse.
 *
 * That needs `CREATEROLE`, and roles are cluster-wide. `DATABASE_URL` and
 * `DATABASE_MIGRATION_URL` connect as `shortkit_app`/`shortkit_migrator`, neither of which
 * may hold `CREATEROLE` (ADR-0003), and a role created on the suite's shared cluster would
 * leak into every other `.int-spec.ts` in the run. So this file owns a scratch cluster,
 * `test/support/scratch-postgres.ts`, created and destroyed here.
 *
 * The guard block is sliced out of the provisioning file and executed. Slicing is the
 * harness; the assertion is on what the block DOES to a controlled database — not on the
 * file's text, which would prove only that the source is the source
 * (`superpowers:test-driven-development`, `writing-good-tests.md`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assertTenantsIsMigrated, migrationDsn } from '../support/rls-fixture';
import { querySql } from '../support/psql';
import type { ScratchPostgres } from '../support/scratch-postgres';
import { startScratchPostgres } from '../support/scratch-postgres';

const REPOSITORY_ROOT = new URL('../../../../', import.meta.url);

const PROVISIONING_SQL = fileURLToPath(
  new URL('.github/scripts/provision-test-database.sql', REPOSITORY_ROOT),
);

/** Long enough for an image pull on a cold machine; a warm start takes ~2s. */
const CONTAINER_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

/**
 * The census every provisioning site has to produce. Hand-written, sorted, and NOT read
 * from any constant the fixtures share — an expectation derived from the code under test
 * passes whatever that code does.
 */
const THREE_ROLES = ['shortkit_app', 'shortkit_auth', 'shortkit_migrator'];

const ROLE_CENSUS = "SELECT rolname FROM pg_roles WHERE rolname LIKE 'shortkit\\_%' ORDER BY rolname";

/**
 * Counts rather than booleans, so a **missing** role reads as `0` on every line instead of
 * as `undefined`/an empty result set. That is the difference between this file failing as
 * an assertion today and failing as a crash: `shortkit_auth` does not exist yet.
 */
const AUTH_ROLE_ATTRIBUTES = `
  SELECT (SELECT count(*)::int FROM pg_roles
           WHERE rolname = 'shortkit_auth')                     AS defined,
         (SELECT count(*)::int FROM pg_roles
           WHERE rolname = 'shortkit_auth' AND rolcanlogin)     AS can_login,
         (SELECT count(*)::int FROM pg_roles
           WHERE rolname = 'shortkit_auth' AND rolbypassrls)    AS bypasses_rls,
         (SELECT count(*)::int FROM pg_roles
           WHERE rolname = 'shortkit_auth' AND rolsuper)        AS superuser`;

interface AuthRoleAttributes extends Record<string, unknown> {
  defined: number;
  can_login: number;
  bypasses_rls: number;
  superuser: number;
}

interface RoleName extends Record<string, unknown> {
  rolname: string;
}

/**
 * The `DO $$ ... END $$;` blocks `provision-test-database.sql` carries, run on their own
 * so they can be pointed at a database this repository did not provision.
 *
 * Every block is taken, not the first, so splitting the checks into two blocks — a
 * reasonable thing for the implementer to do while widening them — keeps working.
 */
function provisioningGuards(): string {
  const blocks = readFileSync(PROVISIONING_SQL, 'utf8').match(/DO \$\$[\s\S]*?END \$\$;/g);

  if (blocks === null) {
    throw new Error(
      `${PROVISIONING_SQL} carries no 'DO $$ ... END $$;' block. The provisioning guards ` +
        'are what these two assertions exercise; if they moved, this harness has to follow ' +
        'them (TASK-018).',
    );
  }

  return blocks.join('\n');
}

/**
 * The init script a Compose file mounts into `/docker-entrypoint-initdb.d`, rendered the
 * way Compose renders it.
 *
 * `docker compose config` is used rather than a YAML parse so the interpolation is
 * Compose's own. It re-escapes `$` as `$$` on the way out (that output is meant to be
 * re-consumable), so the `$$` the file writes for the *host* environment — F-043, F-315,
 * F-316, and the contaminant guard at `check-compose-stack.sh:180` — is unescaped here to
 * recover the bytes the container actually executes. An unescaped `$` would leave the
 * script reading `$$POSTGRES_USER`, which `sh` expands to a PID and psql then refuses; it
 * cannot pass quietly.
 */
function composeInitScript(composeFile: string, configName: string): string {
  let rendered: string;

  try {
    rendered = execFileSync('docker', ['compose', '-f', composeFile, 'config', '--format', 'json'], {
      cwd: fileURLToPath(REPOSITORY_ROOT),
      encoding: 'utf8',
    });
  } catch (error) {
    throw new Error(
      `could not render ${composeFile} with \`docker compose config\`: ` +
        `${error instanceof Error ? error.message : String(error)}. These assertions run the ` +
        'init script that file mounts, so Compose has to be available to the test run.',
    );
  }

  const configs = (JSON.parse(rendered) as { configs?: Record<string, { content?: string }> })
    .configs;
  const content = configs?.[configName]?.content;

  if (content === undefined) {
    throw new Error(
      `${composeFile} declares no config '${configName}'. That block is where the roles are ` +
        'created; renaming it moves TASK-018\'s work somewhere this assertion cannot see.',
    );
  }

  return content.replaceAll('$$', '$');
}

describe('auth role provisioning', () => {
  let scratch: ScratchPostgres;

  beforeAll(() => {
    scratch = startScratchPostgres('auth-role');
  }, CONTAINER_TIMEOUT_MS);

  afterAll(() => {
    scratch.stop();
  });

  beforeEach(() => {
    scratch.reset();
  }, TEST_TIMEOUT_MS);

  describe('every site that provisions a role', () => {
    it(
      "TASK-018 (ADR-0050): CI's provisioning script creates all three roles",
      () => {
        scratch.runSql(readFileSync(PROVISIONING_SQL, 'utf8'));

        const roles = scratch.queryJson<RoleName>(ROLE_CENSUS).map((row) => row.rolname);

        expect(roles).toEqual(THREE_ROLES);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "TASK-018 (ADR-0050): CI's provisioning script gives shortkit_auth LOGIN, NOBYPASSRLS and no superuser",
      () => {
        scratch.runSql(readFileSync(PROVISIONING_SQL, 'utf8'));

        const [attributes] = scratch.queryJson<AuthRoleAttributes>(AUTH_ROLE_ATTRIBUTES);

        expect(attributes).toEqual({
          defined: 1,
          can_login: 1,
          bypasses_rls: 0,
          superuser: 0,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "TASK-018 (ADR-0050): docker-compose.test.yml's init script creates all three roles",
      () => {
        scratch.runSql(composeInitScript('docker-compose.test.yml', 'shortkit_roles_sql'));

        const roles = scratch.queryJson<RoleName>(ROLE_CENSUS).map((row) => row.rolname);

        expect(roles).toEqual(THREE_ROLES);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "TASK-018 (ADR-0050): docker-compose.yml's init script creates all three roles",
      () => {
        /**
         * `SHORTKIT_AUTH_PASSWORD` is passed although nothing consumes it yet: the dev
         * script runs under `set -eu` and interpolates each password through `psql -v`, so
         * a `CREATE ROLE shortkit_auth ... PASSWORD :'auth_password'` whose variable was
         * never plumbed through fails initialisation outright (F-040). The name is fixed
         * by the card; if the implementer picks another, this test is the one edit.
         */
        scratch.runShellScript(composeInitScript('docker-compose.yml', 'shortkit_roles_sh'), {
          POSTGRES_USER: 'postgres',
          SHORTKIT_MIGRATOR_PASSWORD: 'migrator',
          SHORTKIT_APP_PASSWORD: 'app',
          SHORTKIT_AUTH_PASSWORD: 'auth',
        });

        const roles = scratch.queryJson<RoleName>(ROLE_CENSUS).map((row) => row.rolname);

        expect(roles).toEqual(THREE_ROLES);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'TASK-018 (ADR-0050): the database this suite runs against carries all three roles',
      () => {
        const roles = querySql<RoleName>(migrationDsn(), ROLE_CENSUS).map((row) => row.rolname);

        expect(
          roles,
          'the live integration database is provisioned once, on first `up` against an empty ' +
            'data directory: `docker compose -f docker-compose.test.yml down -v` then `up -d ' +
            '--wait` is what re-runs the init script (ADR-0032)',
        ).toEqual(THREE_ROLES);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'TASK-018 (ADR-0050): shortkit_auth owns no relation in the migrated schema',
      () => {
        assertTenantsIsMigrated();

        const [state] = querySql<AuthRoleAttributes & { owned_relations: number }>(
          migrationDsn(),
          `${AUTH_ROLE_ATTRIBUTES},
                  (SELECT count(*)::int
                     FROM pg_class c
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public'
                      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
                      AND pg_get_userbyid(c.relowner) = 'shortkit_auth') AS owned_relations`,
        );

        expect(state).toEqual({
          defined: 1,
          can_login: 1,
          bypasses_rls: 0,
          superuser: 0,
          owned_relations: 0,
        });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("the provisioning script's guards", () => {
    /**
     * Each case builds the cluster by hand and then runs the guards over it. The database
     * `shortkit_test` is created and owned by `shortkit_migrator` in every case, because
     * the third check in the same block asserts that ownership — without it the block
     * raises for a reason that has nothing to do with the role model, and the test would
     * be green on the wrong exception.
     */
    it(
      'TASK-018 (ADR-0050): the provisioning guard refuses a shortkit_auth that holds BYPASSRLS',
      () => {
        scratch.runSql(`
          CREATE ROLE shortkit_migrator LOGIN PASSWORD 'migrator' NOBYPASSRLS;
          CREATE ROLE shortkit_app      LOGIN PASSWORD 'app'      NOBYPASSRLS;
          CREATE ROLE shortkit_auth     LOGIN PASSWORD 'auth'     BYPASSRLS;
          CREATE DATABASE shortkit_test OWNER shortkit_migrator;`);

        expect(
          () => {
            scratch.runSql(provisioningGuards());
          },
          'a shortkit_auth holding BYPASSRLS reads every row of every tenant and no policy ' +
            'applies to it, so the guard has to name it and stop CI',
        ).toThrow(/shortkit_auth/);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'TASK-018 (ADR-0050): the provisioning guard refuses a database that never created shortkit_auth',
      () => {
        scratch.runSql(`
          CREATE ROLE shortkit_migrator LOGIN PASSWORD 'migrator' NOBYPASSRLS;
          CREATE ROLE shortkit_app      LOGIN PASSWORD 'app'      NOBYPASSRLS;
          CREATE DATABASE shortkit_test OWNER shortkit_migrator;`);

        expect(
          () => {
            scratch.runSql(provisioningGuards());
          },
          'the cardinality guard is the one that notices a provisioning site that was never ' +
            'widened, and its message has to name the missing role or the CI failure says ' +
            'nothing actionable',
        ).toThrow(/shortkit_auth/);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'TASK-018 (ADR-0050): control — a guard that fires is visible to this harness, on the shortkit_app case it already covers',
      () => {
        /**
         * Not a TASK-018 assertion: this one passes today and has to keep passing. It is
         * here so the two above cannot be read as "the harness cannot see a raise". If this
         * goes red, the psql-exit-to-thrown-Error path in `scratch-postgres.ts` broke, and
         * the two failures above mean nothing until it is fixed.
         */
        scratch.runSql(`
          CREATE ROLE shortkit_migrator LOGIN PASSWORD 'migrator' NOBYPASSRLS;
          CREATE ROLE shortkit_app      LOGIN PASSWORD 'app'      BYPASSRLS;
          CREATE DATABASE shortkit_test OWNER shortkit_migrator;`);

        expect(() => {
          scratch.runSql(provisioningGuards());
        }).toThrow(/shortkit_app/);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
