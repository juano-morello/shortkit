/**
 * Contract: docs/contracts/rls-policy-template.md
 * ADR: adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md
 * Produced by: TASK-005
 *
 * Drizzle Kit does not generate policy DDL. Each schema file exports its policy SQL
 * built from here, and the producing TASK appends it to the generated migration BY HAND
 * in the same commit. `pnpm db:check-policies` asserts the result against pg_policies.
 *
 * THIS FILE READS ALL FOUR CONTEXT FLAGS AND SETS NONE (F-118). It is the one file
 * besides each flag's setter that may contain the strings `app.tenant_id`,
 * `app.redirect_context`, `app.privileged_erase` and `app.membership_lookup_user`,
 * because the policies that read them are built here. The isolation suite asserts this
 * file contains no set_config call at all, which is what keeps that carve-out from being
 * the hole (docs/contracts/isolation-coverage.md, clause A3).
 *
 * FOUR, NOT THREE, SINCE 2026-08-13 (ADR-0045, F-007). `membershipLookupPolicy()` below
 * put `app.membership_lookup_user` in this file, so an enumeration that stopped at three
 * would have been false in the commit that added it. isolation-coverage.md's flag table
 * was amended for the same row (F-047); this list and that one are the same list.
 *
 * Write each flag name inline in the policy SQL. No exported constant: clause A4 forbids
 * passing an identifier to set_config, so a constant would be inlined at the only call
 * site that matters anyway.
 */
import { sql } from 'drizzle-orm';

import { databaseTransaction } from './client';

export interface PolicySet {
  readonly table: string;
  readonly statements: string[];
}

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
 *
 * `nullif(<flag>, '')` IS THE OTHER HALF, AND ON A POOLED BACKEND IT IS THE COMMON CASE
 * (ADR-0049, F-003). The `true` argument answers the UNSET case. It does not answer the
 * RESET one: a transaction-local `set_config` leaves a session placeholder behind whose
 * reset value is the empty string, not NULL, and `pg.Pool` returns the backend with no
 * reset query. So from the first committed tenant transaction onward every later checkout
 * of that physical connection reads `''`, `''::uuid` is evaluated, and the statement
 * raises `22P02 invalid input syntax for type uuid: ""` — the out-of-context read failing
 * on the only connection state the application actually runs in.
 *
 * `nullif` collapses unset and reset to NULL alike, so the predicate is NULL, the policy
 * treats it as false, and the read returns zero rows on a cold backend and a warm one.
 * An `AND` guard is NOT a substitute and was measured raising anyway: PostgreSQL does not
 * guarantee left-to-right evaluation of `AND` operands inside a policy predicate. Every
 * reference to a context flag in this file is wrapped, cast or not — `''` is dangerous
 * because of the comparison and not because of the cast (F-021), and a rule with
 * exceptions cannot be checked mechanically. `db:check-policies` counts the wrappers.
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
        `  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)\n` +
        `  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);`,
      // Exclusion 2 of exactly 3. FOR DELETE and it stays FOR DELETE: it grants no
      // read, and it names one tenant, so even the eraser cannot cross a boundary.
      //
      // Wrapped for the rule rather than for the bug (ADR-0049, F-029): this one compares
      // as text and `''` matches no tenant id, so it never raised. The counting control
      // reads the catalogue and counts wrappers mechanically, so an unwrapped-but-safe
      // policy is still a policy it rejects.
      `CREATE POLICY ${t}_privileged_erase ON ${t}\n` +
        `  FOR DELETE\n` +
        `  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));`,
      `CREATE INDEX ${t}_tenant_id_idx ON ${t} (tenant_id);`,
    ],
  };
}

/**
 * The redirect read escape. Applied to `domains` and `links` ONLY.
 * FOR SELECT only. Set only by withRedirectRead, which additionally issues
 * SET TRANSACTION READ ONLY.
 *
 * Exclusion 1 of exactly 3 recorded by the SC-1 suite.
 *
 * ~~`domains` and `links` do not exist yet (TASK-023), so this policy has no applied
 * instance and migration `0001` carries no statement for it: the ADR-0049 repair is to
 * this function alone and every table that later applies it inherits the wrapped form.~~
 *
 * AMENDED 2026-08-19 (TASK-2-02). BOTH INSTANCES ARE APPLIED. `apps/api/drizzle/0005_*.sql`
 * creates `domains` and `links` and hand-appends `redirectReadPolicy('domains')` and
 * `redirectReadPolicy('links')` beside each table's `tenantScopedPolicies()` block, in the
 * SAME migration and the same commit — the amended GC-A, because a policy appended in a
 * later migration is a second F-239 window. The ADR-0049 repair the struck paragraph
 * described was to this function alone and both applied instances inherited the wrapped
 * form, which `db:check-policies` now counts over two real `pg_policies` rows rather than
 * over none. `rls-policy-template.md` carried the same sentence and is corrected with it.
 *
 * NOTHING SETS `app.redirect_context` YET. `withRedirectRead` is TASK-2-06's, so until it
 * lands the flag is never set, `nullif(current_setting(...), '')` is NULL on every backend,
 * the predicate is NULL, and both policies admit nothing — which is what the isolation
 * suite's `domains` and `links` batteries incidentally prove on every run.
 */
export function redirectReadPolicy(table: 'domains' | 'links'): PolicySet {
  const t = assertTableName(table);

  return {
    table: t,
    statements: [
      `CREATE POLICY ${t}_redirect_read ON ${t}\n` +
        `  FOR SELECT\n` +
        `  USING (nullif(current_setting('app.redirect_context', true), '') = 'on');`,
    ],
  };
}

/**
 * The token-mint lookup escape. Applied to `tenant_memberships` ONLY.
 * FOR SELECT only. Set only by withMembershipLookup, which additionally issues
 * SET TRANSACTION READ ONLY.
 *
 * Exclusion 3 of exactly 3 (ADR-0045).
 *
 * The table name is a literal rather than a parameter. This policy applies to one table
 * by design and a parameter would invite a second.
 *
 * THE `nullif` IS REQUIRED EVEN THOUGH THIS POLICY NEVER CASTS (F-021). The earlier form
 * compared the flag raw and rested on "no `"user"` row has id `''`" — a data property
 * stated as if it were a constraint, where `user.id` is `text PRIMARY KEY` with no CHECK.
 * With such a row present, measured on a warm backend: a no-flag read returned it, and
 * tenant A's ordinary transaction returned tenant B's full membership row through the
 * permissive OR.
 */
export function membershipLookupPolicy(): PolicySet {
  return {
    table: 'tenant_memberships',
    statements: [
      `CREATE POLICY tenant_memberships_membership_lookup ON tenant_memberships\n` +
        `  FOR SELECT\n` +
        `  USING (user_id = nullif(current_setting('app.membership_lookup_user', true), ''));`,
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
  tables_owned_in_public: number;
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
 *
 * THREE PROPERTIES, NOT TWO (F-129). Table ownership is the third, and ADR-0003 says
 * it is the one that gets missed: a table's owner is exempt from its own policies
 * wherever FORCE ROW LEVEL SECURITY is absent, and that line is hand-appended per
 * table by whoever writes the migration. The count is of tables `current_user` owns,
 * not of tables that exist — a check on the latter would refuse the correctly
 * provisioned database, where shortkit_app owns nothing and shortkit_migrator owns
 * everything.
 *
 * One limit worth stating so this is not read as stronger than it is: `rolbypassrls`
 * is a role attribute, and attributes are not inherited, so a role that is a MEMBER
 * of a BYPASSRLS role reads false here. That is only reachable through `SET ROLE`,
 * which nothing in this application issues.
 */
export async function assertRuntimeRoleCannotBypassRls(): Promise<void> {
  const privileges = await databaseTransaction(async (tx) => {
    const result = await tx.execute<RuntimeRolePrivileges>(
      sql`select current_user                           as role,
                 current_setting('is_superuser') = 'on' as superuser,
                 rolbypassrls                           as bypassrls,
                 (select count(*)::int
                    from pg_class c
                    join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public'
                     and c.relkind = 'r'
                     and c.relowner = current_user::regrole) as tables_owned_in_public
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

  if (privileges.tables_owned_in_public > 0) {
    throw new Error(
      `DATABASE_URL connects as '${privileges.role}', which owns ` +
        `${String(privileges.tables_owned_in_public)} table(s) in schema public. A table's ` +
        'owner is exempt from its policies unless that table carries FORCE ROW LEVEL ' +
        'SECURITY, which is appended per table by hand. Connect as shortkit_app, which ' +
        'owns nothing, and run migrations as shortkit_migrator (ADR-0003).',
    );
  }
}
