---
id: STORY-020
epic: EPIC-005
title: Proven tenant isolation across the whole surface (SC-1)
status: todo
tasks: [TASK-056]
depends_on: [STORY-007, STORY-009, STORY-014, STORY-016, STORY-017, STORY-018, STORY-019, STORY-003]
---

## User story

As Juano, I need a suite that proves no repository method and no authenticated endpoint leaks across tenants, so SC-1 is evidence rather than a claim.

## Acceptance criteria

- [ ] AC-93: **(SC-1)** Given the isolation suite, when it runs, then it enumerates every exported repository method and every registered authenticated route, and fails if any one of them is not covered by a cross-tenant attempt.
- [ ] AC-94: **(SC-1)** Given the isolation suite, when every cross-tenant read attempt executes, then each returns zero rows, 403, or 404 — never data belonging to another tenant.
- [ ] AC-95: **(SC-1)** Given the isolation suite, when every cross-tenant write attempt executes, then each is rejected or affects zero rows, and a post-run database check finds no row whose `tenant_id` was altered.
- [ ] AC-96: Given a new authenticated route is added without a corresponding isolation case, when the suite runs, then it fails and names the uncovered route.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS.** The strongest STORY in the plan — AC-96 makes the suite self-maintaining. **Ship it even if other EPIC-005 STORIEs are cut**, because SC-1 is a claim the portfolio makes.

The suite records **two** explicit, justified exclusions: the redirect module's non-tenant-scoped read (TASK-029) and `privilegedTenantEraser` (TASK-054). Any third exclusion added later fails the suite unless accompanied by a written justification.

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
