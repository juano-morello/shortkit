# TASK-002 — code review, round 1

- **Reviewer:** sdlc-reviewer
- **Package:** `.superpowers/sdd/plan/review-f6ac5fd..86c6b2b.diff` (1 commit, 19 files, +1954/-112)
- **Read alongside:** `tasks/TASK-002.md`, `work/TASK-002-report.md`, ADR-0043/0045/0046/0049/0050,
  `contracts/isolation-coverage.md`, `contracts/rls-policy-template.md`, `contracts/tenant-context.md`,
  `contracts/tenant-membership-lookup.md`
- **Finding ids used:** F-120 … F-124 (range F-120…F-131 was allotted)
- **Verdict:** `changes-requested` — **no blocker, no major.** Four `minor` and one `nit`, all of them
  stale-count / stale-claim sites of exactly the class this card was chartered to close.

---

## What was checked and found correct

Recorded because the card's own risk is its size, and a reviewer who reports only defects leaves the
orchestrator unable to tell "checked and fine" from "not looked at".

### `rls.ts` — all four reasons landed, none half-landed

| Reason | Site | Verdict |
|---|---|---|
| `nullif` wrapper | isolation `USING`, isolation `WITH CHECK`, `<t>_privileged_erase` `USING`, `redirectReadPolicy()` | all four wrapped |
| `membershipLookupPolicy()` | new export, one statement | matches ADR-0045:89-91 **character for character** |
| exclusion count | `Exclusion 2 of exactly 3`, `Exclusion 1 of exactly 3` | both moved (digit form, as the card warned) |
| exhaustive-flag header | `THIS FILE READS ALL FOUR CONTEXT FLAGS` + all four literals named | moved with the fourth flag |

### Migration `0001`

- The hand-appended `tenantScopedPolicies('tenant_memberships')` block is byte-identical to what the
  function emits, including `FORCE  ROW LEVEL SECURITY`'s double space and the index.
- The four `tenants` DROP/CREATE pairs match `rls-policy-template.md:213-233` exactly, including
  `tenants_privileged_erase` (F-029's fourth).
- **The GC-A / F-239 window does not exist here.** Checked in `node_modules`:
  `drizzle-orm@0.45.2/pg-core/dialect.js` `migrate()` runs every statement of every pending migration
  inside one `session.transaction(...)`. `CREATE TABLE`, `ENABLE`/`FORCE`, the policies and the
  `REVOKE` therefore commit atomically — no interval in which `tenant_memberships` exists,
  `shortkit_app` holds its default-privilege DML, and no policy is installed.
- `REVOKE ALL PRIVILEGES ON <table>` does not reach column-level grants, but there are none to reach:
  the five tables are created in this same migration and `ALTER DEFAULT PRIVILEGES` grants at table
  level. A later column grant is caught by the `has_any_column_privilege` term (measured by the
  implementer against `GRANT SELECT (email) ON "user" TO shortkit_app`).
- `insertOwnedBy` on `tenant_memberships` is refused by RLS and not by the unique index or the FK:
  `ExecWithCheckOptions(WCO_RLS_INSERT_CHECK)` runs before `ExecInsertIndexTuples` and before AFTER
  triggers, so `42501` is what the harness sees — which is why `MEMBERSHIP_USER_PLANTED` being a
  third, unseeded user matters and is correct.
- FK integrity across the revoke holds: RI triggers switch to the referenced table's owner
  (`ri_PerformCheck` → `SetUserIdAndSecContext(relowner, … SECURITY_NOFORCE_RLS)`), so `shortkit_app`
  inserting a membership row with an FK into a `"user"` table it cannot `SELECT` still works. ADR-0050
  measured the same thing.

### `client.ts` — the second pool

- Both listeners on both pools, via one `attachConnectionListeners()`; the application pool's two
  label strings are byte-identical to the previous inline ones (`client-logging.spec.ts` matches on
  them).
- `'connect'` and not `'acquire'` preserved — the F-137 property survives the extraction.
- `closeDatabase()` ends both, `Promise.allSettled` so one rejecting `end()` cannot strand the other's
  backends, and both module-level handles are cleared before either `end()` is awaited.
- `authConnectionString()` has no fallback to `DATABASE_URL` in any branch.
- Caller list is five entries and the stale "`tenant-context.md` still names three" paragraph is gone.
  `tenant-context.md:325-335` does carry five. (But see **F-122**.)

### `check-policies.mts`

- `EXEMPT.size !== 5` runs before `pg.Client` is constructed, so a wrong list cannot be masked by a
  connection failure.
- The counting control reads **every** row of `pg_policies` in `public`, not a name list, and asserts
  the safe form is *present* rather than a blacklist absent. Verified the regex against the renderings
  in the implementer's captured `pg_policies` output: `NULLIF(current_setting('app.x'::text, true),
  ''::text)` matches; a one-argument `current_setting`, a `false` second argument, and a wrong
  sentinel all score `referenced > wrapped` and fail. `matchAll` on a `/g` regex clones the pattern,
  so no `lastIndex` carry-over between rows.
- Grant matrix is genuinely bidirectional: exempt ⇒ `auth_dml && !app_dml`, everything else ⇒
  `app_dml && !auth_dml`. `missingExempt` runs first, so an unmigrated database cannot report a
  satisfied matrix by contributing no rows. `has_any_column_privilege`'s list is the three
  column-grantable privileges, not four.

### The two new controls (read from disk — they are **not** in this diff; they landed in `3e1d785`)

- `apps/api/src/db/context-flag-owners.spec.ts` implements what the card specified: A4 with the
  contract's permitted list inherited verbatim (`statement_timeout`,
  `idle_in_transaction_session_timeout`, `app.*`) and **no independent `app.` prefix filter**; A1 in
  the subset direction, matched on the `{ flag, file }` pair (`flag <- file`) and not on the flag
  alone; a text scan, no AST; and a premise test that fails if the walk reads nothing. It lives under
  `src/**`, so `vitest.config.ts:10` collects it.
- The scan set now contains `membership-lookup.ts`'s three `set_config` first arguments plus its three
  docblock copies; all six pass A4, and the `app.membership_lookup_user` ones match the row
  `coverage.ts` gained in this diff.
- `apps/api/test/tenancy/warm-connection-no-context.int-spec.ts` scopes to
  `has_table_privilege(current_user, …, 'SELECT') OR has_any_column_privilege(current_user, …,
  'SELECT')`, both terms, `'SELECT'` only, on one long-lived `pg.Client` rather than through `psql`.
  It treats a raise as a defect and not as a denial.

### Clause A2 — the class the implementer found off-list

I re-ran the check the implementer describes over the whole of `apps/api/src` (excluding `*.spec.ts`).
`mentions(F)` for all four flags:

```
app.tenant_id              -> src/db/rls.ts, src/tenancy/tenant-context.ts
app.redirect_context       -> src/db/rls.ts
app.privileged_erase       -> src/db/rls.ts
app.membership_lookup_user -> src/db/rls.ts, src/auth/membership-lookup.ts
```

Every set is a subset of its permitted pair. `tenant-id-for-user.ts` holds no `app.` string, no
`set_config` and no `databaseTransaction` import (contract "must guarantee" 1). `rls.ts` holds no
`set_config` (A3). **No further instance of the stub-literal class in this diff.**

### The three inherited findings

- **F-001** — the `EXEMPT` docblock is corrected to five, names `jwks`, and states the failure the old
  wording invited. *Its sibling site two hundred lines down was missed — see F-120.*
- **F-009** — `controls.ts`'s `TENANT_ID` is now extracted from `tenantScopedPolicies('probe')` by a
  regex anchored on the emitted rendering, throwing **at import** when it cannot parse. I traced the
  regex against the emitted string by hand: the greedy `(.+)\)$` under `/m` yields exactly
  `nullif(current_setting('app.tenant_id', true), '')::uuid`. All 24 `TENANT_ID` uses in that file go
  through it and no raw `current_setting` survives outside a comment.
- **F-084** — the guard now checks `DATABASE_URL` and `DATABASE_AUTH_URL`, names three exports in the
  remedy, and passes both DSNs explicitly. `api-server.ts:178` spreads `process.env` then the
  callback, so explicit passing is additive and cannot drop `PORT` or anything else.

### `mutableValue` — no regression to the existing registrations

`spec.mutableValue ?? <old literal>` preserves the two **different** literals for every registration
that leaves it unset, which is required: `controls.ts:313` puts
`CHECK (label NOT IN ('planted-by-another-tenant', 'overwritten-by-another-tenant'))` on
`isolation_masked_refusal_canary`, and that constraint rejects `updateOwnedBy`'s literal only. Had
`mutableValue` collapsed both shapes onto one literal by default, that canary's unqualified write
would refuse with `23514` and hide the leak it exists to expose. It does not.

### Counts and rosters in `cross-tenant-isolation.int-spec.ts`

3 subjects × 8 shapes × 2 directions = 48; reads 12; writes 36; unqualified writes 18. All four moved.
`EXPECTED_SURFACE_IDS` sorts correctly with the new block between `RlsFixtureRows…` and `Tenants…`
(`'M'` 0x4D < `'s'` 0x73). The unqualified roster has each of `deleteAll`/`reparentAll`/`updateAll`
three times per direction; the refusal roster has `insertOwnedBy` three times per direction.
`protectionOf('tenant_memberships')` expecting `policies: 3` matches the three the migration installs.

---

## Findings

```yaml
verdict: changes-requested
findings:
  - severity: minor
    kind: implementation
    file: apps/api/scripts/check-policies.mts
    line: 384
    summary: >-
      A second stale site in the same file F-001 was filed against still says "for all four
      today" and still attributes the exempt tables to TASK-009; the fix landed on the docblock
      above the Map and not on this one.
    failure_scenario: >-
      The comment reads "the table isn't wrong, it just doesn't exist in this database yet
      (TASK-009, for all four today)". After migration 0001 there are FIVE exempt tables and all
      five exist, and TASK-009 left this initiative in the 2026-08-09 re-scope. This is the exact
      pair of false claims F-001 named — the count and the owning TASK — surviving in the same
      file, roughly 200 lines below the docblock the card sent the implementer to correct. The
      concrete harm is the one the corrected docblock spells out in its own text: a reader who
      counts from a comment instead of from the Map concludes the auth tables are absent and
      TASK-009's, and either adds a sixth entry or defers work that has already landed. The block
      this comment sits on (`neverExisted`) is also now unreachable in a migrated database, so
      nothing exercises the sentence and no test will contradict it.
    required_change: >-
      The `neverExisted` explanatory comment states the count and the owning TASK correctly, or
      states neither. Whatever wording is chosen must be true in the same commit as the docblock
      correction above it, since the two describe the same Map.

  - severity: minor
    kind: contract
    file: .sdlc/foundation/design/contracts/isolation-coverage.md
    line: 514
    summary: >-
      The fourth-flag amendment quotes `membershipLookupPolicy()` as emitting
      `FOR SELECT TO shortkit_app USING (...)`, a `TO` clause that neither ADR-0045,
      `tenant-membership-lookup.md`, `rls-policy-template.md`, `rls.ts` nor migration 0001
      carries. This diff amends the same file at two other sites and leaves this one.
    failure_scenario: >-
      Three artifacts now state the normative DDL for one policy and one of them states a
      different policy. `ADR-0045:89-91` and `tenant-membership-lookup.md:53-57` both emit no
      `TO` clause, and the shipped `membershipLookupPolicy()` matches them; this contract's
      justification paragraph shows a role-restricted form. A policy with no `TO` applies to
      PUBLIC and a policy with `TO shortkit_app` does not, so the two texts describe different
      grants of the token-mint escape — to `shortkit_migrator` under FORCE RLS today, and to any
      role added later. Concretely: a future implementer or auditor reconciling `pg_policies`
      against this contract finds a mismatch on a policy that is correct, or "corrects" the
      shipped policy to match the quote and silently narrows the escape's applicability. The
      implementer raised this in `work/TASK-002-report.md` note 1 and declined to resolve it by
      inference, which was the right call and leaves the resolution owed.
    required_change: >-
      One text for this policy across the four artifacts. Either the `TO shortkit_app` clause is
      normative — in which case ADR-0045, `tenant-membership-lookup.md`,
      `rls-policy-template.md`'s approved set and `rls.ts` all carry it and a new migration
      recreates the applied policy — or it is not, and this paragraph's quotation drops it. The
      contract is the architect's; this is reported, not routed.

  - severity: minor
    kind: contract
    file: .sdlc/foundation/design/contracts/tenant-context.md
    line: 366
    summary: >-
      "the set of files containing the string `databaseTransaction` equals exactly those four
      paths" sits directly under a table that lists five, so the assertion TASK-056 is told to
      implement is specified one path short.
    failure_scenario: >-
      TASK-056 implements the sentence at :364-368 literally, as the surrounding text tells it to
      ("File-level and by grep, like isolation-coverage.md clauses A1 to A3"). Over
      `apps/api/src/**/*.ts` excluding `*.spec.ts` and `client.ts`, the files containing
      `databaseTransaction` are `tenancy/tenant-context.ts`, `redirect/db/redirect-read.ts`,
      `gdpr/privileged-eraser.ts`, `db/rls.ts` AND `auth/membership-lookup.ts` — five, as of this
      commit. An equality assertion written from the sentence is red on the day it lands, and the
      cheap way to make a red build green is to drop a path from the expected list, which is
      precisely the escape the list exists to prevent. TASK-002's card rules this file "ALREADY
      CORRECT — do not edit" on the strength of two other sites in it, which is what let this one
      survive; it is outside this diff's changed files.
    required_change: >-
      The sentence names five paths, matching the table above it, or is written to derive from
      that table rather than restate its length.

  - severity: minor
    kind: implementation
    file: apps/api/test/isolation/registrations.ts
    line: 692
    summary: >-
      The F-295 census assertion passes only because `tenantMembershipsAccess` is the LAST
      registration; `createRlsFixture()` — the reset for both earlier subjects — cascades every
      `tenant_memberships` row away, and nothing in the file records that the order is
      load-bearing.
    failure_scenario: >-
      `createRlsFixture()` (`test/support/rls-fixture.ts`) runs `eraseFixtureTenants` against
      `tenants`, and `tenant_memberships.tenant_id` is `ON DELETE CASCADE`, so every reset of
      `tenantsAccess` or `rlsFixtureRowsAccess` deletes both seeded membership rows.
      `coverage.ts:1211` runs `registration.reset()` at the start of every attempt and
      `coverage.ts:1437` iterates the registry Map in insertion order, so the last reset of a run
      today is `createMembershipFixture` and the two rows are back. Register a fourth subject
      after line 693 — the ordinary way this file grows — or make any change that leaves a
      `createRlsFixture`-only reset running last, and
      `"F-295: each tenant sees exactly its own row in every registered table"` returns four
      census lines where six are expected, naming the two literal membership row ids as missing.
      The failure is loud rather than silent, and the diagnosis ("a table was seeded and then
      cascaded away by another subject's reset") is not derivable from the assertion. Note that
      the reverse coupling is already handled: `createMembershipFixture` calls `createRlsFixture`
      first, and its docblock says why.
    required_change: >-
      Either the coupling is stated where a future registration will be written — that a reset
      erasing `tenants` cascades every other registered table's rows, so a subject whose fixture
      depends on `tenants` must be registered after every subject that erases it — or the
      dependency is removed so registration order stops deciding whether the census holds.

  - severity: nit
    kind: implementation
    file: docs/architecture/rls.md
    line: 169
    summary: >-
      The "What checks what" row for `db:check-policies` was updated to three of its four
      assertions and omits the `EXEMPT.size !== 5` length control.
    failure_scenario: >-
      The row now reads "missing ENABLE or FORCE; a policy referencing a context flag outside
      nullif(<flag>, ''); a table on the wrong side of the grant matrix". `check-policies.mts`
      also fails on `EXEMPT.size !== EXPECTED_EXEMPT_COUNT`, which ADR-0044 and the script's own
      docblock both call "the whole of the security argument" for the RLS-exempt tables, and
      which is the one assertion that runs before the connection opens. A reader auditing what
      protects the exemption list from a sixth entry finds nothing here.
    required_change: >-
      The row names all four assertions, or names none and points at the script.
```

---

## Cannot verify from diff

1. **`shortkit_auth` itself.** Its existence, `CONNECT` on the database, `USAGE` on schema `public`,
   and that it is not a member of any role holding DML on a tenant-scoped table are all TASK-018's
   (wave 0) and appear nowhere in this diff. Migration `0001`'s `GRANT` and `check-policies.mts`'s
   `has_table_privilege('shortkit_auth', …)` both depend on it. Worth noting for whoever holds
   TASK-018: if the role is absent, the grant-matrix query raises `42704` inside `main()`'s `try`,
   which propagates past the `finally` as an unhandled rejection rather than as one of this script's
   named `FAIL:` lines — non-zero exit, but a stack trace instead of a remedy.
2. **CI and compose provisioning.** Whether `.github/scripts/provision-test-database.sql`,
   `docker-compose.yml` and `docker-compose.test.yml` carry `shortkit_auth` and `DATABASE_AUTH_URL`
   (ADR-0050's follow-up table assigns all three to TASK-018, wave 0). This diff makes
   `security-headers.int-spec.ts` throw when `DATABASE_AUTH_URL` is unset, so a shell or CI job that
   lacks the variable turns that file red **even though nothing in wave 1 constructs the auth pool**
   (`betterAuthDatabase()` has no caller until TASK-003). That is what the card asked for and it is
   fail-fast rather than wrong, but it makes a wave-0 artifact load-bearing for a wave-1 test file.
3. **ADR-0046's residual constraints** — `transaction: false`, the one-caller rule, and the model-map
   wiring — cannot be checked here: `betterAuthDatabase()` has no consumer in this diff. Only its
   construction (second pool, second DSN, max 5, both listeners, ended by `closeDatabase()`) is
   verifiable, and that part is correct.
4. **AC-4's mint-path clause.** The card's own frontmatter records it: the "no JWT is returned" half
   needs `definePayload`, which is TASK-003. This card covers `tenantIdForUser` throwing, which it
   does.
5. **`main.ts`'s third boot precondition** (`AUTH_VERDICT_PREFIX`, `assertAuthRoleSeparation`) is
   TASK-004, wave 3 per ADR-0050's follow-up table — correctly absent here, but that means nothing at
   boot yet asserts the grant matrix; only CI's integration job does.
6. **The two control specs** are not in the review package. I read them on disk
   (`apps/api/src/db/context-flag-owners.spec.ts`, `apps/api/test/tenancy/warm-connection-no-context.int-spec.ts`,
   both from commit `3e1d785`) and they implement what the card specified; but their authorship and
   their green result belong to the test architect, not to this diff.

---

## Notes

- **`TENANT_ID_COLUMN_SQL` "character for character" is not literally met, and I do not think it
  should be forced.** `tenant-membership-lookup.md:33-34` asks for the literal string;
  drizzle-kit emits `"tenant_id" uuid NOT NULL` plus a separately named
  `ALTER TABLE … ADD CONSTRAINT tenant_memberships_tenant_id_tenants_id_fk … ON DELETE cascade`.
  The three properties the constant exists for — `uuid`, `NOT NULL`, FK to `tenants(id)` with
  `ON DELETE CASCADE` — all hold, `pg_attribute` sees the column, and AC-90's cascade works. Nothing
  in the repository checks the text. The implementer declined to hand-edit generated structural DDL
  and said so; I agree, and record it so the contract's wording is not read later as an unmet
  obligation. If the wording is meant to bind, it is the contract that should relax to naming the
  properties.
- **`rls.ts`'s header claims "Each schema file exports its policy SQL built from here."** Neither
  `tenants.ts` nor the new `tenant-memberships.ts` does. Pre-existing, not introduced here, and
  `tenant-memberships.ts` matches its neighbour — flagged only so it is not mistaken for a gap this
  card opened.
- **`rls-policy-template.md`'s "Tables covered" table** still attributes `tenant_memberships` to TASK
  013 and `user, session, account, verification` to TASK 009, and omits `jwks` from that row. Stale
  against the 2026-08-09 re-scope and against this commit; outside this diff, and the architect's.
- **The exclusion-count sites all moved.** Sites 1-4 (`rls.ts:72`, `rls.ts:87`, `rls.ts:10-19`,
  `coverage.ts:490-499`) are in the diff; sites 6 and 7 (`isolation-coverage.md`'s section, its length
  assertion, and invariant 5 at :1195) are also in the diff, despite the implementer's report saying
  they were left undone — they landed in `86c6b2b`. Site 5 (`tenant-context.md`) was already correct
  on the two things the card named, and F-122 above is a third, different site in that file.
- **Cost, not a defect:** `createMembershipFixture` runs `createRlsFixture()` — which drops and
  recreates `rls_fixture_rows` and re-applies its policies — plus three more `psql` process spawns,
  once per attempt, and the membership subject has sixteen attempts plus post-write resets. That is
  the largest single addition to the isolation suite's wall time in this commit.
- **`closeDatabase()` after a cached handle:** `auth.config.ts` (TASK-003) will call
  `betterAuthDatabase()` once at module init and hold the returned handle, so a `closeDatabase()`
  followed by continued use would query an ended pool. The application pool does not have this shape
  because `databaseTransaction` re-enters `client()` on every call. Not a defect in this diff —
  `closeDatabase()` is a shutdown path — but it is a property TASK-003 should not be surprised by.
