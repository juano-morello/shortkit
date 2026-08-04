---
id: STORY-019
epic: EPIC-005
title: GDPR export and account deletion with cascade
status: todo
tasks: [TASK-053, TASK-054, TASK-055]
depends_on: [STORY-012, STORY-014, STORY-016, STORY-017]
---

## User story

As an agency operator, I can take all my data out and delete my account permanently.

## Acceptance criteria

- [ ] AC-88: Given a tenant with workspaces, members, domains, links, click events and audit entries, when an export is requested, then the produced archive contains records from every one of those categories for that tenant.
- [ ] AC-89: Given tenants A and B, when tenant A exports, then the archive contains zero records belonging to tenant B (verified by asserting no `tenant_id` other than A's appears anywhere in the archive).
- [ ] AC-90 **(revised 2026-08-03, Amendment A-2)**: Given a tenant requests deletion and confirms it, when the **privileged deletion path** completes, then a referential check over every table containing a `tenant_id` — **including `click_events` and `audit_entries`** — returns zero rows for that tenant and zero orphaned rows referencing deleted parents. Rows are hard-deleted, not marked.
- [ ] AC-91: Given a tenant has been deleted, when its members attempt to log in, then authentication fails; and when a link that belonged to it is requested, then the response is the branded 404, not a 5xx.
- [ ] AC-92: Given a deletion request without the documented confirmation step, when it is submitted, then it is rejected and the tenant's data is unchanged.
- [ ] AC-106 **(new 2026-08-03, Amendment A-2)**: Given the privileged deletion path, when every authenticated tenant-facing route is enumerated, then none of them invokes it except `POST /gdpr/delete`, and that route requires the tenant `owner` role plus the documented confirmation step.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS** (was FAIL). The conflict between SC-6's append-only guarantee and GDPR erasure is resolved by Amendment A-2: append-only is scoped to the tenant-facing API, and deletion runs through a separate privileged path that hard-deletes. AC-60 and AC-90 were rewritten, AC-106 added, and the privileged eraser is an explicit, separately-testable surface in TASK-054 so a security auditor finds it deliberately rather than discovering it.

- [x] ACs are testable and unambiguous
- [x] Dependencies identified
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run yet
- [x] No blocking open questions

## Definition of Done
- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids
