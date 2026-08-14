# TASK-001 — product auditor, round 1

Scope: per-TASK acceptance verification of `ea1b48e` against TASK-001's card, STORY-001's AC-8,
and the two design stubs frozen at the Design gate.

Review package: `.superpowers/sdd/plan/review-65339de..ea1b48e.diff`

```yaml
verdict: clear
ac_verification:
  - id: AC-8 (clause 1 — no-password parse keys an issue under `password`)
    status: met
    evidence: packages/contracts/src/auth/auth.spec.ts:49 "AC-8: a sign-up body with no password fails the parse and keys an issue under password"
    note: >-
      The test is the AC verbatim, not an adjacent proxy: it parses a body with `email` and
      `name` and no `password`, asserts `success === false`, asserts `isZodError`, and asserts
      `toValidationDetails(error).fieldErrors.password.length > 0`. `toValidationDetails`
      (packages/contracts/src/errors.ts:168-196) keys on `issue.path[0]`, and zod 4 emits
      `path: ['password']` for a missing required key, so the assertion cannot pass by
      accident on a differently-keyed issue.
  - id: AC-8 (clause 2 — `pnpm typecheck` at the repository root exits 0)
    status: partial
    evidence: packages/contracts typecheck exits 0 (re-run by me); apps/api typecheck exits 2
    note: >-
      NO ASSERTION CAN COVER THIS CLAUSE AND NONE CLAIMS TO — a test in this package cannot
      shell out (`node:child_process` banned by ADR-0005), which was recorded at the Test gate
      and approved; auth.spec.ts:13-16 states it in the file. The clause is discharged by the
      gate command, and TODAY THE GATE COMMAND DOES NOT EXIT 0. Verified by me:
      `tsc --noEmit -p packages/contracts/tsconfig.json` → exit 0, and
      `tsc --noEmit -p apps/api/tsconfig.json` → exit 2 with the same seven errors the
      implementation report lists, all in `apps/api/src/auth/tenant-id-for-user.spec.ts`,
      `apps/api/src/db/auth-schema.spec.ts` and `apps/api/test/auth/tenant-memberships.int-spec.ts`,
      awaiting TASK-002's stub commit. Every one is outside TASK-001's `paths`. Nothing in
      TASK-001's diff contributes an error. See F-097: this is a state to carry, not rework
      for this card.
      I did NOT re-run `apps/web`'s typecheck: its script is `next typegen && tsc`, and
      `next typegen` writes into `.next/types`, which is a mutation. I am relying on the
      dispatch's statement that it is clean, and I say so rather than implying I checked.
findings:
  - id: F-097
    severity: major
    kind: behavior
    file: apps/api/tsconfig.json
    line: 1
    summary: >-
      AC-8's second clause — "`pnpm typecheck` run at the repository root exits 0" — is FALSE
      as of ea1b48e. Root typecheck exits non-zero because `pnpm -r typecheck` reaches
      `apps/api`, whose spec files import `./tenant-id-for-user` and `./schema/auth`, both
      TASK-002's. Re-verified by direct `tsc` invocation, not taken from the report.
    failure_scenario: >-
      AC-8 is TASK-001's only acceptance criterion and the card is now `tests-green`. If the
      Ship gate reads "TASK-001 done" as "AC-8 green", STORY-001 records a criterion satisfied
      whose stated command has never exited 0 in this repository, and the one half of AC-8 that
      no assertion covers is also the half nothing observed. That is exactly the ledger-vs-prose
      drift class this workflow has filed before.
    required_change: >-
      No change in TASK-001's paths can fix this and none should be attempted. AC-8 stays
      unchecked in STORY-001 until TASK-002 lands, at which point `pnpm typecheck` is run at the
      repository root and its exit code recorded against AC-8 clause 2 by whoever closes wave 2.
  - id: F-098
    severity: minor
    kind: correctness
    file: packages/contracts/src/roles.ts
    line: 127
    summary: >-
      `tenantRoleRank`'s new body reads `TENANT_ROLE_RANK[key]` and tests `=== undefined`.
      `TENANT_ROLE_RANK` is an object literal with `Object.prototype` in its chain, so the keys
      `toString`, `constructor`, `valueOf`, `hasOwnProperty` and `__proto__` return an inherited
      value rather than `undefined`, and the function returns that value typed as `number`
      instead of throwing. Confirmed by executing the lookup, not by reading it.
    failure_scenario: >-
      `tenantRoleRank('toString' as never)` returns a function where its own doc comment
      promises a throw ("Throws on an unknown key rather than returning undefined"). Reachable
      only through an unsound cast — the parameter is branded and `asTenantRole` uses
      `TENANT_ROLES.includes`, which has no prototype hole — and it fails CLOSED
      (`function >= 20` is `false`), so `meetsTenantRole` denies rather than grants. That is why
      this is minor and not a blocker. It is nonetheless the exact defect class this repository
      has already written a 25-line comment about, one file over
      (`packages/contracts/src/errors.ts:139-166`, "THE ACCUMULATOR IS A `Map`, NOT AN OBJECT
      LITERAL. THIS IS NOT STYLE").
    required_change: >-
      Guard with `Object.hasOwn(TENANT_ROLE_RANK, _role)` or `typeof rank !== 'number'`, and add
      a row to `roles.spec.ts`'s existing table for one prototype key (`'toString'`) expecting
      `THROWS`. The table-driven shape the spec already uses takes the row with no restructuring.
  - id: F-099
    severity: minor
    kind: test-coverage
    file: packages/contracts/src/index.ts
    line: 24
    summary: >-
      The two barrel lines this TASK exists to land — `export * from './auth'` and
      `export * from './members'` — are asserted by nothing. Every spec imports from the
      relative module (`./index`, `../errors`), and the only tests that import
      `@shortkit/contracts` by package name (`apps/web/src/lib/api/client.spec.ts:40`,
      `apps/web/app/not-found.spec.ts:2`) read `idContract`, `isErrorEnvelope`, `paginated` and
      `ERROR_CODE_STATUS` — none of the new symbols.
    failure_scenario: >-
      Deleting either barrel line leaves all 30 target tests green, contracts typecheck at 0, and
      the web build passing. It would be caught in wave 2 when TASK-003 imports
      `ACCESS_TOKEN_LIFETIME_SECONDS` — one wave and one implementer later, presenting as
      TASK-003's failure. It also matters for ADR-0005 specifically: apps/web's typecheck only
      sees these modules BECAUSE the barrel re-exports them, so the barrel line is what makes
      the "may import zod and nothing else" constraint observable at all, and it is the one thing
      here with no test behind it.
    required_change: >-
      One assertion importing `signUpRequestContract` (or `ACCESS_TOKEN_LIFETIME_SECONDS`) and
      `parseTenantMembership` through `@shortkit/contracts` rather than through a relative path.
      Cheapest home is an existing spec; no new file needed.
  - id: F-100
    severity: minor
    kind: process
    file: .sdlc/identity-membership/work/TASK-001-report.md
    line: 37
    summary: >-
      The implementation report states "no `.sdlc/**` files" changed. Commit ea1b48e changes two:
      `.sdlc/identity-membership/findings.yaml` (+83, F-086/F-087/F-088) and
      `.sdlc/identity-membership/tasks/TASK-001.md` (+27, pre-flight section and
      `status: tests-red` → `tests-green`).
    failure_scenario: >-
      The content is the orchestrator's pre-flight work and is correct; the report's own
      accounting of its commit is not. A reviewer reconciling the report against the diff finds
      a mismatch and has to work out which is authoritative — the same "a correction that is
      wrong about its own subject" class F-085 filed one entry earlier in this very findings file.
    required_change: >-
      The report's Changes section names the two `.sdlc` files and attributes them to pre-flight,
      or the ledger records that pre-flight edits ride in the implementer's commit by convention.
  - id: F-101
    severity: minor
    kind: plan
    file: .sdlc/identity-membership/tasks/TASK-001.md
    line: 116
    summary: >-
      F-088 fixed ONE omission in the card's Produces list and left three. Still missing:
      `brandTenantMembership` (F-088's own subject — it was written into the Corrections prose at
      line 68 but never added to Produces), `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH`, and
      `authUserContract`/`AuthUser`. All four are in the frozen design stub and all four ship.
      Counted against the card, the stub and the specs.
    failure_scenario: >-
      Produces is what an implementer builds from — F-088's stated rationale. The constants are
      load-bearing beyond this card: auth.spec.ts:107-123 asserts the contract is built FROM them
      precisely because TASK-003 feeds `emailAndPassword.minPasswordLength` from the same two
      symbols, and a Produces list that does not name them lets wave 2 restate `8` inline.
    required_change: >-
      The card's Produces names all four, or it says once that the design stub's export list is
      the authoritative one and Produces is a summary.
  - id: F-102
    severity: minor
    kind: scope
    file: packages/contracts/src/index.ts
    line: 24
    summary: >-
      Two trailing comments were rewritten, which no card line asked for: `// TASK-009` →
      `// TASK-001` and `// TASK-018` → `// TASK-001`. The card's Approach says only to uncomment
      the two lines.
    failure_scenario: >-
      Low risk and disclosed in the report. I verified the new text is accurate: TASK-009 is
      "Compose stack and declared environment", TASK-018 is the `shortkit_auth` role provisioning,
      and neither owns a contracts barrel line in this initiative — the old ids are residue from
      the deferred 2026-08-03 numbering. The remaining commented lines still carry ids from that
      scheme (TASK-014, TASK-021, TASK-025, TASK-040, TASK-045, TASK-049, TASK-053; this
      initiative stops at TASK-019), correctly left alone. The cost is that the file now mixes two
      numbering schemes with nothing saying so.
    required_change: >-
      None required. If review prefers minimum diff, revert the two comments; if it prefers
      accuracy, a one-line note above the block saying the commented ids predate this initiative
      would stop the next reader deriving the wrong conclusion twice.
```

## Stub conformance (the thing nothing in CI checks)

F-087 is correct that `assert-stub-drift.mjs` cannot see this initiative's stubs
(`STUB_ROOT` = `.sdlc/foundation/design/stubs`, `ENFORCED_PREFIXES` = `['apps/web/']`). I ran the
comparison by hand.

- `packages/contracts/src/auth/index.ts` vs its stub — **byte-identical, `diff` exit 0.** All 138
  lines, comments included. Nothing was added, dropped or reworded.
- `packages/contracts/src/members/index.ts` vs its stub — **identical except the two function
  bodies the card assigns to this TASK**, plus the one import the implementation needs
  (`asTenantRole` added to the existing `../roles` import). Every schema, type, interface and
  comment is unchanged. `parseTenantMembership` parses then delegates; `brandTenantMembership`
  copies four fields and brands `role`. Both match what their own doc comments — written at the
  Design gate, before the implementation — say they do, including the ZodError-before-brand
  ordering that `members.spec.ts:111` asserts.

No drift. Recorded here because this is the only place it is recorded.

## Pre-flight section — did the rest of it land

Every item in "Corrections found at the Implement pre-flight" is discharged.

- **`brandTenantMembership` shipped** — `packages/contracts/src/members/index.ts:73`, tested at
  `members.spec.ts:128-149`. The test is the strong form: one assertion covering accept AND
  refuse (`['owner', 'throws']`), so a function that throws on everything fails it. Card's own
  Produces list still omits it (F-101).
- **Stubs treated as the reference implementation** — confirmed above.
- **`toValidationDetails` consumed, not rewritten** — `errors.ts` is not in the commit; both spec
  files import it from `../errors`.
- **The zod-only import rule followed although nothing enforces it** — `auth/index.ts` imports
  `zod` and nothing else; `members/index.ts` imports `zod`, `../pagination`, `../roles`. No
  `node:*`, no `@nestjs/*`, no `drizzle-orm`, no `pg`, no `react`. Correctly did NOT add an
  eslint rule: F-086 is open and owned elsewhere, and adding it here would have been the
  out-of-scope edit.
- **F-087 acknowledged, not acted on** — right call; `assert-stub-drift.mjs` is TASK-010's file in
  wave 5.

Two additional checks worth the record. `roles.spec.ts` and `members.spec.ts` both carry an
explicit note that a bare `toThrow()` would pass against the `not implemented` stub, and both use
accept-and-refuse tables instead — these tests could not have been green before this commit. And
the two `@ts-expect-error` directives in `members.spec.ts:91,138` ARE live assertions, not
decoration: `packages/contracts/tsconfig.json` includes `src/**/*.ts`, so `tsc` reads the spec
files, and the package typecheck exiting 0 means neither directive is unused. That is what pins
ADR-0048's "the inferred wire type carries no brand" — and it is carried by AC-8's second clause,
the one currently blocked by F-097.

## Shipped but not asked for

Little, and all of it defensible.

- `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` and `authUserContract` / `AuthUser` are not on the
  card's Produces list. They are in the frozen design stub and required by the specs, so the
  defect is in the card, not the code (F-101).
- The two task-id comment rewrites in `index.ts` (F-102).
- `asTenantRole`'s and `tenantRoleRank`'s error message text (`not a tenant role: ${value}`) is
  new and specified by nothing — no stub prescribed it, and both specs discard the message in a
  `catch`. It interpolates only a role name that has already failed an allowlist check, so no
  caller-controlled value of consequence reaches a log. Fine as written; flagged only so nobody
  later reads it as a contract.

Nothing else. No workspace contracts, no invitation contracts, no new `ERROR_CODES` entry, no
`errors.ts` change, no API/web/database file, no eslint config, no new dependency.

## Out-of-scope items that got built

None. Every item in the card's "Out of scope" section is intact: `packages/contracts/src/workspaces/**`
does not exist, invitations do not exist, `asWorkspaceRole` and `roleRank` still
`throw new Error('not implemented')` (`roles.ts:88`, `roles.ts:117`), `ERROR_CODES` is untouched,
and no `apps/api`, `apps/web` or migration file is in the commit.

## What I could not verify

- `apps/web`'s typecheck. Its script runs `next typegen`, which writes generated types; running it
  would have been a mutation. Not re-run. I did confirm the mechanism the clause depends on:
  `apps/web/tsconfig.json` maps `@shortkit/contracts` → `packages/contracts/src/index.ts`, and
  `apps/web/src/lib/api/client.ts:18` imports from that specifier, so the barrel now pulls both new
  modules into apps/web's program. A Node-only import in either file would surface there — which is
  the whole of what ADR-0005 asks the typecheck to prove.
- Whether the `@ts-expect-error` directives would fail if the wire type DID carry a brand. Proving
  it requires editing a source file, which I may not do. The indirect evidence — typecheck at 0
  with `noUnusedLocals` and unused-directive checking on — is as far as a read-only pass reaches.
- Test execution, lint and build: taken from the dispatch as already verified, not re-run.
