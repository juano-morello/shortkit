# TASK-006 — security audit r1 (`sdlc-security-auditor`)

Date 2026-08-10. HEAD at audit start `ecc9275`. Read-only on the repository; all
mutations were made against the throwaway Postgres container and reverted.

---

## Verdict

```yaml
verdict: changes-requested
safe_to_mark_done: no
can_the_harness_be_green_while_isolation_is_broken: yes
```

**Answer to the question the TASK was audited for: YES, and it was measured twice, not
reasoned.**

1. With one `ALTER POLICY` on the migrated `tenants` table, `shortkit_app` acting as
   tenant B reads tenant A's row. `cross-tenant-isolation.int-spec.ts` → **5 passed**,
   `report.json` → `"verdict": "pass"`, `db:check-policies` → **OK**.
2. With a new tenant-scoped table (`workspaces`, `tenant_id`, `ENABLE` + `FORCE`,
   `USING (true)`), every tenant reads every tenant's rows. Suite → **5 passed**,
   `db:check-policies` → **OK**, and the table is not named anywhere in `report.json`.

The harness is well built and its author's own mutation testing (report §3.2, §3.3) is
real. What those mutations share is one shape: a **total, symmetric leak on an
already-registered table, visible from A looking at B**. That is the only shape the
shipped harness — and its leak canary — can see. Four distinct classes of leak pass it.

This is not an argument for rewriting TASK-006. F-1 and F-3 are small, local changes to
`coverage.ts`. F-2 is the one that needs a scheduling decision at the gate.

---

## Findings

```yaml
findings:
  - id: SEC-006-1
    severity: blocker
    kind: behavior
    file: apps/api/test/isolation/coverage.ts
    line: 490
    summary: >
      Every attempt runs in exactly one direction. `attempt()` always calls
      `method.attempt(fixtures.tenantA, fixtures.tenantB)`, so a policy that leaks only
      to a particular tenant, or only in the B→A direction, is reported as `pass`.
    attacker: >
      Any authenticated user of the privileged tenant, once a route exists. Reached
      without an attacker at all by an ordinary defect: an `OR` arm in a policy, an
      "internal tenant" or "first tenant" carve-out, a support-tenant read, or a
      predicate that compares the flag against a hardcoded id.
    reachable_path: >
      The suite acts only as tenant A. `judge()` (coverage.ts:432) flags a returned row
      only when its owner differs from the ACTING tenant, and the acting tenant is
      always A. Nothing ever runs a statement as B. The ownership census DOES read as
      both tenants (coverage.ts:359) and builds the exact string that proves the leak —
      `tenants seen-by=<B> id=<A> owner=<A>` — but the census is only ever compared
      before/after an attempt (coverage.ts:485, 498) and against a baseline taken after
      the fixture was built (coverage.ts:338). A leak that is present at baseline is
      therefore identical before and after, and no assertion ever inspects the census
      lines themselves. The harness computes the evidence and discards it.
    measured_evidence: |
      # asymmetric leak, applied to the MIGRATED table, policy count unchanged (4)
      ALTER POLICY tenants_self_select ON tenants
        USING (id = current_setting('app.tenant_id', true)::uuid
               OR current_setting('app.tenant_id', true)::uuid
                  = '22222222-2222-4222-8222-222222222222');

      # as shortkit_app, app.tenant_id = A  -> Tenant A
      # as shortkit_app, app.tenant_id = B  -> Tenant A, Tenant B     <-- cross-tenant read
      # node scripts/check-policies.mts     -> "ok tenants" / "OK: 1 table(s) ... all protected"
      # vitest cross-tenant-isolation       -> "isolation coverage — PASS", Tests 5 passed (5)
    required_change: >
      Run every registered method in both directions (A acting against B, and B acting
      against A) and report both as distinct surface outcomes. Separately, add an
      ABSOLUTE assertion over the census rather than only a differential one: for every
      census line, `seen-by` must equal `owner`. That single invariant catches this
      class regardless of which direction the battery happens to run, and the data for
      it is already being collected.

  - id: SEC-006-2
    severity: major
    kind: behavior
    file: apps/api/test/isolation/registrations.ts
    line: 183
    summary: >
      The covered table set is a hand-maintained list of two `registerTenantScopedSurfaces()`
      calls. Nothing cross-checks it against the database, so a tenant-scoped table added
      later without a registration is silently uncovered and the report still says
      `verdict: pass`.
    attacker: >
      Any authenticated tenant user, against whichever table the omission lands on. The
      "attacker" that creates the condition is a future schema TASK.
    reachable_path: >
      `runCrossTenantAttempts()` enumerates `registeredSubjects()`, and `uncovered`
      (coverage.ts:563) is computed from `discoveredSurfaces()` over that same registry —
      as the TASK-006 report states in §2, discovery and the registry are the same list,
      so `uncovered` is structurally empty and can never fire. `tablesWithoutRepository()`
      (coverage.ts) throws `TASK-056 owns this`. The gate that would catch it,
      ADR-0019's set-equality cross-check between `tenantScopedTables()` and the
      database, is TASK-053/TASK-056. `db:check-policies` only asserts `relrowsecurity`
      and `relforcerowsecurity`; it never reads a policy's predicate, so a table shipped
      with `ENABLE`, `FORCE` and a permissive policy passes it. This ordering is known
      and recorded — `scripts/check-policies.mts` says in its own header that the TASK it
      was written to catch "adds `links` three waves before TASK-053 runs" — so the
      window between the next table-adding TASK and TASK-056 is real, not hypothetical.
    measured_evidence: |
      CREATE TABLE workspaces (id uuid PRIMARY KEY,
                               tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                               name text NOT NULL);
      ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workspaces FORCE  ROW LEVEL SECURITY;
      CREATE POLICY workspaces_tenant_isolation ON workspaces FOR ALL USING (true) WITH CHECK (true);
      GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces TO shortkit_app;

      # as shortkit_app, app.tenant_id = A -> "A private workspace", "B private workspace"
      # node scripts/check-policies.mts    -> "ok workspaces" / "OK: 2 table(s) ... all protected"
      # vitest cross-tenant-isolation      -> "isolation coverage — PASS", Tests 5 passed (5)
      # grep workspaces report.json        -> no match
    required_change: >
      This wave does not need `tenantScopedTables()` to close it. Add one assertion to
      the suite: every relation in schema `public` (`relkind in ('r','p')`) carrying a
      `tenant_id` column in `pg_attribute`, plus `tenants`, must appear as the `table` of
      a registration — `toEqual([])` on the difference, naming the table and pointing at
      `registrations.ts`. Roughly the query `check-policies.mts` already runs at
      `TENANT_ID_COLUMNS`. Until that exists, the gate should record that SC-1's covered
      set grows only by convention.

  - id: SEC-006-3
    severity: major
    kind: behavior
    file: apps/api/test/isolation/coverage.ts
    line: 490
    summary: >
      Any thrown error scores the attempt `pass`. The judge never checks that the refusal
      came from a policy, so an unrelated constraint violation, a missing grant, a bad
      identifier or a broken fixture is recorded as isolation proven.
    attacker: >
      A tenant user exploiting the widened policy that the masking hides. The masking
      itself arrives from an ordinary schema addition — a CHECK, a NOT NULL, a foreign
      key, or a unique index the planted row happens to violate.
    reachable_path: >
      `attempt()` wraps `method.attempt(...)` in `try/catch` and the catch returns
      `{ outcome: 'pass', refusedWith: describeError(error) }` (coverage.ts:490-494)
      unconditionally. Note also that RLS never refuses a SELECT — it returns zero rows —
      so a read attempt that is reported as `refused` means the read never ran at all,
      and is still scored `pass`. The report's own §3 acknowledges the 23505-vs-42501
      hazard on `tenants` and works around it with `TENANT_C_NEVER_SEEDED`, which fixes
      that one instance without closing the class.
    measured_evidence: |
      # step 1: widen the insert policy on the migrated table. Policy count stays 4.
      ALTER POLICY tenants_self_insert ON tenants WITH CHECK (true);
      # -> suite RED, correctly:
      #    FAIL repo:TenantsTableAccess.insertOwnedBy — "affected 1 row(s) while acting as
      #    1111... against 2222...; a cross-tenant write must be rejected (AC-95)"

      # step 2: add an unrelated constraint the planted row violates. Policy still WITH CHECK (true).
      ALTER TABLE tenants ADD CONSTRAINT tenants_name_not_planted
        CHECK (name <> 'planted-by-another-tenant');
      # -> "pass repo:TenantsTableAccess.insertOwnedBy (write on tenants) — refused: error [23514]"
      #    isolation coverage — PASS, Tests 5 passed (5)
      # i.e. GREEN while any tenant may insert a tenants row carrying any id.
    required_change: >
      Record the SQLSTATE on `AttemptOutcome` and require it. A write attempt passes on
      `42501` (or zero rows affected); a read attempt must RETURN a result, never throw.
      Any other refusal is `unverified` — a suite failure that names the surface and the
      code, in the same shape as `uncovered`. `describeError()` already extracts `code`;
      it is thrown away into a string.

  - id: SEC-006-4
    severity: major
    kind: behavior
    file: apps/api/test/isolation/coverage.ts
    line: 507
    summary: >
      No positive control. Nothing asserts that the acting tenant can see its OWN row, and
      `AttemptOutcome` records no row count, so a run in which every read returned zero
      rows for a reason unrelated to tenancy is indistinguishable from a run that proved
      isolation. The leak canary does not close this: the canary table has no RLS at all,
      so it leaks whether or not the tenant context works.
    attacker: >
      No external attacker. The failure mode is the control going quiet — the harness
      keeps reporting `pass` after the thing it tests has stopped working, which is
      precisely what SC-1 must not do.
    reachable_path: >
      `judge()` returns leaks only for rows it was given; zero rows is a pass, and so is
      zero `rowsAffected`. `tenantOwnershipCensus()` returning empty for both tenants is
      also a pass, because only equality before/after is checked. So if `app.tenant_id`
      were never set, set under a mistyped flag name, or set to a value no row matches,
      all ten attempts pass, the census stays constant and empty, the canary still fails
      as required, and the suite is green. The four grep clauses A1..A4 that would catch a
      mistyped or duplicated flag name are TASK-056's and do not run.
    measured_evidence: |
      # a proxy for "the context is not what the harness thinks it is": give every app
      # connection an ambient tenant id it never set.
      ALTER ROLE shortkit_app SET "app.tenant_id" = '22222222-2222-4222-8222-222222222222';
      # any app session that opens no tenant transaction now reads tenant B's rows.
      # vitest cross-tenant-isolation -> "isolation coverage — PASS", Tests 5 passed (5)
      # vitest tenant-context -t AC-10 -> FAIL "expected [ { …(2) } ] to deeply equal []"
      # The compensating assertion exists, but it is in TASK-005's file, not in the
      # artifact SC-1 points at.
    required_change: >
      Assert the actor sees its own row: each read attempt must return exactly the acting
      tenant's fixture row(s), not merely "no row belonging to the target". Add `rowsSeen`
      (and `rowsAffected`) to `AttemptOutcome` so `report.json` distinguishes "denied" from
      "found nothing". Assert the baseline census is non-empty and holds one row per tenant
      per registered table.

  - id: SEC-006-5
    severity: major
    kind: behavior
    file: apps/api/test/isolation/coverage.ts
    line: 485
    summary: >
      The harness proves neither that `app.tenant_id` is transaction-scoped nor that it was
      set. GC-5's third argument `true` has no assertion behind it anywhere in the
      repository; flipping it to `false` leaves the whole integration suite green.
    attacker: >
      Any tenant user whose request is served by a pooled connection previously used by
      another tenant, on any path that reaches the pool without opening a tenant
      transaction — the F-121 settled-context continuation, a direct `databaseTransaction`
      caller (`client.ts` names four sanctioned ones), TASK-029's redirect read, TASK-054's
      eraser.
    reachable_path: >
      Every statement the suite issues goes through `withTenantTransaction`, which always
      sets the flag, so no assertion can observe the difference between `is_local = true`
      and `false`. The only flag-free read in the repository is AC-10 in
      `tenant-context.int-spec.ts`, and it runs in a FRESH psql process, so it cannot see a
      value leaked onto a pooled connection either. `client.ts`'s stated safety property —
      "a transaction opened without a context flag sees zero rows and can write none, which
      is fail-closed by policy" — is exactly what a session-scoped flag destroys, and
      nothing tests it.
    measured_evidence: |
      # one connection, sequential transactions, rows seeded for A and B:
      BEGIN; SELECT set_config('app.tenant_id','1111…',false); COMMIT;
      BEGIN; SELECT string_agg(name,',') FROM tenants; COMMIT;
        -> "Tenant A"                       # a transaction that set nothing reads A's row
      BEGIN; SELECT set_config('app.tenant_id','1111…',true);  COMMIT;
      BEGIN; SELECT string_agg(name,',') FROM tenants; COMMIT;
        -> ERROR: invalid input syntax for type uuid: ""     # fail-closed
      # The harness cannot distinguish these two worlds: reasoned from the code (no
      # flag-free query path exists in the suite), hazard measured above.
    required_change: >
      Add one attempt-shaped probe to the harness: after a `withTenantTransaction` has run,
      open a transaction on the pool that sets NO flag and read each registered table. It
      must return zero rows or raise; a row is a leak. That assertion fails the moment the
      third argument changes, and it is the only thing that would.

  - id: SEC-006-6
    severity: minor
    kind: behavior
    file: apps/api/test/support/rls-fixture.ts
    line: 133
    summary: >
      The role premise is re-checked for `shortkit_app` only, and only for two of the three
      properties the production boot check enforces. `shortkit_migrator` is not checked at
      all on the local path, which is half of the F-191 gap this TASK was routed to close.
    attacker: >
      Whoever edits `docker-compose.test.yml`'s inline provisioning while debugging a grant.
      The compose file's header promises "both roles NOBYPASSRLS"; unlike
      `.github/scripts/provision-test-database.sql` it carries no `DO` block that asserts it.
    reachable_path: >
      `assertAppRoleCannotBypassRls()` reads `is_superuser` and `rolbypassrls` for
      `current_user` on `DATABASE_URL` only. It omits the third property that
      `assertRuntimeRoleCannotBypassRls()` in `src/db/rls.ts` does check — tables owned in
      schema `public` — which ADR-0003 calls "the one that gets missed"; today that hole is
      covered only because the suite hand-asserts `force_row_security` for the two tables it
      knows about. `rolcreaterole`, asserted over both roles in CI, is asserted nowhere
      locally. A BYPASSRLS migrator makes the fixture's seed and erase succeed regardless of
      `tenants_self_insert` and `tenants_privileged_erase`, so the `tenants` fixture path
      stops being evidence that those policies admit anything.
    measured_evidence: |
      ALTER ROLE shortkit_migrator BYPASSRLS;
        -> vitest cross-tenant-isolation: "isolation coverage — PASS", Tests 5 passed (5)
      ALTER ROLE shortkit_app BYPASSRLS;
        -> Error: DATABASE_URL connects as 'shortkit_app', which is exempt from row-level
           security (superuser=false, bypassrls=true). Test Files 1 failed, 5 skipped.
        # the app-role half works exactly as documented.
    required_change: >
      Assert over BOTH roles by name in one query — `rolbypassrls OR rolsuper OR
      rolcreaterole` for `shortkit_app` and `shortkit_migrator` — and add the app role's
      `tables owned in public` count, matching `assertRuntimeRoleCannotBypassRls()` and CI's
      first `DO` block. It folds into the query `assertTenantsIsMigrated()` already issues.

  - id: SEC-006-7
    severity: minor
    kind: docs
    file: apps/api/test/isolation/coverage.ts
    line: 256
    summary: >
      `COVERAGE_BOUNDARY`, reproduced verbatim into `report.json`, is accurate in what it
      says and materially incomplete in three things it does not say — each of which was
      measured above to produce a false green.
    attacker: >
      A reader of the SC-1 artifact — a gate reviewer, an auditor, or a customer-facing
      claim built on it — who reads `verdict: pass` as stronger than it is.
    reachable_path: >
      The statement enumerates which TABLES are covered and which mechanisms are TASK-056's.
      It does not say (a) that attempts run in one direction only, (b) that the covered set
      is hand-maintained in `registrations.ts` and is not cross-checked against the database,
      or (c) that a refusal of any kind counts as a pass. It also calls `rls_fixture_rows`
      one of "the two tables that exist"; it exists only for the duration of a run, so a
      reader of `report.json` counts two tables where the migrated schema has one.
    required_change: >
      Extend the boundary string with those three sentences, and mark `rls_fixture_rows` as
      a fixture table built by the suite. If SEC-006-1 and SEC-006-3 are fixed, (a) and (c)
      come out again.

  - id: SEC-006-8
    severity: nit
    kind: behavior
    file: apps/api/test/isolation/coverage.ts
    line: 438
    summary: >
      `judge()` serialises the entire leaked row into the `leaks` string, and `leaks` is
      written into `report.json`, which `isolation-coverage.md` declares is uploaded as a CI
      artifact.
    attacker: >
      Anyone with read access to CI artifacts, which is a wider audience than anyone with
      access to the database.
    reachable_path: >
      Only fixture rows exist today, so there is nothing to disclose. It becomes real when a
      registration points at a table seeded with anything resembling production data.
    required_change: >
      Report the row's id and owner column, not the whole row.
```

---

## The three questions asked, answered directly

**1. The roles.** The check is real and it runs before each suite file
(`cross-tenant-isolation.int-spec.ts:97`, `tenant-context.int-spec.ts:157`). Measured: it
refuses a `BYPASSRLS` `shortkit_app` with a clear message and skips every test. It cannot
currently be satisfied by a role that in fact bypasses **for the two tables the suite knows
about**, because the suite independently asserts `relforcerowsecurity` on both, which closes
the ownership vector. It is nonetheless two-thirds of the production check and covers one of
the two roles — see SEC-006-6.

**2. The transaction rule.** The harness proves neither. It proves that statements which set
the flag are denied cross-tenant access; it never observes a statement that does not set it,
so `is_local = true` versus `false` is invisible to it and to the rest of the integration
suite. See SEC-006-5, with the hazard measured at the SQL level.

**3. The leak canary.** It fails for the right reason. Verified in the baseline run: the
premise is asserted from `pg_class` (`row_security: false, force_row_security: false,
policies: 0`) before the control is used, all five attempts report `fail`, and each leak
string contains tenant B's id. The harder question — would the suite go red if RLS were
silently disabled on a real table — splits:

| Case | Result | Why |
|---|---|---|
| `ALTER TABLE tenants DISABLE ROW LEVEL SECURITY` | **RED**, measured | `assertTenantsIsMigrated()` raises before any test runs |
| a policy dropped from `tenants` or `rls_fixture_rows` | **RED** | the hand-written `policies: 4` / `policies: 2` premise |
| a registration removed from `registrations.ts` | **RED** | `EXPECTED_SURFACE_IDS` compared as a sorted literal |
| a NEW tenant-scoped table, unregistered | **GREEN**, measured | SEC-006-2 — the report gets smaller, not redder |

So the "quietly shrinking report" mode is closed for what is already registered and open for
everything that arrives later.

**4. Enumeration.** Yes — a tenant-scoped table can be added and not covered with the suite
still green (measured, SEC-006-2). A repository method cannot be added without a registration
today because no repository exists; when one does, `discoverRepositoryMethods()` is TASK-056's
and still throws, so the same convention-only property will hold for methods.

**5. The coverage claim.** True as far as it goes, incomplete in three specific ways, each of
which was measured to produce a false green. See SEC-006-7.

---

## What I could not verify

- **The `is_local` flip itself.** Proving the harness is blind to it would require editing
  `apps/api/src/tenancy/tenant-context.ts:224`, which is outside a read-only audit. The
  blindness is reasoned from the code — no query path in the suite omits the flag — and the
  underlying hazard is measured at the SQL level. Treat SEC-006-5's mechanism as reasoned and
  its consequence as measured.
- **The CI path.** `.github/workflows/ci.yml`'s "ORDER IS LOAD-BEARING" ordering and the
  artifact upload were read, not executed. The TASK-006 report's §5.4 note that the comment is
  now stale is consistent with what I measured locally (`db:check-policies` is green after the
  suite).
- **TASK-056's half of `coverage.ts`.** Confirmed only that every declared function throws
  with a message naming its owner. Its contents are not this audit's subject.
- **Anything about routes, guards or repositories.** None exist; the harness's route half is
  types only.

## Environment and residue

- Postgres left running per instruction: `docker compose -f docker-compose.test.yml`,
  container `shortkit-postgres-1`, port 55433, migrated.
- All mutations reverted. Final state verified: `tenants` carries its four migration policies
  with the original `qual`/`with_check` text, `relrowsecurity`/`relforcerowsecurity` both
  true, both roles `bypass=false super=false`, no role-level GUC default, one table in schema
  `public`, no leftover `workspaces`, no leftover `isolation_leak_canary`.
- Final gates re-run by me after restore: integration **38 passed (38)**, `db:check-policies`
  **OK**. `git status` clean — the only file this audit wrote is itself. `report.json` is
  gitignored (`.gitignore:51`) and untracked; test runs rewrote it, which cannot show as drift.
