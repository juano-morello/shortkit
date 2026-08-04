---
id: TASK-042
story: STORY-015
epic: EPIC-004
title: Automated certificate provisioning state machine
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-039, TASK-040]
paths: ["apps/api/src/domains/certificates/**"]
contracts: [design/contracts/domain-provisioning.md]
test_files: []
acceptance: [AC-70, AC-72, AC-73]
rework_count: 0
---

## Intent

Verified → active with no human in the loop.

## Approach

**SC-4** — no manual step between verified and active; provisioning is triggered by the verification transition, not by a person; failures land in `certificate_failed` with an actionable reason and a **retry that is safe to repeat**; domain deletion releases the hostname/certificate binding (AC-73).

**Fly's certificate API has unpublished quotas** for large numbers of custom hostnames (`refinement.md` Risks). Confirm behaviour before relying on it, and surface quota errors as an actionable reason rather than a generic failure.

## Out of scope for this TASK

Hostname routing into the redirect module (TASK-043), UI (TASK-044), certificate renewal automation beyond what the platform provides.

## Interfaces

**Consumes**

`verifyDomain` and its transition (TASK-039); `DomainState`, `domainRepository.transitionState` (TASK-038); `domainContract` (TASK-040).

**Produces**

Automatic `verified → provisioning → active` transition; `POST /domains/:id/retry-certificate`; `certificateStatus(domainId)` → `{ state, reason }`; the documented provisioning window AC-70 asserts against.

## ⚠ BLOCKED on dispatch

Requires a **registered apex domain**. AC-70 exercises Fly's real certificate API; faking it would test the mock. One of exactly three hard-blocked TASKs (042 → 043 → 044, serial, trailing wave D).
