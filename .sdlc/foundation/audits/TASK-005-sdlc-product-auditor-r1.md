# TASK-005 Product Audit — AC-8, AC-9, AC-10, AC-11

> Returned inline by `sdlc-product-auditor` and persisted verbatim by the orchestrator on
> 2026-08-05. Review package: `.superpowers/sdd/TASK-005/review-e6166a9..eed8e90.diff`.

## Scope note

Read-only review of the diff (`review-e6166a9..eed8e90.diff`), the frozen suite (`tenant-context.int-spec.ts`, `rls-fixture.ts`, `psql.ts`), production `src/db/rls.ts`, `src/db/client.ts`, `src/tenancy/tenant-context.ts`, both contracts, ADR-0002/0003, the implementer's report, and `findings.yaml` F-116..F-119. I did **not** run the suite, build, or connect to a database myself — I'm relying on the orchestrator's stated 6/6 integration result and reading the code/tests for whether that pass is meaningful, per the brief.

## The core question: does the fixture exercise production enforcement, not application politeness

Confirmed. `apps/api/test/support/rls-fixture.ts:34` imports `TENANT_ID_COLUMN_SQL` and `tenantScopedPolicies` from `../../src/db/rls` (production), and `createRlsFixture()` (rls-fixture.ts:153) applies the fixture table's policies by calling `tenantScopedPolicies(RLS_FIXTURE_TABLE).statements.join('\n')` — the exact function under test, not fixture-authored SQL. `apps/api/src/db/rls.ts`'s implementation matches `rls-policy-template.md`'s per-table template verbatim, including the load-bearing `current_setting(name, true)` (NULL on unset → deny, which is what AC-10 needs). The fixture also guards its own premise (`assertAppRoleCannotBypassRls`) before every run. This holds up: the six tests exercise Postgres enforcing the shipped policy, through the shipped `withTenantTransaction`, not a mock or fixture SQL standing in for either.

## AC verification

```yaml
ac_verification:
  - id: AC-8
    status: met
    evidence: apps/api/test/tenancy/tenant-context.int-spec.ts::"AC-8: a read inside tenant A's transaction returns A's row and not B's"
    note: >-
      Unfiltered SELECT through production withTenantTransaction; isolation comes from
      the USING clause of tenantScopedPolicies() (rls.ts:450), not an app-level WHERE.
  - id: AC-9
    status: met
    evidence: >-
      apps/api/test/tenancy/tenant-context.int-spec.ts::"AC-9: an insert carrying
      tenant B's tenant_id is refused..." and "...an update of tenant B's row affects
      zero rows..."
    note: >-
      Insert test asserts real Postgres 42501 (insufficient_privilege from WITH CHECK),
      reachable only because client.ts:370 unwraps DrizzleQueryError.cause — without that
      unwrap the assertion would read `undefined` per the implementer's own repro. Update
      test asserts rowCount 0 via the USING clause. Both then re-read as tenant B to
      confirm no row was planted. One reading of AC-9 not covered by the frozen suite: an
      UPDATE that re-parents A's *own* row by setting its tenant_id to B is not exercised;
      the same WITH CHECK clause that the insert test proves would reject it, so this is a
      test-coverage note, not a code defect — flagged below, not a blocker.
  - id: AC-10
    status: met
    evidence: >-
      apps/api/test/tenancy/tenant-context.int-spec.ts::"AC-10: a read issued outside
      any tenant-context transaction returns zero rows"
    note: >-
      Issued via raw psql (test/support/psql.ts), not through withTenantTransaction at
      all — which is actually the stronger form of evidence for this AC: it shows
      Postgres denies an unscoped session regardless of how the query was issued, not
      only when the application's own helper happens to ask nicely.
  - id: AC-11
    status: met
    evidence: >-
      apps/api/test/tenancy/tenant-context.int-spec.ts::"AC-11: a throw inside the
      wrapped function rolls the transaction back" and "...tenant context does not leak
      to the next transaction after a throw"
    note: >-
      First test proves rollback by row absence after commit, not merely by catching the
      rethrow — genuine evidence. Second test proves no session-level leak by reading
      tenant B immediately after a failed tenant-A call. This relies on the `pg.Pool`
      actually reusing the same idle connection across the two sequential calls (no
      `max: 1` or explicit connection pinning in client.ts); node-postgres's LIFO idle
      reuse makes this reliable under sequential execution but it is an implicit
      assumption, not a guarantee the code enforces. Worth noting, not disqualifying —
      it is exactly the verification method AC-11 itself specifies.
```

## Findings

```yaml
findings:
  - severity: minor
    kind: test-coverage
    file: apps/api/src/tenancy/tenant-context.ts
    line: 704
    summary: >-
      Nesting semantics (contract invariants 5 and 6 — same-tenant nesting reuses the
      outer transaction and defers afterCommit until the real COMMIT) are implemented
      but exercised by zero tests, unit or integration.
    failure_scenario: >-
      A future regression in the nested branch (e.g., afterCommit firing before the
      outer commit, or a savepoint silently introduced) would pass every currently
      existing test, since none calls withTenantTransaction from inside another.
    required_change: >-
      Not TASK-005's to fix — apps/api/test/** belongs to sdlc-test-architect. Flagging
      so it lands somewhere before a caller (e.g. TASK-054's GDPR flow) depends on it.
  - severity: minor
    kind: test-coverage
    file: apps/api/test/tenancy/tenant-context.int-spec.ts
    line: 104
    summary: >-
      AC-9's UPDATE test targets an existing B-owned row; it does not cover the
      re-parenting case (updating A's own row to carry tenant_id = B), which is also
      "an update... carrying tenant B's tenant_id" on one reading of the AC text.
    failure_scenario: >-
      Low risk in practice — the same WITH CHECK clause the insert test proves rejects
      this case too — but the frozen suite doesn't demonstrate it, so a regression
      specific to UPDATE's WITH CHECK path (as opposed to INSERT's) would not be caught.
    required_change: Note for whoever next touches this suite; not a TASK-005 defect.
```

Neither finding blocks AC-8..AC-11 as written; both are test-coverage observations against contract invariants, not evidence the implementation fails the ACs.

## The seven disclosed additions (report §4)

| # | Item | Verdict |
|---|---|---|
| 1 | `redirectReadPolicy()` | **Contract-mandated.** Pre-existing stub in `design/stubs/apps/api/src/db/rls.ts` with `Produced by: TASK-005` header, inside TASK-005's own paths. Completing it is not scope creep, it's finishing the file. |
| 2 | `assertRuntimeRoleCannotBypassRls()` | **Contract-mandated to implement**, per the same stub and `tenant-context.md`'s "Boot-time assertion." Correctly implemented. The gap is that nothing calls it — already filed as **F-116, major, escalated**, and I agree with that severity: it's the one condition that makes STORY-003's "isolation is structural, not remembered" claim actually true in production, and it currently isn't wired to anything. Not re-filing. Does not affect AC-8..AC-11 as written, since none of the four test boot behavior. |
| 3 | `tenantDb()` / `currentTenantId()` | **Contract-mandated.** Pre-existing stubs; ADR-0002's follow-ups explicitly assign them to TASK-005 by name. |
| 4 | `closeDatabase()` | **Not contract-mandated** — no stub, no ADR, no contract names it. Genuinely unrequested, but low-risk: 8 lines, encapsulated in the one file TASK-005 exclusively owns, currently dead code (no caller, no test). Acceptable to carry forward; flag if it starts accumulating more untested surface. |
| 5 | `afterCommit` deferral on nested calls | **Contract-mandated.** Contract invariants 5 and 6 are only jointly satisfiable this way. The concern isn't that it was built, it's that it's completely untested (see finding above). |
| 6 | `assertTableName()` | **Not contract-mandated.** Defensive validation in the one module that builds SQL by concatenation of table names. Acceptable — inputs are hardcoded schema table names today, so the guard is currently unreachable in practice, but it's cheap insurance against a future caller passing something unsanitized. |
| 7 | `allowExitOnIdle: true` | **Not contract-mandated.** Standard `pg.Pool` operational default to prevent hung processes. Acceptable, no risk. |

Items 4, 6, 7 are the genuine "shipped but not asked for" set — all small, all contained, none material.

## AC-12

Confirmed out of scope for this diff. Nothing in `apps/api/src/db/**` or `apps/api/src/tenancy/tenant-context.ts` touches an isolation-harness/reporting concern (pass/fail per repository method, method enumeration). AC-12 remains untouched, correctly, as TASK-006's.

## The three unbuilt deliverables (F-117)

`docs/architecture/rls.md`, `docs/architecture/migrations.md`, `db:check-policies` — none of the three affect AC-8, AC-9, AC-10, or AC-11 as written; none of those ACs mention documentation or a policy-checking script. One correction to the framing I was given: **GC-13, as actually written in `plan.md`, reads `docs.required: [README]`, sole producer TASK-001** — it does not itself obligate `docs/architecture/*.md`. The real hook for those two documents is `STORY-003`'s own Definition of Done line, "Docs updated (README / API / ADR consequences)," plus ADR-0003/ADR-0004's prose follow-ups naming TASK-005 as producer — both of which sit outside TASK-005's `paths`. That's a routing question, already correctly escalated as F-117 (minor). `db:check-policies` additionally can't be built honestly yet since it's specified against `tenantScopedTables()`, which is TASK-053's and doesn't exist — the implementer's choice not to fake an enumeration is the right one. All three are Juano's scope calls to make, not gaps in this TASK's acceptance.

## Shipped but not asked for

`closeDatabase()`, `assertTableName()`, `allowExitOnIdle: true` — see table above. All acceptable, all low-risk, none contract-mandated.

## Out-of-scope items that got built

None found. TASK-005 did not touch `RequestContext`, `Public()`, `NoTenantTransaction()`, or `TenantScopedRepository()` in `tenant-context.ts` — verified by reading the current file end-to-end; those remain TASK-011's untouched stubs. No AC-12 territory was entered. No domain table other than `tenants` was added.

## Verdict

AC-8, AC-9, AC-10, and AC-11 are each met by tests that genuinely exercise Postgres enforcing the shipped `tenantScopedPolicies()` through the shipped `withTenantTransaction`, not application-level convention standing in for database enforcement. The two test-coverage notes above and the already-escalated F-116 (unwired boot check) are real but don't bear on these four ACs as written.

**APPROVED**
