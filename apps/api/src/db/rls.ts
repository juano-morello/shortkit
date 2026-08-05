/**
 * Contract: design/contracts/rls-policy-template.md
 * ADR: adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md
 * Produced by: TASK-005
 *
 * Drizzle Kit does not generate policy DDL. Each schema file exports its policy SQL
 * built from here, and the producing TASK appends it to the generated migration BY HAND
 * in the same commit. `pnpm db:check-policies` asserts the result against pg_policies.
 *
 * This file holds the literal names of the three context flags. ADR-0003 asserts each
 * one appears in exactly one non-test source file, and the policies that READ a flag
 * live here, so the code that SETS it imports the name from here rather than repeating
 * it — see TENANT_ID_SETTING below.
 */
import { sql } from 'drizzle-orm';

import { databaseTransaction } from './client';

export interface PolicySet {
  readonly table: string;
  readonly statements: string[];
}

/**
 * The transaction-local setting every tenant_isolation policy reads and
 * `withTenantTransaction` sets. Imported by apps/api/src/tenancy/tenant-context.ts,
 * which is the only code that may set it.
 */
export const TENANT_ID_SETTING = 'app.tenant_id';

/**
 * Postgres folds an unquoted identifier to lower case and these names are also
 * substituted into policy and index names, so anything outside this shape either
 * produces DDL that does not match what `pg_policies` is later asserted against, or
 * carries SQL into a statement that cannot bind it as a parameter. Table names all
 * come from this repository's own schema files, so this only ever fires on a typo.
 */
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

function assertTableName(table: string): string {
  if (!SAFE_TABLE_NAME.test(table)) {
    throw new Error(`Not a usable table name for policy DDL: ${JSON.stringify(table)}`);
  }

  return table;
}

/**
 * The four statements every tenant-scoped table applies, plus the tenant_id index.
 *
 * FORCE ROW LEVEL SECURITY matters: without it the table owner bypasses every policy,
 * producing an RLS configuration that looks correct and enforces nothing.
 *
 * `current_setting(name, true)` — the second argument is load-bearing. Without it an
 * unset flag raises rather than returning NULL, and the AC-10 read outside any tenant
 * context would fail with an error instead of returning zero rows.
 */
export function tenantScopedPolicies(table: string): PolicySet {
  const t = assertTableName(table);

  return {
    table: t,
    statements: [
      `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
      `ALTER TABLE ${t} FORCE  ROW LEVEL SECURITY;`,
      // AC-8 and AC-9. USING filters what a statement may see, WITH CHECK what it may
      // write: without the second half an insert carrying another tenant's tenant_id
      // succeeds, which is exactly what AC-9 asserts it does not.
      `CREATE POLICY ${t}_tenant_isolation ON ${t}\n` +
        `  FOR ALL\n` +
        `  USING      (tenant_id = current_setting('${TENANT_ID_SETTING}', true)::uuid)\n` +
        `  WITH CHECK (tenant_id = current_setting('${TENANT_ID_SETTING}', true)::uuid);`,
      // Exclusion 2 of exactly 2. FOR DELETE and it stays FOR DELETE: it grants no
      // read, and it names one tenant, so even the eraser cannot cross a boundary.
      `CREATE POLICY ${t}_privileged_erase ON ${t}\n` +
        `  FOR DELETE\n` +
        `  USING (tenant_id::text = current_setting('app.privileged_erase', true));`,
      `CREATE INDEX ${t}_tenant_id_idx ON ${t} (tenant_id);`,
    ],
  };
}

/**
 * The redirect read escape. Applied to `domains` and `links` ONLY.
 * FOR SELECT only. Set only by withRedirectRead, which additionally issues
 * SET TRANSACTION READ ONLY.
 *
 * Exclusion 1 of exactly 2 recorded by the SC-1 suite.
 */
export function redirectReadPolicy(table: 'domains' | 'links'): PolicySet {
  const t = assertTableName(table);

  return {
    table: t,
    statements: [
      `CREATE POLICY ${t}_redirect_read ON ${t}\n` +
        `  FOR SELECT\n` +
        `  USING (current_setting('app.redirect_context', true) = 'on');`,
    ],
  };
}

/** Column definition every tenant-scoped table declares. The cascade is load-bearing for AC-90. */
export const TENANT_ID_COLUMN_SQL =
  'tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE';

interface RuntimeRolePrivileges extends Record<string, unknown> {
  role: string;
  superuser: boolean;
  bypassrls: boolean;
}

/**
 * Boot-time guard. Exits non-zero when the runtime role could bypass RLS.
 * TASK-005 calls this before the app accepts traffic.
 *
 * A role holding BYPASSRLS or SUPERUSER is exempt from every policy in this file, so
 * the whole isolation claim becomes decorative while every test that runs against a
 * correctly provisioned database still passes. Nothing in the application can detect
 * that at runtime; this check is the only thing that does. It throws rather than
 * calling process.exit so the caller can close what it already opened — main.ts's
 * bootstrap handler exits non-zero (ADR-0003).
 */
export async function assertRuntimeRoleCannotBypassRls(): Promise<void> {
  const privileges = await databaseTransaction(async (tx) => {
    const result = await tx.execute<RuntimeRolePrivileges>(
      sql`select current_user                           as role,
                 current_setting('is_superuser') = 'on' as superuser,
                 rolbypassrls                           as bypassrls
            from pg_roles
           where rolname = current_user`,
    );

    return result.rows[0];
  });

  if (privileges === undefined) {
    throw new Error('DATABASE_URL connected as a role that pg_roles does not list.');
  }

  if (privileges.superuser || privileges.bypassrls) {
    throw new Error(
      `DATABASE_URL connects as '${privileges.role}', which is exempt from row-level ` +
        `security (superuser=${String(privileges.superuser)}, ` +
        `bypassrls=${String(privileges.bypassrls)}). Every tenant isolation policy would ` +
        'be ignored. Connect as shortkit_app (ADR-0003).',
    );
  }
}
