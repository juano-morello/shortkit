/**
 * `pnpm --filter @shortkit/api db:check-policies`
 *
 * Contract: design/contracts/rls-policy-template.md
 * ADR: adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md
 * Produced by: TASK-005 (F-122)
 *
 * WHY THIS EXISTS. The role model is allow-by-default on privilege and deny-by-default
 * only if someone remembers the DDL. `shortkit_app` receives SELECT, INSERT, UPDATE and
 * DELETE on every table the migrator creates, forever, through one ALTER DEFAULT
 * PRIVILEGES statement written once. Row-level security is the opposite: two ALTER TABLE
 * lines per table, hand-appended to a migration Drizzle Kit generated without them. So a
 * TASK that adds a table, appends its CREATE POLICY block and forgets ENABLE or FORCE
 * ships a table every authenticated tenant can read and write — with every gate green,
 * because the grants exist so the feature's own queries work, its tests pass, and neither
 * typecheck nor lint reads SQL. This script is the only thing that looks.
 *
 * MINIMUM VIABLE FORM, DELIBERATELY. It asserts from `pg_class` that every table in
 * schema `public` has both `relrowsecurity` and `relforcerowsecurity`, against an
 * explicit exception list. It does NOT yet assert the policy set itself against
 * `pg_policies`, which is what rls-policy-template.md's "What the implementer must
 * guarantee" describes: that needs `tenantScopedTables()`, which is ADR-0019's and
 * TASK-053's and does not exist yet. Landing the weaker check now is the point — the
 * TASK this was written to catch adds `links` three waves before TASK-053 runs.
 *
 * Run it after `db:migrate`, against a database the migrations have been applied to.
 * CI's integration job runs it (TASK-002).
 *
 * Node runs this by stripping the types (`.mts`, no build step), so nothing here may use
 * syntax that needs emit — no enums, no namespaces, no decorators, no parameter properties.
 */
import pg from 'pg';

/**
 * Tables that legitimately carry no row-level security. Every entry needs a reason, and
 * the reason has to be a decision recorded somewhere, not a shrug — an exception list is
 * the obvious place to hide the failure this script exists to catch.
 *
 * A `Map` rather than an object literal (F-146): an object literal's lookup resolves
 * through `Object.prototype`, so `EXEMPT['constructor']` returns the native `Object`
 * function — not `undefined` — and a table named `constructor`, `toString`, `valueOf`,
 * `hasOwnProperty` or `__proto__` (all legal lowercase Postgres identifiers) would read as
 * exempt and pass unchecked. `Map#get` carries no such inheritance.
 *
 * Naming a table here is not enough to exempt it (F-147): `main()` below cross-checks
 * every entry against the system catalogue before honouring it. An entry for a table
 * that carries a `tenant_id` column fails the check instead of skipping it — the name is
 * a claim, not a fact, and the reason recorded next to each entry is exactly that claim:
 * "no tenant_id".
 *
 * That cross-check reads `pg_attribute`, NOT `information_schema.columns` (F-213). See
 * TENANT_ID_COLUMNS below for why the difference decides whether the cross-check works
 * at all.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  // ADR-0003 and ADR-0015 put the Better Auth tables outside the tenancy contract: they
  // carry no tenant_id, so there is no predicate to write. Tenant-facing code reads
  // `user` only through userDirectory.findByIds(), which joins tenant_memberships, and
  // RLS on the joined table does the filtering (rls-policy-template.md, "Tables covered").
  // None of the four exist yet (TASK-009) — the entries are inert until then.
  ['user', 'Better Auth. No tenant_id (ADR-0003, ADR-0015)'],
  ['session', 'Better Auth. No tenant_id (ADR-0003, ADR-0015)'],
  ['account', 'Better Auth. No tenant_id (ADR-0003, ADR-0015)'],
  ['verification', 'Better Auth. No tenant_id (ADR-0003, ADR-0015)'],

  // The fifth table (F-232). Better Auth's `jwt` plugin creates `jwks` to hold the
  // instance's signing key set, which ADR-0013 serves at GET /api/auth/jwks and the
  // guard caches for ten minutes. It is server-instance state, not tenant data: there
  // is no tenant_id and therefore no predicate to write, so it is exempt on the same
  // ground as the four above and the same cross-check verifies the same claim.
  //
  // Recorded here rather than discovered when TASK-009 migrates. RLS is not the control
  // that protects this table's contents — key material is protected by not granting the
  // runtime role access to it at all, which is a TASK-009 decision this list does not
  // make and must not be read as having made.
  ['jwks', 'Better Auth jwt plugin. Instance signing keys, no tenant_id (ADR-0013, F-232)'],
]);

interface TableRow {
  table_name: string;
  row_security: boolean;
  force_row_security: boolean;
}

/**
 * `relkind` 'r' is an ordinary table and 'p' a partitioned one; both take RLS, and a
 * partitioned parent that lacks it is the same defect. Views, sequences and indexes are
 * not tables and cannot carry it.
 */
const TABLES = `
  select c.relname             as table_name,
         c.relrowsecurity      as row_security,
         c.relforcerowsecurity as force_row_security
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
   order by c.relname`;

interface TenantIdColumnRow {
  table_name: string;
}

/**
 * Every table in `public` that actually carries a `tenant_id` column. This is what an
 * exemption is checked against (F-147) — the entry in `EXEMPT` is a claim that the table
 * has no such column, and this query is how that claim gets verified rather than trusted.
 *
 * READS `pg_attribute`, NOT `information_schema.columns` (F-213). The two answer
 * different questions and only one of them is the question being asked here.
 * `information_schema` is privilege-filtered by the SQL standard: it shows a column only
 * where the connected role holds some privilege on it. This check connects as the
 * runtime role deliberately (F-122) — checking as the migrator would prove nothing about
 * the DSN the API actually uses — so a table `shortkit_app` has no grant on returns
 * ZERO ROWS from `information_schema.columns` whether or not it carries a `tenant_id`.
 * Under the old query, `REVOKE ALL ON session FROM shortkit_app` was enough to make a
 * tenant-bearing table with row security off print "confirmed: no tenant_id column" and
 * exit 0. That is the same shape of false green this whole script exists to catch, one
 * level up: "I found nothing" reported as "nothing is there".
 *
 * `pg_attribute` is not privilege-filtered. Every role can read the catalogue, so the
 * absence of a row here means the column does not exist rather than that this connection
 * cannot see it — which is the only reading that makes an exemption safe to honour.
 *
 * `attnum > 0` drops the system columns; `not attisdropped` drops columns removed by
 * `ALTER TABLE ... DROP COLUMN`, whose catalogue rows survive under a mangled name. The
 * `relkind` filter matches TABLES so the two queries describe the same set of relations.
 */
const TENANT_ID_COLUMNS = `
  select c.relname as table_name
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and a.attname = 'tenant_id'
     and a.attnum > 0
     and not a.attisdropped`;

function connectionString(): string {
  const value = process.env.DATABASE_URL;

  if (value === undefined || value.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set. This check reads pg_class as the runtime role, which is ' +
        'the role whose access the policies exist to constrain.',
    );
  }

  return value;
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();

  let rows: TableRow[];
  let tenantIdTables: Set<string>;

  try {
    rows = (await client.query<TableRow>(TABLES)).rows;
    tenantIdTables = new Set(
      (await client.query<TenantIdColumnRow>(TENANT_ID_COLUMNS)).rows.map((r) => r.table_name),
    );
  } finally {
    await client.end();
  }

  // A database with no tables passes "every table has RLS" without having checked
  // anything, which is the same shape of silent green this script exists to prevent.
  if (rows.length === 0) {
    console.error(
      'FAIL: schema public holds no tables. Run `pnpm --filter @shortkit/api db:migrate` ' +
        'first — this check is meaningless against an unmigrated database.',
    );
    process.exitCode = 1;
    return;
  }

  const unprotected: string[] = [];

  for (const row of rows) {
    const exemption = EXEMPT.get(row.table_name);

    if (exemption !== undefined) {
      if (!tenantIdTables.has(row.table_name)) {
        // "no tenant_id in pg_attribute" and not merely "no tenant_id I can see" — the
        // distinction is the whole of F-213, so the line that claims it says which
        // catalogue was read and that the reading does not depend on this role's grants.
        console.log(
          `skip  ${row.table_name} — exempt: ${exemption} (confirmed against pg_attribute, ` +
            'which is not privilege-filtered: no tenant_id column exists)',
        );
        continue;
      }

      // The exemption's premise no longer holds: the table exists and carries a
      // tenant_id column, so it falls through to the same check as every other table
      // instead of being waved through on its name (F-147).
      console.log(
        `      ${row.table_name} — exemption ("${exemption}") does not apply: pg_attribute ` +
          'shows this table has a tenant_id column, so it is checked like any other table.',
      );
    }

    const missing = [
      row.row_security ? undefined : 'ENABLE ROW LEVEL SECURITY',
      row.force_row_security ? undefined : 'FORCE ROW LEVEL SECURITY',
    ].filter((statement): statement is string => statement !== undefined);

    if (missing.length > 0) {
      unprotected.push(`${row.table_name} — missing ${missing.join(' and ')}`);
      continue;
    }

    console.log(`ok    ${row.table_name}`);
  }

  // An EXEMPT entry that never matched a row was never evaluated, and that is a
  // different fact from "evaluated and confirmed no tenant_id" above — the table isn't
  // wrong, it just doesn't exist in this database yet (TASK-009, for all four today).
  // Saying so explicitly keeps that silence from reading as a check that passed.
  const neverExisted = [...EXEMPT.keys()].filter(
    (name) => !rows.some((row) => row.table_name === name),
  );

  if (neverExisted.length > 0) {
    console.log(
      `\n${String(neverExisted.length)} exemption(s) refer to tables that do not exist in ` +
        `schema public yet, so they were not evaluated: ${neverExisted.join(', ')}.`,
    );
  }

  if (unprotected.length > 0) {
    console.error(
      `\nFAIL: ${String(unprotected.length)} table(s) in schema public are readable and ` +
        'writable by any tenant:\n' +
        unprotected.map((line) => `  - ${line}`).join('\n') +
        '\n\nAppend the statements from design/contracts/rls-policy-template.md to the ' +
        'migration that creates the table — tenantScopedPolicies() in src/db/rls.ts emits ' +
        'them — and add a new migration rather than editing an applied one. A table that ' +
        'genuinely carries no tenant_id goes in this script\'s exception list with its reason.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nOK: ${String(rows.length)} table(s) in schema public, all protected or exempt.`);
}

await main();
