/**
 * `pnpm --filter @shortkit/api db:seed`, and `docker compose`'s `seed` service.
 *
 * Contract: design/contracts/rls-policy-template.md, design/contracts/tenant-context.md
 * ADR: adr-0034-seed-contract.md (normative), adr-0033-compose-migrate-and-seed-services.md
 * Produced by: TASK-059
 *
 * ===========================================================================
 * HOW LITTLE THIS COVERS, STATED FIRST BECAUSE IT DECIDES WHAT A GREEN RUN MEANS
 * ===========================================================================
 *
 * TODAY THIS SEED COVERS ONE TABLE, BECAUSE THE SCHEMA HAS ONE TABLE.
 * `apps/api/drizzle/0000_odd_betty_ross.sql` creates `tenants` and nothing else. Links,
 * users, auth and workspaces left with EPIC-002 through EPIC-006 in the 2026-08-09
 * re-scope, and `rls_fixture_rows` is built at runtime by the integration fixture and is
 * in no migration.
 *
 * So a passing `docker compose up` proves that one demo tenant exists and that
 * `shortkit_app` could write it. It proves nothing about any table this repository does
 * not yet have. A file called `seed.mts` reads as "the demo data" whatever it contains,
 * which is why the boundary is a PRINTED LINE computed from the live catalogue rather
 * than this paragraph: see `NOT SEEDED` below. `apps/api/test/isolation/coverage.ts` is
 * the worked example this follows.
 *
 * ===========================================================================
 * IT IS ALSO A GRANT CHECK, AND THAT IS WHY IT CONNECTS AS `shortkit_app`
 * ===========================================================================
 *
 * `ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public` grants
 * `shortkit_app` its DML on tables THE IDENTITY `shortkit_migrator` CREATES. A stack that
 * migrated as any other role produces tables `shortkit_app` cannot touch, the API boots
 * fine, and nothing is wrong until a query runs in whatever feature happens to run it.
 *
 * EXCEPTION, FROM TASK-002's migration `0001` (ADR-0050), not yet applied at wave 0:
 * `user`, `session`, `account`, `verification` and `jwks` will also be created by
 * `shortkit_migrator`, but will be immediately `REVOKE`d from `shortkit_app` and
 * `GRANT`ed to `shortkit_auth` instead. This seed never connects as `shortkit_auth` and
 * writes none of those five tables, so the grant check this file performs will keep
 * covering everything it seeds and nothing on the auth role's side once that migration
 * lands.
 *
 * Connecting as the runtime role and writing turns a bad migration identity into
 * `permission denied for table tenants` here, before the API starts, with the `seed`
 * service named in the `up` output (ADR-0033). Rule 6 below is what makes the check real
 * rather than credited.
 *
 * Node runs this by stripping the types (`.mts`, no build step), so nothing here may use
 * syntax that needs emit — no enums, no namespaces, no decorators, no parameter properties.
 */
import pg from 'pg';
import type { PoolClient } from 'pg';

/**
 * The one tenant everything else in this repository's seed data hangs from.
 *
 * FROZEN (ADR-0034). It is in volumes on developer machines and this seed has no delete
 * path, so changing it means two demo tenants and a manual cleanup. Version nibble 4 and
 * variant nibble 8, so it passes any uuid validation the code applies, and it is
 * obviously synthetic to a human reading a row.
 */
export const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_TENANT_NAME = 'Demo Agency';

/** The role and database this seed will write to, and the only ones (rule 6). */
const REQUIRED_ROLE = 'shortkit_app';
const REQUIRED_DATABASE = 'shortkit';

export interface SeedUnit {
  /** The table this unit writes. Must exist in schema `public` after migrations. */
  readonly table: string;
  /** One line: why these rows exist. Printed by the coverage report. */
  readonly purpose: string;
  /**
   * Idempotent insert. Runs inside a transaction that has already issued
   * `set_config('app.tenant_id', DEMO_TENANT_ID, true)`, as `shortkit_app`.
   * Returns the number of rows it actually inserted, which is 0 on a re-run.
   */
  run(client: PoolClient): Promise<number>;
}

/**
 * Every unit, in dependency order. A TASK adding a table appends exactly one entry and
 * changes nothing else, the way a schema TASK appends one `registerTenantScopedSurfaces()`
 * call in `registrations.ts`. That array is the whole growth story.
 *
 * FIVE RULES BIND WHAT A UNIT MAY DO (ADR-0034), and the sixth binds the harness:
 *
 *  1. Idempotent BY CONSTRUCTION, not by checking first. Fixed primary key declared as a
 *     constant in this file, and the insert ends `ON CONFLICT (<pk>) DO NOTHING`. Never
 *     `DO UPDATE`: that clobbers a value a developer changed by hand, which is the same
 *     destruction TRUNCATE performs, arriving one row at a time.
 *  2. It may run against a non-empty database and it runs on every `up`. There is no
 *     "already seeded" marker — that would be state about state, and the database is
 *     already the state. Running always is what makes rule 1 load-bearing.
 *  3. It never deletes and never updates. No TRUNCATE, no DELETE, no ALTER. The reset is
 *     `docker compose down -v` and it is the only one.
 *  4. Every unit performs a real write on its first run. A unit that no-ops is not
 *     coverage, and it silently removes the grant check this file exists to be.
 *  5. All units run inside ONE transaction that set `app.tenant_id` before any of them,
 *     so a failing unit leaves the database exactly as it found it.
 */
export const SEED_UNITS: readonly SeedUnit[] = [
  {
    table: 'tenants',
    purpose: 'the tenant every later unit hangs its rows from',
    async run(client: PoolClient): Promise<number> {
      // `tenants` carries FORCE ROW LEVEL SECURITY and `tenants_self_insert` admits only
      // a row whose id equals current_setting('app.tenant_id'), so this insert is
      // policy-correct only because the harness set the flag first. No role in this
      // stack can insert a tenant without it — the seed is written against that rather
      // than around it.
      const result = await client.query(
        'insert into tenants (id, name) values ($1, $2) on conflict (id) do nothing',
        [DEMO_TENANT_ID, DEMO_TENANT_NAME],
      );

      return result.rowCount ?? 0;
    },
  },
];

interface TableRow {
  table_name: string;
}

/**
 * Every table in schema `public`, asked of the database rather than listed here.
 *
 * READS `pg_class`, NOT `information_schema.tables` (F-213). `information_schema` is
 * privilege-filtered by the SQL standard: it shows a relation only where the connected
 * role holds some privilege on it. This connection is `shortkit_app` deliberately — that
 * is the whole point of the file — so a table it has no grant on would be reported as
 * "not there" when the truth is "I cannot see it", and the coverage line would claim
 * completeness over a schema it could not read. `pg_class` is not privilege-filtered.
 *
 * `relkind` 'r' is an ordinary table and 'p' a partitioned one. Drizzle's bookkeeping
 * table lives in schema `drizzle`, not `public`, so it does not appear here; if that ever
 * changes it gets an explicit exclusion with the reason beside it.
 */
const TABLES = `
  select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
   order by c.relname`;

interface ConnectionRow {
  current_user: string;
  current_database: string;
}

function connectionString(): string {
  const value = process.env.DATABASE_URL;

  if (value === undefined || value.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set. The seed connects as shortkit_app, the runtime role, ' +
        'because writing as that role is what proves the migration ran as ' +
        'shortkit_migrator. Never DATABASE_MIGRATION_URL.',
    );
  }

  return value;
}

/**
 * Rule 6: the seed names its own connection and refuses one it does not recognise, before
 * it writes anything. Two separate reasons, and both are failures it would otherwise pass
 * through in silence.
 *
 * THE ROLE HALF IS WHAT MAKES THE GRANT CHECK REAL. Nothing else in the running system
 * asserts that this script connected as the role it is credited with, and `DATABASE_URL`
 * is assembled by string interpolation in `docker-compose.yml`, so `shortkit_app` to
 * `shortkit_migrator` is a one-token edit. The migrator owns the tables and holds every
 * privilege, and FORCE ROW LEVEL SECURITY keeps the RLS half passing too, so both of this
 * file's silent jobs would keep reporting success while checking nothing.
 *
 * THE DATABASE HALF IS DELIBERATELY NOT A LOOPBACK REFUSAL. `db:seed` exists so the seed
 * can run outside compose, and it writes. `docker-compose.test.yml`'s header documents a
 * workflow whose first step exports a `DATABASE_URL` pointing at `shortkit_test`; from
 * that shell, `pnpm db:seed` would write the demo tenant into the integration suite's
 * database. A host-based refusal would be wrong in both directions — it permits that
 * case, because the test database is on 127.0.0.1, and rejects the legitimate one,
 * because this script's primary invocation is inside the `seed` container where the host
 * is the service name `postgres`. The database NAME separates them exactly, wherever the
 * script runs from.
 *
 * THE RESIDUAL: neither discriminator separates this stack from a future production
 * database, which would plausibly also be named `shortkit` and reached as `shortkit_app`.
 * Nothing needs to today — ADR-0030 records that there is no production database — and
 * whoever provisions one decides what guard replaces this.
 */
async function refuseUnrecognisedConnection(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<ConnectionRow>(
    'select current_user, current_database()',
  );
  const connection = rows[0];

  if (connection === undefined) {
    console.error('seed: `select current_user, current_database()` returned no row.');
    return true;
  }

  // First, and before anything is written: a coverage report from the wrong role over the
  // wrong database is worse than no report at all.
  console.log(`seed: connected as ${connection.current_user} to ${connection.current_database}`);

  if (connection.current_user !== REQUIRED_ROLE) {
    console.error(
      `seed: REFUSING. This seed writes as ${REQUIRED_ROLE} and nothing else: writing as ` +
        `the migrator would exercise the owner's privileges and prove nothing about the ` +
        `grants the API depends on (ADR-0033). Point DATABASE_URL at ${REQUIRED_ROLE}.`,
    );
    return true;
  }

  if (connection.current_database !== REQUIRED_DATABASE) {
    console.error(
      `seed: REFUSING. This seed writes to the database "${REQUIRED_DATABASE}" and nothing ` +
        `else. "${connection.current_database}" is not it — the integration suite's ` +
        'shortkit_test is the likely mistake, and this demo tenant does not belong in it.',
    );
    return true;
  }

  return false;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: connectionString() });
  const inserted = new Map<string, number>();

  try {
    const client = await pool.connect();

    try {
      if (await refuseUnrecognisedConnection(client)) {
        process.exitCode = 1;
        return;
      }

      // One transaction for every unit (rule 5), so a failing unit leaves the database
      // exactly as it found it.
      await client.query('begin');

      let present: string[];

      try {
        // The flag name is an inline SQL string literal and the value is bound
        // (rls-policy-template.md, F-118). `set_config`, never `SET LOCAL`: SET accepts
        // no bind parameters. The third argument is transaction-local, so the flag is
        // gone at commit. Set once, here, so a later unit inserting into a
        // tenant-scoped table gets a policy-correct insert without doing anything.
        await client.query("select set_config('app.tenant_id', $1, true)", [DEMO_TENANT_ID]);

        for (const unit of SEED_UNITS) {
          inserted.set(unit.table, await unit.run(client));
        }

        present = (await client.query<TableRow>(TABLES)).rows.map((row) => row.table_name);

        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }

      report(present, inserted);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * The coverage boundary, computed as a diff against the live catalogue rather than
 * against a list in this file — a hardcoded list is exactly what goes stale, and a table
 * nobody added to it would report as covered.
 *
 * `NOT SEEDED` is the load-bearing literal, and it is a WARNING: the exit code stays 0
 * when the set is non-empty. Failing instead would make the cheapest green fix an empty
 * unit that covers nothing while reporting coverage, which is the defect this whole file
 * is shaped against. The cost accepted is that `docker compose up` prints a lot of lines
 * and this one competes with all of them.
 */
function report(present: readonly string[], inserted: ReadonlyMap<string, number>): void {
  const covered = SEED_UNITS.filter((unit) => present.includes(unit.table));
  const uncovered = present.filter(
    (table) => !SEED_UNITS.some((unit) => unit.table === table),
  );

  console.log(
    `seed: covered ${String(covered.length)} of ${String(present.length)} tables in schema public`,
  );

  for (const unit of SEED_UNITS) {
    const rows = inserted.get(unit.table) ?? 0;
    console.log(
      `seed:   ${unit.table}  ${String(rows)} row${rows === 1 ? '' : 's'} inserted  ${unit.purpose}`,
    );
  }

  console.log(
    `seed: NOT SEEDED (${String(uncovered.length)}): ${uncovered.length === 0 ? 'none' : uncovered.join(', ')}`,
  );
  console.log(
    'seed: this seed covers the tables listed above and nothing else. It is not a demo dataset.',
  );
}

await main();
