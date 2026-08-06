# Row-level security

Postgres enforces tenant isolation. Application code scopes its queries too, but the
database is what makes a missing `where` clause return nothing instead of returning
another agency's links.

Sources: ADR-0002 (tenant context binding), ADR-0003 (policy template and roles), and
the contracts `design/contracts/tenant-context.md` and
`design/contracts/rls-policy-template.md`. This document is the working version — how
the pieces fit and what you have to do when you add a table.

## The two roles

| Role | Env var | Owns tables | What it does |
| --- | --- | --- | --- |
| `shortkit_migrator` | `DATABASE_MIGRATION_URL` | yes | DDL: `db:generate`, `db:migrate`, integration-test setup |
| `shortkit_app` | `DATABASE_URL` | **nothing** | every statement the running API issues |

Neither role holds `BYPASSRLS` or `SUPERUSER`. `shortkit_app` owns no table, and that
matters as much as the attributes: a table's owner is exempt from its own policies
unless the table carries `FORCE ROW LEVEL SECURITY`, so an owning runtime role turns
every policy below into decoration.

`shortkit_app` gets its DML through one statement, written once:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shortkit_app;
```

Every table the migrator creates from then on is readable and writable by the runtime
role automatically. Row-level security is not automatic. That asymmetry is the reason
`pnpm db:check-policies` exists — see below.

`docker-compose.test.yml` provisions both roles for local work. Its role and grant
shape is the reusable part; its passwords, its lack of TLS and its tmpfs storage are
not. The header on that file says so at more length.

## How a request reaches a row

Every tenant-scoped read and write runs inside `withTenantTransaction`
(`apps/api/src/tenancy/tenant-context.ts`). It opens one transaction and issues three
statements before your code runs:

```sql
BEGIN;
SELECT set_config('statement_timeout',                   $1, true);
SELECT set_config('idle_in_transaction_session_timeout', $2, true);
SELECT set_config('app.tenant_id',                       $3, true);
```

The third argument `true` makes each setting transaction-local, so it disappears at
`COMMIT` or `ROLLBACK` and the connection carries no residue back to the pool. That is
the whole isolation mechanism on the application side.

Four things about it are worth knowing before you write code against it.

**`set_config`, never `SET LOCAL`.** `SET` accepts no bind parameter, so
`SET LOCAL app.tenant_id = $1` is a syntax error and the only way to write it is string
interpolation — at the one statement all of RLS depends on. `set_config(name, value,
true)` has identical semantics and binds the value.

**The flag name is written inline; only the value is bound.** Write
`set_config('app.tenant_id', ${value}, true)`. No named TypeScript constant: an
identifier in that position cannot be told apart, by the grep the isolation suite runs,
from an identifier holding a concatenated value.

**The idle bound is five seconds and is not tunable.** `statement_timeout` bounds a
running query; nothing bounded the gap *between* two queries, which is what a
third-party call inside `fn` is. ADR-0002 bans that call because the transaction holds a
pooled connection for its whole lifetime, and until now the ban was a rule with no
mechanism behind it. When the bound fires, Postgres terminates the connection: the
caller sees a connection failure rather than a SQLSTATE it can branch on, which is
correct — there is nothing to retry inside a transaction that no longer exists. It is
why `db/client.ts` attaches an error listener to every client it creates. Do not remove
that listener; without it the same event takes the process down.

**One file sets each flag.**

| Flag | Set by | Read by |
| --- | --- | --- |
| `app.tenant_id` | `src/tenancy/tenant-context.ts` | `<t>_tenant_isolation`, `tenants_self_*` |
| `app.redirect_context` | `src/redirect/db/redirect-read.ts` | `<t>_redirect_read` |
| `app.privileged_erase` | `src/gdpr/privileged-eraser.ts` | `<t>_privileged_erase` |

`src/db/rls.ts` contains all three strings and sets none of them — it builds the
policies that read them. The isolation suite (TASK-056) asserts both halves.

## The context ends when the transaction ends

`tenantDb()` and `currentTenantId()` read an ambient context held in
`AsyncLocalStorage`. That store stays visible to any continuation started inside `fn`,
including one that resumes after `COMMIT`, and `pg` does not disable queries on a
client it has returned to the pool. A fire-and-forget `void warmCache()` inside `fn`
would therefore run a statement on a connection another request has since checked out —
inside that request's transaction, under its `app.tenant_id`.

So the context is marked settled when the transaction ends, and every read of it after
that throws `TenantContextMissingError`, including a nested `withTenantTransaction`.
Work that has to outlive the transaction goes in `afterCommit` or after the call
returns.

## The per-table template

Every tenant-scoped table gets all of this, in the migration that creates it:

```sql
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

Do not type it. `tenantScopedPolicies('<t>')` in `apps/api/src/db/rls.ts` emits exactly
these statements, and the integration fixture builds its own protected table from the
same function, so what the tests exercise is what your migration applies.

Four details in there are load-bearing:

- **`FORCE`**, because the migrator owns the table and would otherwise bypass the
  policies it just created — including when it runs a later migration.
- **`USING` and `WITH CHECK` both.** `USING` decides what a statement may see, `WITH
  CHECK` what it may write. Without the second, a tenant can insert a row carrying
  another tenant's `tenant_id`, or re-parent one of its own rows to another tenant.
- **The second argument to `current_setting`.** With `true` an unset flag returns NULL
  instead of raising, so a query with no context returns zero rows rather than an error.
  `NULL = uuid` is NULL, which the policy treats as false.
- **`tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`**, which is how
  erasure reaches the table at all.

`tenants` is the exception: it carries `id`, not `tenant_id`, so it has its own four
policies and deliberately no ordinary `DELETE`. See `rls-policy-template.md`.

## Adding a tenant-scoped table

1. Write the schema file under `apps/api/src/db/schema/` and export it from the barrel.
2. `pnpm --filter @shortkit/api db:generate`.
3. Append `tenantScopedPolicies('<t>').statements` to the generated `.sql` file, by
   hand, in the same commit. Drizzle Kit does not generate policy DDL and never will.
4. `pnpm --filter @shortkit/api db:migrate`, then `pnpm --filter @shortkit/api
   db:check-policies`.
5. Add an isolation test for the new table.

Step 3 against an **already applied** migration does nothing at all. See
`migrations.md` — the migrator compares timestamps, not file contents.

## What checks what

| Check | Catches | When |
| --- | --- | --- |
| `assertRuntimeRoleCannotBypassRls()` | a `DATABASE_URL` whose role is superuser, holds `BYPASSRLS`, or owns tables in `public` | boot, before traffic |
| `pnpm db:check-policies` | a table in `public` missing `ENABLE` or `FORCE` | after `db:migrate`, and in CI's integration job |
| the integration suite | the policies themselves: cross-tenant read, write, re-parenting, and a read with no context | `pnpm test:integration` |

The boot check reads three properties, and ownership is the one that gets missed. It
throws rather than calling `process.exit`, so the caller can close what it opened; the
process still exits non-zero.

`db:check-policies` is the minimum viable form: every table in schema `public` has both
`relrowsecurity` and `relforcerowsecurity`, with an exception list for the Better Auth
tables, which carry no `tenant_id`. It does not yet compare the policy set itself
against `pg_policies` — that needs `tenantScopedTables()`, which arrives with TASK-053.
It fails on an empty schema rather than passing vacuously.

If you add a table that genuinely has no tenant, put it in that script's exception list
with the reason. An exception list is the obvious place to hide the failure the script
exists to catch, so the reason has to point at a decision somebody recorded.

## Reading a database error

Drizzle wraps a failed statement in `DrizzleQueryError`, whose `message` is the SQL text
and every bound parameter. `databaseTransaction` unwraps it, but only at the transaction
boundary — a `catch` **inside** `fn` still holds the wrapper, where `code` and
`constraint` are `undefined`.

Use `postgresErrorCode(error)` and `postgresErrorConstraint(error)` from
`src/db/client.ts`. They are the only sanctioned way to read a caught database error,
inside `fn` or outside it. Reading `.code` directly is a defect and inside `fn` it is a
silent one: the branch never matches and a retryable collision surfaces as a 500.

Do not log or return `message`, `detail`, `hint`, `where`, `internalQuery` or `query`
from a database error. `detail` on a unique violation contains the colliding values
verbatim — `Key (slug)=(abc) already exists` — so unwrapping the drizzle wrapper reduces
the exposure without removing it. The readable fields are the SQLSTATE and the
constraint name, and that list is closed.
