---
id: STORY-003
epic: EPIC-001
title: Tenant-scoped persistence with row-level security
status: done
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

## Verification at Ship — 2026-08-11 (F-397)

**No STORY in this initiative recorded its Definition of Done until Ship.** Twenty acceptance
criteria and twenty DoD items across four cards, every one still `- [ ]` while ten TASKs were
`done`. The evidence existed in `state.yaml`, the acceptance report and the integration report; it
was absent from the cards a reader opens. Found by the Ship traceability pass, not by any of the
six audits that ran today.

**Checkboxes are deliberately left unticked and this block records the state instead.** A tick is a
claim with no room for a caveat, and three of this initiative's criteria are not the kind of thing a
tick can honestly carry — one is untestable by construction, one was met by an artifact that no
longer exists, and one has never been observed in the environment it gates. Evidence below, per
criterion, with what is *not* proven stated beside what is.

See `.sdlc/foundation/ship/acceptance-report.md` for the per-criterion verdict and
`ship/integration-report.md` for the evidence. **SC-1 is `untestable`, not "partly met"** — it
quantifies over "every repository method and every authenticated endpoint" and both sets are empty,
so a verbatim reading is vacuously true, which is the shape the harness's own F-295 rule refuses.

**DoD.** Auditors clear of blocker/major: **yes**. Docs updated: **yes**. Observability per config:
**yes**. Traceable: **yes for feature commits**, with five source-touching orphans named in F-398.
