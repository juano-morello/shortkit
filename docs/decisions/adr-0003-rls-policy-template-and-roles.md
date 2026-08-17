---
id: ADR-0003
slug: foundation
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

**Context flags are set with `set_config`, never with `SET LOCAL`.** PostgreSQL's
`SET` and `SET LOCAL` take no bind parameters, so `SET LOCAL app.tenant_id = $1` is a
syntax error and the shortest repair is string interpolation at the one statement all
of RLS depends on. `set_config(name, value, true)` is the parameterised form with
identical transaction-local semantics:

```sql
SELECT set_config('app.tenant_id', $1, true);
```

No context flag is ever set by concatenation, in any file. Revised 2026-08-04 (F-007).
The flag **name** is an inline SQL string literal, never a bound parameter and never a
TypeScript identifier; only the **value** is bound. Clause A4 below is what enforces it.
Revised 2026-08-05 (F-118).

**The policy template.** Every tenant-scoped table applies all of these. TASK-005
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

**The cascade root is not the template.** `tenants` carries `id`, not `tenant_id`, so
it needs its own set. Revised 2026-08-04 (F-005): the earlier `FOR ALL` policy on
`tenants` included `DELETE`, which let any authenticated handler delete its own tenant
row and cascade-destroy every `click_events` and `audit_entries` row without setting a
context flag, without passing through the eraser, and without appearing in
`ISOLATION_EXCLUSIONS`. Ordinary tenant code now has no path to `DELETE`.

```sql
CREATE POLICY tenants_self_select ON tenants
  FOR SELECT USING (id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenants_self_update ON tenants
  FOR UPDATE USING      (id = current_setting('app.tenant_id', true)::uuid)
             WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);

-- Signup creates exactly the tenant whose context it is already in (ADR-0021).
CREATE POLICY tenants_self_insert ON tenants
  FOR INSERT WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);

-- The only DELETE path on tenants, anywhere.
CREATE POLICY tenants_privileged_erase ON tenants
  FOR DELETE USING (id::text = current_setting('app.privileged_erase', true));
```

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

**The erase escape stays `FOR DELETE`. The eraser reads elsewhere.** Revised
2026-08-04 (F-002): the eraser needs the tenant's member user ids before it deletes,
and under `app.privileged_erase` alone that `SELECT` returned zero rows, so the whole
erasure completed while deleting nothing. Widening the erase policy to `FOR ALL` would
have fixed it by giving the eraser read and write reach over every tenant-scoped
table. Instead the caller collects the ids in an ordinary
`withTenantTransaction(tenantId, ...)` census before the eraser runs, and passes them
in. The escape stays delete-only. `tenant-scoped-tables.md` holds the sequence.

**Grep is the audit, and `pg_policies` is the rest of it.** Grep catches an escape
that sets a new context flag. It does not catch a cascade and it does not catch a
permissive policy added to an existing table, which is how F-005 survived the first
round. Two assertions in the isolation suite, not one:

1. **One setter file per flag.** Revised 2026-08-05 (F-118). The earlier wording, "each
   flag appears in exactly one non-test source file", was unsatisfiable for all three
   flags, not just one: the policies that READ a flag are built in
   `apps/api/src/db/rls.ts`, and the code that SETS it lives elsewhere, so every flag
   name is in at least two files by construction. The property that carries the security
   claim is about `set_config` call sites, not about occurrences of the string. Reading a
   flag inside a `CREATE POLICY` is not an escape; setting one is.

   The assertion now has four clauses, stated exactly in `isolation-coverage.md` with the
   regexes TASK-056 implements:

   - **A1** For each flag, exactly one file in the scan set contains a `set_config` call
     naming it, and it is that flag's permitted setter.
   - **A2** For each flag, the string appears only in that flag's permitted setter and in
     `apps/api/src/db/rls.ts`.
   - **A3** `apps/api/src/db/rls.ts` contains no `set_config` call at all. That is what
     stops A2's carve-out from becoming the hole.
   - **A4** Every `set_config` first argument in the scan set is a quoted string literal
     beginning `app.`, or one of exactly two named GUCs: `statement_timeout` and
     `idle_in_transaction_session_timeout`. No identifier, no concatenation, no
     interpolation. A4 is the check behind this ADR's existing no-concatenation rule,
     which until now was prose with nothing enforcing it.

     The second GUC was admitted 2026-08-05 (F-123) so `withTenantTransaction` can bound
     how long a transaction sits idle holding a pooled connection. The non-`app` names
     are an enumeration rather than a pattern, because a pattern loose enough to admit a
     timeout by shape also admits `role`, `session_authorization`, `row_security` and
     `search_path`, and grep cannot tell a resource bound from an identity switch.
     `isolation-coverage.md` clause A4 holds the permitted-name table, the regex TASK-056
     implements, and the test a third name has to pass.

   The scan set is `apps/api/src/**/*.ts` minus `*.spec.ts`. `apps/api/test/**` and
   `apps/api/drizzle/**` are outside it. The migration SQL is excluded deliberately: it
   holds the `CREATE POLICY` statements that read the flags, so its literals are the
   read side of exactly the same distinction A1 draws, and DDL applied by
   `shortkit_migrator` at deploy cannot set a flag on a request path.

   **No flag gets a named constant.** A4 forbids passing one to `set_config`, so a
   constant would have to be inlined at the only call site that matters, which is what
   the setter files do directly. `rls.ts` writes all three literals inline in its policy
   templates.
2. **Every policy on every tenant-scoped table matches an approved shape by name and
   by `qual` text.** The approved set is the **seven** shapes above and nothing else:
   `<t>_tenant_isolation`, `<t>_privileged_erase`, `<t>_redirect_read`,
   `tenants_self_select`, `tenants_self_update`, `tenants_self_insert`,
   `tenants_privileged_erase`. The same seven are tabulated in
   `rls-policy-template.md`. A permissive policy, a widened `FOR` clause, or a policy on
   a table that should not have one fails and names the policy.

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
| Widen `<t>_privileged_erase` to `FOR ALL` so the eraser can read its own work list (F-002) | One word; the eraser becomes self-sufficient | Turns a delete-only escape into read, write and delete reach over every tenant-scoped table, for a path that already sits outside the tenant-facing interface. It would double the blast radius of exclusion 2 to solve a sequencing problem | Rejected. The caller collects the ids in an ordinary tenant transaction instead, which costs one extra statement and widens nothing |
| Enforce isolation only in the application `where` clause | No database configuration; easier local setup | AC-25 requires tenant filtering by RLS, not by an application clause. One missing `where` becomes a leak with no backstop | Contradicts AC-25 and the whole premise of SC-1 |

## Consequences

### Positive

- Reading `pg_policies` tells an auditor the complete set of ways data crosses a
  tenant boundary, and a test now asserts that reading, so the claim is enforced
  rather than stated. There are the template shape, the cascade root's four, and two
  escapes, each narrowed by statement type and by table.
- The redirect escape cannot write and cannot touch a table other than `domains` and
  `links`. The erase escape cannot cross tenants and cannot read.
- **Ordinary tenant code has no `DELETE` on `tenants`,** so the cascade that hard-deletes
  `click_events` and `audit_entries` is reachable only from `privilegedTenantEraser`.
  That cascade is a deliberate, policy-gated bypass of row security: PostgreSQL runs
  referential actions with RLS off, so the `DELETE FROM tenants` behind
  `tenants_privileged_erase` removes every child row regardless of the child's own
  policies. It is intended, it is the mechanism AC-90 depends on, and it is now gated
  by exactly one policy that only the eraser can satisfy.
- The grep test plus the `pg_policies` shape assertion make a third escape a build
  failure whether it arrives as a new flag, a new policy, or a widened `FOR` clause.

### Negative / accepted cost

- Two roles and two connection strings to provision on Neon, in CI, and in local
  Docker. Getting the grants wrong produces permission errors at runtime rather than
  at migration time, and the first symptom is usually a confusing `permission denied
  for table` in an unrelated feature.
- Two policies per table instead of one, and four on `tenants`. Every schema TASK
  copies more boilerplate, and a TASK that copies only the isolation policy leaves
  erasure broken for its table. AC-90's referential check is what catches it, one wave
  later.
- **A tenant owner cannot delete their own tenant through any ordinary code path.**
  Deletion works only through `POST /api/gdpr/delete`. That is the intent, and it means
  any future self-service teardown has to go through the same route rather than
  issuing a delete.
- The `pg_policies` assertion matches on `qual` text, which PostgreSQL normalises and
  reformats. The expected strings have to be captured from a live database rather than
  written by hand, and a PostgreSQL upgrade that changes normalisation will fail the
  test with a diff that looks alarming and means nothing.
- `FORCE ROW LEVEL SECURITY` applies to the migrator too, so data-backfill migrations
  cannot use plain `UPDATE` across tenants. Any such migration has to set the context
  flag per tenant or run before the policy is created.
- The grep test couples the isolation suite to file layout. Moving
  `redirect-read.ts` fails a test that has nothing to do with the move.
- **`rls.ts` is a permitted container for all three flag strings, so A2 cannot see a
  fourth flag added to a policy template there.** A3 keeps that file from setting
  anything, and the `pg_policies` shape assertion rejects any policy whose name or `qual`
  is not on the approved list, so a new flag in a new policy fails there instead. The
  cost is that one of the two completeness assertions has a blind file and the other has
  to cover it. Added 2026-08-05 (F-118).
- **A4 bans a named constant for a flag name.** Someone will reasonably want
  `TENANT_ID_SETTING` to bind the setter to the policies that read it, and A4 says no,
  because an identifier at a `set_config` call site is indistinguishable by grep from an
  identifier holding a concatenated value. The drift it would have prevented is caught
  loudly instead: a typo on either side makes `current_setting` return NULL, every policy
  denies, and AC-8, AC-9 and AC-10 fail on the first integration run. Added 2026-08-05
  (F-118).

### Follow-ups this creates

- TASK-005 publishes the template, the four `tenants` policies, both roles, the
  boot-time privilege check, `set_config` as the only way to set a flag, and
  `docs/architecture/rls.md`.
- Every schema TASK (013, 016, 020, 023, 033, 038, 045, 048) applies the template.
  See `docs/contracts/rls-policy-template.md`.
- TASK-029 owns `withRedirectRead`; TASK-054 owns `privilegedTenantEraser` and the
  census-before-erase sequence.
- TASK-056 owns the grep assertion, the `pg_policies` shape assertion, and records the
  two exclusions.
