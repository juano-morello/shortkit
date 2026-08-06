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
 * ⚠ NOT TYPECHECKED. `apps/api/tsconfig.json`'s `include` covers src, test and the vitest
 * and tsup configs; `scripts/**` is not in it and that file is not TASK-005's to edit
 * (F-133, same shape as `drizzle.config.ts`). Node runs this by stripping the types, so
 * nothing here may use syntax that needs emit — no enums, no namespaces, no decorators,
 * no parameter properties.
 */
import pg from 'pg';

/**
 * Tables that legitimately carry no row-level security. Every entry needs a reason, and
 * the reason has to be a decision recorded somewhere, not a shrug — an exception list is
 * the obvious place to hide the failure this script exists to catch.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  // ADR-0003 and ADR-0015 put the Better Auth tables outside the tenancy contract: they
  // carry no tenant_id, so there is no predicate to write. Tenant-facing code reads
  // `user` only through userDirectory.findByIds(), which joins tenant_memberships, and
  // RLS on the joined table does the filtering (rls-policy-template.md, "Tables covered").
  user: 'Better Auth. No tenant_id (ADR-0003, ADR-0015)',
  session: 'Better Auth. No tenant_id (ADR-0003, ADR-0015)',
  account: 'Better Auth. No tenant_id (ADR-0003, ADR-0015)',
  verification: 'Better Auth. No tenant_id (ADR-0003, ADR-0015)',
};

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

  try {
    rows = (await client.query<TableRow>(TABLES)).rows;
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
    const exemption = EXEMPT[row.table_name];

    if (exemption !== undefined) {
      console.log(`skip  ${row.table_name} — exempt: ${exemption}`);
      continue;
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
