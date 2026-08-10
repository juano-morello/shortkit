# TASK-006 — sdlc-reviewer, round 1

Reviewer: `sdlc-reviewer`. Date 2026-08-10. First audit of this TASK.
Package: `.sdlc/foundation/work/TASK-006-review-audit.diff` (5 files, 1597 lines, whole-TASK
from empty tree). Read in the context of the whole files at HEAD, plus
`apps/api/src/db/rls.ts`, `apps/api/src/tenancy/tenant-context.ts`,
`apps/api/src/db/client.ts`, `apps/api/drizzle/0000_odd_betty_ross.sql`,
`apps/api/scripts/check-policies.mts`, `apps/api/test/support/psql.ts`,
`apps/api/vitest.integration.config.ts`, `.github/workflows/ci.yml`,
`.github/scripts/provision-test-database.sql`, `apps/api/test/isolation/report.json`.

---

## verdict

```yaml
verdict: changes-requested
```

**TASK-006 is not ready for `done`.** Two `major` findings, both in the attempt-judging
core, both of the shape "the harness reports a clean run over a surface it did not
actually test". Neither is wrong on the two tables that exist today. Both are inherited
by every future TASK that registers into this harness, and both are cheap to close now
and expensive to retrofit after ten tables have registered.

Nothing here is a `blocker`: I found no way the harness reports `pass` on a real
cross-tenant leak in the two tables it covers today.

---

## The detection question, answered

> **Would this harness actually DETECT a cross-tenant leak?**

**Yes, for the leak shapes it attempts, against the tables it covers — and the shipped
canary is a real negative control, not a test-of-a-test.** With three qualifications,
two of which are the `major` findings below.

### What holds

1. **The judge is real and the canary is a real control.** `judge()`
   (`apps/api/test/isolation/coverage.ts:413`) flags any returned row whose owner column
   is not the acting tenant, and any `rowsAffected > 0`. `leak-canary.ts` builds
   `isolation_leak_canary` with `TENANT_ID_COLUMN_SQL` from production and **no**
   `ENABLE ROW LEVEL SECURITY`, seeds one row per tenant, and the suite requires **all
   five** attempts to come back `fail`
   (`cross-tenant-isolation.int-spec.ts:166-167`), not merely the verdict. I traced
   each of the five against the actual table state and each produces a leak for the
   right reason:

   | attempt | why it leaks on the canary | assertion that catches a blind harness |
   |---|---|---|
   | `findAll` | unfiltered read returns B's row; `owner !== actor` | `judge` leak string names B's uuid |
   | `findOwnedBy` | filtered read returns B's row | same |
   | `updateOwnedBy` | `rowCount = 1` | `affected 1 row(s) ... against <B>` |
   | `deleteOwnedBy` | `rowCount = 1`, plus census drift | same, twice |
   | `insertOwnedBy` | `rowCount = 1` planting B's ownership | same |

   The premise is asserted from `pg_class`/`pg_policies` first
   (`leak-canary.ts:88`, asserted at spec:155-159), so a canary someone "repaired"
   fails loudly rather than confusingly. And a canary that had gone dead by throwing —
   missing table, missing GRANT — would report five `pass`es and be caught by
   `expect(control.attempts.filter(pass)).toEqual([])`. The control is self-guarding.

2. **The canary is not load-bearing for detecting a real leak.** Removing it removes a
   proof, not a detector. The primary assertion is
   `expect(leakedSurfaces(report)).toEqual([])` at spec:161, driven by the same
   `judge()` over the real tables. A real leak on `tenants` or `rls_fixture_rows` flips
   that regardless of whether the canary exists. Removing the canary is also a visible
   deletion of a file and a test.

3. **The attempts run GC-5's actual mechanism.** Every attempt and every census row goes
   through `withTenantTransaction`, which issues `BEGIN` +
   `set_config('app.tenant_id', $1, true)` — transaction-scoped, parameterised — as
   `shortkit_app`, a role the fixture refuses to run against unless it holds neither
   SUPERUSER nor BYPASSRLS (`rls-fixture.ts:134`, called first in `beforeAll`). Not a
   mock anywhere. See "GC-5" below for what this proves and what it does not.

### What does not hold — the two qualifications

4. **An attempt that errors for a non-policy reason is recorded as `pass`, and the
   evidence recorded cannot tell the two apart.** Finding 1. Two of the ten current
   attempts pass by this path.

5. **An attempt against a target that owns no row passes vacuously.** Finding 2. Nothing
   in the harness asserts the fixture it is attacking actually contains the row it is
   trying to reach.

### What I did not reproduce

The report's §3.2 (mutating `src/db/rls.ts` to `USING (true)` / `WITH CHECK (true)`) and
§3.3 (injecting `tenants_oops FOR ALL USING (true) WITH CHECK (true)`) are the evidence
that the two *registered* batteries are live — §3.3 in particular is the only evidence
that the `tenants` battery is live, since the shipped canary is `tenant_id`-shaped and
therefore only exercises the `rls_fixture_rows` battery's shape. Both were one-off manual
runs. **Neither runs in CI, and nothing preserves them.** I did not re-run them (see
"Environment" — the live database is currently in a mutated state that would make any
run red for an unrelated reason). By code reading they are sound: with
`tenants_self_insert WITH CHECK (true)`, `TenantsTableAccess.insertOwnedBy` gets
`rowCount = 1`, `judge` pushes a leak, `report.verdict` becomes `fail`, and spec:161
and spec:165 both go red.

---

## Findings

```yaml
findings:
  - severity: major
    kind: behavior
    file: apps/api/test/isolation/coverage.ts
    line: 489
    summary: >
      Any throw from an attempt is recorded as `pass`, and `describeError()` discards the
      only field that distinguishes a policy refusal from a permission, schema or timeout
      error — both are SQLSTATE 42501.
    failure_scenario: >
      MEASURED, not reasoned, against the live test database:
        - RLS WITH CHECK violation -> `ERROR: 42501: new row violates row-level security
          policy for table "reviewer_probe_t"`
        - missing privilege        -> `ERROR: 42501: permission denied for schema drizzle`
      `describeError()` (coverage.ts:455) returns `${error.name} [${code}]` and drops the
      message whenever a code is present, so BOTH render as the identical string
      `error [42501]` — which is exactly the string `report.json` carries today for
      `repo:TenantsTableAccess.insertOwnedBy` and
      `repo:RlsFixtureRowsTableAccess.insertOwnedBy`.
      Concrete future failure: TASK-024 lands `links`, and the ALTER DEFAULT PRIVILEGES
      grant does not reach it (migration run under a different identity — see finding 8 —
      or an explicit REVOKE), so `shortkit_app` keeps SELECT but loses INSERT/UPDATE/DELETE.
      `LinksTableAccess.updateOwnedBy`, `.deleteOwnedBy` and `.insertOwnedBy` each raise
      42501 `permission denied for table links`; `attempt()` catches at coverage.ts:491,
      returns `outcome: 'pass', refusedWith: 'error [42501]'`; `leakedSurfaces()` is empty,
      `verdict` is `pass`, and `EXPECTED_SURFACE_IDS` still matches. Three of the five write
      surfaces on a new tenant-scoped table tested nothing, the suite is green, and
      `report.json` is indistinguishable from a correct run. Same shape for 23502
      (NOT NULL on a planted row), 42703 (renamed column in a `projection` or
      `mutableColumn`), 42P01, and 57014 (`statement_timeout`, which `withTenantTransaction`
      sets to 5000 ms — a slow CI database turns a real attempt into a silent pass).
    required_change: >
      A throw must be classified before it counts as a pass. Only an error the harness
      recognises as a policy-level refusal may be `outcome: 'pass'`; anything else must be
      a distinct outcome that fails the run and names the surface, the same way `judge()`
      already throws rather than tolerating a row with no owner column (coverage.ts:421).
      Recognising it needs more than the SQLSTATE, because 42501 covers both cases —
      the driver's `message` (or `error.detail`/`error.table`) has to survive
      `describeError()` and be part of the recorded evidence in `report.json`, so a human
      reading the artifact can tell a policy denial from a grant problem. The two attempts
      that pass by throw today must be shown to be RLS denials, not privilege denials.

  - severity: major
    kind: behavior
    file: apps/api/test/isolation/coverage.ts
    line: 413
    summary: >
      No positive control. `judge()` cannot distinguish "the policy denied the actor" from
      "there was nothing there to deny", so a registration whose fixture does not actually
      seed the target tenant's row reports a clean run over a table with no RLS at all.
    failure_scenario: >
      Four of the five statement shapes return zero rows / zero rowsAffected when the
      TARGET owns no row, whether or not any policy exists: `findAll` (only the actor's
      rows exist, so nothing foreign comes back), `findOwnedBy` (`where owner = target`
      matches nothing), `updateOwnedBy` and `deleteOwnedBy` (same predicate). Only
      `insertOwnedBy` still bites.
      Concrete: a wave-3 TASK registers `workspaces` with a `reset()` that seeds tenant A's
      workspace and forgets tenant B's — a one-line omission in `registrations.ts` that no
      other test covers. `WorkspacesTableAccess.findAll/.findOwnedBy/.updateOwnedBy/
      .deleteOwnedBy` all report `pass`, `verdict` stays `pass`, `EXPECTED_SURFACE_IDS`
      matches, and the shipped canary is unaffected because it carries its own rows. Four
      of five surfaces on a table that could have `ENABLE ROW LEVEL SECURITY` missing
      entirely are reported green.
      Today this is masked rather than absent: `rls_fixture_rows` seeding is positively
      asserted by a DIFFERENT TASK's file (`test/tenancy/tenant-context.int-spec.ts:171`,
      AC-8), and `tenants` seeding is held up by the canary's foreign key. Neither
      mitigation is in this TASK, and neither extends to a table a later TASK registers.
    required_change: >
      Before an attempt is judged, the harness must establish its own premise: the target
      tenant owns at least one row in the registered table, read through the target's own
      tenant transaction. The census `tenantOwnershipCensus()` (coverage.ts:352) already
      produces exactly this data per attempt — an empty census half for the target must
      fail the surface rather than pass it. `check-policies.mts:171` sets the precedent
      in this codebase: "a database with no tables passes 'every table has RLS' without
      having checked anything", and it hard-fails on it.

  - severity: minor
    kind: implementation
    file: apps/api/test/isolation/coverage.ts
    line: 589
    summary: >
      `runCrossTenantAttempts()` writes module-level `lastReport` unconditionally, so the
      negative-control run clobbers the real one and `isolationReport()` afterwards returns
      the canary's failing report.
    failure_scenario: >
      Test order in the spec is fixed: `beforeAll` runs the real attempts (lastReport =
      the pass report), then spec:148 runs `runCrossTenantAttempts([leakCanaryAccess], ...)`
      (lastReport = five failed canary surfaces, `verdict: 'fail'`). Any caller of
      `isolationReport()` after that point — the contract's declared accessor, which
      TASK-056 and any CI reporting step will use — gets a report whose `discovered`,
      `covered` and `attempts` describe only `LeakCanaryTableAccess` and whose verdict is
      `fail`. Nothing in this file calls it, which is why the suite is green.
    required_change: >
      The negative-control run must not be able to become the run of record. Either
      `runCrossTenantAttempts` takes an explicit flag for a control run, or `lastReport` is
      set by a separate call the control does not make. `isolationReport()` must return the
      report over the registered subjects.

  - severity: minor
    kind: behavior
    file: apps/api/test/isolation/cross-tenant-isolation.int-spec.ts
    line: 177
    summary: >
      "AC-12: no row changed tenant across the run (AC-95)" cannot fail for the reason its
      comment claims; every path to a differing census is erased before the assertion runs.
    failure_scenario: >
      `attempt()` calls `registration.reset()` BEFORE each attempt (coverage.ts:483), and
      the canary registration's `reset` at registrations.ts:196 calls `createRlsFixture()`,
      which erases and re-seeds tenants A/B/C and drops and rebuilds `rls_fixture_rows`.
      The last thing to run before spec:177 is therefore a full fixture rebuild. The census
      it compares against `ownershipBaseline` is, by construction, a census of a freshly
      rebuilt fixture compared to a census of a freshly rebuilt fixture. The comment at
      spec:178-180 — "A cross-tenant UPDATE that had been allowed through, or a DELETE that
      reached another tenant's row, shows up here even if the statement that did it
      reported nothing" — is false: the next `reset()` erased it. The report's clause table
      lists this as AC-95's post-run check "delivered"; what actually delivers it is the
      per-attempt census inside `attempt()` (coverage.ts:498-505), which is genuinely
      stronger and genuinely live.
    required_change: >
      Either the assertion is placed where it can observe residue (a snapshot taken after
      the last attempt with no intervening reset), or the test and the comment stop
      claiming to detect something they cannot, and the per-attempt census is named as the
      mechanism that satisfies AC-95. A test that can only pass is worse than no test,
      because it occupies the slot a real one would.

  - severity: minor
    kind: implementation
    file: apps/api/test/isolation/coverage.ts
    line: 586
    summary: >
      `runCrossTenantAttempts([])` returns `verdict: 'pass'` — an empty registry produces a
      clean report.
    failure_scenario: >
      `registry` is a module-level `Map` populated by import-time side effects in
      `registrations.ts:174-175`. A future spec file (TASK-056 adds at least one) that
      imports `coverage.ts` without importing `registrations.ts` gets
      `registeredSubjects() === []`; `covered`, `uncovered` and `failed` are all empty,
      `verdict` is `pass`, and `formatIsolationReport()` prints
      `isolation coverage — PASS` with no attempt lines under it. Today the spec is saved
      by the `EXPECTED_SURFACE_IDS` comparison at spec:136, not by the harness.
    required_change: >
      A run over an empty registration set must be a failure, not a pass, and must say so.
      `check-policies.mts:171-178` is the pattern already used in this repository for the
      identical hazard.

  - severity: minor
    kind: behavior
    file: apps/api/test/isolation/coverage.ts
    line: 11
    summary: >
      "SC-1 lives here. Coverage is enforced by ENUMERATION, not by a hand-maintained list"
      is not true of what this file ships, and the coverage-boundary statement is as much
      the deliverable as the code.
    failure_scenario: >
      `discoveredSurfaces()` (coverage.ts:303) derives `discovered` from the registry, so
      `uncovered` is structurally `[]` — `report.json` confirms it. The registry is
      populated by hand in `registrations.ts`, and `EXPECTED_SURFACE_IDS`
      (registrations.ts:217) is an explicitly hand-maintained list. A later TASK that adds
      a tenant-scoped table and forgets a `registerTenantScopedSurfaces()` call gets a
      green run over a smaller set, with `uncovered: []` in the artifact SC-1 points at.
      The TASK-006 report says this plainly in §2 ("uncovered is structurally empty in this
      wave and asserting it proves nothing"); the file header contradicts it, and the
      header is what a reader of the code sees first. `COVERAGE_BOUNDARY`
      (coverage.ts:256), which is the sentence that travels into `report.json`, is silent
      on this — it names the two tables but does not say that discovery is the registry.
    required_change: >
      The header sentence and `COVERAGE_BOUNDARY` must state that in this wave discovery
      IS the registry, so a table registered nowhere is invisible to the suite, and name
      what closes it (ADR-0019's `tenantScopedTables()` cross-check, TASK-053/TASK-056).
      The boundary statement is accurate about tables and routes and inaccurate about the
      mechanism, which is the half that decides whether it keeps being accurate.

  - severity: minor
    kind: implementation
    file: apps/api/test/support/rls-fixture.ts
    line: 290
    summary: >
      F-191's local equivalent asserts a weaker predicate than the CI block it was routed
      here to mirror — it drops the role name, which is the load-bearing half.
    failure_scenario: >
      `.github/scripts/provision-test-database.sql:71` asserts
      `pg_get_userbyid(datdba) IS DISTINCT FROM 'shortkit_migrator'` — the owner must be
      that named role, because `ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator`
      (same file, line 84) grants nothing for tables created by any other identity.
      `assertTenantsIsMigrated()` asserts `state.database_owner !== state.role`, i.e. only
      "whoever DATABASE_MIGRATION_URL connects as owns this database". Edit
      `docker-compose.test.yml` so the database is created and owned by `postgres` and
      point `DATABASE_MIGRATION_URL` at `postgres` — a plausible pair of edits while
      debugging a grant — and the local check passes while `shortkit_app` receives no
      privileges on any migrated table. It then fails as a 42501 inside `beforeAll`'s
      census, which is the "permission error inside a test rather than at provisioning
      time" failure F-191 exists to convert into a clear one.
    required_change: >
      Compare the database owner against the role literally named in the
      ALTER DEFAULT PRIVILEGES statements, not against `current_user`, so the local guard
      fails on the same input as the CI block.

  - severity: minor
    kind: contract
    file: apps/api/test/isolation/coverage.ts
    line: 604
    summary: >
      `report.json` — which ADR-0020 and isolation-coverage.md both call "the artifact SC-1
      points at", "uploaded as a CI artifact" — is gitignored and is never uploaded by CI,
      so it survives no run.
    failure_scenario: >
      `.gitignore:51` ignores `apps/api/test/isolation/report.json` (correctly — it is
      regenerated per run). `.github/workflows/ci.yml`'s `integration` job has no
      `actions/upload-artifact` step for it; the only artifact path in that job is
      `${{ runner.temp }}/integration-results.json`, consumed by the collection assertion
      and not published. On CI the file is written into a workspace that is discarded. The
      coverage boundary therefore travels in three committed source-file headers, in the
      TASK report, and in a run log — but not in the artifact the contract designates.
      Separately: `writeIsolationReport()` is called only from `beforeAll`, so a run whose
      `beforeAll` throws leaves the previous run's `report.json` on disk, still saying
      `verdict: pass`, distinguishable only by `runAt`.
    required_change: >
      Either CI uploads `report.json` from the integration job, or the design stops calling
      it the artifact SC-1 points at. ADR-0020's follow-ups assign `report.json` to
      TASK-056, so the orchestrator should confirm the upload step is booked there rather
      than assumed. A run that does not complete must not leave a stale report that reads
      as current.

  - severity: minor
    kind: implementation
    file: apps/api/test/isolation/cross-tenant-isolation.int-spec.ts
    line: 69
    summary: >
      `protectionOf()` in the spec and `leakCanaryProtection()` in `leak-canary.ts` are the
      same `pg_class`/`pg_policies` query and the same `TableProtection` interface, written
      twice.
    failure_scenario: >
      Not a defect today; both are correct. It is duplication of something that already
      exists in the same directory, in the file the diff also adds, and the two will drift:
      `leakCanaryProtection()` throws a named error when the table is absent, `protectionOf()`
      returns `undefined` and lets `toEqual` produce a bare `undefined !== {...}`.
    required_change: >
      One helper taking a table name, used by both call sites, with the absent-table error
      the canary version already has.

  - severity: nit
    kind: implementation
    file: apps/api/test/isolation/leak-canary.ts
    line: 21
    summary: >
      The canary's header says it impersonates "a TASK that appends its CREATE POLICY block
      and forgets ENABLE or FORCE", but the table has no policies at all and
      `leakCanaryProtection()` asserts `policies: 0`.
    failure_scenario: >
      No behavioural difference — a policy with RLS disabled is inert, so the leak is
      identical. But the file states the defect it reproduces and does not reproduce that
      defect, and the assertion at spec:155-159 pins the divergence in place.
    required_change: >
      Either apply `tenantScopedPolicies()` to the canary without `ENABLE` (then
      `policies: 2`, and the impersonation is literal), or state that the canary reproduces
      the leak rather than the DDL.

  - severity: nit
    kind: implementation
    file: .github/workflows/ci.yml
    line: 253
    summary: >
      The "ORDER IS LOAD-BEARING" comment is now factually wrong as a consequence of this
      TASK's change to `rls-fixture.ts` — outside the diff, and already disclosed by the
      implementer's report §5.4.2.
    failure_scenario: >
      It says "apps/api/test/support/rls-fixture.ts drops and recreates `tenants` per test
      and drops it again on teardown, so after the suite schema `public` holds either an
      unprotected fixture table or nothing at all". After this TASK, `tenants` is migrated
      and the fixture only seeds and erases rows through its policies. The stated ordering
      is still correct; the stated reason no longer exists, and a reader repairing the
      comment could reasonably conclude the ordering is now free.
    required_change: >
      The comment states the reason that holds today (the suite creates
      `rls_fixture_rows` and `isolation_leak_canary` in schema `public`, both of which
      `db:check-policies` would fail on if the two ever overlapped). Routing is the
      orchestrator's: the file is TASK-002's.
```

---

## Answers to the four questions put to this review

### 1. The enumeration mechanism — does a forgotten registration shrink the harness quietly?

**Yes, and by construction.** `discoveredSurfaces()` (coverage.ts:303) maps over the
registry, and the coverage assertion subtracts `covered` from `discovered` — two names for
the same list. `uncovered` is `[]` in every possible run of this wave, and `report.json`
records it as `[]`, which reads to an outside consumer as "nothing is uncovered".

The three ADR-0020 backstops are all present as declarations that throw
(`discoverRoutes`, `discoverRepositoryMethods`, `undecoratedRepositoryClasses`,
`tablesWithoutRepository`, coverage.ts:636-663) and are correctly TASK-056's. ADR-0019's
`tenantScopedTables()` is TASK-053's.

What partially covers the gap today: `db:check-policies` enumerates **every** table in
schema `public` from `pg_class` and fails any that lacks `ENABLE`+`FORCE`, with an
exemption list cross-checked against `pg_attribute`. So a new tenant-scoped table that
nobody registers is still proven to have RLS *on*; it is not proven to have RLS that
*works*, and no cross-tenant attempt is ever made against it.

Worth the orchestrator's attention: **the SQL half of ADR-0019's cross-check needs no
TASK-053 artifact.** `select relname from pg_attribute join pg_class ... where attname =
'tenant_id'` compared against the registered table set is a self-contained assertion that
could ship in this file today and would fail the moment a wave-3 TASK adds a table without
registering it. I have not filed it as a finding because ADR-0019 assigns the cross-check
to TASK-053; the decision of whether to pull it forward is the orchestrator's, and it is
the single cheapest thing that would stop this harness shrinking quietly.

### 2. The coverage-boundary statement — accurate, and does it travel?

**Accurate on substance, inaccurate on the mechanism, and it travels unevenly.**

Accurate: two tables, ten repository-method surfaces, no routes, no repositories, "it does
not mean the system has no uncovered cross-tenant surface". I verified each clause —
`apps/api/drizzle/` contains exactly one migration creating exactly `tenants`;
`@TenantScopedRepository()` throws `not implemented` at
`src/tenancy/tenant-context.ts:384`; no controller exists; the four `tenants` policies and
two `rls_fixture_rows` policies match `rls-policy-template.md`'s approved set exactly, so
the hard-coded `policies: 4` / `policies: 2` premises at spec:143-153 are right.

Inaccurate: it is silent on the fact that discovery *is* the registry (finding 6), which is
the clause that decides whether the rest of it stays true.

Travel: it is in three committed source-file headers (`coverage.ts:11-52`,
`cross-tenant-isolation.int-spec.ts:11-27`, `registrations.ts:1-30`), in `COVERAGE_BOUNDARY`
as a first-class exported constant, printed by `formatIsolationReport()` on every run, and
written into `report.json`. That is more than a gate transcript and is genuinely good. But
`report.json` is gitignored and never uploaded (finding 8), so the *artifact* half of the
travel does not currently happen; what travels is the source.

### 3. GC-5's transaction rule — exercised, or something weaker?

**Exercised, for what it covers; it proves the enforcement half of GC-5 and none of the
universality half.**

All ten attempts and every census row go through `withTenantTransaction`, which issues
`BEGIN` then `set_config('app.tenant_id', $1, true)` with the flag name as an inline
literal and the value bound (`tenant-context.ts:220-224`) — the exact SQL GC-5 names,
including the `true` third argument. The connecting role is `shortkit_app` and the suite
refuses to run if that role holds SUPERUSER or BYPASSRLS. So "a transaction that has run
`set_config('app.tenant_id', $1, true)` sees only its own tenant's rows and can write only
its own tenant's rows" is what this harness demonstrates, over two tables.

What it does not touch: GC-5's "**No query path may bypass this**". That is the four grep
clauses A1–A4 and the module-graph discovery, all TASK-056's, all declared and throwing.
`assertRuntimeRoleCannotBypassRls()` (`src/db/rls.ts:137`) — the production boot guard —
is likewise not exercised here; the suite has its own fixture-level equivalent for the
app role only.

One deviation worth recording rather than filing: the fixture's own seed and erase run
through `psql` as `shortkit_migrator` with `set_config(..., false)` — **session**-scoped,
not transaction-scoped (`rls-fixture.ts:184-198`). That is not a GC-5 violation
(isolation-coverage.md's scan set excludes `apps/api/test/**` by name, and each `execSql`
is a separate short-lived process so nothing can bleed into the application pool), but it
means the fixture's own writes are not GC-5-shaped. The only GC-5-shaped statements this
TASK adds are the ten attempts and the census.

### 4. What a fresh read finds

Findings 1–11 above. The two that matter are 1 and 2, and they are the same defect seen
from two sides: **the harness has no way to tell "the database refused me" from "there was
nothing to refuse".** One is the throw path, the other the empty-result path. Closing both
is what turns "a green run means the policies denied" from an inference into an assertion.

---

## Cannot verify from diff

- **The §3.2 / §3.3 mutation evidence.** Self-reported, one-off, not preserved in any test
  or script, and I did not reproduce it (see Environment). §3.3 is the *only* evidence that
  the `tenants` battery — five of the ten surfaces — is live under a real policy weakening,
  because the shipped canary is `tenant_id`-shaped and exercises only the
  `rls_fixture_rows` battery's shape. If the orchestrator wants that claim to hold beyond
  one afternoon, a second canary shaped like `tenants` (own id as owner column, no RLS)
  is the mechanical form of it. I did not file this as a finding because the TASK card's
  ruling scopes the wave deliberately; I record it because §3.3 is doing load-bearing work
  that nothing repeats.
- **Whether TASK-056's card carries** the `report.json` CI upload, the
  `tenantScopedTables()` cross-check, and the four grep clauses. Cross-TASK; the
  orchestrator holds it.
- **Whether F-191 is now considered closed.** The TASK card routes it here and the report
  claims closure; finding 8 says the local guard is weaker than the CI block in a nameable
  way. Whether that is "closed enough" is the orchestrator's ruling, not mine.
- **Full-gate reproduction.** I did not run unit, integration, typecheck, lint, build or
  `db:check-policies`. The user's settled-tree numbers (137/137, 38/38, 0/0/0, policy gate
  OK) are the evidence of record, and the live database is currently unfit to reproduce
  them (below).
- **`docker-compose.test.yml`'s CREATEROLE clause.** The CI `DO` block asserts
  `rolbypassrls OR rolsuper OR rolcreaterole` over BOTH roles;
  `assertAppRoleCannotBypassRls()` checks superuser and bypassrls for the app role only.
  The migrator half and the CREATEROLE clause have no local equivalent. F-191 as routed
  covers only the third `DO` block, so this is outside what TASK-006 was asked for — but
  the card's claim that "the app-role half is still recovered locally" is true only for two
  of the three attributes.

---

## ⚠ Environment — read before running any gate on this machine

**The live test database currently carries a weakened production policy that is not in the
repository.** `pg_policies` on `shortkit_test` right now:

```
tenants|tenants_self_insert|INSERT||true
```

`with_check` is the literal `true`. `apps/api/drizzle/0000_odd_betty_ross.sql:26-27` says
`WITH CHECK (id = current_setting('app.tenant_id', true)::uuid)`, and I confirmed by
replaying that exact statement in a rolled-back transaction that it produces
`(id = (current_setting('app.tenant_id'::text, true))::uuid)`. The recorded migration hash
in `drizzle.__drizzle_migrations` (`db8156ef…ed34`) matches `sha256sum` of the file
byte-for-byte, so the applied SQL was this file and the policy was altered afterwards.

Consequences:

- `apps/api/test/isolation/report.json` (`runAt` 2026-08-10T19:16:15Z) records
  `repo:TenantsTableAccess.insertOwnedBy` as `refusedWith: error [42501]`, which cannot
  happen against the current policy. The database changed after that run — within roughly
  the last fifteen minutes, with no other session active when I looked. Most likely a
  concurrent auditor's mutation experiment still in flight.
- Any isolation-suite run against this database right now will be **red**, correctly, on
  `repo:TenantsTableAccess.insertOwnedBy` — the insert of `TENANT_C_NEVER_SEEDED` under
  tenant A's context now succeeds (`INSERT 0 1`, confirmed and rolled back), `judge()`
  records `affected 1 row(s)`, and `verdict` becomes `fail`. That red is the harness
  working, not a defect in this TASK.
- **I did not repair it.** Restoring needs
  `docker compose -f docker-compose.test.yml down -v && up -d --wait` followed by
  `pnpm --filter @shortkit/api db:migrate`, which destroys whatever the other auditor is
  doing. Coordinate before running it.

Per instruction I left the container running.

**What I did against the database**, all read-only or rolled back, none of it touching
`shortkit_test`'s schema or data: one `SELECT` against `drizzle.__drizzle_migrations`
(denied, which was the point), one `INSERT` into `tenants` inside `BEGIN … ROLLBACK`, two
`CREATE TABLE`/`CREATE POLICY` probes inside `BEGIN … ROLLBACK`, and catalogue reads.
Nothing persisted.

**What I did not do**, per the concurrency constraint: I ran no test command and wrote no
file inside the repository other than this report. `pnpm test:integration` would rewrite
`apps/api/test/isolation/report.json` (gitignored, so no drift risk) and would drop and
recreate `rls_fixture_rows`, `isolation_leak_canary` and the fixture tenant rows in the
shared database, which is not safe while another auditor holds it. With the policy in its
current state the run would have been red for an unrelated reason anyway.

---

## Notes

- **The engineering here is well above the line.** `judge()` throwing rather than passing
  when a read projects no owner column (coverage.ts:421-427); `reset()` before every
  attempt rather than after, so a wrongly-successful attempt cannot poison the next;
  `TENANT_C_NEVER_SEEDED` existing specifically because a 23505 on `tenants` would read
  like the 42501 the policy owes; the registry throwing on a duplicate subject and on a
  zero-method subject; `EXPECTED_SURFACE_IDS` as a hand-written cross-check so a battery
  that quietly loses a statement shape fails with the id named; the canary asserted
  method-by-method rather than on the verdict. Finding 1 is notable precisely because
  every other judgement in this file refuses to tolerate an unverifiable signal.
- **`assertNoCrossTenantAccess()` (coverage.ts:517) has no caller.** It is the contract's
  declared entry point and it carries invariant 1's whole mechanism — the "a surface with
  no registered attempt FAILS AS UNCOVERED" branch. The report discloses this (§5.6) and
  the ruling declining tests-of-the-harness covers it. Recorded so the orchestrator knows
  that branch has never executed, in any environment, ever.
- **`report.covered` includes surfaces whose outcome was `fail`.** Defensible — it means
  "attempted", and `failed` is carried separately — but the contract does not define the
  term, and a consumer reading `covered` as "proven isolated" would be wrong. Worth one
  sentence in `isolation-coverage.md` when it absorbs the additive fields.
- **Contract divergences, all declared:** `TenantFixture` ships 2 of 6 fields (ruled
  2026-08-06); `IsolationReport` gains three additive fields (`attempts`, `failed`,
  `coverageBoundary`) — the report's §5.2 names two of the three. Every field the contract
  declares is present with its declared meaning, so TASK-056 consumers are unaffected.
  `isolation-coverage.md` should absorb all three.
- **Concurrency and resources are sound.** `fileParallelism: false` in
  `vitest.integration.config.ts` closes the F-134 race this TASK's second spec file would
  otherwise have re-opened; the pool is `allowExitOnIdle: true` so not calling
  `closeDatabase()` in `afterAll` is consistent with the file's neighbours; the canary is
  dropped in `afterAll` and CI runs `db:check-policies` before the suite, so the two never
  meet. `psql` is absent on this machine, so every fixture call is a
  `docker run postgres:17-alpine psql` — I measured 0.34 s per invocation, which leaves
  the default 5 s test timeout comfortable. No finding.
- **Not re-reported here, as they belong to other auditors:** the report's §5.1
  (`tenants_privileged_erase` cannot delete with a `WHERE` clause — a GDPR erasure that
  reports success and deletes nothing) is a genuine and serious finding against ADR-0019 /
  `rls-policy-template.md` / TASK-054, and it needs a routing decision before TASK-054
  runs. It is not a defect in this diff; the fixture's choice of repair (set both flags) is
  correct for its own use and is documented with the measurements behind it.
