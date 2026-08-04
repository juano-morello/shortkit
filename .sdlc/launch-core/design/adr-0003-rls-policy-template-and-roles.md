---
id: ADR-0003
slug: launch-core
title: Two database roles, forced RLS, and exactly two named context escapes
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

ADR-0002 makes RLS the bottom layer under GC-5. That layer only holds if the runtime
role is actually subject to the policies. Postgres exempts a table's owner from RLS
unless the table declares `FORCE ROW LEVEL SECURITY`, and it exempts any role holding
`BYPASSRLS` unconditionally. A single-role setup where the API owns its own tables
gives an RLS configuration that looks correct, passes review, and enforces nothing.
TASK-005 already forbids `BYPASSRLS`; ownership is the part that gets missed.

Two code paths need to read or write across tenant boundaries by design. TASK-029
resolves a redirect before any tenant is known, because the visitor is anonymous.
TASK-054 erases a whole tenant through a path that sits outside the tenant-facing
interface, per Amendment A-2. TASK-056 records these two and no others. Anything
that grants those paths their access by turning RLS off gives them unlimited reach
and leaves an auditor nothing to inspect.

## Decision

**Two roles.**

| Role | Owns tables | RLS | Grants |
|---|---|---|---|
| `shortkit_migrator` | yes | subject to it via `FORCE ROW LEVEL SECURITY` | DDL; used only by the migration runner |
| `shortkit_app` | no | subject | `SELECT, INSERT, UPDATE, DELETE` on application tables, `USAGE` on sequences. `NOBYPASSRLS`, no `CREATEROLE`, no `SUPERUSER` |

`DATABASE_URL` (runtime) authenticates as `shortkit_app`. `DATABASE_MIGRATION_URL`
authenticates as `shortkit_migrator` and appears only in the deploy step and in the
integration test setup. A startup check asserts
`current_setting('is_superuser') = 'off'` and that `rolbypassrls` is false for the
connected role, and refuses to boot otherwise.

**The policy template.** Every tenant-scoped table applies all four of these. TASK-005
publishes it; every later schema TASK copies it verbatim with the table name
substituted.

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;

-- 1. Normal tenant access. The only policy most code ever meets.
CREATE POLICY <t>_tenant_isolation ON <t>
  FOR ALL
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`current_setting(..., true)` returns NULL when unset, the comparison is NULL, and the
policy denies. That is AC-10.

**Escape 1, redirect read.** Applied to `domains` and `links` only:

```sql
CREATE POLICY <t>_redirect_read ON <t>
  FOR SELECT
  USING (current_setting('app.redirect_context', true) = 'on');
```

The only code that sets `app.redirect_context` is `withRedirectRead()` in
`apps/api/src/redirect/db/redirect-read.ts`. That function opens a
`SET TRANSACTION READ ONLY` transaction, so the escape cannot write. The policy is
`FOR SELECT`, so it cannot write even if the transaction were writable. It exists on
two tables, so it cannot read memberships, invitations, audit entries or click
events.

**Escape 2, privileged erasure.** Applied to every tenant-scoped table:

```sql
CREATE POLICY <t>_privileged_erase ON <t>
  FOR DELETE
  USING (tenant_id::text = current_setting('app.privileged_erase', true));
```

The flag names one tenant. Even the eraser cannot delete another tenant's rows. The
only code that sets it is `privilegedTenantEraser` in
`apps/api/src/gdpr/privileged-eraser.ts`.

**Grep is the audit.** A test in the isolation suite asserts that the string
`app.redirect_context` appears in exactly one non-test source file, that
`app.privileged_erase` appears in exactly one, and that `app.tenant_id` appears in
exactly one. A third escape cannot be added without that test failing.

**Auth tables are not tenant-scoped.** Better Auth owns `user`, `session`, `account`
and `verification`. None carries `tenant_id`, none has RLS, and none is enumerated by
`tenantScopedTables()`. The tenant-to-user relation lives in `tenant_memberships`,
which is tenant-scoped and RLS-protected. Tenant-facing code reads `user` only through
`userDirectory.findByIds()`, which joins through `tenant_memberships`, so RLS on the
joined table does the filtering. This is why looking up a user by email at login is
not a GC-5 exception and does not become a third exclusion.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| One role that owns its tables, RLS enabled without `FORCE` | Simplest to set up; one connection string | The owner bypasses every policy, so the whole isolation claim is decorative. The isolation suite would pass while running as a role that ignores RLS | Silently defeats SC-1, which is the initiative's headline claim |
| A dedicated `shortkit_redirect` role with `SELECT` on `domains` and `links` and no policies | The escape is a grant, visible in `\dp`, with no runtime flag to forget | A second connection pool on the hot path, doubling connection use against Neon for the highest-volume traffic; and the process would hold a credential that reads every tenant's links for the whole process lifetime rather than for one transaction | Broader blast radius over time, and it costs connections on the path GC-1 constrains |
| Give the eraser `BYPASSRLS` for the duration | One line; no per-table delete policy | `BYPASSRLS` is not scoped to a tenant or to `DELETE`. TASK-005 forbids it outright, and it would let the eraser read and write anything | Explicitly forbidden, and unnecessary given the flag policy scopes to one tenant |
| Enforce isolation only in the application `where` clause | No database configuration; easier local setup | AC-25 requires tenant filtering by RLS, not by an application clause. One missing `where` becomes a leak with no backstop | Contradicts AC-25 and the whole premise of SC-1 |

## Consequences

### Positive

- Reading `pg_policies` tells an auditor the complete set of ways data crosses a
  tenant boundary. There are three shapes and two escapes, both narrowed by column,
  by statement type, and by transaction mode.
- The redirect escape cannot write and cannot touch a table other than `domains` and
  `links`. The erase escape cannot cross tenants.
- The grep test makes a third escape a build failure rather than a review finding.

### Negative / accepted cost

- Two roles and two connection strings to provision on Neon, in CI, and in local
  Docker. Getting the grants wrong produces permission errors at runtime rather than
  at migration time, and the first symptom is usually a confusing `permission denied
  for table` in an unrelated feature.
- Three policies per table instead of one. Every schema TASK copies more boilerplate,
  and a TASK that copies only the isolation policy leaves erasure broken for its
  table. AC-90's referential check is what catches it, one wave later.
- `FORCE ROW LEVEL SECURITY` applies to the migrator too, so data-backfill migrations
  cannot use plain `UPDATE` across tenants. Any such migration has to set the context
  flag per tenant or run before the policy is created.
- The grep test couples the isolation suite to file layout. Moving
  `redirect-read.ts` fails a test that has nothing to do with the move.

### Follow-ups this creates

- TASK-005 publishes the template, both roles, the boot-time privilege check, and
  `docs/architecture/rls.md`.
- Every schema TASK (013, 016, 020, 023, 033, 038, 045, 048) applies all four
  statements. See `design/contracts/rls-policy-template.md`.
- TASK-029 owns `withRedirectRead`; TASK-054 owns `privilegedTenantEraser`.
- TASK-056 owns the grep assertion and records the two exclusions.
