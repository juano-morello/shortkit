---
id: TASK-053
story: STORY-019
epic: EPIC-005
title: Tenant data export
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-016, TASK-020, TASK-023, TASK-033, TASK-038, TASK-045, TASK-048]
paths: ["apps/api/src/gdpr/**", "packages/contracts/src/gdpr/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/click-events.md, design/contracts/error-envelope.md, design/contracts/tenant-context.md, design/contracts/tenant-scoped-tables.md, design/contracts/workspace-authorization.md]
test_files: []
acceptance: [AC-88, AC-89]
rework_count: 0
---

## Intent

Give a tenant everything it owns, in a form it can read.

## Approach

**GC-5** — the export runs inside tenant context so **RLS itself is the isolation mechanism**, and AC-89 asserts the result rather than the intent.

Every table carrying `tenant_id` must be represented (AC-88), so **the export enumerates tables rather than listing them by hand** — a table added later without export coverage should fail this TASK's test. **GC-9** — `ip_hash` is exported; raw IPs do not exist to export. **Only a tenant `owner` may export** (AC-105).

## Out of scope for this TASK

Deletion (TASK-054), UI (TASK-055), scheduled or partial exports.

## Interfaces

**Consumes**

Every tenant-scoped repository and table produced by TASK-016, TASK-020, TASK-023, TASK-033, TASK-038, TASK-045, TASK-048; `withTenantTransaction` (TASK-005).

**Produces**

`POST /gdpr/export` → a machine-readable archive; `exportContract`; `tenantScopedTables()` — the enumeration reused by TASK-054 and TASK-056.
