---
id: TASK-006
story: STORY-003
epic: EPIC-001
title: Cross-tenant isolation test harness
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-005]
paths: ["apps/api/test/isolation/**"]
contracts: []
test_files: []
acceptance: [AC-12]
rework_count: 0
---

## Intent

Build the reusable machinery SC-1 needs, before there are entities to point it at.

## Approach

The harness accepts a repository method or route plus two tenant fixtures and asserts zero rows / 403 / 404; it must report which surfaces it exercised so TASK-056 can assert completeness against that report.

## Out of scope for this TASK

Enumerating the full surface (TASK-056) — nothing but `tenants` exists yet; endpoint coverage.

## Interfaces

**Consumes**

`withTenantTransaction`, `db`, `tenants` (TASK-005).

**Produces**

`createTenantFixtures()` → two isolated tenants with seeded rows; `assertNoCrossTenantAccess(subject)` — asserts zero rows / 403 / 404; `isolationReport()` → the list of surfaces exercised in a run.
