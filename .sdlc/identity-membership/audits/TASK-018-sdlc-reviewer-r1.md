# TASK-018 — code review, round 1

Reviewer: sdlc-reviewer. Range reviewed: `d6b79f0..4cfa57f` (one commit, six files).
Package: `.superpowers/sdd/plan/review-d6b79f0..4cfa57f.diff`.
Read in context of the whole file for all six paths, plus `.github/workflows/ci.yml`,
`scripts/check-compose-stack.sh`, `apps/api/scripts/check-policies.mts`,
`apps/api/test/support/rls-fixture.ts`, `apps/api/test/tenancy/auth-role-provisioning.int-spec.ts`,
ADR-0050, ADR-0051 and `rls-policy-template.md`.

No tests re-run: the implementer's report carries the evidence for the nine target tests,
the full integration suite, lint, build and the typecheck comparison.

```yaml
verdict: changes-requested
findings:
  - id: F-048
    severity: major
    kind: contract
    file: docker-compose.test.yml
    line: 7
    summary: >-
      The header's documented local flow still exports two DSNs. ADR-0050 assigns this
      file "the role block and the export lines in its header comment" to TASK-018, and
      only the role block landed.
    failure_scenario: >-
      A developer follows the block at docker-compose.test.yml:7-11 verbatim — `up -d
      --wait`, `export DATABASE_URL=...`, `export DATABASE_MIGRATION_URL=...`, `pnpm
      test:integration`. From wave 2, when a spec spawns the API child through
      `authServerEnv()`, the new `authDsnOrThrow()` (apps/api/test/support/auth-fixture.ts:122-135)
      throws `DATABASE_AUTH_URL is not set` before any assertion runs, and the file that
      documents the environment for that suite never mentioned the third variable. The
      same header is the normative source for CI: `.github/workflows/ci.yml:194` says its
      `env:` block is "the same DSNs docker-compose.test.yml documents in its header",
      so the omission propagates. The role and the credential both exist — the init
      script at :125 creates `shortkit_auth LOGIN PASSWORD 'auth'` and `GRANT USAGE ON
      SCHEMA public` at :136 — so nothing but the documentation line is missing.
    required_change: >-
      The header's command block documents the third DSN alongside the other two
      (`shortkit_auth`, password `auth`, port 55433, database `shortkit_test`), so that a
      reader who follows it gets an environment the integration tier can boot the API
      child in. `rls-policy-template.md`'s env-var table (three rows) is what this header
      has to keep agreeing with.

  - id: F-049
    severity: minor
    kind: implementation
    file: docker-compose.yml
    line: 25
    summary: >-
      The "NOBYPASSRLS on BOTH roles" sentence was updated inside both `configs` blocks
      and left stale in four other places in the same two files, plus one in the CI SQL.
    failure_scenario: >-
      Both compose banners state the file *is* `rls-policy-template.md`'s "Roles" section
      applied, and then describe a role model the same file no longer creates:
      docker-compose.yml:25 and docker-compose.test.yml:33 ("both roles NOBYPASSRLS, both
      with attribute defaults otherwise"), docker-compose.yml:82 ("every statement the
      API, the migrator and the seed issue comes from one of the two NOBYPASSRLS roles" —
      false from wave 2, when the API issues statements as `shortkit_auth`),
      docker-compose.test.yml:56 (same sentence), and docker-compose.yml:90-94 ("Both
      survive into the running server's environment" now covers three variables after
      `SHORTKIT_AUTH_PASSWORD` was added two lines below it). `.github/scripts/provision-test-database.sql:50-51`
      quotes the contract as "shortkit_app must never hold BYPASSRLS, SUPERUSER,
      CREATEROLE or table ownership" directly above a `WHERE rolname IN (...)` this commit
      widened to three roles; the contract's sentence now reads "Neither `shortkit_app`
      nor `shortkit_auth` may hold...". This is the exact failure mode the card names for
      the guards ("a guard that passes while describing something that no longer exists
      reads as coverage"), arriving in the prose instead.
    required_change: >-
      Every remaining two-role sentence in the three provisioning artifacts describes the
      three-role model, so the banners' claim to be a transcription of the contract's
      "Roles" section stays true.

  - id: F-050
    severity: minor
    kind: implementation
    file: .github/scripts/provision-test-database.sql
    line: 51
    summary: >-
      The guard's comment attributes the table-ownership half of the contract to
      `check-policies.mts`, which contains no ownership read at all — and the widened
      `WHERE` now implies that coverage for `shortkit_auth` as well.
    failure_scenario: >-
      The comment says "table ownership is checked downstream by check-policies.mts's
      count of tables owned in schema public, which runs in the same job". Verified:
      `apps/api/scripts/check-policies.mts` contains no `relowner`, `pg_get_userbyid`,
      `owner` or `current_user` reference; the only ownership counts in the repository are
      `apps/api/src/db/rls.ts:148` (boot, connected role only, i.e. `shortkit_app`),
      `apps/api/test/tenancy/tenant-context.int-spec.ts:983` and the new
      `auth-role-provisioning.int-spec.ts:281`. A reader widening or trimming this block
      later is told a downstream check exists that does not, for both runtime roles. The
      sentence predates this commit; it is reported because the commit widened the guard
      it describes from two roles to three without revisiting it.
    required_change: >-
      The comment names where the fourth property is actually asserted for each role —
      boot (`assertRuntimeRoleCannotBypassRls`, `shortkit_app` only) and the integration
      tier for `shortkit_auth`, with `assertAuthRoleSeparation` arriving in wave 3 — or
      drops the claim. Nothing about the SQL changes.

  - id: F-051
    severity: minor
    kind: behavior
    file: scripts/check-compose-stack.sh
    line: 180
    summary: >-
      A third host-interpolated `$$` variable was added to `configs.*.content` without
      widening the contaminant guard that exists to stop an exported value from masking a
      missing `$$`.
    failure_scenario: >-
      The loop refuses only on `POSTGRES_USER SHORTKIT_MIGRATOR_PASSWORD
      SHORTKIT_APP_PASSWORD`. `docker-compose.yml:322` now also reads
      `$$SHORTKIT_AUTH_PASSWORD` in the same interpolated block. A developer with
      `SHORTKIT_AUTH_PASSWORD` exported — plausible once TASK-009 documents the role
      passwords as override knobs — who reduces that to a single `$` gets no warning from
      `docker compose config -q` (the variable is set, so nothing is reported unset), no
      refusal from this check, and a green stack. On AC-115's machine and on a CI runner
      the same file renders `-v auth_password=""`, PostgreSQL answers `PASSWORD ''` with a
      NOTICE that `ON_ERROR_STOP=1` does not catch, and the stack comes up with a
      passwordless `shortkit_auth` — F-315/F-316 reproduced on the new variable, which is
      precisely what the comment at :174-179 says this loop exists to prevent. Note that
      this file is outside TASK-018's declared `paths` and ADR-0050 assigns it to TASK-017
      in wave 9; routing is the orchestrator's.
    required_change: >-
      Every variable read as `$$NAME` inside `configs.*.content`, `healthcheck.test` or
      `command` is in the contaminant list, `SHORTKIT_AUTH_PASSWORD` included.

  - id: F-052
    severity: minor
    kind: implementation
    file: apps/api/test/support/auth-fixture.ts
    line: 122
    summary: >-
      A third copy of the same read-env-or-throw helper, in a file that already imports
      from the module carrying the parameterised original.
    failure_scenario: >-
      `authDsnOrThrow()` (:122-135) is byte-identical to `appDsnOrThrow()` (:102-114)
      apart from the variable name and the remedy text, and `appDsnOrThrow()` is itself a
      copy of `rls-fixture.ts`'s `dsn(variable)` / `appDsn()` (:106-123) — from which this
      file already imports `migrationDsn`. The concrete cost is drift: the older copy's
      message at :107-109 still names only two DSNs and is now wrong about what the
      integration tier needs, while the new copy at :127-131 names three. There is no
      wrong behaviour today; the two messages disagree about the same fact.
    required_change: >-
      One parameterised reader for the three DSN variables, or the two messages in this
      file agree about how many the suite requires. `rls-fixture.ts:106` is the shape the
      neighbours use.
```

## Cannot verify from diff

- **`.github/workflows/ci.yml:202-203` declares `DATABASE_URL` and
  `DATABASE_MIGRATION_URL` and no `DATABASE_AUTH_URL`.** Verified absent; also verified
  that ADR-0050's follow-up table names no owning TASK for `ci.yml`. Today nothing calls
  `authServerEnv()` (only definition plus a docblock mention at
  `apps/api/test/support/api-server.ts:69`), so the `integration` job is unaffected by
  this commit. From the wave in which a spec spawns the API child, that job throws in
  `authDsnOrThrow()`. Whether a later card owns the workflow env is cross-TASK context I
  do not hold.
- **The dev stack's upgrade path.** `configs.shortkit_roles_sh` runs exactly once against
  an empty data directory (`docker-compose.yml:358-360`, ADR-0032), so any machine with an
  existing `shortkit-dev_pgdata` volume keeps a two-role database. When TASK-002's
  migration `0001` lands, the `migrate` service fails with `role "shortkit_auth" does not
  exist` and the stack stops. The failure is loud and names the role; nothing in this diff
  or in TASK-018's card tells that developer to `docker compose down -v`. README is
  TASK-009's, wave 4. Whether that is already covered is the orchestrator's to resolve.
  The equivalent for the *test* stack is covered — `auth-role-provisioning.int-spec.ts:260-262`
  carries the `down -v && up -d --wait` remedy in its assertion message.
- **TASK-002's side of the split.** The three sites create `shortkit_auth` with `LOGIN`,
  `NOBYPASSRLS`, `USAGE` on schema `public` and no table privilege whatsoever, by design.
  Nothing in this diff can show that migration `0001`'s `REVOKE`/`GRANT` and the
  grant-matrix assertion arrive; until they do the role can connect and read nothing.

## Notes

- **The `BETTER_AUTH_SECRET` compose default was checked against ADR-0051's four
  rejections and clears all four.** `development-compose-better-auth-secret-not-a-real-value`
  is 55 characters (counted), non-empty, set, and is not
  `better-auth-secret-12345678901234567890`. Confirmed no test in this TASK's scope
  asserts it and no artifact pins the string — the first thing that would notice a future
  edit shortening it below 32 is `assertBetterAuthSecretConfigured()` in wave 2, where it
  would surface as a red required `compose` job rather than a silent weakening. I found no
  defect here; flagged only because the orchestrator asked for it un-prejudged.
- **Both `$` conventions are correct in `docker-compose.yml`.** `$$SHORTKIT_AUTH_PASSWORD`
  in `configs.shortkit_roles_sh.content:322` (host interpolation at parse time, F-043,
  F-315, F-316) and `${SHORTKIT_AUTH_PASSWORD:-auth}` / `${BETTER_AUTH_SECRET:-...}` under
  `environment:` (:97, :233, :238). No convention crossed either way.
- **The guard widening satisfies the Test phase's three structural constraints.** All
  three `IF` checks remain in one `DO $$ … END $$;` block and all three stay reachable;
  the cardinality message was widened rather than rewritten, so it still names
  `shortkit_auth` and matches the spec's `/shortkit_auth/`; and on a two-role cluster the
  BYPASSRLS check finds nothing and the cardinality check is the one that raises, before
  the ownership check.
- **The `rls-fixture.ts` "nothing to change" ruling is correct.** Independently checked:
  `dsn()` (:106-118) is parameterised over the variable name and
  `assertAppRoleCannotBypassRls()` (:139-161) asks `current_user` about `is_superuser` and
  `rolbypassrls` without naming a role. A third cluster role changes nothing it reads.
- **`GRANT USAGE ON SCHEMA public TO shortkit_app, shortkit_auth` with no
  `ALTER DEFAULT PRIVILEGES` for the auth role is right**, at all three sites, and matches
  the contract's "Roles" block and F-239's reasoning.
- GC-A: no tenant-scoped table is created here, so its three obligations do not apply.
  GC-B: nothing in this diff keys on `NODE_ENV`; the two new bindings are declared
  variables. GC-J: every path is `apps/api/**`, infra or repo-root config, and the commit
  carries no AI attribution trailer.
- `apps/api/scripts/seed.mts`'s new paragraph is accurate — `SEED_UNITS` writes `tenants`
  only, so the grant check it performs really does cover everything it seeds. One
  readability cost: the sentence that follows it, "Connecting as the runtime role and
  writing turns **that** into `permission denied for table tenants`", now refers back past
  the inserted exception paragraph. Not filed as a finding.
