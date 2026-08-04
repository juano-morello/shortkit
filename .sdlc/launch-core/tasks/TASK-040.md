---
id: TASK-040
story: STORY-014
epic: EPIC-004
title: Domain endpoints and contracts
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-039, TASK-017, TASK-007]
paths: ["apps/api/src/domains/**", "packages/contracts/src/domains/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/domain-provisioning.md, design/contracts/error-envelope.md, design/contracts/tenant-context.md, design/contracts/workspace-authorization.md]
test_files: []
acceptance: [AC-65, AC-68, AC-69]
rework_count: 0
---

## Intent

Add, list, check, and remove custom domains.

## Approach

Cross-tenant access returns **404** (AC-69); a hostname already claimed returns a stable `code` **without disclosing which tenant holds it** (AC-68); the response carries the required DNS records and the latest diagnostics verbatim.

**Not apex-blocked.**

## Out of scope for this TASK

Certificate lifecycle (TASK-042), hostname routing (TASK-043), UI.

## Interfaces

**Consumes**

`verifyDomain`, `requiredDnsRecords` (TASK-039); `DomainState` (TASK-038); `@RequireWorkspaceRole` (TASK-017); `ErrorEnvelope` (TASK-007).

**Produces**

`POST/GET/DELETE /domains`, `POST /domains/:id/verify`; `domainContract` — `{ id, hostname, state, requiredRecords, diagnostics, lastError }`; error code `hostname_already_claimed`.
