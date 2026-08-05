---
id: TASK-002
story: STORY-002
epic: EPIC-001
title: CI pipeline running the quality gates
status: tests-red
test_exempt: true
test_exempt_reason: >-
  AC-5's intent clause is GitHub Actions runner semantics, not a property of any importable
  value, and the only in-process assertion available is an open-ended negative: a test
  enumerating continue-on-error, `|| true` and `set +e` passes a workflow that uses the fourth
  evasion. Nothing hosts such a test today (verified: no vitest project collects a file under
  tools/, and `vitest run <path>` reports no test files) and no YAML parser resolves in any
  workspace (verified MODULE_NOT_FOUND for both js-yaml and yaml), leaving regex-over-YAML,
  which writing-good-tests.md names as a warning sign. Ruled by Juano 2026-08-05. AC-5 and
  AC-114 are verified by the workflow running in CI and by sdlc-product-auditor reading it.
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: [".github/**"]
contracts: []
test_files: []
acceptance: [AC-5, AC-114, AC-113]
rework_count: 0
---

## ⚠ AC-113 half added 2026-08-05 (F-084, ruled by Juano)

**This TASK owns the invocation, not the check.** TASK-004 writes
`apps/web/scripts/assert-no-inlined-secrets.mjs` and exposes it as the `assert:no-secrets`
package script. The workflow this TASK produces must build `apps/web` and then run that
script, so a build inlining a server-only value fails the pipeline:

```yaml
- run: pnpm --filter @shortkit/web build
- run: pnpm --filter @shortkit/web assert:no-secrets
```

**Why AC-113 is on both TASKs' acceptance lists.** AC-113 is one criterion whose two halves
sit in two different paths lists — the check itself under `apps/web/**`, the thing that fails
CI under `.github/**`. Left on TASK-004 alone, `sdlc-product-auditor` auditing this TASK has no
criterion requiring the invocation step and would be right to file it as scope nobody asked
for; auditing TASK-004 it would find AC-113 unmet, because a script nothing runs fails no
pipeline. Each TASK's amendment block names the half it discharges, and the auditor checks
that half. F-084 exists because AC-113 was minted against a single TASK that could only
deliver one half of it.

## Intent

Block merges that fail lint, typecheck, test or build.

## Approach

Uses the root scripts produced by TASK-001 and the values `init` wrote into `config.yaml`; must fail the workflow on any non-zero exit; free-tier runner minutes only (GC-3).

## Out of scope for this TASK

Deployment, the performance gate (TASK-037), coverage thresholds.

**Paths widened 2026-08-04 (F-055 consequence).** `paths` moved from
`.github/workflows/**` to `.github/**`. Juano's F-055 ruling keeps exact pinning and
requires it be paired with an update mechanism; ADR-0018 makes that mechanism
`.github/dependabot.yml`, which the old glob excluded. With the old glob an implementer
would correctly refuse to write the file and the ruling would not take effect.

**Amended 2026-08-04 (F-039, ruled by Juano).** The `integration` job is **in** scope
and was missing. ADR-0001's follow-ups assigned it here; the assignment never reached
this file, whose Produces block listed only `quality`. Without it every integration
test exists and never runs: `pnpm test` is deliberately DB-free and stays green, so CI
passes while the whole RLS and tenant-isolation surface goes unexercised, and SC-1
reads as proven by a suite nothing invokes. The local counterpart is
`docker-compose.test.yml` and belongs to TASK-005 (F-038).

## Interfaces

**Consumes**

Root scripts `lint`, `typecheck`, `test`, `build` (TASK-001).

**Produces**

Workflow `ci` with a job named `quality`, triggered on push and pull_request.

Workflow `ci` also with a job named `integration`, running `pnpm test:integration`
against a `postgres:17-alpine` service container, triggered on the same events and
failing the workflow on any non-zero exit. Per ADR-0001 the job runs migrations before
the suite. Per ADR-0018 every job installs with a frozen lockfile.

## ⚠ Two obligations added 2026-08-04 (F-064, ruled by Juano)

Both were stated in round-1 audit findings and never reached this file. The orchestrator
recorded F-047 and F-044 as fixed on their code halves alone; these are the missing halves.

**1. Resolve pnpm from `packageManager`, do not hardcode a version.** The root
`package.json` carries `pnpm@11.20.0+sha512.9a6f330a...`, an integrity hash the security
auditor verified against the npm registry. A setup step that hardcodes a bare `11.20.0`
never checks that hash, so the hash is decorative and reads as supply-chain coverage that
does not exist. Use a setup step that reads `packageManager`. Consider
`node-version-file: package.json` for the Node floor too, so `engines` stays the single
source of truth.

**2. The `integration` job must assert a non-zero test count.** `pnpm test:integration`
passes with `passWithNoTests: true`, so a suite that matches nothing exits 0 while a real
Postgres service container spins up and zero assertions run. TASK-001 added a guard that
catches a *near-miss* filename, but not the case where the glob legitimately matches
nothing. Without this assertion SC-1 can read as proven by a suite no pipeline invokes,
which is the failure F-039 exists to prevent.

## ⚠ AC-114 added 2026-08-05 (F-079, ruled by Juano)

**AC-114: the `integration` job must assert it collected at least one test file and at least
one test, and fail the workflow if it collected none.** This is obligation 2 of the F-064
block above, which until now existed only in this TASK file. AC-5's only occurrence of
"non-zero" is about a command's exit code, so AC-5 as written was satisfied by an
`integration` job that stands up `postgres:17-alpine` and runs zero assertions —
the failure F-039 exists to prevent, re-entering through the acceptance criteria.

**Also recommended, and worth taking beyond the AC.** Declare a `gate` job with
`needs: [quality, integration]` and make *that* the branch's required check. GitHub Actions
rejects a workflow whose `needs` names a job that does not exist, so a job silently dropped
or renamed becomes a hard configuration error instead of a green pipeline that ran nothing.
Raised by `sdlc-test-architect` while establishing AC-5's exemption.
