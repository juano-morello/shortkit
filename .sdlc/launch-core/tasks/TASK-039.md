---
id: TASK-039
story: STORY-014
epic: EPIC-004
title: DNS verification with per-record diagnostics
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-038]
paths: ["apps/api/src/domains/verification/**"]
contracts: []
test_files: []
acceptance: [AC-66, AC-67]
rework_count: 0
---

## Intent

Check DNS and, when it is wrong, say exactly what is wrong.

## Approach

**SC-4** — a failure must yield the record type, record name, expected value, **and the value actually observed**; verification runs without human intervention on a trigger and/or schedule; **DNS lookups must be fakeable so tests do not depend on real DNS**; propagation delay is not treated as permanent failure.

**Not apex-blocked** — `FakeDnsResolver` exists precisely so this is testable without a registered domain. AC-67's *live* form waits on one; record the unit-level pass as **provisional**.

## Out of scope for this TASK

Certificate provisioning (TASK-042), endpoints (TASK-040), UI copy (TASK-041).

## Interfaces

**Consumes**

`DomainState`, `domainRepository.transitionState`, `verification_token` (TASK-038).

**Produces**

`requiredDnsRecords(domain)` → `[{ type, name, value }]`; `verifyDomain(domainId)` → `{ verified: boolean, diagnostics: [{ type, name, expected, observed }] }`; `FakeDnsResolver` for tests.
