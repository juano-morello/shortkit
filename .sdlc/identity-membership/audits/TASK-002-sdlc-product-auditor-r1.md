# TASK-002 — product audit, round 1

Initiative `identity-membership`, wave 1, STORY-001.
Diffs audited: `f6ac5fd..86c6b2b` (the card) and `86c6b2b..86b48d9` (fix round 1).
Criteria claimed: **AC-2** (whole), **AC-4** (this card's half only — the mint-path clause is
TASK-003's, wave 2).

Nothing was executed for this audit: the dispatch supplied the run results (236 unit,
80/80 integration, typecheck 0, lint 0, build green, `db:check-policies` green, view control
planted-and-caught-and-dropped) and asked that they not be re-run. Every judgement below is
read off the diff, the specs and the migrated DDL as committed. Where I could not verify
something from those, I say so rather than inferring it.

---

```yaml
verdict: changes-requested
ac_verification:
  - id: AC-2
    status: met
    evidence: |
      apps/api/drizzle/0001_cute_doomsday.sql:63 —
        CONSTRAINT "tenant_memberships_user_unique" UNIQUE("user_id")
      apps/api/src/db/schema/tenant-memberships.ts:68 — unique('tenant_memberships_user_unique').on(table.userId)
      apps/api/test/auth/tenant-memberships.int-spec.ts:130 —
        "AC-2: a second membership for the same user is refused by tenant_memberships_user_unique"
        asserts { code: '23505', constraint: 'tenant_memberships_user_unique' }
      apps/api/test/auth/tenant-memberships.int-spec.ts:157 —
        "AC-2: the table still holds exactly one row for that user" asserts
        { underTenantA: 1, underTenantB: 0 }
    note: |
      Both clauses have real assertions and the constraint is named, not merely implied by a
      23505. Two structural weaknesses in HOW the conjunction is discharged — see F-134. They
      do not change the verdict on this AC: a unique violation aborts the transaction, and the
      first test rolls it back explicitly, so the second clause cannot be false while the first
      is true. The AC's "under any tenant" is exercised for a DIFFERENT tenant only; the
      same-tenant case is not attempted anywhere.
  - id: AC-4
    status: partial
    evidence: |
      This card's half — `tenantIdForUser` throwing, the primary stop ADR-0015 names:
        apps/api/src/auth/tenant-id-for-user.ts:99-101 — throws NoTenantMembershipError when
          the row set is empty; never returns null, never returns ''
        apps/api/test/auth/tenant-memberships.int-spec.ts:175 —
          "AC-4: a user with no membership row is rejected with NoTenantMembershipError, never a
          null or empty tid" — asserts the WHOLE outcome object with toEqual, so a resolved
          null or '' reads as { resolved: null } and fails. This is the right shape.
        apps/api/test/auth/tenant-memberships.int-spec.ts:164 — the positive case on a WARM
          pooled connection, the assertion that fails without ADR-0049's nullif
        apps/api/src/auth/tenant-id-for-user.spec.ts:38,46,56,66 — the error's name, its
          .userId, the eight-character-prefix message rule, and that it carries no second field
    note: |
      NOT MET AS WRITTEN, and deliberately so. AC-4 reads "when a JWT is minted for a session
      belonging to that user, then minting fails with NoTenantMembershipError, NO JWT IS
      RETURNED, and the caller receives an error rather than a token with an absent tid."
      Nothing in this diff mints anything. `tenantIdForUser` has no caller in the repository —
      `definePayload` is TASK-003's, wave 2 — so the clauses "no JWT is returned" and "the
      caller receives an error rather than a token with an absent tid" have zero evidence here
      and cannot have any. What is proven is the precondition: the function throws rather than
      resolving to a falsy tid. Whether that throw becomes a failed mint or a swallowed error
      and a token with no `tid` is entirely TASK-003's code, unwritten.
      Four test titles in this card carry the "AC-4:" prefix and all four are green. At a Ship
      gate read by AC id, AC-4 looks discharged. It is not. See F-132.
findings:
  - severity: major
    kind: test
    file: apps/api/test/auth/tenant-memberships.int-spec.ts
    line: 197
    summary: >-
      F-133. The lookup policy's narrowing — the whole justification for isolation exclusion 3 —
      is asserted against a table that holds exactly one row, so the "and no other tenant" half
      of the control cannot fail. `USING (true)` on tenant_memberships_membership_lookup passes
      this test.
    failure_scenario: >-
      `seedUsersAndOneMembership()` (:51) inserts ONE membership row, for USER_WITH_A_MEMBERSHIP
      under TENANT_A; the orphan user gets none, and `createRlsFixture()` in `beforeEach` erases
      the fixture tenants, which cascades any membership row left by another suite. So when
      "tenant-membership-lookup.md control 2" reads `SELECT user_id, tenant_id FROM
      tenant_memberships` with `app.membership_lookup_user` set to user A, the only row that
      exists is A's. The assertion `toEqual([{ user_id: A, tenant_id: TENANT_A }])` is then
      satisfied by any policy that admits anything at all.
      The contract states the control as "returns exactly A's row AND NOT TENANT B'S"
      (tenant-membership-lookup.md:268-269). The second conjunct is vacuous as shipped.
      This matters more than a normal vacuous assertion: ADR-0045's exclusion is justified in
      `ISOLATION_EXCLUSIONS` by the claim that the policy "admits one user_id", the isolation
      harness never sets that flag (registrations.ts:615-628 says so explicitly and treats it
      as a property proven elsewhere), and `db:check-policies` only counts nullif wrappers — it
      cannot see which column a predicate compares against and says so at
      check-policies.mts:"A SYNTACTIC CONTROL OVER A RENDERED EXPRESSION IS STILL A PROXY".
      A widened lookup policy — `user_id IS NOT NULL`, a mistyped column, a copy that compares
      `tenant_id` — is therefore invisible to every control in the initiative, and it is the
      one policy that reads a tenant-scoped table with no tenant context.
    required_change: >-
      Seed a SECOND membership row before that control — a different user under TENANT_B, which
      the unique constraint permits — and assert the flagged read still returns exactly A's row.
      The same fixture makes the "warm zero rows" control (:216) discriminating too: it would
      then be zero of two rather than zero of one.
  - severity: minor
    kind: behavior
    file: apps/api/src/auth/tenant-id-for-user.ts
    line: 77
    summary: >-
      F-132. AC-4's mint-path clauses have no evidence in this card and cannot get any here, but
      four green tests are titled "AC-4:" — the AC reads discharged when half of it is unbuilt.
    failure_scenario: >-
      A Ship-phase reader checking ACs against test titles finds AC-4 green in wave 1. If
      TASK-003's `definePayload` catches the throw and mints a token without `tid`, or lets the
      rejection escape into a 500 with no error contract, AC-4's actual text — "no JWT is
      returned, and the caller receives an error rather than a token with an absent tid" — is
      false in production while the suite stays green. The card's own frontmatter (:35-39)
      records this and asks for a second test in TASK-003's wave; nothing enforces it.
    required_change: >-
      TASK-003 carries a test that mints for a session whose user has no membership row and
      asserts (a) no token is returned and (b) the caller receives an error. AC-4 stays open in
      the ledger until that test exists; it is not closable on this card's evidence. Judged
      against the AC as written, this card's contribution is a precondition, not the AC.
  - severity: minor
    kind: test
    file: apps/api/test/auth/tenant-memberships.int-spec.ts
    line: 157
    summary: >-
      F-134. AC-2 is one sentence with two conjuncts and it is discharged by two independent
      `it`s with a `beforeEach` re-seed between them, so the "still holds exactly one row"
      assertion never observes the post-rejection table.
    failure_scenario: >-
      The count test runs on freshly seeded state in which no second insert was ever attempted.
      It would pass identically if the refusal test did not exist. Today the gap is harmless —
      the refused INSERT is inside a transaction the test ROLLBACKs at :149, and a 23505 aborts
      the transaction regardless — but the AC's conjunction is not what is being asserted, and
      a later edit that made the insert autocommit (or a DEFERRABLE constraint) would leave the
      second clause unasserted with nothing red.
      Related and smaller: AC-2 says "inserted under any tenant". Only the cross-tenant case
      (TENANT_B) is attempted. A second row for the same user under the SAME tenant — the shape
      a buggy signup retry actually produces — is attempted nowhere.
    required_change: >-
      Assert the count inside the same `it` as the refusal, after the ROLLBACK, so the sentence
      is tested as one sentence; and add the same-tenant duplicate as a second refusal case.
  - severity: minor
    kind: process
    file: apps/api/test/isolation/cross-tenant-isolation.int-spec.ts
    line: 402
    summary: >-
      F-135. This card's commit changes assertions in a file the card forbids it to edit and
      whose assertions it assigns to TASK-015 — eight hunks, including four hand-derived counts,
      three rosters and the F-295 census.
    failure_scenario: >-
      TASK-002.md:294-296 reads "Do not edit any file under apps/api/test/isolation/*.int-spec.ts.
      Your isolation work is the registrations.ts entry and the coverage.ts count, nothing else",
      and `test_files` records the file as "registration only — the assertions there are
      TASK-015's". 86c6b2b nonetheless carries 32→48, 8→12, 24→36, the eighteen-element
      unqualified-write roster, the six-line census, the six-element refusal roster and two
      report-artifact lengths.
      `work/TASK-002-report.md:330-360` shows the implementer identified these, declined to make
      them, and listed the required edits; the fix-round section (:465) attributes them to the
      test architect landing inside 86c6b2b. **I cannot verify that attribution from the diff** —
      every commit in the range has the same author and the edits are indistinguishable from the
      implementer's. The consequence that survives either way: TASK-015's declared scope now
      partially exists, and no card records that.
      The edits themselves are correct and not weakened — 3 tables x 8 shapes x 2 directions = 48,
      reads 12, writes 36, unqualified writes 18, all consistent with the 2-table values they
      replace, and no assertion was converted from a literal to a derivation (F-293 already read
      `EXPECTED_SURFACE_IDS`, which is in this card's paths).
    required_change: >-
      Record the ruling on TASK-002.md that made these edits admissible and who made them, and
      re-scope TASK-015 against what is now already in the file, so its own audit does not judge
      shipped work as missing.
  - severity: minor
    kind: process
    file: .sdlc/identity-membership/tasks/TASK-002.md
    line: 12
    summary: >-
      F-136. The card's `paths` declares `apps/api/src/db/schema/auth.spec.ts` — the exact
      location F-045 forbids the file to occupy — while the file that actually exists and that
      this commit edits, `apps/api/src/db/auth-schema.spec.ts`, is in NO card's paths across the
      initiative.
    failure_scenario: >-
      Verified by grep over `.sdlc/identity-membership/tasks/`: `auth-schema.spec.ts` appears
      only in TASK-002's prose (:249), never in a `paths` list; `schema/auth.spec.ts` appears in
      TASK-002's paths and names a file that does not and must not exist (drizzle-kit
      `require()`s every match of `./src/db/schema/*.ts`, so a vitest import there breaks
      `db:generate`).
      86c6b2b edits the undeclared file — the two type defects whose removal makes AC-8's second
      clause true. This is the fourth instance of the same class in this initiative (F-002,
      F-010, F-032 widenings, F-084): a file edited that no card's paths reach, each found by a
      different reader in a different round. The parallel-safety argument that `paths` exists to
      support is unverifiable for a file nobody declared.
    required_change: >-
      Replace the `schema/auth.spec.ts` entry with `apps/api/src/db/auth-schema.spec.ts` and
      re-check that no other card claims it.
  - severity: nit
    kind: docs
    file: .sdlc/foundation/design/contracts/isolation-coverage.md
    line: 480
    summary: >-
      F-137. The amended "Exclusions: exactly three" section bumps the assertion to
      `toHaveLength(3)` inside a code block that still shows only two exclusion entries.
    failure_scenario: >-
      The block now reads as a snippet that cannot be true of itself: two array elements, an
      assertion demanding three. A reader copying the contract's own sample as the source of
      truth writes a red test. The shipped `coverage.ts` has all three entries, so this is the
      contract disagreeing with the code it specifies, not a code defect.
    required_change: >-
      Add the third entry (`repo:TenantMembershipLookup.tenantIdForUser`) to the sample block, or
      elide the array body so the block is not read as exhaustive.
  - severity: nit
    kind: behavior
    file: apps/api/scripts/check-policies.mts
    line: 214
    summary: >-
      The relation-kind enumeration is still an enumeration. `DERIVED_RELATIONS` covers 'v' and
      'm'; `TABLES`, `TENANT_ID_COLUMNS` and `GRANT_MATRIX` cover 'r' and 'p'. A foreign table
      ('f') is in neither set — the same shape as F-109, one relkind further out.
    failure_scenario: >-
      A `public` foreign table would be absent from the ENABLE/FORCE check, the grant matrix and
      the view check alike, and `warm-connection-no-context.int-spec.ts` scopes on
      ('r','p','v','m') too. I have NOT verified whether the compose image makes this reachable:
      creating a foreign table needs an FDW extension, `CREATE EXTENSION` needs superuser, and
      whether `shortkit_migrator` is one is not something I checked. So this is recorded as a
      residual enumeration risk with an unverified premise, not a measured bypass.
    required_change: >-
      None demanded. If it is cheap, assert instead that `relkind` in `public` is a subset of the
      kinds these queries know, so the next unenumerated kind fails loudly rather than silently.
```

---

## Judgement on the fix round's change of control shape

The dispatch asked specifically whether replacing the `relkind` widening with a
`security_invoker` rule still discharges what the card asked. **It does, and mechanically
widening `GRANT_MATRIX` would not have.**

The card asked for one thing here: the grant matrix over the exempt/tenant-scoped TABLES, in
both directions. That is `GRANT_MATRIX` at check-policies.mts:130-141 and it is intact and
unchanged by the fix round — still `relkind in ('r','p')`, still `has_table_privilege` OR'd
with `has_any_column_privilege`, still the three-privilege column list, still the
all-five-EXEMPT-present guard. The card's ask is discharged by that query and by nothing in the
fix round.

The fix round's addition is a separate rule for a relation kind the card never mentioned. The
implementer's reasoning that widening `GRANT_MATRIX` to `('r','p','v','m')` would have made the
attack view **pass** is correct as written: the matrix's rule is "EXEMPT name ⟺ auth-only, else
app-only", a view carries no EXEMPT name, so `auth_peek` lands in the `else` branch, which
*requires* `app_dml = true` — the grant that makes it a bypass would have been the grant that
satisfied the check. A widened filter there would have been strictly worse than none: covered on
the face of it, licensing the attack underneath.

The replacement rests on the property that distinguishes safe from unsafe rather than on a name
list, and both halves are measured in the report (plain view returned the token; `security_invoker`
view answered 42501; materialised view returned the token). Two of the four `relkind` sites are
deliberately left at `('r','p')` with the reason recorded in each query's docblock, and both
reasons hold: RLS is not a property a view has, and `TENANT_ID_COLUMNS` must describe the same
set `TABLES` iterates or the exemption cross-check compares against a different population.
`derivedRelationBypass` asserts no positive direction, which is right — views carry no default
privilege, so "nobody granted it" is the normal state.

Two limits worth stating, neither a defect:

- **The control is armed, not exercised.** Zero views exist, so `derived` is empty on every real
  run and the OK line reads "of 0 view(s), none reaches past a runtime role". Its only evidence
  is the planted-and-dropped probe in the report and Juano's own replication. No committed test
  fires it. If views ever matter, a fixture view belongs in the integration suite.
- **The truthy-spelling enumeration** (`true|on|1|yes`) is an enumeration over values Postgres
  stores verbatim, and it fails safe: an unknown spelling reads as not-invoker and goes red.

---

## Shipped but not asked for

Nothing here is a leak or a feature. All of it is control surface, and all of it is
finding-routed rather than card-routed — worth naming because the card is the agreed scope and
none of this was in it.

1. **The whole view / materialised-view control** — `DERIVED_RELATIONS`, `derivedRelationBypass`,
   the failure block, the `('r','p','v','m')` widening in
   `warm-connection-no-context.int-spec.ts`, and two paragraphs in `docs/architecture/rls.md`.
   Routed by F-109 in the fix round, not by TASK-002. Correct work; it belongs in the ledger as
   F-109's remediation, not as this card's deliverable.
2. **Two POSITIVE directions in the grant matrix.** The card asked for two negative directions —
   "`shortkit_app` holding none of SELECT,INSERT,UPDATE,DELETE" on the exempt five, and
   "`shortkit_auth` holding none of the same" on the tenant-scoped tables. The shipped predicate
   (`exempt ? !auth_dml || app_dml : !app_dml || auth_dml`) also fails when an exempt table is
   *unreachable by* `shortkit_auth` or a product table is *unreachable by* `shortkit_app`. The
   docblock calls these "availability, not security" and is right; they are two extra ways for
   `db:check-policies` to go red that nobody asked for. Low risk (default privileges make the
   product-table direction true automatically), stated because it is scope.
3. **`resetTenantFixtures` replacing `createRlsFixture` as the reset for the OTHER two
   registrations** (`tenantsAccess`, `rlsFixtureRowsAccess`). Routed by F-123. It changes the
   per-attempt cost of two subjects that had nothing to do with this card, 48 attempts over. The
   report measures the suite at 4m59s before and after, so the cost is real and paid for.
4. **`attachConnectionListeners` extracted from `client()`.** A refactor of shipped code, not
   requested; justified as "the strongest available reading of verbatim" for ADR-0050's
   both-pools requirement, and `client-logging.spec.ts` pins the application pool's two log
   strings, which are byte-identical. Fine, but it is a shipped-file refactor inside a feature
   card.
5. **`closeDatabase()` semantics changed**, not just extended: `Promise.allSettled` on both ends
   with the application pool's rejection rethrown first. The card asked only that it "end both
   pools". Behaviour under a rejecting `end()` is now different from before for the single-pool
   case in ordering terms only. Harmless; noted.
6. **`InvalidLookupUserIdError` and the 255-character bound** in `membership-lookup.ts` — not in
   the card's Produces list. It IS in `tenant-membership-lookup.md:101,127-129`, which is in the
   card's `contracts:`, so this is contract-scoped rather than invented. Named here only because
   a reader working from the card's Produces section will not find it.

## Out-of-scope items that got built

The card's "Out of scope" list is otherwise clean: no `auth.config.ts`, no Better Auth instance,
no `workspaces`, no `memberships` workspace table, no endpoint, guard or web code, and no
endpoint-level isolation control. Verified against the full file list of both commits.

One item crossed:

- **"the assertions in `cross-tenant-isolation.int-spec.ts` are not edited here"** — they were,
  in 86c6b2b. Eight hunks. See F-135; the edits are correct, forced by the registry-versus-
  database cross-check (F-296 fails the run naming `inDatabaseNotRegistered:
  ["tenant_memberships"]` if the registration is skipped — measured in the report), and
  attributed to the test architect. The boundary was still crossed inside this card's commit and
  no card records the ruling.

## What the card demanded and I could not find missing

Checked item by item against the card's six dated sections; all present in the diff:

migration `0001` with all five Better Auth tables, `tenant_memberships` with the ADR-0015 column
set and `user_id text`; `tenant_role` enum sourced from `@shortkit/contracts`;
`tenantScopedPolicies('tenant_memberships')` and `membershipLookupPolicy()` hand-appended;
**four** DROP/CREATE pairs on `tenants` including `tenants_privileged_erase`; the REVOKE on five
tables and the GRANT to `shortkit_auth`; `nullif` on all four predicates in `rls.ts` including
`redirectReadPolicy()`, which correctly gets no migration statement; the second pool on
`DATABASE_AUTH_URL` at max 5 with both listeners and no fallback; `betterAuthDatabase()`;
`closeDatabase()` ending both; the `EXEMPT.size !== 5` length control; the counting control over
every `pg_policies` row; the grant matrix in both directions with the `has_any_column_privilege`
term and its three-privilege list; the F-001 docblock correction; `controls.ts` reading the
predicate out of `tenantScopedPolicies()` and throwing at import if it cannot; the
`registerTenantScopedSurfaces` entry with its eight shapes and `EXPECTED_SURFACE_IDS` ids; the
`CONTEXT_FLAG_OWNERS` fourth row; the barrel's two lines; all six design stubs materialised at
their mirrored paths; and all **six** exclusion-count sites — `rls.ts:72`, `rls.ts:87`,
`rls.ts`'s exhaustive-flag header, `coverage.ts`'s "EXACTLY TWO" block including the "Neither
surface exists yet" prose, and both `isolation-coverage.md` sites (the section plus invariant 5).
Site 5 (`tenant-context.md`) correctly untouched.

Two disclosed deviations, both acceptable as judged against the card:

- **`tenant_id` is not `TENANT_ID_COLUMN_SQL` character for character.** drizzle-kit emits
  `"tenant_id" uuid NOT NULL` plus a named `ALTER TABLE ... FOREIGN KEY ... ON DELETE cascade`.
  Semantically identical — NOT NULL, uuid, FK to `tenants(id)`, ON DELETE CASCADE — and
  hand-editing generated structural DDL is what ADR-0004 is most nervous about. No control reads
  the literal text. Correct call.
- **`membershipLookupPolicy()` carries no `TO shortkit_app`**, following ADR-0045 and
  `tenant-membership-lookup.md` over `isolation-coverage.md:514-516`. Already tracked as
  F-110/F-121 with the architect. Not re-filed.

## What remains unproven, stated plainly

- **AC-4 is half proven.** `tenantIdForUser` throws `NoTenantMembershipError` for an orphan user
  on a warm pooled connection, and resolves to the right tenant id for a real one. Nothing about
  a JWT, a mint, or what a caller receives is demonstrated or demonstrable in this card.
  `tenantIdForUser` currently has **no caller anywhere in the repository** and
  `betterAuthDatabase()` has no caller either, so the token path this AC is about does not exist
  yet in any form.
- **The lookup policy's narrowness is untested** in the discriminating direction (F-133).
- **The view control has no committed test** — armed, evidenced only by a planted probe that was
  dropped.
- **Authorship inside 86c6b2b is not recoverable from the diff**, so the claim that the test
  architect made the isolation-suite and `auth-schema.spec.ts` edits is taken from the work
  report, not verified.
