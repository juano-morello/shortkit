---
id: STORY-003
epic: EPIC-001
title: Tenant-scoped persistence with row-level security
status: in-progress
tasks: [TASK-005, TASK-006]
depends_on: [STORY-001]
---

## User story

As Juano, I need a data layer where a query issued without tenant context returns nothing, so that isolation is structural rather than remembered.

## Acceptance criteria

- [ ] AC-8: Given two tenants A and B each owning one row in an RLS-protected table, when a read runs inside a transaction with tenant context set to A, then exactly A's row is returned and B's row is not.
- [ ] AC-9: Given tenant context set to A, when a write attempts to insert or update a row carrying tenant B's `tenant_id`, then the write fails or affects zero rows, and the database contains no row of B's owned by A.
- [ ] AC-10: Given a query against an RLS-protected table issued **outside** any tenant-context transaction, when it executes, then it returns zero rows (it does not return all rows).
- [ ] AC-11: Given the tenant-context transaction helper, when the wrapped function throws, then the transaction rolls back and the tenant context does not leak to the next use of the same connection (verified by a subsequent read on a different tenant returning only that tenant's rows).
- [ ] AC-12: Given the isolation test harness, when it is invoked with a repository method name and two tenant fixtures, then it reports pass/fail per method and its output enumerates which methods were exercised.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS.** The strongest-grounded STORY in the plan: GC-5 gives it an unambiguous rule to build against.

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
