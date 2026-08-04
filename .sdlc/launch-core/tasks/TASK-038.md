---
id: TASK-038
story: STORY-014
epic: EPIC-004
title: Domain verification state and schema
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-023]
paths: ["apps/api/src/db/schema/**", "apps/api/drizzle/**"]
contracts: [design/contracts/domain-provisioning.md, design/contracts/rls-policy-template.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-65, AC-68, AC-69]
rework_count: 0
---

## Intent

Extend the domain record with everything provisioning needs to be a state machine.

## Approach

**GC-5** — RLS applied; hostname is **globally unique across tenants** so AC-68 is a constraint rather than a check; the state set must distinguish verification failure from certificate failure so AC-66 and AC-72 are separately testable.

**Not apex-blocked.** This TASK needs no registered domain.

## Out of scope for this TASK

DNS lookups (TASK-039), certificates (TASK-042), endpoints (TASK-040), UI.

## Interfaces

**Consumes**

`domains`, `domainRepository`, RLS template (TASK-023).

**Produces**

`domains` extended with `state`, `verification_token`, `last_checked_at`, `last_error`; `DomainState` = `pending_verification | verified | provisioning | active | verification_failed | certificate_failed`; unique constraint on `hostname`; `domainRepository` extended with `transitionState`.
