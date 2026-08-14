# TASK-018 — product audit, round 1

- **Auditor:** sdlc-product-auditor
- **Mode:** per-TASK
- **Range audited:** `d6b79f0..4cfa57f` (single commit `4cfa57f`)
- **Date:** 2026-08-14
- **Verdict:** changes-requested

## What was verified against

TASK-018 carries `acceptance: []` — approved knowingly, not an oversight, and **not filed as a
finding**. The specification verified against is the card's **"What the tests must pin"** items
1–4, plus the card's **"Produces"** list and the four test-architect handbacks and two ambiguity
resolutions recorded in "What the red tests pinned".

Tests were not re-run (the orchestrator verified 9/9 green, lint clean, build green, typecheck
failing only on untouched files). This audit reads the tests and the diff and judges whether the
assertions pin what the card said they pin.

```yaml
verdict: changes-requested
ac_verification:
  - id: PIN-1   # three roles come up, at every site that provisions one
    status: met
    evidence: |
      apps/api/test/tenancy/auth-role-provisioning.int-spec.ts::"CI's provisioning script
      creates all three roles" / "docker-compose.test.yml's init script creates all three
      roles" / "docker-compose.yml's init script creates all three roles" / "the database this
      suite runs against carries all three roles".
      Impl: .github/scripts/provision-test-database.sql:36, docker-compose.yml:334,
      docker-compose.test.yml:125.
    note: |
      The assertions run each artifact rather than grepping it, and the expected census
      (THREE_ROLES, spec:79) is hand-written rather than imported from the code under test.
      All four sites genuinely covered.
  - id: PIN-2   # shortkit_auth attributes: LOGIN, NOBYPASSRLS, not superuser, owns nothing
    status: met
    evidence: |
      spec::"CI's provisioning script gives shortkit_auth LOGIN, NOBYPASSRLS and no superuser"
      (attributes) and spec::"shortkit_auth owns no relation in the migrated schema"
      (owns nothing, live suite database).
      Impl: NOBYPASSRLS written out explicitly at all three sites; no OWNER, no CREATEDB,
      no SUPERUSER anywhere in the diff.
    note: |
      Met as written. Coverage is narrower than the implementation: the attribute assertion
      runs against the CI SQL and the live database only, so the two Compose init scripts are
      asserted for role *existence* only. See F-067 — implementation is correct at all three
      sites today, the regression net is not.
  - id: PIN-3   # the widened BYPASSRLS guard fires on a BYPASSRLS'd shortkit_auth
    status: met
    evidence: |
      spec::"the provisioning guard refuses a shortkit_auth that holds BYPASSRLS" — builds the
      wrong cluster and requires a raise matching /shortkit_auth/.
      Impl: .github/scripts/provision-test-database.sql:59 (`rolname IN (... 'shortkit_auth')`).
    note: |
      Genuine rejection test, not a "correct database passes" tautology. With the pre-commit
      two-role `IN` list this case raises nothing at all, so the assertion is load-bearing.
      The control test (spec::"control — a guard that fires is visible to this harness") keeps
      the harness itself honest.
  - id: PIN-4   # the widened cardinality guard fires on a two-role database
    status: met
    evidence: |
      spec::"the provisioning guard refuses a database that never created shortkit_auth",
      asserting /shortkit_auth/ on the thrown message.
      Impl: provision-test-database.sql:68 (`<> 3`) and :70 (message).
    note: |
      Handback 2 satisfied as specified: the message was *widened* to name all three roles
      ("shortkit_app, shortkit_migrator and shortkit_auth must all exist and be distinct
      roles: ...") rather than rewritten to "all three roles must exist". Checked against the
      exact wording the card required.
  - id: HANDBACK-1   # all three IF checks stay reachable in one DO block
    status: met
    evidence: .github/scripts/provision-test-database.sql:52-79 — single DO block, three IFs, third (ownership) check untouched.
  - id: HANDBACK-3   # SHORTKIT_AUTH_PASSWORD is the pinned variable name
    status: met
    evidence: docker-compose.yml:97 and docker-compose.yml:322 (`-v auth_password="$$SHORTKIT_AUTH_PASSWORD"`), matching spec:243.
  - id: HANDBACK-4   # new CI dependency for the integration job
    status: met
    evidence: informational; nothing to ship. `docker`/`docker compose` already available to the integration job.
  - id: RESOLUTION-A   # rls-fixture.ts — nothing to change
    status: met
    evidence: |
      Not in the diff. Independently re-verified: apps/api/test/support/rls-fixture.ts:139-161
      (`assertAppRoleCannotBypassRls`) selects on `rolname = current_user` and never names a
      role; :225 memoises whatever `DATABASE_URL` answers to `SELECT current_user`; the only
      `count(*)` in the file (:292) counts policies on `tenants`, not roles.
    note: The card's reasoning holds. A third cluster role changes nothing this file reads. Leaving it untouched was correct.
  - id: RESOLUTION-B   # seed.mts — grant docblock exception, not a rewrite
    status: met
    evidence: apps/api/scripts/seed.mts:33-38 — an EXCEPTION paragraph added under the existing grant-check docblock; REQUIRED_ROLE untouched.
    note: See F-071 on the paragraph's present tense.
  - id: PRODUCES-A   # both guards cover all three roles
    status: met
    evidence: provision-test-database.sql:59, :68, :70.
  - id: PRODUCES-B   # authServerEnv() returns DATABASE_AUTH_URL
    status: met
    evidence: apps/api/test/support/auth-fixture.ts:83 with authDsnOrThrow() at :121-134; no fallback to DATABASE_URL; BETTER_AUTH_SECRET at :85 untouched as instructed.
  - id: PRODUCES-C   # docker-compose.yml api service carries BETTER_AUTH_SECRET and DATABASE_AUTH_URL
    status: met
    evidence: docker-compose.yml:233 (DATABASE_AUTH_URL as shortkit_auth) and :237 (BETTER_AUTH_SECRET). Ordinary `${VAR:-default}` in the environment: block, `$$` in the configs body — the two conventions kept apart per F-043.
  - id: PRODUCES-D   # docker-compose.test.yml gets the role block AND its header export lines
    status: partial
    evidence: docker-compose.test.yml:125 (role block, shipped); docker-compose.test.yml:8-9 (header export lines, NOT updated).
    note: The role block landed; the header export lines named twice by the card did not. F-064.

findings:
  - severity: blocker
    kind: behavior
    id: F-064
    file: docker-compose.test.yml
    line: 9
    summary: |
      The card names "the header export lines" as this file's deliverable twice (card:121 and
      card Produces:248-249) and they were not touched. The header still documents only
      DATABASE_URL and DATABASE_MIGRATION_URL.
    failure_scenario: |
      From wave 2 a developer runs the documented local flow — the four lines at
      docker-compose.test.yml:7-11 are the only place in the repository that documents them;
      README carries no export block and ci.yml:195 explicitly defers to this header — and
      then any spec that spawns the API child through authServerEnv() throws
      "DATABASE_AUTH_URL is not set. The integration suite needs a live Postgres: start it
      with `docker compose -f docker-compose.test.yml up -d` and export DATABASE_AUTH_URL
      (shortkit_auth) ...". The remedy message points at a file that does not mention the
      variable. The fixture and the documentation this commit ships disagree with each other.
    required_change: |
      Add the third export to the header block, matching the port and database of the two
      beside it:
      `export DATABASE_AUTH_URL='postgres://shortkit_auth:auth@127.0.0.1:55433/shortkit_test'`.
      One line, inside a file already in this card's paths.

  - severity: major
    kind: behavior
    id: F-065
    file: .github/workflows/ci.yml
    line: 203
    summary: |
      No TASK in this initiative owns adding DATABASE_AUTH_URL to the integration job's env,
      and authServerEnv() now hard-fails without it.
    failure_scenario: |
      ci.yml:202-203 sets DATABASE_URL and DATABASE_MIGRATION_URL only. No spec calls
      authServerEnv() today (the only startApiServer caller,
      apps/api/test/security/security-headers.int-spec.ts:140, passes its own env), so CI is
      green now. The first wave-2 spec that boots the API child through authServerEnv() turns
      the required `integration` job red with a message about a variable no workflow sets.
      Ownership checked: TASK-010:58 and TASK-017:92 both put ci.yml changes explicitly out of
      scope, TASK-002's card never mentions ci.yml, and docker-compose.test.yml:13-14 says the
      CI equivalent "belongs to TASK-002 (F-039)" without naming the variable. This is the same
      unowned-artifact class ADR-0050 escalated.
    required_change: |
      Not this card's paths — route it. Assign DATABASE_AUTH_URL in ci.yml's integration job
      env to a named TASK at or before wave 2 (TASK-002 is the card the compose header already
      points at), or state on TASK-018 that the CI half is deliberately deferred and to which
      card.

  - severity: minor
    kind: behavior
    id: F-066
    file: docker-compose.test.yml
    line: 33
    summary: |
      Two-role prose left standing in both files this commit edited, while the prose next to
      the CREATE ROLE lines in the same files was correctly widened.
    failure_scenario: |
      docker-compose.test.yml:33 and docker-compose.yml:25 both still read "both roles
      NOBYPASSRLS, both with attribute defaults otherwise" in the "Reusable — this is
      rls-policy-template.md's Roles section, applied" list, and :56 / :82 still say "one of
      the two NOBYPASSRLS roles". The test file's own header calls itself "the repository's
      only worked example of role provisioning ... what someone reaches for under time
      pressure", so the copy-me list describing a two-role model is the exact failure the
      widened cardinality guard exists to prevent, one level up in the documentation.
      (.env.example:13's "any of the three passwords" is now four, but that file is TASK-009's
      by this card's own out-of-scope list — noted so it is not lost, not charged here.)
    required_change: |
      Widen the four comment lines in the two files already in this card's paths:
      docker-compose.test.yml:33 and :56, docker-compose.yml:25 and :82.

  - severity: minor
    kind: test-coverage
    id: F-067
    file: apps/api/test/tenancy/auth-role-provisioning.int-spec.ts
    line: 218
    summary: |
      PIN-2's attribute assertions cover the CI SQL and the live suite database; the two
      Compose init scripts are asserted for role existence only.
    failure_scenario: |
      A future edit that provisions `CREATE ROLE shortkit_auth ... BYPASSRLS` in
      docker-compose.yml or docker-compose.test.yml passes all nine tests: the census
      assertion (spec:224, spec:248) only checks that the three names exist. The dev stack and
      the integration stack are precisely the two clusters the suite's isolation assertions
      run against. The implementation is correct at all three sites today — this is about the
      net, not the code.
    required_change: |
      Test-tier work, not the implementer's. Run AUTH_ROLE_ATTRIBUTES against the two scratch
      clusters the Compose scripts already build in the existing tests — the query and the
      expectation object are both already in the file.

  - severity: minor
    kind: behavior
    id: F-068
    file: docker-compose.yml
    line: 237
    summary: |
      BETTER_AUTH_SECRET's development default is a value invented by the implementer that no
      artifact pins and no test in this TASK's scope asserts. (Raised by the implementer
      itself; assessed here.)
    failure_scenario: |
      Verified against ADR-0051's four rejections, and the value clears all four:
      `development-compose-better-auth-secret-not-a-real-value` is 55 characters (measured),
      non-empty, always set through `${BETTER_AUTH_SECRET:-...}` (`:-` also covers the
      exported-but-empty case), and is not
      `better-auth-secret-12345678901234567890`. It also matches the shape the card asked for
      — a development throwaway that signs nothing real, mirroring auth-fixture.ts:85. So this
      is NOT a gap in the deliverable as the card wrote it; the card stated four constraints
      and deliberately did not pin a value.
      The residual is that nothing mechanical holds it. Between now and TASK-003 (wave 2) any
      edit shortening it below 32 characters is invisible; from wave 2 the failure is loud —
      the `compose` gating job cannot go green — which is exactly the F-034 outcome this
      declaration exists to prevent, one wave later than intended.
    required_change: |
      Optional, and cheap: have TASK-003's test that covers assertBetterAuthSecretConfigured()
      also assert that docker-compose.yml's rendered default clears betterAuthSecret(). Until
      then the inline comment at :234-236 should state all four rejections rather than two
      ("55 characters, not the library's published default").

  - severity: minor
    kind: behavior
    id: F-069
    file: docker-compose.yml
    line: 233
    summary: |
      Nothing tells a developer with an existing dev volume that their database has no
      shortkit_auth and never will without `down -v`.
    failure_scenario: |
      The init script runs exactly once against an empty data directory (the file says so at
      :353). Every machine that has run `docker compose up` before this commit keeps a
      two-role `shortkit` database. From wave 2 the API's second pool fails against a role
      that does not exist, on a stack whose compose file plainly declares DATABASE_AUTH_URL —
      an authentication dead end with no obvious cause, which is the exact failure mode
      .env.example:13-17 warns about for password changes.
    required_change: |
      One sentence in the comment already being added at docker-compose.yml:230-232: existing
      stacks need `docker compose down -v` before this role exists. README and .env.example
      are TASK-009's; the compose comment is this card's.

  - severity: minor
    kind: behavior
    id: F-070
    file: .sdlc/foundation/design/contracts/rls-policy-template.md
    line: 15
    summary: |
      The contract's header paragraph still describes the provisioning guards as two-role
      ("`WHERE rolname IN ('shortkit_app', 'shortkit_migrator')` at `:57`, and a `count(*) <>
      2` guard at `:66`. Adding a role means editing the guard"), which this commit did.
    failure_scenario: |
      The contract is the artifact all three transcriptions are supposed to be checked
      against. A reader reconciling it with the code now finds the contract describing a state
      that no longer exists and may "restore" it. The Roles section itself (:21-43) is already
      correct and matches the shipped SQL exactly.
    required_change: |
      Not this card's paths. Route the header paragraph's update to the contract's owner —
      it should now read as a widened guard rather than a guard to widen.

  - severity: minor
    kind: behavior
    id: F-071
    file: apps/api/scripts/seed.mts
    line: 33
    summary: |
      The added docblock states a wave-1 fact in the present tense: "EXCEPTION, since
      migration `0001` (ADR-0050)".
    failure_scenario: |
      At wave 0 there is no migration 0001 and no REVOKE. A reader who greps for it between
      now and TASK-002 finds nothing and cannot tell whether the comment is aspirational or
      whether the migration was deleted. The card demanded this paragraph, so the content is
      in scope and correct — only the tense is unqualified.
    required_change: |
      Qualify: "from TASK-002's migration `0001`" or equivalent. Trivial.
```

## Shipped but not asked for

**One deviation, and it is justified — no change requested.**

`GRANT USAGE ON SCHEMA public TO shortkit_app, shortkit_auth` was added to **both** Compose init
scripts (docker-compose.yml:348, docker-compose.test.yml:136). The card asked for that GRANT
explicitly at the CI site only (card:62-63) and said "Roles only" for the two Compose sites
(card:75, card:78). Read literally, the Compose GRANTs exceed the instruction.

They are right anyway, on two grounds I verified rather than assumed:

1. `rls-policy-template.md`'s Roles section — the normative form all three files transcribe —
   now reads `GRANT USAGE ON SCHEMA public TO shortkit_app, shortkit_auth;` at line 33. Not
   widening the Compose copies would have put them out of agreement with the contract, which
   that same contract says must be edited in one commit across all three transcriptions.
2. Without `USAGE` on schema `public`, TASK-002's per-table `GRANT` to `shortkit_auth` is
   inert — the role could hold DML on all five tables and reach none of them.

"Roles only" in context means "not the `environment:` blocks, which are TASK-009's", and the
implementer read it that way. Recorded here so the deviation is on the record, not to be undone.

Nothing else in the diff is unrequested. No application code, no schema, no policy, no
`.env.example`, no README, no `check-compose-stack.sh`, no migration.

## Out-of-scope items that got built

**None.** Each named exclusion checked directly:

| Excluded item | Owner | State in this diff |
|---|---|---|
| `check-compose-stack.sh` contaminant guard | TASK-017 (card:72) | Untouched. Still loops `POSTGRES_USER SHORTKIT_MIGRATOR_PASSWORD SHORTKIT_APP_PASSWORD` at :180. |
| Migration `REVOKE`/`GRANT`, grant matrix, second pool | TASK-002 | Absent. Referenced in comments only. |
| `assertAuthRoleSeparation` | TASK-004 | Absent. |
| `.env.example`, README, other `environment:` entries | TASK-009 | Untouched. |
| `apps/api/test/support/rls-fixture.ts` | resolved as no-change | Untouched, and the reasoning verified independently. |
| Application code, schema, policy | — | None. |

One consequence of correct scope discipline worth stating plainly: the new
`$$SHORTKIT_AUTH_PASSWORD` reference at docker-compose.yml:322 is **not** covered by the
contaminant guard until TASK-017 lands, which depends on TASK-009 and TASK-013. The escaping in
this commit is correct (`$$`, verified in the diff), so the window is a missing net rather than a
live defect — but it is open from wave 0 to wave 4+ and TASK-017 is the only thing that closes
it. Not a finding against this card; a scheduling fact worth carrying.

## Summary

Items 1–4 of "What the tests must pin" are **all met, and met genuinely** — the two guard tests
construct the databases the guards must refuse rather than asserting that a correct database
passes, which is the difference between a guard and a guard-shaped comment and is the thing that
would most plausibly have drifted. The four handbacks and both ambiguity resolutions landed as
written, including the two that were easiest to get wrong: the cardinality message widened rather
than rewritten, and `rls-fixture.ts` left alone.

The one thing the card demanded that did not ship is `docker-compose.test.yml`'s header export
lines (F-064) — one line, but the file it is missing from is the only place in the repository
that documents the integration tier's DSNs, and the throw this same commit adds to
`auth-fixture.ts` sends developers there. F-065 is the same gap on the CI side, one card short of
an owner.
