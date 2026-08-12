---
id: TASK-044
story: STORY-015
epic: EPIC-004
title: Web certificate status and failure remediation
status: deferred
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-041, TASK-042]
paths: ["apps/web/app/(app)/domains/**", "apps/web/src/components/domains/**"]
contracts: [design/contracts/domain-provisioning.md, design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-70, AC-72]
rework_count: 0
---

## Intent

Show the operator where a domain is in provisioning and what to do when it stalls.

## Approach

Each `DomainState` renders distinct copy; `certificate_failed` shows the reason and a working retry; the screen reflects state changes without a manual refresh; copy is human-facing prose (GC-12).

## Out of scope for this TASK

DNS instruction rendering (TASK-041), branding (TASK-047).

## Interfaces

**Consumes**

`<DomainStateBadge />`, `/domains` route (TASK-041); `certificateStatus` and the retry endpoint (TASK-042).

**Produces**

Provisioning progress and retry UI on `/domains`.

## ⚠ BLOCKED on dispatch

Depends on TASK-042, which requires a registered apex domain.
