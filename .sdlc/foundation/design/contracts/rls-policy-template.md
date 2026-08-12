# Contract: RLS policy template, roles, and grants

- **Boundary:** every tenant-scoped table in the database.
- **Normative form:** the SQL below, applied verbatim per table.
- **Produced by:** TASK-005.
- **Consumed by:** TASK-013, 016, 020, 023, 027, 033, 038, 045, 048, 054. Verified by TASK-006, TASK-053, TASK-056.
- **The "Roles" section below has two transcriptions, and both are consumers.**
  `docker-compose.test.yml` (TASK-005) and `docker-compose.yml` (TASK-059). Neither is
  derived from the other and nothing enforces that they agree, so a change to that section
  edits both files in the same commit. ADR-0031 records why they are duplicated rather than
  shared, and which runtime assertions catch the drift that matters.
- **ADRs:** ADR-0003, ADR-0004, ADR-0019.

## Roles

```sql
-- migrator: owns tables, runs DDL, still subject to RLS via FORCE.
CREATE ROLE shortkit_migrator LOGIN PASSWORD :'migrator_password' NOBYPASSRLS;

-- app: runtime. Owns nothing.
CREATE ROLE shortkit_app LOGIN PASSWORD :'app_password' NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO shortkit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shortkit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shortkit_app;
```

| Env var | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `shortkit_app` | the API process, always |
| `DATABASE_MIGRATION_URL` | `shortkit_migrator` | `db:migrate`, `db:generate`, integration test setup |

`shortkit_app` must never hold `BYPASSRLS`, `SUPERUSER`, `CREATEROLE` or table
ownership. Boot asserts the first two.

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
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY <t>_privileged_erase ON <t>
  FOR DELETE
  USING (tenant_id::text = current_setting('app.privileged_erase', true));

CREATE INDEX <t>_tenant_id_idx ON <t> (tenant_id);
```

`current_setting(name, true)` returns NULL when unset. `NULL = uuid` is NULL, which
the policy treats as false, so a query with no context returns zero rows (AC-10) and an
insert with no context fails (AC-9).

`<t>_privileged_erase` is `FOR DELETE` and stays `FOR DELETE`. It grants no read. The
eraser's work list is collected by the caller in an ordinary tenant transaction; see
`tenant-scoped-tables.md`.

## The cascade root: `tenants`

`tenants` carries `id`, not `tenant_id`, so the template does not apply. Four policies,
and **no ordinary `DELETE`**. Revised 2026-08-04 (F-005): a `FOR ALL` policy here let
any authenticated handler delete its own tenant row and cascade-destroy `click_events`
and `audit_entries` while setting no context flag.

```sql
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenants_self_select ON tenants
  FOR SELECT USING (id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenants_self_update ON tenants
  FOR UPDATE USING      (id = current_setting('app.tenant_id', true)::uuid)
             WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);

-- Signup creates exactly the tenant whose context it is already in (ADR-0021).
CREATE POLICY tenants_self_insert ON tenants
  FOR INSERT WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);

-- The only DELETE path on tenants, anywhere in the system.
CREATE POLICY tenants_privileged_erase ON tenants
  FOR DELETE USING (id::text = current_setting('app.privileged_erase', true));
```

## Additional policy: `domains` and `links` only

```sql
CREATE POLICY domains_redirect_read ON domains
  FOR SELECT USING (current_setting('app.redirect_context', true) = 'on');

CREATE POLICY links_redirect_read ON links
  FOR SELECT USING (current_setting('app.redirect_context', true) = 'on');
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
| `tenants_self_select` | `tenants` | `SELECT` | `app.tenant_id` |
| `tenants_self_update` | `tenants` | `UPDATE` | `app.tenant_id` |
| `tenants_self_insert` | `tenants` | `INSERT` | `app.tenant_id` |
| `tenants_privileged_erase` | `tenants` | `DELETE` | `app.privileged_erase` |

## Tables covered

| Table | Tenant-scoped | Redirect read policy | Producing TASK |
|---|---|---|---|
| `tenants` | root (has `id`, not `tenant_id`); own four-policy set, **no ordinary DELETE** | no | 005 |
| `tenant_memberships` | yes | no | 013 |
| `workspaces` | yes | no | 013 |
| `memberships` | yes | no | 016 |
| `invitations` | yes | no | 020 |
| `invitation_workspaces` | yes | no | 020 |
| `domains` | yes | **yes** | 023, extended 038 |
| `links` | yes | **yes** | 023, extended 027 |
| `click_events` | yes | no | 033 |
| `audit_entries` | yes | no | 048 |
| `user`, `session`, `account`, `verification` | **no** (no `tenant_id`, no RLS) | n/a | 009 |

Auth tables are outside this contract by decision (ADR-0003, ADR-0015). Tenant-facing
code reads `user` only through `userDirectory.findByIds()`, which joins
`tenant_memberships`, so RLS on the joined table performs the filtering.

## Invariants a caller may rely on

1. Any `SELECT`, `INSERT`, `UPDATE` or `DELETE` on a table above, issued with no
   context flag set, affects zero rows.
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

## What the implementer must guarantee

- Every statement above is present. `pnpm db:check-policies` asserts, against
  `pg_policies` and `pg_class`, that each table from `tenantScopedTables()` has
  `relrowsecurity`, `relforcerowsecurity`, and exactly the policies the approved set
  permits for it. CI's `integration` job runs it.
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
