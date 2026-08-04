---
id: TASK-002
story: STORY-002
epic: EPIC-001
title: CI pipeline running the quality gates
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: [".github/workflows/**"]
contracts: []
test_files: []
acceptance: [AC-5]
rework_count: 0
---

## Intent

Block merges that fail lint, typecheck, test or build.

## Approach

Uses the root scripts produced by TASK-001 and the values `init` wrote into `config.yaml`; must fail the workflow on any non-zero exit; free-tier runner minutes only (GC-3).

## Out of scope for this TASK

Deployment, the performance gate (TASK-037), coverage thresholds.

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
