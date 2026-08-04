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

## Interfaces

**Consumes**

Root scripts `lint`, `typecheck`, `test`, `build` (TASK-001).

**Produces**

Workflow `ci` with a job named `quality`, triggered on push and pull_request.
