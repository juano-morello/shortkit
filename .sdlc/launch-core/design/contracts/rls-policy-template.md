# Contract: RLS policy template, roles, and grants

- **Boundary:** every tenant-scoped table in the database.
- **Normative form:** the SQL below, applied verbatim per table.
- **Produced by:** TASK-005.
- **Consumed by:** TASK-013, 016, 020, 023, 027, 033, 038, 045, 048, 054. Verified by TASK-006, TASK-053, TASK-056.
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

## Per-table template

Substitute `<t>` with the table name. Every tenant-scoped table applies all of it, in
the migration that creates the table, in the same commit.

```sql
-- Column and cascade root. Required for ADR-0019's erasure to reach this table.
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

## Additional policy: `domains` and `links` only

```sql
CREATE POLICY domains_redirect_read ON domains
  FOR SELECT USING (current_setting('app.redirect_context', true) = 'on');

CREATE POLICY links_redirect_read ON links
  FOR SELECT USING (current_setting('app.redirect_context', true) = 'on');
```

`FOR SELECT` only. Applied to these two tables only. Set only by `withRedirectRead`,
which additionally issues `SET TRANSACTION READ ONLY`.

## Tables covered

| Table | Tenant-scoped | Redirect read policy | Producing TASK |
|---|---|---|---|
| `tenants` | root (has `id`, not `tenant_id`); own policy `id = current_setting(...)` | no | 005 |
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
   cascade. Referential actions run with row security bypassed.

## What the implementer must guarantee

- Every one of the six statements is present. `pnpm db:check-policies` asserts, against
  `pg_policies` and `pg_class`, that each table from `tenantScopedTables()` has
  `relrowsecurity`, `relforcerowsecurity`, and both named policies. CI's `integration`
  job runs it.
- Drizzle Kit does not generate policy DDL. The producing TASK appends these statements
  to the generated migration by hand, in the same commit.
- Never write `SET` in place of `SET LOCAL`.

## Versioning

Changing the template means a migration touching every table. Adding a policy shape
requires a new ADR superseding ADR-0003 and a change to the exclusion count assertion
in `isolation-coverage.md`.
