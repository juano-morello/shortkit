# Contract: RLS policy template, roles, and grants

- **Boundary:** every tenant-scoped table in the database.
- **Normative form:** the SQL below, applied verbatim per table.
- **Produced by:** TASK-005.
- **Consumed by:** TASK-013, 016, 020, 023, 027, 033, 038, 045, 048, 054. Verified by TASK-006, TASK-053, TASK-056.
- **The "Roles" section below has ~~two~~ three transcriptions, and all three are consumers.**
  Amended 2026-08-13 (ADR-0050). `docker-compose.test.yml` (TASK-005), `docker-compose.yml`
  (TASK-059) and `.github/scripts/provision-test-database.sql`, which was always a
  transcription and was never listed. None is derived from another and nothing enforces that
  they agree, so a change to that section edits all three in the same commit. ADR-0031 records
  why they are duplicated rather than shared, and which runtime assertions catch the drift
  that matters.

  The provisioning SQL additionally hardcodes the role **set**, not just the names:
  `WHERE rolname IN ('shortkit_app', 'shortkit_migrator')` at `:57`, and a `count(*) <> 2`
  guard at `:66`. Adding a role means editing the guard, and a guard left at two passes while
  describing a two-role model that no longer exists.
- **ADRs:** ADR-0003, ADR-0004, ADR-0019.

## Roles

```sql
-- migrator: owns tables, runs DDL, still subject to RLS via FORCE.
CREATE ROLE shortkit_migrator LOGIN PASSWORD :'migrator_password' NOBYPASSRLS;

-- app: runtime. Owns nothing.
CREATE ROLE shortkit_app LOGIN PASSWORD :'app_password' NOBYPASSRLS;

-- auth: runtime, Better Auth only. Owns nothing. Added 2026-08-13 (ADR-0050).
CREATE ROLE shortkit_auth LOGIN PASSWORD :'auth_password' NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO shortkit_app, shortkit_auth;
ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shortkit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shortkit_app;
```

**`shortkit_auth` gets no default privilege.** The `ALTER DEFAULT PRIVILEGES` above grants
`shortkit_app` DML on every table the migrator creates, forever, so the split cannot be
expressed as a default privilege in either direction. Each auth table carries an explicit
`REVOKE` from `shortkit_app` and an explicit `GRANT` to `shortkit_auth` in the migration that
creates it. Forgetting either fails open; the grant-matrix check in `check-policies.mts` is
what catches it. ADR-0050 carries the DDL and the reasoning.

| Env var | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `shortkit_app` | the API process, always |
| `DATABASE_AUTH_URL` | `shortkit_auth` | the API process's second pool, reached only through `betterAuthDatabase()` (ADR-0050, ADR-0046) |
| `DATABASE_MIGRATION_URL` | `shortkit_migrator` | `db:migrate`, `db:generate`, integration test setup |

**`DATABASE_AUTH_URL` never falls back to `DATABASE_URL`.** Unset fails boot in every
environment, with no `NODE_ENV` consulted. A fallback silently reinstates `shortkit_app` as
the auth role and every gate stays green, which is the failure ADR-0050 exists to close.

| Role | tenant-scoped tables | `user`, `session`, `account`, `verification`, `jwks` |
|---|---|---|
| `shortkit_app` | `SELECT, INSERT, UPDATE, DELETE`, bounded by RLS | **none** |
| `shortkit_auth` | **none** | `SELECT, INSERT, UPDATE, DELETE` |
| `shortkit_migrator` | owns everything, runs DDL, holds no `BYPASSRLS` | same |

Neither `shortkit_app` nor `shortkit_auth` may hold `BYPASSRLS`, `SUPERUSER`, `CREATEROLE` or
table ownership. Boot asserts all three properties for `shortkit_app` through
`assertRuntimeRoleCannotBypassRls` and for `shortkit_auth` through `assertAuthRoleSeparation`,
which also asserts the grant matrix above in both directions.

## Setting a context flag

**`set_config`, never `SET LOCAL`.** PostgreSQL's `SET`/`SET LOCAL` accept no bind
parameters, so `SET LOCAL app.tenant_id = $1` is a syntax error. `set_config(name,
value, true)` is parameterised with identical transaction-local semantics.

```sql
SELECT set_config('app.tenant_id',        $1, true);   -- withTenantTransaction
SELECT set_config('app.redirect_context', 'on', true); -- withRedirectRead
SELECT set_config('app.privileged_erase', $1, true);   -- privilegedTenantEraser
SELECT set_config('statement_timeout',    $1, true);
SELECT set_config('idle_in_transaction_session_timeout', '5000', true);
```

The last two are not context flags. They bound the resources a tenant transaction holds,
and `isolation-coverage.md` clause A4 names them as the only two non-`app.` GUCs any
`set_config` under `apps/api/src` may take. The idle bound was added 2026-08-05 (F-123);
`tenant-context.md` carries it, including the `pg` client error listener it requires.

**No context flag is ever set by string concatenation, in any file.** The value passed
for `app.tenant_id` and `app.privileged_erase` is validated as a uuid before it reaches
the statement. Revised 2026-08-04 (F-007).

**The flag name is an inline SQL string literal. The value is bound.** Added 2026-08-05
(F-118). Write `set_config('app.tenant_id', ${value}, true)`, not
`set_config(${SOME_CONSTANT}, ${value}, true)`. The name is a compile-time constant that
never comes from a request, and `isolation-coverage.md`'s clause A4 asserts that every
`set_config` first argument in `apps/api/src/**` is a quoted literal. An identifier there
is indistinguishable by grep from an identifier holding a concatenated value, so no flag
gets a named TypeScript constant. `rls.ts` writes all three literals inline in its policy
templates too.

**One file sets each flag. `apps/api/src/db/rls.ts` reads all three and sets none.**

| Flag | Set by | Read by |
|---|---|---|
| `app.tenant_id` | `apps/api/src/tenancy/tenant-context.ts` | `<t>_tenant_isolation`, `tenants_self_*` |
| `app.redirect_context` | `apps/api/src/redirect/db/redirect-read.ts` | `<t>_redirect_read` |
| `app.privileged_erase` | `apps/api/src/gdpr/privileged-eraser.ts` | `<t>_privileged_erase`, `tenants_privileged_erase` |

The full four-clause assertion TASK-056 implements is in `isolation-coverage.md`.

## Per-table template

Substitute `<t>` with the table name. Every tenant-scoped table applies all of it, in
the migration that creates the table, in the same commit.

```sql
-- Required for ADR-0019's erasure cascade to reach this table.
-- tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE

ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;

CREATE POLICY <t>_tenant_isolation ON <t>
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY <t>_privileged_erase ON <t>
  FOR DELETE
  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));

CREATE INDEX <t>_tenant_id_idx ON <t> (tenant_id);
```

**Amended 2026-08-13 (ADR-0049, F-003, F-005). The `nullif` is not decoration and the
paragraph this replaces was wrong.**

~~`current_setting(name, true)` returns NULL when unset. `NULL = uuid` is NULL, which the
policy treats as false, so a query with no context returns zero rows (AC-10) and an insert
with no context fails (AC-9).~~

`current_setting(name, true)` returns NULL only while the flag placeholder has **never been
created on that backend**. A transaction-local `set_config` creates it, and its reset value
after COMMIT is the **empty string**. `pg.Pool` returns the connection with no reset query,
so every backend that has served one tenant transaction reads `''` for the rest of its life.
Measured, one session: cold `is null = true`; after one committed transaction-local
`set_config`, `is null = false` and the value is `''`.

Without the `nullif`, `''::uuid` raises `22P02 invalid input syntax for type uuid: ""`, so
the AC-10 read **raises instead of returning zero rows** on every warm connection, and so
does every escape reading the table without setting the flag. With it, both the never-set
and the reset states collapse to NULL, `tenant_id = NULL` is NULL, and the policy treats it
as false: zero rows (AC-10) and a failed insert (AC-9), on a cold backend and a warm one
alike.

**`nullif` and not an `AND` guard.** `current_setting(...) <> '' AND tenant_id = ...::uuid`
was installed verbatim and re-measured on a warm session: it still raises. PostgreSQL does
not guarantee left-to-right evaluation of `AND` operands in a policy predicate. The index on
`tenant_id` is preserved under `nullif`: verified, `Bitmap Index Scan on
<t>_tenant_id_idx`.

**Widened 2026-08-13 (F-021, F-022). ~~No policy expression may apply a cast directly to
`current_setting(...)`.~~ EVERY reference to a context flag in a policy expression is wrapped
in `nullif(..., '')`, cast or not.** The cast is not what makes `''` dangerous; the comparison
is. A raw text comparison against `''` matched a `"user"` row whose `id` is the empty string
and returned another tenant's membership row (measured, F-021), so the two text-comparison
policies above take the wrapper too, even though `''` matched nothing in them.

`pnpm db:check-policies` asserts it over `pg_policies.qual` and `with_check` for every table
in schema `public`, **by requiring the safe form to be present rather than a blacklist to be
absent** (F-022): count occurrences of `current_setting(` and of
`NULLIF(current_setting('<flag>'::text, true), ''::text)`, and require the two counts to be
equal. The earlier blacklist form passed `nullif(current_setting(...), 'x')::uuid` and
`(current_setting(...) || '')::uuid`, both of which still raise.

A syntactic check over a rendered expression is a proxy. It cannot see that the flag is
compared against the right column, and it cannot see a flag reached by a wrapper function or
a view. The behavioural control is the other half: on a connection that has committed one
transaction-local `set_config` of each declared flag, a no-context `SELECT` on every table
returns zero rows rather than raising.

`<t>_privileged_erase` is `FOR DELETE` and stays `FOR DELETE`. It grants no read. The
eraser's work list is collected by the caller in an ordinary tenant transaction; see
`tenant-scoped-tables.md`.

## The cascade root: `tenants`

`tenants` carries `id`, not `tenant_id`, so the template does not apply. Four policies,
and **no ordinary `DELETE`**. Revised 2026-08-04 (F-005): a `FOR ALL` policy here let
any authenticated handler delete its own tenant row and cascade-destroy `click_events`
and `audit_entries` while setting no context flag.

**Migration `0000` is applied and carries the pre-`nullif` form of ~~the three casting
policies~~ all four policies on `tenants`.** Corrected 2026-08-13 (F-029): the count was
three because `tenants_privileged_erase` never casts and never raised, but the control
counts wrappers rather than casts, and the applied form of that policy
(`((id)::text = current_setting('app.privileged_erase'::text, true))`) is rejected by it.
Measured against the control on real `pg_policies.qual` renderings.

ADR-0004 is forward-only, so the repair is a `DROP POLICY` / `CREATE POLICY` pair per policy
in migration `0001` (TASK-002), **four pairs**, never an edit to `0000`. A reviewer seeing
`DROP` in a generated migration is told by ADR-0004 to stop and ask for the ADR; it is
ADR-0049.

**The property `0001` establishes, and it is checkable in one query: no policy in schema
`public` survives `0001` in a form the counting control rejects.** `pnpm db:check-policies`
runs over every row of `pg_policies` in schema `public`, not over a list of repaired names, so
a policy nobody thought of fails it rather than being skipped by it.

~~`<t>_redirect_read` has no applied instance: `domains` and `links` do not exist yet, so the
change is to `redirectReadPolicy()` in `apps/api/src/db/rls.ts` and `0001` carries no
statement for it.~~

*Amended 2026-08-19 (TASK-2-02).* **Both instances are applied.** Migration `0005` creates
`domains` and `links` and hand-appends `redirectReadPolicy('domains')` and
`redirectReadPolicy('links')` beside each table's `tenantScopedPolicies()` block, in the same
migration and the same commit (GC-A as amended for item 2: a policy appended later is a
second F-239 window). The struck sentence stays true of `0001`, which still carries no
statement for the policy: the ADR-0049 repair was to the builder alone and both applied
instances inherited the wrapped form, so `db:check-policies` now counts the wrappers over two
real `pg_policies` rows rather than over none.

**Nothing sets `app.redirect_context` yet.** `withRedirectRead` is TASK-2-06's, so until it
lands the flag is never set, `nullif(current_setting(...), '')` is NULL on every backend, and
both policies admit nothing, which the isolation suite's `domains` and `links` batteries
prove incidentally on every run.

```sql
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;

-- The three casting policies carry the same `nullif` as the per-table template, for the
-- same reason and by the same amendment (ADR-0049, 2026-08-13).
CREATE POLICY tenants_self_select ON tenants
  FOR SELECT USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenants_self_update ON tenants
  FOR UPDATE USING      (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
             WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Signup creates exactly the tenant whose context it is already in (ADR-0021).
CREATE POLICY tenants_self_insert ON tenants
  FOR INSERT WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The only DELETE path on tenants, anywhere in the system.
CREATE POLICY tenants_privileged_erase ON tenants
  FOR DELETE USING (id::text = nullif(current_setting('app.privileged_erase', true), ''));
```

## Additional policy: `domains` and `links` only

```sql
CREATE POLICY domains_redirect_read ON domains
  FOR SELECT USING (nullif(current_setting('app.redirect_context', true), '') = 'on');

CREATE POLICY links_redirect_read ON links
  FOR SELECT USING (nullif(current_setting('app.redirect_context', true), '') = 'on');
```

`FOR SELECT` only. Applied to these two tables only. Set only by `withRedirectRead`,
which additionally issues `SET TRANSACTION READ ONLY`.

## The complete approved policy set

Normative. `isolation-coverage.md`'s `pg_policies` assertion matches every policy on
every tenant-scoped table against this list by name and by `qual` text. **Anything not
on this list fails the suite**, which is what catches a permissive policy added to an
existing table.

| Policy name | Table(s) | `FOR` | Predicate keyed on |
|---|---|---|---|
| `<t>_tenant_isolation` | every tenant-scoped table | `ALL` | `app.tenant_id` |
| `<t>_privileged_erase` | every tenant-scoped table | `DELETE` | `app.privileged_erase` |
| `<t>_redirect_read` | `domains`, `links` only | `SELECT` | `app.redirect_context` |
| `tenant_memberships_membership_lookup` | `tenant_memberships` only | `SELECT` | `app.membership_lookup_user` (ADR-0045) |
| `tenants_self_select` | `tenants` | `SELECT` | `app.tenant_id` |
| `tenants_self_update` | `tenants` | `UPDATE` | `app.tenant_id` |
| `tenants_self_insert` | `tenants` | `INSERT` | `app.tenant_id` |
| `tenants_privileged_erase` | `tenants` | `DELETE` | `app.privileged_erase` |

## Tables covered

| Table | Tenant-scoped | Redirect read policy | Producing TASK |
|---|---|---|---|
| `tenants` | root (has `id`, not `tenant_id`); own four-policy set, **no ordinary DELETE** | no | 005 |
| `tenant_memberships` | yes | no | ~~013~~ 002 (identity-membership; note below) |
| `workspaces` | yes | no | ~~013~~ 011 (identity-membership; note below) |
| `memberships` | yes | no | ~~016~~ 1b-03 (invitations; note below) |
| `invitations` | yes | no | ~~020~~ 1b-03 (invitations; note below) |
| `invitation_workspaces` | yes | no | ~~020~~ 1b-03 (invitations; note below) |
| `domains` | yes | **yes** | ~~023~~ 2-02 (links/redirect; note below), extended 038 |
| `links` | yes | **yes** | ~~023~~ 2-02 (links/redirect; note below) |
| `click_events` | yes | no | ~~033~~ 2-02 (links/redirect; note below) |
| `audit_entries` | yes | no | 048 |
| `user`, `session`, `account`, `verification` | **no** (no `tenant_id`, no RLS) | n/a | 009 |

Auth tables are outside this contract by decision (ADR-0003, ADR-0015). Tenant-facing
code reads `user` only through `userDirectory.findByIds()`, which joins
`tenant_memberships`, so RLS on the joined table performs the filtering.

*Amended 2026-08-18 (TASK-1b-11, ledger 1b-W1-12).* The "Producing TASK" column was written
against the 2026-08-03 plan, whose cards were retired unshipped. The struck ids are that
plan's; the ids beside them are the cards that shipped each table: `tenant_memberships` in
identity-membership TASK-002 (migration `0001`), `workspaces` in TASK-011 (`0002`), and
`memberships`, `invitations` and `invitation_workspaces` together in invitations TASK-1b-03
(`0003`, `tenantScopedPolicies()` for all three, ADR-0062). The four rows below them
(`domains`, `links`, `click_events`, `audit_entries`) are not built and keep the old ids
until their initiatives open.

*Amended 2026-08-19 (TASK-2-02, links and the redirect hot path).* Three of those four are
now built. `domains`, `links` and `click_events` shipped together in migration `0005` under
one card, each with `tenantScopedPolicies()` hand-appended and a
`registerTenantScopedSurfaces()` entry in the same commit (GC-A); `domains` and `links`
additionally carry `redirectReadPolicy()`, the first applied instances of the redirect
escape. The seeded system default domain, one `domains` row owned by a seeded platform
tenant, written by `scripts/seed.mts` and never by the migration (F-236), is ADR-0063's.
`audit_entries` is still unbuilt and keeps `048`.

## Invariants a caller may rely on

1. Any `SELECT`, `INSERT`, `UPDATE` or `DELETE` on a table above, issued with no
   context flag set, affects zero rows, **and returns rather than raising, on a reused
   pooled connection as well as a fresh one.** Amended 2026-08-13 (ADR-0049). This invariant
   was false for every backend that had served one tenant transaction, which is every backend
   within seconds of taking traffic; it holds under the `nullif` form above and not under the
   direct cast this contract carried until then. **It is the invariant to re-measure against a
   warm connection, not a cold one**, and it is the one a test can pass while it is untrue.
2. An `INSERT` or `UPDATE` carrying a `tenant_id` other than `current_setting('app.tenant_id')`
   is rejected by `WITH CHECK` (AC-9, AC-95).
3. `app.redirect_context` grants `SELECT` on exactly two tables and cannot write.
4. `app.privileged_erase` grants `DELETE` for exactly one tenant id and cannot read,
   insert or update.
5. Deleting a `tenants` row removes every row in every table above for that tenant, by
   cascade. Referential actions run with row security bypassed. **This is a deliberate,
   policy-gated bypass**, reachable only through `tenants_privileged_erase`, and it is
   the mechanism AC-90 depends on.
6. **No ordinary tenant code path can delete a `tenants` row.** There is no `FOR
   DELETE` policy on `tenants` keyed on `app.tenant_id`, so an authenticated handler
   issuing `DELETE FROM tenants` affects zero rows.
7. **`shortkit_app` holds no privilege of any kind on `user`, `session`, `account`,
   `verification` or `jwks`, and `shortkit_auth` holds none on any table above.** Added
   2026-08-13 (ADR-0050). This is a grant, not a policy: a statement crossing the boundary
   fails with `permission denied for table <t>` rather than affecting zero rows. Column-level
   grants count as privilege here, and the check that enforces it reads
   `has_any_column_privilege` alongside `has_table_privilege` for exactly that reason.
   The one path across the boundary is `ON DELETE CASCADE` from `"user"` into
   `tenant_memberships`, which runs as a referential action and is covered by invariant 5.

## What the implementer must guarantee

- Every statement above is present. `pnpm db:check-policies` asserts, against
  `pg_policies` and `pg_class`, that each table from `tenantScopedTables()` has
  `relrowsecurity`, `relforcerowsecurity`, and exactly the policies the approved set
  permits for it. CI's `integration` job runs it.
- **The same script asserts the grant matrix**, added 2026-08-13 (ADR-0050): for every table
  in schema `public`, a table is exempt if and only if `shortkit_auth` reaches it and
  `shortkit_app` does not, and every other table is the reverse. Note that a comma-separated
  privilege list in `has_table_privilege` is ANY-of rather than ALL-of, so the two negative
  directions are the ones carrying the security property; and that `has_any_column_privilege`
  rejects `DELETE` as an unrecognised privilege type, because `DELETE` is not
  column-grantable. Both measured.
- Drizzle Kit does not generate policy DDL. The producing TASK appends these statements
  to the generated migration by hand, in the same commit.
- **Never write `SET` or `SET LOCAL` for a context flag. Always `set_config(name, $n,
  true)`.** `SET` takes no bind parameter and the workaround is string interpolation at
  the tenancy boundary.
- The expected `qual` strings for the `pg_policies` assertion are captured from a live
  database after migration, not written by hand: PostgreSQL normalises and reformats
  policy expressions.

## Versioning

Changing the template means a migration touching every table. Adding a policy shape
requires a new ADR superseding ADR-0003, a new row in the approved policy set above,
and a change to the exclusion count assertion in `isolation-coverage.md`.
