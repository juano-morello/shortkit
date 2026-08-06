# Integration report: launch-core wave 1

**This is an intermediate integration, not the Ship phase.** Juano ruled it on 2026-08-06:
merge `feat/launch-core` into `main`, then continue to wave 2. No release changelog and no
end-to-end acceptance pass against the eight success criteria appear here, because 53 of 58
TASK cards are unimplemented and SC-2, SC-3 and SC-7 have no implementing TASK yet. That
work belongs to the real Ship phase.

| | |
|---|---|
| Verified at | 2026-08-06 |
| Branch | `feat/launch-core` @ `734b56e` |
| Base | `origin/main` @ `cee06e4` |
| Scope | TASK-001 (wave 0), TASK-002, TASK-004, TASK-005, TASK-007 (wave 1) |
| Verifier | `sdlc-integrator` |

## The merge base question

Juano asked for the suite on the merge result rather than on the branch tip. The two are the
same tree here, and that is established rather than assumed.

`origin/main` is a direct ancestor of `HEAD`: 0 behind, 104 ahead. `git merge-tree
--write-tree origin/main HEAD` exits 0 with no conflicted paths and produces tree
`87926071bce41db40a696a96fa95a96221a7bec0`, which is byte-identical to `HEAD^{tree}`.

The merge is a clean fast-forward. **No rebase is needed.** Every result below was produced
against the exact tree the merge will publish.

## Verification

| Check | Command | Result | Notes |
|---|---|---|---|
| Merge cleanliness | `git merge-tree --write-tree origin/main HEAD` | **PASS** | Exit 0, no conflicts. Merged tree equals `HEAD^{tree}`. |
| Unit suite | `pnpm test` | **PASS** | 8 files, 65 tests, 556ms. Covers api, web and contracts. |
| Integration suite | `pnpm test:integration` | **PASS** | 21 tests, 28.13s, against the live container. |
| e2e suite | none | **SKIPPED** | No e2e suite exists. No Playwright, Cypress or Puppeteer in any manifest and no `e2e/` directory. Nothing to run. |
| Lint | `pnpm lint` | **PASS** | Exit 0. |
| Typecheck | `pnpm typecheck` | **PASS** | Root program plus 3 workspace projects, all Done. |
| Build | `pnpm build` | **PASS** | api via tsup (`dist/main.js`, 565.74 KB); web via Next 16.3.0, 3 static routes. |
| Coverage | none | **SKIPPED** | `testing.coverage_gate` is `null` in `.sdlc/config.yaml:50`. No coverage tooling installed and no threshold chosen, so there is no gate to measure against. |
| Production audit | `pnpm audit --prod --audit-level moderate` | **PASS** | "No known vulnerabilities found". This is the merge-blocking audit. |
| Whole-tree audit | `pnpm audit --audit-level moderate` | **FAILS, EXPECTED** | Exit 1 on GHSA-67mh-4wv8-2f99 (esbuild via drizzle-kit). Accepted and assessed in `docs/security/known-advisories.md`. See "What changes on merge" below. |
| Migration forward, compose route | `db:migrate` on a `down -v` container | **PASS** | Exit 0. See "Migrations". |
| Migration forward, CI route | `.github/scripts/provision-test-database.sql` then `db:migrate` | **PASS** | Run on a bare `postgres:17-alpine`. Both roles created `NOBYPASSRLS`. This SQL had never executed anywhere before now. |
| Migration rollback | none | **NO ROLLBACK EXISTS** | Not a pass and not a skip. See "Migrations". |
| Migrator compares timestamps | edited copy of an applied migration | **CAVEAT CONFIRMED** | Reported "migrations applied successfully!", exit 0, executed nothing. See "Migrations". |
| Fixture wipes migrated tables | catalog inspection after the suite | **CAVEAT CONFIRMED** | Schema `public` holds 0 tables afterwards; `db:migrate` does not repair it. See "Migrations". |
| RLS gate, positive | `pnpm db:check-policies` on a freshly migrated DB | **PASS** | `ok tenants`, exit 0. |
| RLS gate, negative | 6 constructed databases | **PASS on 5, GAP on 1** | Exercised, not assumed. See "The RLS gate". |
| Startup / smoke, API | `node dist/main.js` | **PASS** | Boots, listens, serves. See "Startup". |
| Startup / smoke, production | `curl` the Vercel URL | **PASS** | HTTP 200, `text/html; charset=utf-8`, 0.234s. Verified fresh, not quoted. |
| CI integration job, reproduced | migrate, check-policies, suite, collection assert | **PASS** | Run locally in CI's exact order. All four steps exit 0. |
| AC-113 inlined-secret guard | `pnpm --filter @shortkit/web assert:no-secrets` | **PASS, WEAKENED** | Checked 54 files, no leaked value. Its positive control is inactive (F-171); it proves absence of the secret but not build/check environment agreement. Activates at TASK-008. |
| AC-14 contract drift | `node .github/scripts/assert-contract-drift.mjs` | **PASS** | 2 mutations, each broke the consuming workspace's typecheck. Tree confirmed clean afterwards by `git diff --exit-code`. |
| AC-114 collection assert | `node .github/scripts/assert-integration-collected.mjs` | **PASS** | Green on the real report (21 executed of 21 collected); exit 1 on a constructed zero-test report. |
| Backward compatibility | none | **NOT APPLICABLE** | Stated rather than skipped. Nothing consumes these contracts. `main` is the scaffold commit; `@shortkit/contracts` has exactly two consumers, both inside this repo and both in this merge. No external client, no published package, no deployed API. No coordinated deploy is required. |
| GC-4 authorship | `git log` scan of all 104 commits | **PASS** | Zero matches for `Co-Authored-By: Claude`, "Generated with Claude Code", the robot emoji, or "anthropic". All 104 commits authored by `Juano <me@juanomorello.dev>`. |
| CI itself | GitHub Actions | **NOT VERIFIED** | No Actions run stands behind the final commits. Runners were backed up over an hour and every recent run was cancelled by a superseding push. Local verification in this report is currently the only verification. |

## Migrations

### Forward

Clean and repeatable. Verified twice by two independent provisioning routes.

Against a `docker compose down -v` container, `db:migrate` exits 0 and produces `tenants`
with `relrowsecurity = t`, `relforcerowsecurity = t`, and all four hand-appended policies
present with the right commands: `tenants_self_select` (r), `tenants_self_update` (w),
`tenants_self_insert` (a), `tenants_privileged_erase` (d). The UPDATE policy carries both
`USING` and `WITH CHECK`. One row lands in `drizzle.__drizzle_migrations`.

Against a bare `postgres:17-alpine` provisioned by `.github/scripts/provision-test-database.sql`,
the same migration applies and the same policy check passes. That SQL is a TASK-002 artifact
that had never run, in CI or anywhere else, until this verification.

### Rollback

**There is none.** Stating it plainly, as asked.

Drizzle Kit generates no down migrations. `apps/api/drizzle/` holds one `.sql`, one snapshot
and `_journal.json`, and nothing else. No `db:down`, `db:rollback` or `db:revert` script
exists in any manifest. Grepping the migration directory for down, rollback or revert
returns nothing.

For local and test databases the reset is `docker compose -f docker-compose.test.yml down -v`,
then `up -d --wait`, then `db:migrate`. The container stores its data in tmpfs, so this costs
seconds and loses nothing anyone wanted.

For production there is no equivalent, and no production database exists yet. The Fly release
command runs `db:migrate` before a machine takes traffic, so a failed migration blocks the
deploy. Undoing an applied migration would be hand-written SQL against a live database, with
the `__drizzle_migrations` row deleted by hand so the migrator will re-apply. Nothing in the
repo automates or tests that path.

This is not a finding for this merge. The migration is additive, it creates one table, and no
production database has it applied. It is recorded so nobody later reads "migrations verified"
as "rollback verified". No ADR claims a rollback path exists, so nothing was accepted and
then broken.

### Caveat 1: the migrator compares timestamps, not hashes

`docs/architecture/migrations.md` says appending to an already-applied migration is a silent
no-op. Confirmed empirically, without modifying the repository.

A copy of `apps/api/drizzle/` was made in a scratch directory, `CREATE TABLE caveat1_probe`
was appended to the already-applied `0000_odd_betty_ross.sql`, and `drizzle-kit migrate` ran
against the already-migrated database through a scratch config. It printed **"migrations
applied successfully!"** and exited 0. `caveat1_probe` was never created and
`__drizzle_migrations` still held exactly 1 row.

The caveat holds exactly as documented. Editing an applied migration reports success and does
nothing.

### Caveat 2: the integration fixture wipes the migrated tables

Also confirmed. After `pnpm test:integration`, schema `public` held **zero tables**, not an
unprotected `tenants`. Re-running `db:migrate` printed "migrations applied successfully!",
exited 0, and left schema `public` still empty. `db:check-policies` against that database then
failed correctly with exit 1 and "schema public holds no tables".

Both caveats hold. Together they make CI's step ordering load-bearing, and `.github/workflows/ci.yml`
gets it right: `db:migrate`, then `db:check-policies`, then the suite. Reordering those three
would produce a green job that asserted nothing.

## The RLS gate

`pnpm db:check-policies` passes against a freshly migrated database: `ok tenants`, exit 0, with
the four Better Auth exemptions correctly reported as not evaluated because those tables do not
exist yet.

It was also made to fail, on six constructed databases, rather than trusted to.

| Case | Expected | Actual |
|---|---|---|
| Empty schema `public` | FAIL | FAIL, exit 1, "schema public holds no tables" |
| `links` with `tenant_id`, no RLS | FAIL | FAIL, exit 1, "missing ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY" |
| F-147: `user` is in `EXEMPT` but has `tenant_id`, no RLS | FAIL, exemption refused | FAIL, exit 1, printed "exemption does not apply: this table has a tenant_id column" |
| Same table with RLS enabled and forced | PASS, exemption still refused | PASS, exit 0, still routed through the real check |
| `user` with `tenant_id` dropped | PASS, exemption honoured | PASS, "confirmed: no tenant_id column" |
| F-146: table named `constructor`, no RLS | FAIL, must not read as exempt | FAIL, exit 1 |

**F-147's exemption cross-check works as designed, and F-146's `Map` holds.** The gate refuses
to honour an exemption whose premise no longer holds, and it does so on a real database rather
than in a comment.

One gap was found in that cross-check. It is written up as F-213 below.

## Startup

The API boots. It does more than exit cleanly, so the honest answer is better than the one the
dispatch expected.

`node dist/main.js` with `PORT=3111` logs "Nest application successfully started", stays alive,
and serves HTTP. `GET /api/anything` returns 404 with TASK-007's envelope,
`{"code":"not_found","message":"The requested resource was not found."}`, at
`application/json`. Shutdown on SIGTERM was clean.

`GET /health` also returns 404. `main.ts` excludes `health` from the global `/api` prefix so a
platform health check never depends on the API surface, but no controller provides that route
yet. That is a reservation, not a regression, and it is recorded as F-217 because it becomes a
real deployment defect the moment the API is deployed with a health check configured.

The web app is live. `https://shortkit-bp22uipii-juanomorellos-projects.vercel.app` returned
HTTP 200, `text/html; charset=utf-8`, in 0.234s, verified during this run.

## Cross-TASK interaction

Everything green in isolation and broken together is what this phase exists to catch. Wave 1
has four seams, and CI has never completed a run, so none of them had been exercised end to end.
All four were run locally here.

1. **TASK-002 CI meets TASK-005 database scripts.** CI's integration job was reproduced step by
   step in its exact order against a clean container: provision, `db:migrate`, `db:check-policies`,
   suite with the JSON reporter, collection assertion. All exit 0. The ordering comment in
   `ci.yml` is correct and the two migration caveats prove why it has to be.
2. **TASK-002 CI meets TASK-004 web.** `pnpm --filter @shortkit/web build` followed by
   `assert:no-secrets` under a single job-level `BFF_PROXY_SECRET`, as `ci.yml` does it. Passes,
   with the disclosed limitation that the positive control is inactive until TASK-008.
3. **TASK-002 harness meets TASK-007 contracts meets TASK-004 web.** `assert-contract-drift.mjs`
   ran both mutations. Renaming an `ERROR_CODES` member broke `apps/web`'s typecheck; renaming
   `FORM_ERROR_KEY` broke `apps/api`'s. Each mutation was reverted and the tree confirmed clean
   by `git diff --exit-code`. AC-14 genuinely holds across three separately-implemented TASKs.
4. **TASK-001 bootstrap meets TASK-007 exception filter.** The built binary boots and the filter
   answers, verified over HTTP rather than in a unit test.

No seam defect was found.

## Findings

Ids continue from F-212, the highest in `findings.yaml`. **They are proposed, not appended.**
This agent writes only to `ship/**`, so nothing was added to `.sdlc/launch-core/findings.yaml`.

```yaml
- id: F-213
  phase: ship
  source: sdlc-integrator
  round: 1
  severity: major
  kind: security
  file: apps/api/scripts/check-policies.mts
  line: 93
  summary: >-
    F-147's exemption cross-check queries information_schema.columns, which Postgres filters
    by privilege, so an exempt table the app role holds no grant on is reported as
    "confirmed: no tenant_id column" when it has one.
  failure_scenario: >-
    Verified on a live database, not reasoned about. A table named `session` was created with a
    `tenant_id` column, no RLS, and `REVOKE ALL ... FROM shortkit_app`. As shortkit_app,
    information_schema.columns returned 0 rows for it, so the cross-check saw no tenant_id and
    honoured the exemption. check-policies printed
    "skip session - exempt: Better Auth. No tenant_id (ADR-0003, ADR-0015) (confirmed: no
    tenant_id column)" and exited 0 on a tenant-bearing table with row security off. The word
    "confirmed" is the false claim. All four EXEMPT names are the Better Auth tables TASK-009
    creates, and Better Auth applies its own schema through its own tooling, which need not be
    shortkit_migrator. docker-compose.test.yml's own header documents exactly this: ALTER
    DEFAULT PRIVILEGES is scoped to the identity shortkit_migrator, so a deploy that runs
    migrations as any other role grants shortkit_app nothing. The gate is the only thing that
    looks at RLS, and this is the one path that walks past it while printing a confirmation.
  required_change: >-
    Replace the information_schema.columns query with a pg_attribute join, which is not
    privilege-filtered. Verified on the same database in the same session: as shortkit_app,
    information_schema.columns returned 0 rows and
    `select c.relname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n
    on n.oid = c.relnamespace where n.nspname = 'public' and a.attname = 'tenant_id'
    and a.attnum > 0 and not a.attisdropped` returned `session`. The TABLES query above it
    already reads pg_class for the same reason, so this makes the file consistent with itself.
  owner_slot: implementer
  owner_task: TASK-005
  status: open
  blocking: false
  note: >-
    Not blocking this merge. No EXEMPT table exists today and `tenants` is not exempt, so the
    gate is sound on the current schema. It must be fixed before TASK-009 lands, which is the
    next wave. F-122 made this script a blocking prerequisite for TASK-023.

- id: F-214
  phase: ship
  source: sdlc-integrator
  round: 1
  severity: major
  kind: process
  file: .sdlc/launch-core/state.yaml
  line: 22
  summary: >-
    The tasks: block still records TASK-004 as in-audit with AC-7 blocked, contradicting the
    wave-1 gate approval in the same file.
  failure_scenario: >-
    Line 16 approves implement.wave_1 over "TASK-002, TASK-004, TASK-005, TASK-007" and log line
    733 records "TASK-001 (wave 0), TASK-002, TASK-004, TASK-005 and TASK-007 all done" with AC-7
    re-verified live at 200 text/html. Line 22 still reads
    `status: in-audit, ac_blocked: [AC-7], blocked_on: "AC-7 needs a deployed Vercel URL; repo has
    no git remote and no Vercel credentials."` and the escalation at line 29 still asserts "AC-7
    stays open; TASK-004 still cannot reach done." All three claims in that blocked_on string are
    now false: the remote exists, the deploy is live, and AC-7 was verified twice. state.yaml is
    the file the workflow resumes from, so an agent reading the tasks: block rather than the log
    concludes wave 1 is incomplete and re-dispatches finished work. TASK-004's recorded head
    fad4d28 is also stale; 91d81d6 landed under TASK-004 afterwards.
  required_change: >-
    Set TASK-004 status: done, clear ac_blocked and blocked_on, update head to the real final
    commit, and retire or annotate the two stale TASK-004 escalation entries.
  owner_slot: orchestrator
  status: open
  blocking: false

- id: F-215
  phase: ship
  source: sdlc-integrator
  round: 1
  severity: minor
  kind: process
  file: .gitignore
  line: 1
  summary: Orphan commit c5e1165 carries no TASK id and no ledger scope.
  failure_scenario: >-
    `fix: restate the .env.example negation after vercel's .env* rule` modifies .gitignore,
    findings.yaml and state.yaml. The work is legitimate and well explained in its body: `vercel
    link` appended `.env*` below the `!.env.example` negation and overrode it. But it is
    attributable to TASK-004, and its own body says F-169 requires TASK-009 to add
    apps/api/.env.example, so the change is enabling work for a TASK two waves out. Untagged
    commits are where scope creep hides, which is the reason the traceability rule exists.
  required_change: >-
    Attribute it in the ledger to TASK-004, or record it as accepted out-of-band housekeeping
    with a reason. Do not rewrite the commit; it is already pushed.
  owner_slot: orchestrator
  status: open
  blocking: false

- id: F-216
  phase: ship
  source: sdlc-integrator
  round: 1
  severity: minor
  kind: process
  file: .sdlc/launch-core/stories/STORY-001.md
  line: 5
  summary: >-
    STORY-001 has all its TASKs done and the wave-1 gate approved, but its front-matter still
    reads status: todo and none of its five DoD boxes is ticked.
  failure_scenario: >-
    STORY-001 holds exactly one TASK, TASK-001, done since wave 0. Its Definition of Done lists
    five items, all unchecked, including "Traceable: commits reference TASK ids" which this report
    verifies as met. phases/ship.md step 5 requires every STORY's DoD to be recorded, so a
    completed STORY carrying no record leaves the real Ship phase with nothing to cite.
    STORY-002, STORY-003 and STORY-004 are correctly still todo: each contains an unfinished TASK
    (TASK-003, TASK-006 and TASK-008 respectively). STORY-001 is the only one at fault.
  required_change: Record STORY-001's DoD and set its status.
  owner_slot: orchestrator
  status: open
  blocking: false

- id: F-217
  phase: ship
  source: sdlc-integrator
  round: 1
  severity: minor
  kind: implementation
  file: apps/api/src/main.ts
  line: 47
  summary: >-
    main.ts excludes GET /health from the global prefix so a platform health check never depends
    on the API surface, but no controller serves /health, so it returns 404.
  failure_scenario: >-
    Verified against the built binary: GET /health returns 404 with the not_found envelope. The
    API is not deployed today, so nothing is broken now. A Fly deployment configured with an HTTP
    health check on /health would never pass it, and the platform would cycle machines that are
    in fact healthy. The exclusion in main.ts reads as though the route exists.
  required_change: >-
    Either land the health controller with the TASK that first deploys the API, or note in
    main.ts that the exclusion is a reservation and name the TASK that fills it.
  owner_slot: implementer
  owner_task: TASK-003
  status: open
  blocking: false

- id: F-218
  phase: ship
  source: sdlc-integrator
  round: 1
  severity: minor
  kind: process
  file: .github/workflows/ci.yml
  line: 1
  summary: No GitHub Actions run stands behind the commits being merged.
  failure_scenario: >-
    Runners were backed up over an hour and every recent run was cancelled by a superseding push,
    which is correct behaviour under the concurrency block F-190 scoped to non-default refs. The
    consequence is that every control in ci.yml is verified by local reproduction only. This
    report reproduces all of them, including the three scripts that had never executed anywhere,
    but a local run does not prove the workflow YAML parses, that the services: block starts, or
    that the runner image behaves as assumed.
  required_change: >-
    Let CI run to completion on main after the merge and read the result before wave 2 dispatches.
  owner_slot: orchestrator
  status: open
  blocking: false
```

## Traceability

104 commits on `origin/main..HEAD`, all authored by `Juano <me@juanomorello.dev>`.

| | |
|---|---|
| Commits referencing a TASK id | 32 |
| `docs(sdlc)` ledger commits | 70 |
| Orphans | 2 |

Per-TASK commit counts: TASK-001 17, TASK-002 26, TASK-004 9, TASK-005 20, TASK-007 36.
TASK-009 appears once, in `1a3291f docs(sdlc): re-attribute better-auth pin to TASK-009`,
which is a ledger commit re-attributing a dependency pin rather than implementation work.
TASK-009 is not claimed done, so this is correct.

**Orphan commits** (neither a TASK id nor a `docs(sdlc)` ledger commit):

- `c5e1165` `fix: restate the .env.example negation after vercel's .env* rule`. Real product
  change, no TASK id. Filed as F-215.
- `98306e1` `chore(sdlc): rename branch to feat/launch-core, align branch_prefix [launch-core]`.
  Touches only `.sdlc/config.yaml` and `.sdlc/launch-core/state.yaml`, carries the `[launch-core]`
  tag, and is a ledger commit in everything but the `docs(sdlc)` prefix. Benign. Recorded here
  and not filed.

**TASKs marked done with no commit:** none. Every recorded head SHA resolves and sits on the
branch: `bd89924` (TASK-001), `2627867` (TASK-002), `fad4d28` (TASK-004), `9eb654a` and
`cdb07e4` (TASK-005), `7913b16` (TASK-007).

**Ledger contradiction:** TASK-004 is recorded `done` by the wave-1 gate and `in-audit` by the
`tasks:` block of the same file. Filed as F-214.

**Incomplete DoDs:** STORY-001 only. Filed as F-216. STORY-002, STORY-003 and STORY-004 each
still contain an unfinished TASK, so their `status: todo` is correct rather than stale.

**AI attribution:** none. All 104 commit messages were scanned for `Co-Authored-By: Claude`,
"Generated with Claude Code", the robot emoji and "anthropic". Zero matches. GC-4 holds.

## What changes on merge

Two things start happening that have never happened, both intended, one of which will look like
a failure.

`dependencies.yml` begins running. `schedule:` only fires from the default branch and the file
exists only on `feat/launch-core`, which is Juano's stated reason for merging now. Its first
Monday run at 06:17 UTC **will fail**, exit 1 on GHSA-67mh-4wv8-2f99. That is the documented,
accepted advisory in `docs/security/known-advisories.md`, and the register deliberately takes no
`--ignore` so an accepted advisory still fails and still has to be re-read. Reproduced in this
run: `--prod` exits 0, whole-tree exits 1 on that row. Expect the email.

Branch protection and the `gate` job start guarding something real. Until now `main` was the
scaffold commit and neither existed there.

## Verdict

**Safe to merge.** No blocking finding.

The merge is a clean fast-forward to a tree that passes unit, integration, lint, typecheck,
build and the production audit, whose migration applies forward on a clean database by two
independent provisioning routes, whose RLS gate was made to fail on five of six constructed
databases, and whose four cross-TASK seams were each exercised end to end.

Six findings are open, all non-blocking. **F-213 is the one to fix first**, and it should be
fixed before TASK-009 rather than before the merge: it is the only finding that weakens a
security control, and TASK-009 creates the exact four tables that trigger it.

The honest caveat on everything above: CI has never run green on these commits, so this local
verification is currently the only verification.
