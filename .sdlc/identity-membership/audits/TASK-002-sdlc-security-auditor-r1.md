# TASK-002 — sdlc-security-auditor, round 1

Mode: code. Commit `86c6b2b` (review package `review-f6ac5fd..86c6b2b.diff`), initiative
`identity-membership`, wave 1.

Everything below was executed against a scratch database (`sec_audit`) created on the running
`docker-compose.test.yml` container, provisioned with the same three roles, the same
`GRANT USAGE` and the same `ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator` as
`docker-compose.test.yml`, and migrated with the repository's own `drizzle-kit migrate` through
`0001`. Dropped at the end. The `shortkit_test` stack was left up, untouched and green
(`db:check-policies` re-run against it after cleanup: OK, 7/7/7). The `shortkit` application
database was never contacted.

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: behavior
    file: apps/api/src/db/client.ts
    line: 259
    summary: >-
      betterAuthDatabase() exports an unconstrained database handle holding privileges no
      other code path in the process holds, and no executing control bounds its callers.
    failure_scenario: >-
      Measured. `betterAuthDatabase()` returns a NodePgDatabase typed over the FULL schema,
      outside any transaction and with no context flag, on a pool connecting as
      shortkit_auth. From a plain script importing nothing else I read
      `select id, token, user_id from "session"` and got back the plaintext session
      credential `REAL-TOKEN-B` for another tenant's user. The same handle holds INSERT,
      UPDATE and DELETE on `user`, `session`, `account`, `verification` and `jwks` — i.e.
      exactly the account-takeover primitive F-024 measured and migration 0001's REVOKE
      closed, reachable again through a different door. Any module under `apps/api/src` can
      obtain it with one import; the attacker is the ordinary one this project already
      accepts (a defect or a careless reuse in `apps/api`), and the plausible shape is a
      request-path service importing it to read a user's display name.
      Nothing catches it. `db:check-policies` reads the catalogue, not the code. The
      isolation harness cannot see it — Better Auth is mounted outside the Nest graph and is
      declared unenumerable (`coverage.ts`, "What enumeration cannot reach"). The grant
      matrix's second direction bounds the ROLE, not the handle, so it does not fire: I
      confirmed the same handle is correctly refused on `tenant_memberships`
      (`permission denied`), which is the property the matrix guarantees and is not this one.
      The one control ADR-0046 names — "`betterAuthDatabase` appears in exactly two files
      under `apps/api/src`" — is marked "(deferred)" to TASK-056, and TASK-056 is not in this
      initiative (its tasks are TASK-001..TASK-019). So the control has no owning card and no
      date.
      Two things make this new rather than pre-existing. (1) The deferral was written when
      ADR-0046 had this handle built on the SAME pool as `databaseTransaction`; a stray
      import then bought an attacker nothing they did not already have. ADR-0050 changed the
      role three days later and nobody re-priced the deferral. (2) `client.ts`'s own header,
      six lines above the export, still reads "THE ONLY FILE THAT CONSTRUCTS THE DRIZZLE
      CLIENT, AND IT DOES NOT EXPORT IT. An exported client is a query path that reaches
      every tenant's rows with no transaction and no context flag, which is the hole GC-5
      exists to close." That sentence is now false in the file that makes it, so a reviewer
      checking a diff against the module's stated invariant gets the wrong answer.
    required_change: >-
      Bring the caller control forward into this initiative rather than leaving it on
      TASK-056, and correct the header. The cheapest executing form matching what this
      repository already does for `databaseTransaction`: a `src/**` grep control asserting
      `betterAuthDatabase` appears in exactly the sanctioned files, sitting beside
      `context-flag-owners.spec.ts` (which is already the wave's proof that a `src` spec
      importing from `test` collects and runs). TASK-003 is the first caller and is the
      natural home if this card is closed. Separately, the docblock at `client.ts:6-9` must
      state what is now true — the module exports one client, as a second role, and what
      bounds it is the grant matrix rather than the absence of an export.

  - severity: minor
    kind: behavior
    file: apps/api/scripts/check-policies.mts
    line: 931
    summary: >-
      The grant matrix and the RLS check both restrict to `relkind IN ('r','p')`, so a view
      over the Better Auth tables is invisible to every assertion in the script.
    failure_scenario: >-
      Measured on the scratch database. As shortkit_migrator:
      `CREATE VIEW auth_peek AS SELECT id, user_id, token FROM "session";
      GRANT SELECT ON auth_peek TO shortkit_app;`
      shortkit_app then read `sess-b | user-b | REAL-TOKEN-B` — the plaintext session
      credential migration 0001 revoked it from — and `pnpm db:check-policies` printed
      "OK: 7 table(s) ... 7 table(s) match the grant matrix in both directions." A view is
      not `security_invoker` by default, so it executes with its owner's (the migrator's)
      privileges and the REVOKE is bypassed entirely rather than merely unchecked.
      The same `relkind IN ('r','p')` filter is in `warm-connection-no-context.int-spec.ts`'s
      `READABLE_TABLES`, so the behavioural control does not cover it either. Attacker: the
      author of a later migration who adds a convenience or reporting view — the same
      "forgetting it fails OPEN" class the script's own docblock is written against, and the
      script is stated to be "the only thing that looks".
    required_change: >-
      Include `relkind` 'v' and 'm' in GRANT_MATRIX (the shortkit_app-must-hold-nothing
      direction is the one that matters; the positive direction should not be asserted for
      views, which carry no default privilege). A view over an EXEMPT table that shortkit_app
      can read must fail. If views are to be forbidden outright instead, assert that schema
      public holds none — either is an executing answer; silence is not.

  - severity: minor
    kind: behavior
    file: apps/api/src/db/rls.ts
    line: 143
    summary: >-
      membershipLookupPolicy() emits no `TO shortkit_app`, so the token-mint escape policy is
      installed TO PUBLIC. The frozen contract quotes it with the role clause; two other
      normative sources do not, and the disagreement is unresolved.
    failure_scenario: >-
      Confirmed against the applied catalogue: `pg_policies.roles` for
      `tenant_memberships_membership_lookup` is `{public}`. The policy is the entire
      narrowing that justifies the third `ISOLATION_EXCLUSIONS` entry, and as installed it
      admits a cross-tenant row to ANY role that holds SELECT on `tenant_memberships` and can
      set `app.membership_lookup_user` — not only to the one role the escape was scoped for.
      Effect today is nil, as the implementer's Note 1 states: only shortkit_app and
      shortkit_migrator hold SELECT, and shortkit_auth is refused (measured). The path is a
      future role. That is not idle speculation in this initiative — adding a second runtime
      role is precisely what this commit does, and a third (analytics, read replica, a Better
      Auth plugin needing membership reads) would silently inherit an escape nobody wrote a
      policy for. `TO <role>` is the one narrowing PostgreSQL offers here and the exclusion's
      justification leans on narrowing.
      `.sdlc/foundation/design/contracts/isolation-coverage.md:523` — frozen, normative, and
      in this card's `contracts:` list — quotes the function as emitting
      `... FOR SELECT TO shortkit_app USING (...)`. ADR-0045:89-91 and
      `tenant-membership-lookup.md` carry no role clause. The implementer followed the two
      that call themselves normative and declined to resolve it by inference, which is the
      right call; it now needs a ruling rather than a re-read.
    required_change: >-
      Rule which text is normative, then make the other match. If the role clause is kept,
      it is a new migration dropping and recreating the policy (ADR-0004 is forward-only) and
      `membershipLookupPolicy()` moves with it; if it is dropped, isolation-coverage.md:523
      is amended. Either way one artifact stops describing SQL the repository does not emit.

  - severity: minor
    kind: behavior
    file: apps/api/src/db/schema/tenant-memberships.ts
    line: 30
    summary: >-
      A tenant can bind an orphaned `user` row into its own tenancy as `owner`, and
      tenantIdForUser then mints that user's `tid` as the capturing tenant.
    failure_scenario: >-
      Measured end to end. ADR-0015 / GC-E accepts an orphaned `user` row with no membership
      as the residue of a non-atomic signup. From an ordinary tenant-A transaction as
      shortkit_app, `app.tenant_id` set to A:
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
       VALUES (gen_random_uuid(), '<A>', 'orphan-user', 'owner');` -> `INSERT 0 1`.
      The isolation policy's WITH CHECK is satisfied because `tenant_id` is the actor's own,
      so nothing refuses it. I then ran the real `tenantIdForUser('orphan-user')` against the
      same database and it returned tenant A. When that person completes or retries signup
      and signs in, their token carries tid = the capturing tenant, and their session
      operates inside it.
      Preconditions, stated honestly: (a) write reach on `tenant_memberships` from within the
      attacker's own tenant — the SQL-defect premise ADR-0050 was itself written on, since no
      wave-1 endpoint inserts memberships; (b) a user with no membership row. Users who
      already have one are protected — I confirmed `user-b` is refused with 23505 on
      `tenant_memberships_user_unique` before any policy is evaluated, so this cannot steal
      an established member. The boundary crossed is an identity boundary, which RLS cannot
      express: the WITH CHECK bounds `tenant_id` and says nothing about whose `user_id` may
      be named.
      Related and lower value, from the same INSERT: the FK gives an existence oracle on
      `user.id` (23503 for absent vs 23505 for present). PostgreSQL redacts the key value in
      the DETAIL because shortkit_app has no SELECT on `user` — measured — so it confirms a
      guess rather than enumerating, and Better Auth ids are not guessable. Noted, not filed.
    required_change: >-
      Decide whether membership rows may name a `user_id` the acting tenant has not
      established a relationship with, and if not, express it where it can be enforced —
      TASK-003's `on-user-created` is the only sanctioned writer, so the narrow answer is to
      keep it that way and say so, e.g. a policy or trigger constraining INSERT rather than
      relying on no endpoint existing. At minimum record the exposure against GC-E, since it
      is the first thing that makes the accepted orphan residue cost something.

  - severity: nit
    kind: behavior
    file: apps/api/scripts/check-policies.mts
    line: 933
    summary: >-
      The grant matrix's negative direction asserts "holds none of SELECT,INSERT,UPDATE,
      DELETE" where migration 0001 writes REVOKE ALL PRIVILEGES.
    failure_scenario: >-
      Measured. `GRANT TRUNCATE ON "session" TO shortkit_app;` then, as shortkit_app,
      `TRUNCATE "session"` succeeded and the row count went 1 -> 0 (read back as migrator),
      while `db:check-policies` printed OK on all three assertions. Every session in the
      system destroyed, from the tenant runtime role, with the control green. TRIGGER and
      REFERENCES are outside the four in the same way.
      Filed as a nit rather than higher because the path needs a hand-written
      `GRANT TRUNCATE`, which is not a plausible slip. The failure mode ADR-0050 actually
      names — a sixth auth table nobody revoked — IS caught: I created one and the script
      failed on it. This is a gap between the property the control asserts and the property
      the DDL writes, not a live hole.
    required_change: >-
      Add TRUNCATE (and, if cheap, TRIGGER and REFERENCES) to the has_table_privilege list in
      the negative direction, or assert the ACL entry is absent outright. Note that the
      has_any_column_privilege term must NOT gain them — it accepts only the three
      column-grantable privileges and raises `unrecognized privilege type`, which the
      docblock already records for DELETE.

  - severity: nit
    kind: behavior
    file: apps/api/src/auth/membership-lookup.ts
    line: 39
    summary: >-
      The docblock's justification for SET TRANSACTION READ ONLY was made true by ADR-0044
      and is false since ADR-0050, in the same commit that lands both.
    failure_scenario: >-
      The header reads "READ ONLY IS NOT REDUNDANT WITH THE `FOR SELECT` POLICY. The handle
      also reaches the five RLS-exempt Better Auth tables (ADR-0044), where a write would be
      unconstrained." Measured inside a real `withMembershipLookup` call:
      `select token from "session"` -> `permission denied for table session`. The handle no
      longer reaches those tables at all, because this commit's own REVOKE took them away.
      READ ONLY is still enforced and still worth keeping — I confirmed an UPDATE inside the
      escape fails with "cannot execute UPDATE in a read-only transaction" — but the reason
      recorded for keeping it no longer holds, and a later reader who checks the stated
      reason and finds it false is one step from deleting the control.
    required_change: >-
      Restate the reason from what is now true: the escape opens a transaction with no tenant
      flag set, so READ ONLY is what stops any write in it from being evaluated against a
      policy set that was never intended to govern writes on this path.
```

## What was executed, and what it proved

### 1. The F-024 attack, re-run against the real migrated schema

The original measurement, replayed statement for statement from an ordinary tenant-A
transaction as `shortkit_app` with `app.tenant_id` set correctly. Each statement in its own
transaction so one abort could not mask the rest.

| Statement | Design phase | This commit |
|---|---|---|
| `UPDATE "account" SET password='OWNED' WHERE user_id='user-b'` | `UPDATE 1` | `42501 permission denied for table account` |
| `INSERT INTO "session" (... token='ATTACKER-CHOSEN' ... user_id='user-b')` | `INSERT 0 1` | `42501 permission denied for table session` |
| `UPDATE "user" SET email='attacker@evil.test' WHERE id='user-b'` | `UPDATE 1` | `42501 permission denied for table user` |
| `SELECT token FROM "session"` | plaintext credential | `42501` |
| `SELECT private_key FROM jwks` | key row | `42501` |
| `SELECT user_id, password FROM "account"` | hashes | `42501` |
| `SELECT id, email FROM "user"` | PII | `42501` |

The tenant-scoped read in the same transaction returned tenant A's membership row throughout,
so the closure is the REVOKE and not an aborted transaction. Post-attack state read back as
migrator: `account.password` unchanged for both users, `session` holding only `REAL-TOKEN-B`,
both `user.email` values unchanged. **F-024 is closed at the database.**

Worth recording because it nearly cost me a false green: on my first scratch build the
`ALTER DEFAULT PRIVILEGES` did not apply (a `docker exec` without `-i`), and every statement
above returned `permission denied` for the wrong reason — shortkit_app had no grant on
anything. I rebuilt and verified `pg_default_acl` carried
`{shortkit_app=arwd/shortkit_migrator}` and that `tenants` and `tenant_memberships` showed
`shortkit_app=arwd` in `relacl`, before treating any refusal as meaningful. A reviewer
repeating this should check the same thing first.

### 2. The `nullif` wrapper — warm and cold, in and out of context

The premise reproduces exactly: after one committed transaction-local `set_config`,
`current_setting('app.tenant_id', true)` is not NULL and `= ''` is true, on the same backend.

- **Cold, no context:** `tenant_memberships` 0 rows, `tenants` 0 rows, no error.
- **Warm, no context:** `tenant_memberships` 0 rows, `tenants` 0 rows, `UPDATE tenants` ->
  `UPDATE 0`, `DELETE FROM tenant_memberships` -> `DELETE 0`, INSERT -> refused by WITH CHECK.
- **Warm, in context as A:** only A's row visible; targeted read of B -> 0; unqualified
  `UPDATE` -> `UPDATE 1`; unqualified `DELETE` -> `DELETE 1`; re-parent own row to B ->
  refused; insert owned by B -> refused.
- **`app.privileged_erase` warm/reset:** `DELETE FROM tenants` -> `DELETE 0`,
  `DELETE FROM tenant_memberships` -> `DELETE 0`.

**The repair is load-bearing, not decorative.** I installed the pre-ADR-0049 predicate on a
scratch table on the *same warm backend* and read it out of context: `ERROR: invalid input
syntax for type uuid: ""`. The wrapped form on the same backend in the same session: 0 rows.
That is the isolation-versus-raise difference, measured side by side rather than inferred.

**F-021's own premise, re-run.** I planted a `"user"` row with `id = ''` (the column is `text
PRIMARY KEY` with no CHECK, so this is permitted) and a `tenant_memberships` row for it owned
by tenant B, warmed `app.membership_lookup_user` so it read `''`, and issued tenant A's
ordinary read. A saw only its own row; the no-context read on the same backend returned 0.
The `nullif` on the lookup policy is doing exactly what F-021 demanded of it.

### 3. `membershipLookupPolicy()` — what can reach it

Installed as `FOR SELECT`, permissive, `{public}` (see the minor above). Reachability measured
through the real modules:

- The escape returns **exactly one row** — `SELECT id, tenant_id, user_id, role FROM
  tenant_memberships` inside `withMembershipLookup('user-b', ...)` returned only user-b's row,
  not the table.
- **`SET TRANSACTION READ ONLY` is real** — an UPDATE inside the escape fails with "cannot
  execute UPDATE in a read-only transaction".
- **The escape cannot reach the Better Auth tables** — `select token from "session"` inside it
  is `permission denied`.
- **The flag does not leak out.** After a completed `tenantIdForUser('user-b')` on the
  application pool, the next `withTenantTransaction(A, ...)` on the same pool saw only tenant
  A's row. The transaction-local set reverts to `''` and the `nullif` collapses it.
- **No request path sets it.** `withMembershipLookup` is imported by exactly one file
  (`tenant-id-for-user.ts`); `tenantIdForUser` has no production caller in wave 1 (TASK-003).
  Verified by grep across `apps/`, `packages/`.

The residual, which ADR-0045 accepts explicitly and I am not filing: under the SQL-defect
premise, injected SQL inside a tenant transaction can `set_config('app.membership_lookup_user',
'<known user id>', true)` and read that user's membership row across the tenant boundary —
one row, SELECT only, requiring the attacker to already know a Better Auth user id. That is the
priced cost of the exclusion, and the `FOR SELECT`/one-row/one-file narrowing holds as written.

### 4. The second pool and `shortkit_auth`, both directions

`shortkit_auth`: `rolbypassrls = f`, owns 0 relations in `public`, `has_schema_privilege
('shortkit_auth','public','CREATE') = false` (same for `shortkit_app`). On the tenant side it
is refused on `tenants` and `tenant_memberships` for SELECT, INSERT, UPDATE and DELETE, and
still refused with `app.membership_lookup_user` set — the lookup policy cannot help a role
with no table privilege. It reads `session` as intended.

Nothing reaches the auth pool from a request path today: `betterAuthDatabase()` has no caller
(TASK-003 wires it), so the pool is never constructed in wave 1. That is the good news; F-108
is about the fact that only the absence of a caller stands there.

`assertAuthRoleSeparation` is TASK-004, wave 3, per ADR-0050's own routing table — correctly
out of this card and already tracked by earlier rounds. Not filed.

### 5. The grant matrix and the counting control — refusing what they claim

I installed attack shapes rather than reading the code.

| Probe | Verdict | Notes |
|---|---|---|
| Sixth auth table, granted to `shortkit_auth`, REVOKE forgotten | **FAIL** | Caught by the RLS check (not in EXEMPT, no RLS). ADR-0050's own named failure mode. |
| Raw `current_setting` in a policy | **FAIL** | Names policy, clause, counts and the expression. |
| Wrong sentinel `nullif(..., 'x')` | **FAIL** | The form the blacklist predecessor passed. |
| Column-level `GRANT SELECT (email) ON "user"` | **FAIL** | The `has_any_column_privilege` term earns its place. |
| `GRANT TRUNCATE ON "session" TO shortkit_app` | **PASS** (gap) | Filed as a nit. shortkit_app truncated `session`, 1 -> 0 rows. |
| Migrator-owned view over `session`, granted to app | **PASS** (gap) | Filed as a minor. Plaintext token returned. |
| `current_setting` behind a STABLE function wrapper | **PASS** here | Not a defect — see below. |
| Unmigrated database | **FAIL** | Missing-exempt check fires; fails closed. |

Two things I set out to disprove and could not:

- **`pg_policies` is not privilege-filtered.** I created a raw-predicate policy on `"session"`,
  a table `shortkit_app` cannot touch at all, and the counting control — which connects as
  `shortkit_app` — saw it and failed naming it. "Over EVERY row" is literally true, including
  rows for tables the connecting role has no access to.
- **The function-wrapper blind spot is genuinely covered.** `unwrappedReferences`' docblock
  admits it cannot see a flag reached through a function wrapper and names
  `warm-connection-no-context.int-spec.ts` as the behavioural control. I built the case: a
  table whose policy calls a STABLE helper returning a raw `current_setting`. `check-policies`
  passed it. I then ran that spec's exact `READABLE_TABLES` query and its warm no-context read
  by hand — the table IS in the computed set and the read raises `22P02`, which the spec
  records as `raised` and fails on, naming the table and its SQLSTATE. The claim in the
  docblock is true. (The same spec inherits the `relkind IN ('r','p')` limit, which is why the
  view probe is filed.)

The `EXEMPT.size !== 5` control runs before the connection is opened, as documented. Note that
every failure branch `return`s, so only the first failing assertion is reported per run — an
operator fixing one may find another behind it. Not a defect; worth knowing.

### 6. `tenantIdForUser` / `withMembershipLookup` bounds

| Input | Result |
|---|---|
| `''` | `InvalidLookupUserIdError`, message carries `""... (0 characters)` |
| 256 chars | `InvalidLookupUserIdError`, `"xxxxxxxx"... (256 characters)` |
| 255 chars | passes the shape check, then `NoTenantMembershipError` |
| unknown user | `NoTenantMembershipError` |
| `' OR '1'='1` | `NoTenantMembershipError` — bound, not interpolated |
| `user-b', 'x', true); SELECT set_config('app.tenant_id` | `NoTenantMembershipError` — the `set_config` injection does not execute |
| `' '` | `NoTenantMembershipError` |

`set_config`'s value is bound and the flag name is an inline literal, so there is no injection
surface; the length/emptiness check is a shape check, as the docblock says. Error messages
carry eight characters and a length and no email — confirmed against a user id shaped like an
email address, where the message showed `"averyver"... (55 characters)` and the full value was
only on `.userId`. The deliberate hole in GC-5 is bounded as designed: `READ ONLY`, no
`AsyncLocalStorage` store entered, one flag, one file, one importer.

### 7. Clause A2

Run by hand across the scan set the contract defines (`apps/api/src/**/*.ts` excluding
`*.spec.ts`), for all four flags:

```
app.tenant_id              -> src/db/rls.ts, src/tenancy/tenant-context.ts
app.redirect_context       -> src/db/rls.ts
app.privileged_erase       -> src/db/rls.ts
app.membership_lookup_user -> src/auth/membership-lookup.ts, src/db/rls.ts
```

Every set is a subset of its permitted pair. **A2 would catch nothing else today.** The two
stub violations the implementer found are the only ones that existed, and both are fixed. A3
also holds (`src/db/rls.ts` contains no `set_config(` call — the three matches are prose in
comments, and the clause is about calls). A4's call sites are the six in
`membership-lookup.ts` and `tenant-context.ts` plus the two timeout GUCs the contract permits;
`context-flag-owners.spec.ts`'s own literals are legitimately outside the scan set by the
`*.spec.ts` exclusion, so the control is not scanning itself into a false failure.

## Notes

**On the hand-written counts.** I did not treat them as a defect, per the ruling. Two of them
are load-bearing in a way worth naming: `expect(protectionOf('tenant_memberships')).toEqual({
..., policies: 3 })` is what would fail if a later migration dropped
`tenant_memberships_membership_lookup`, and without it the exclusion in
`ISOLATION_EXCLUSIONS` would go on being justified by a policy the database does not have while
every attempt in the file stayed green. That is the strongest of the new hand-derived
literals and the comment above it says so correctly.

**The contract amendment landed.** The implementer's report item 3 says sites 6 and 7 of
`isolation-coverage.md` were left stale because `.sdlc/**` was out of bounds. They are not
stale in the commit — `:483` reads `toHaveLength(3)` and `:1203` reads "Exactly three". Someone
made both edits. The report is describing an intermediate state; no action needed.

**Not filed, considered.** The `EXEMPT` list at five with the length control is sound and the
docblock/Map disagreement (F-001) is genuinely fixed. `REVOKE ALL PRIVILEGES` does not remove
column-level grants — but nothing grants any, and the matrix's `has_any_column_privilege` term
catches it if something does; measured by the implementer and I did not reproduce it. The
migration's `DROP`/`CREATE` window on `tenants_privileged_erase` is fail-closed and already
applied. No secrets, DSNs or credentials are introduced by the diff; the fixture DSNs in
`security-headers.int-spec.ts`'s throw are the documented throwaway-container values and match
existing practice. No new dependency.

## Dependencies reviewed

None. The diff adds and bumps no dependency; no lockfile change.
