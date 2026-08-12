---
id: TASK-056
story: STORY-020
epic: EPIC-005
title: Full-surface tenant isolation suite with completeness enforcement (SC-1)
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-006, TASK-018, TASK-021, TASK-025, TASK-040, TASK-045, TASK-049, TASK-051, TASK-053, TASK-054]
paths: ["apps/api/test/isolation/**"]
contracts: [design/contracts/click-events.md, design/contracts/isolation-coverage.md, design/contracts/rate-limit.md, design/contracts/redirect-resolution.md, design/contracts/tenant-context.md, design/contracts/tenant-scoped-tables.md, design/contracts/workspace-authorization.md]
test_files: []
acceptance: [AC-93, AC-94, AC-95, AC-96]
rework_count: 0
---

## Intent

Turn SC-1 from a claim into a suite that fails when the claim stops being true.

## Approach

**SC-1** — coverage is enforced **by enumeration, not by a hand-maintained list**, so a new route or repository method added later fails the suite by default (AC-96); every attempt must return zero rows, 403, or 404 (AC-94) and no write may alter a `tenant_id` (AC-95); the suite runs in CI.

**The suite records exactly two explicit, justified exclusions:**

1. The redirect module's non-tenant-scoped read (TASK-029) — resolution happens before a tenant is known because the visitor is anonymous.
2. `privilegedTenantEraser` (TASK-054) — GDPR deletion is deliberately outside the tenant-facing interface.

**Any third exclusion added later fails the suite unless accompanied by a written justification.**

## Out of scope for this TASK

Fixing leaks it finds (those are rework TASKs), performance of the suite, penetration testing beyond tenant boundaries.

## Interfaces

**Consumes**

`createTenantFixtures`, `assertNoCrossTenantAccess`, `isolationReport` (TASK-006); every repository and authenticated route from TASK-018, TASK-021, TASK-025, TASK-040, TASK-045, TASK-049, TASK-051, TASK-053, TASK-054; `tenantScopedTables()` (TASK-053); `assertNoTenantResidue`, `privilegedTenantEraser` (TASK-054).

**Produces**

The SC-1 suite with a completeness assertion; a machine-readable coverage report.
