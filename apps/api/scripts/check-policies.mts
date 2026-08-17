/**
 * `pnpm --filter @shortkit/api db:check-policies`
 *
 * Contract: docs/contracts/rls-policy-template.md
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
 * explicit exception list. It does NOT yet assert the policy SET itself against
 * `pg_policies` — that the approved policies are the only ones present, with the
 * approved bodies — which is what rls-policy-template.md's "What the implementer must
 * guarantee" describes: that needs `tenantScopedTables()`, which is ADR-0019's and
 * TASK-053's and does not exist yet. Landing the weaker check now is the point — the
 * TASK this was written to catch adds `links` three waves before TASK-053 runs.
 *
 * THREE MORE ASSERTIONS SINCE 2026-08-14, and each answers a measured attack rather
 * than a shape someone imagined (ADR-0044, ADR-0049, ADR-0050):
 *
 *   the exemption list is closed at five  — its LENGTH is the whole security argument
 *   every flag reference is wrapped       — over EVERY row of pg_policies, not a list
 *   the grant matrix, in BOTH directions  — app closed on the five, auth closed on the rest
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
  //
  // FIVE ENTRIES, AND ALL FIVE EXIST FROM MIGRATION 0001 (TASK-002). Corrected
  // 2026-08-14 (F-001): this comment read "None of the four exist yet (TASK-009)" while
  // the Map below it already held five — `jwks` was added by F-232 on 2026-08-07 and the
  // count was never moved with it. TASK-009 also left this initiative in the 2026-08-09
  // re-scope; the tables land in TASK-002. An implementer who read this docblock instead
  // of counting the Map would have added a sixth entry for the jwt plugin's table, which
  // already has one, and the `EXEMPT.size !== 5` control below would then be wrong at six.
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

/**
 * THE LIST IS THE WHOLE OF THE SECURITY ARGUMENT, SO ITS LENGTH IS THE CONTROL
 * (ADR-0044). A sixth exemption then arrives as a one-line diff a reviewer sees, with an
 * ADR beside it. Same shape as `ISOLATION_EXCLUSIONS`'s length assertion and for the same
 * reason: naming a real product table in `EXEMPT` is how this script gets defeated, and
 * the `pg_attribute` cross-check below only catches the case where that table happens to
 * carry a column literally named `tenant_id`.
 */
const EXPECTED_EXEMPT_COUNT = 5;

interface PolicyRow {
  table_name: string;
  policy_name: string;
  qual: string | null;
  with_check: string | null;
}

/**
 * EVERY ROW IN SCHEMA `public`, NOT A LIST OF REPAIRED NAMES (ADR-0049). A list only
 * covers what was known when it was written, so a policy nobody thought of fails this
 * rather than being skipped by it.
 */
const POLICIES = `
  select tablename  as table_name,
         policyname as policy_name,
         qual,
         with_check
    from pg_policies
   where schemaname = 'public'
   order by tablename, policyname`;

/**
 * ADR-0050's grant matrix, in BOTH directions. A one-directional matrix proves the auth
 * tables are closed to the app role while saying nothing about the app tables being
 * closed to the auth role, and the second is what stops the new role becoming a way
 * around row-level security.
 *
 * `has_table_privilege` reads the catalogue and is NOT privilege-filtered, so it answers
 * for a role other than the connected one — the same property that made `pg_attribute`
 * the right source in F-213. This script connects as `shortkit_app`.
 *
 * THREE THINGS ABOUT THIS PREDICATE, ALL MEASURED (F-031):
 *
 *   1. A comma-separated privilege list is ANY-of, not ALL-of. With only INSERT granted,
 *      the four-privilege call returns true. So the two directions carrying the security
 *      property are the NEGATIVE ones, where false means "holds none of the four"; the
 *      positive directions read stricter than they are and are availability, not security.
 *   2. `has_table_privilege` ALONE DOES NOT SEE A COLUMN-LEVEL GRANT. With
 *      `GRANT SELECT (email) ON "user" TO shortkit_app` the table-level call returns
 *      false while the read succeeds. That is why the column-level call is OR'd in — one
 *      extra term, closing a grant a reviewer can write by hand.
 *   3. `has_any_column_privilege` REJECTS `DELETE` with `unrecognized privilege type`,
 *      because DELETE is not column-grantable. Its list is the three that are. Do not
 *      copy the four-privilege string into it; it raises rather than returning false.
 */
const GRANT_MATRIX = `
  select c.relname as table_name,
         has_table_privilege('shortkit_app',  c.oid, 'SELECT,INSERT,UPDATE,DELETE')
         or has_any_column_privilege('shortkit_app',  c.oid, 'SELECT,INSERT,UPDATE') as app_dml,
         has_table_privilege('shortkit_auth', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
         or has_any_column_privilege('shortkit_auth', c.oid, 'SELECT,INSERT,UPDATE') as auth_dml
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
   order by c.relname`;

interface GrantRow {
  table_name: string;
  app_dml: boolean;
  auth_dml: boolean;
}

/**
 * ===========================================================================
 * VIEWS AND MATERIALISED VIEWS. THE RELATION KIND EVERY OTHER ASSERTION IN THIS
 * SCRIPT ENUMERATES ITSELF OUT OF (F-109).
 * ===========================================================================
 *
 * MEASURED, as shortkit_migrator against the migrated schema:
 *
 *   CREATE VIEW auth_peek AS SELECT id, user_id, token FROM "session";
 *   GRANT SELECT ON auth_peek TO shortkit_app;
 *
 * shortkit_app then read `sess-b | probe-user-b | REAL-TOKEN-B` — the plaintext session
 * credential migration 0001 revoked it from — and this script printed OK. A view is
 * `relkind 'v'` and a materialised view `'m'`, so `relkind in ('r','p')` excluded the
 * bypass from the grant matrix, from the RLS check and from the behavioural control at
 * the same time. THE ENTIRE ROLE SPLIT IS BYPASSABLE BY A RELATION KIND NONE OF ITS
 * CONTROLS ENUMERATED.
 *
 * Why it works: a view is NOT `security_invoker` by default, so it executes with its
 * OWNER's privileges. The owner is shortkit_migrator, which holds everything. The REVOKE
 * is not merely unchecked — it is bypassed.
 *
 * THE RULE, AND EACH HALF WAS MEASURED RATHER THAN REASONED:
 *
 *   view ('v')              readable by a runtime role => must be security_invoker
 *   materialised view ('m') readable by a runtime role => always a defect
 *
 *   auth_peek     (plain view)             -> returned the token
 *   auth_peek_si  (security_invoker=true)  -> `permission denied for table session` (42501)
 *   auth_peek_mv  (materialised view)      -> returned the token
 *
 * `security_invoker` makes the CALLER's privileges and policies apply, so such a view
 * grants nothing the caller does not already hold and is transparent to both this matrix
 * and row-level security. A materialised view has no such option at all: its rows are
 * computed by its owner at REFRESH time and stored, and no policy is evaluated on read.
 * There is nothing to assert about one except that a runtime role cannot reach it.
 *
 * BOTH ROLES, NOT JUST shortkit_app. A view over `tenant_memberships` granted to
 * shortkit_auth is the same bypass in the other direction — the one ADR-0050 added the
 * second matrix direction for.
 *
 * THE TRUTHY SPELLINGS ARE AN ENUMERATION BECAUSE POSTGRES STORES reloptions VERBATIM.
 * Measured: `true`, `on`, `1` and `yes` are all accepted by the boolean reloption parser
 * and all four survive into `pg_class.reloptions` exactly as written. A spelling this
 * pattern does not know reads as NOT security_invoker and fails the check, which is the
 * direction to be wrong in: a safe view reported unsafe costs a reviewer a minute, and
 * the reverse costs a session token.
 */
const DERIVED_RELATIONS = `
  select c.relname as relation_name,
         c.relkind as relkind,
         coalesce(array_to_string(c.reloptions, ','), '')
           ~* 'security_invoker=(true|on|1|yes)' as security_invoker,
         has_table_privilege('shortkit_app',  c.oid, 'SELECT,INSERT,UPDATE,DELETE')
         or has_any_column_privilege('shortkit_app',  c.oid, 'SELECT,INSERT,UPDATE') as app_dml,
         has_table_privilege('shortkit_auth', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
         or has_any_column_privilege('shortkit_auth', c.oid, 'SELECT,INSERT,UPDATE') as auth_dml
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('v', 'm')
   order by c.relname`;

interface DerivedRelationRow {
  relation_name: string;
  relkind: 'v' | 'm';
  security_invoker: boolean;
  app_dml: boolean;
  auth_dml: boolean;
}

/**
 * The reason this relation is a bypass, or undefined when it is not one.
 *
 * NO POSITIVE DIRECTION IS ASSERTED. The table matrix requires every non-exempt table to
 * be reachable BY shortkit_app, because `ALTER DEFAULT PRIVILEGES` makes that true and an
 * unreachable product table is a broken deployment. Views carry no default privilege, so
 * "nobody granted it" is the normal state and asserting reachability would demand a grant
 * for every view somebody adds.
 */
function derivedRelationBypass(row: DerivedRelationRow): string | undefined {
  const reachedBy = [
    row.app_dml ? 'shortkit_app' : undefined,
    row.auth_dml ? 'shortkit_auth' : undefined,
  ].filter((role): role is string => role !== undefined);

  if (reachedBy.length === 0) {
    return undefined;
  }

  if (row.relkind === 'm') {
    return (
      `${row.relation_name} — materialised view reachable by ${reachedBy.join(' and ')}. ` +
      'Its rows are computed by its owner and stored, so no policy is evaluated when a ' +
      'runtime role reads it and there is no security_invoker option to make one apply.'
    );
  }

  return row.security_invoker
    ? undefined
    : `${row.relation_name} — view reachable by ${reachedBy.join(' and ')} and not ` +
        'security_invoker, so it executes with its OWNER\'s privileges and bypasses both ' +
        'the REVOKE and row-level security.';
}

/** Every reference to a context flag, however it is wrapped or not wrapped. */
const FLAG_REFERENCE = /current_setting\(/g;

/**
 * The one accepted form, as `pg_policies` renders it. `<flag>` is `[a-z_][a-z0-9_.]*`.
 *
 * ASSERTS THE SAFE FORM IS PRESENT RATHER THAN THAT A BLACKLIST OF UNSAFE FORMS IS
 * ABSENT, and that is the decision rather than a proxy for it (F-022). The blacklist form
 * this replaced passed `nullif(current_setting(...), 'x')::uuid` and
 * `(current_setting(...) || '')::uuid`, both of which still raise `22P02` on a warm
 * backend. Row three is the realistic one: a hand-appended migration copies the repaired
 * pattern with a wrong sentinel, this script prints green, and the raise returns on the
 * redirect path or the token mint.
 */
const WRAPPED_FLAG_REFERENCE =
  /NULLIF\(current_setting\('[a-z_][a-z0-9_.]*'::text, true\), ''::text\)/g;

function occurrences(expression: string, pattern: RegExp): number {
  return [...expression.matchAll(pattern)].length;
}

/**
 * A policy whose flag references are not all inside the wrapper, described so the failure
 * names the policy and the expression rather than a count.
 *
 * A SYNTACTIC CONTROL OVER A RENDERED EXPRESSION IS STILL A PROXY, and this is what it
 * does not see: it cannot tell that the wrapper is compared against the right column, and
 * it cannot see a flag reached by any route other than `current_setting` — a function
 * wrapper, a view, a stable helper. `test/tenancy/warm-connection-no-context.int-spec.ts`
 * is the behavioural control that covers those; this one is what runs on every migration.
 */
function unwrappedReferences(row: PolicyRow): string[] {
  const failures: string[] = [];

  for (const [clause, expression] of [
    ['USING', row.qual],
    ['WITH CHECK', row.with_check],
  ] as const) {
    if (expression === null) {
      continue;
    }

    const referenced = occurrences(expression, FLAG_REFERENCE);
    const wrapped = occurrences(expression, WRAPPED_FLAG_REFERENCE);

    if (referenced !== wrapped) {
      failures.push(
        `${row.table_name}.${row.policy_name} ${clause}: ${String(referenced)} flag ` +
          `reference(s), ${String(wrapped)} inside nullif(..., '') — ${expression}`,
      );
    }
  }

  return failures;
}

interface TableRow {
  table_name: string;
  row_security: boolean;
  force_row_security: boolean;
}

/**
 * `relkind` 'r' is an ordinary table and 'p' a partitioned one; both take RLS, and a
 * partitioned parent that lacks it is the same defect. Views, sequences and indexes are
 * not tables and cannot carry it.
 *
 * THIS ONE STAYS AT ('r','p') AND THAT IS A DECISION, NOT THE OVERSIGHT F-109 FOUND.
 * Row-level security is not a property a view HAS: `ALTER VIEW ... ENABLE ROW LEVEL
 * SECURITY` does not exist, `relrowsecurity` is false for every view and materialised
 * view in the catalogue, and adding 'v' here would report each of them "missing ENABLE
 * ROW LEVEL SECURITY" with a remedy nobody can apply — a permanently red check whose
 * cheapest fix is to delete it. A view's danger is WHOSE privileges it runs with, which
 * is what DERIVED_RELATIONS above asserts instead.
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
 *
 * SO IT STAYS AT ('r','p') FOR EXACTLY THAT REASON (F-109). This query exists to verify
 * one claim — that a name in `EXEMPT` really has no `tenant_id` column — against the set
 * `TABLES` iterates. Widening it alone would make the two queries describe different
 * sets, which is the coupling the sentence above already warns about; widening both would
 * mean an exemption could be claimed for a view, and no view is exempt from anything
 * because none is checked here in the first place.
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
  // ADR-0044's length control, and it runs before the connection is even opened: it
  // reads this file rather than the database, and a wrong list makes every verdict
  // below meaningless.
  if (EXEMPT.size !== EXPECTED_EXEMPT_COUNT) {
    console.error(
      `FAIL: the exemption list holds ${String(EXEMPT.size)} entries and is closed at ` +
        `${String(EXPECTED_EXEMPT_COUNT)} (ADR-0044). The list is the whole of the ` +
        'security argument for the tables that carry no row-level security, so its ' +
        'length is the control: naming a real product table here is how this script ' +
        'gets defeated. Adding a sixth needs an ADR, and this line moves with it.',
    );
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();

  let rows: TableRow[];
  let tenantIdTables: Set<string>;
  let policies: PolicyRow[];
  let grants: GrantRow[];
  let derived: DerivedRelationRow[];

  try {
    rows = (await client.query<TableRow>(TABLES)).rows;
    tenantIdTables = new Set(
      (await client.query<TenantIdColumnRow>(TENANT_ID_COLUMNS)).rows.map((r) => r.table_name),
    );
    policies = (await client.query<PolicyRow>(POLICIES)).rows;
    grants = (await client.query<GrantRow>(GRANT_MATRIX)).rows;
    derived = (await client.query<DerivedRelationRow>(DERIVED_RELATIONS)).rows;
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
  // wrong, it just doesn't exist in this database yet. Saying so explicitly keeps that
  // silence from reading as a check that passed.
  //
  // NO COUNT AND NO OWNING TASK IN THIS SENTENCE, DELIBERATELY (F-120). It read
  // "(TASK-009, for all four today)", which was F-001's exact pair of false claims
  // recurring ~200 lines below where F-001 was fixed: all five exempt tables exist from
  // migration 0001, and TASK-009 left this initiative in the 2026-08-09 re-scope. This
  // block is unreachable in a migrated database, so nothing exercises the sentence and
  // no test would have caught it going stale a second time. `EXEMPT` above is the one
  // place that counts, and the length control asserts that count.
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
        '\n\nAppend the statements from docs/contracts/rls-policy-template.md to the ' +
        'migration that creates the table — tenantScopedPolicies() in src/db/rls.ts emits ' +
        'them — and add a new migration rather than editing an applied one. A table that ' +
        'genuinely carries no tenant_id goes in this script\'s exception list with its reason.',
    );
    process.exitCode = 1;
    return;
  }

  // ADR-0049. Over every row of pg_policies in schema `public`.
  const unwrapped = policies.flatMap(unwrappedReferences);

  if (unwrapped.length > 0) {
    console.error(
      `\nFAIL: ${String(unwrapped.length)} policy expression(s) reference a context flag ` +
        "outside `nullif(<flag>, '')`:\n" +
        unwrapped.map((line) => `  - ${line}`).join('\n') +
        '\n\nA transaction-local set_config leaves a session placeholder whose RESET VALUE ' +
        'IS THE EMPTY STRING, not NULL, and pg.Pool issues no reset — so on any backend ' +
        'that has served one tenant transaction the flag reads \'\' rather than NULL. A ' +
        "cast then evaluates ''::uuid and raises 22P02, and a text comparison against '' " +
        'matches whatever row happens to hold that value. Both are fail-open or fail-loud ' +
        'on the connection state the application actually runs in (ADR-0049).\n' +
        'Wrap every reference: nullif(current_setting(\'app.<flag>\', true), \'\'). An AND ' +
        'guard is NOT a substitute and was measured raising anyway — PostgreSQL does not ' +
        'guarantee left-to-right evaluation of AND operands inside a policy predicate. ' +
        'tenantScopedPolicies(), redirectReadPolicy() and membershipLookupPolicy() in ' +
        'src/db/rls.ts emit the wrapped form; a corrected policy is a NEW migration ' +
        'dropping and recreating it, never an edit to an applied one (ADR-0004).',
    );
    process.exitCode = 1;
    return;
  }

  // ADR-0050's grant matrix, in both directions.
  const present = new Set(grants.map((row) => row.table_name));
  const missingExempt = [...EXEMPT.keys()].filter((name) => !present.has(name));

  // A table that does not exist contributes no row, so without this a missing migration
  // reads as a satisfied matrix — "I found nothing" reported as "nothing is wrong",
  // which is the shape this whole script exists to catch.
  if (missingExempt.length > 0) {
    console.error(
      `\nFAIL: ${String(missingExempt.length)} exempt table(s) are absent from schema ` +
        `public: ${missingExempt.join(', ')}. The grant matrix cannot answer for a table ` +
        'that does not exist, and an absent table is indistinguishable from a correctly ' +
        'revoked one. Run `pnpm --filter @shortkit/api db:migrate` first.',
    );
    process.exitCode = 1;
    return;
  }

  const misgranted = grants
    .filter((row) => {
      const exempt = EXEMPT.has(row.table_name);

      // Exempt iff the auth role reaches it and the app role does not; every other
      // table the other way round.
      return exempt ? !row.auth_dml || row.app_dml : !row.app_dml || row.auth_dml;
    })
    .map((row) => {
      const expected = EXEMPT.has(row.table_name)
        ? 'shortkit_auth only (exempt, ADR-0050)'
        : 'shortkit_app only (tenant-scoped)';

      return (
        `${row.table_name} — ${expected}, but shortkit_app=${String(row.app_dml)} ` +
        `shortkit_auth=${String(row.auth_dml)}`
      );
    });

  if (misgranted.length > 0) {
    console.error(
      `\nFAIL: ${String(misgranted.length)} table(s) do not match the grant matrix:\n` +
        misgranted.map((line) => `  - ${line}`).join('\n') +
        '\n\nsession.token is a session credential in plaintext, so shortkit_app holding ' +
        'INSERT on the Better Auth tables is account takeover rather than credential ' +
        'disclosure — measured, ADR-0050. `ALTER DEFAULT PRIVILEGES` grants shortkit_app ' +
        'DML on every table the migrator creates, so the split cannot be a default ' +
        'privilege: it is a REVOKE and a GRANT hand-written in the migration that creates ' +
        'the table, and forgetting it FAILS OPEN. A sixth auth table that nobody revoked ' +
        'lands here rather than passing quietly.\n' +
        'The other direction matters as much: shortkit_auth holding DML on a tenant-scoped ' +
        'table is a role with no policy standing in it, which is a way around row-level ' +
        'security rather than a convenience.',
    );
    process.exitCode = 1;
    return;
  }

  // F-109. The relation kind every assertion above enumerates itself out of.
  const bypasses = derived
    .map(derivedRelationBypass)
    .filter((line): line is string => line !== undefined);

  if (bypasses.length > 0) {
    console.error(
      `\nFAIL: ${String(bypasses.length)} view(s) in schema public reach past the role ` +
        'split:\n' +
        bypasses.map((line) => `  - ${line}`).join('\n') +
        '\n\nMEASURED: a migrator-owned `CREATE VIEW auth_peek AS SELECT id, user_id, ' +
        'token FROM "session"` granted to shortkit_app returns the PLAINTEXT SESSION ' +
        'TOKEN that migration 0001 revoked, because a view executes with its owner\'s ' +
        'privileges unless it is declared security_invoker. The REVOKE is not merely ' +
        'unchecked, it is bypassed.\n' +
        'Either declare the view `WITH (security_invoker = true)`, which makes the ' +
        "caller's own grants and policies apply and gives it nothing it did not already " +
        'have, or revoke the runtime roles on it. A materialised view has no such option ' +
        '— its rows are stored, computed by its owner, and no policy is evaluated on ' +
        'read — so a runtime role must not reach one at all.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nOK: ${String(rows.length)} table(s) in schema public, all protected or exempt; ` +
      `${String(policies.length)} policy expression set(s) wrap every context flag; ` +
      `${String(grants.length)} table(s) match the grant matrix in both directions; ` +
      `of ${String(derived.length)} view(s), none reaches past a runtime role.`,
  );
}

await main();
