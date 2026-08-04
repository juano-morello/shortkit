---
id: STORY-006
epic: EPIC-002
title: Agency account and client workspaces
status: todo
tasks: [TASK-013, TASK-014, TASK-015]
depends_on: [STORY-005]
---

## User story

As an agency operator, I get an agency on signup and create one workspace per client, so that each client's links are separated.

## Acceptance criteria

- [ ] AC-22: Given signup completes, when the new account's tenant is queried, then exactly one agency tenant exists with that account as its owner.
- [ ] AC-23: Given an authenticated owner in tenant A, when a workspace is created with a name, then it is returned with an id and appears in that tenant's workspace list.
- [ ] AC-24: Given a workspace belonging to tenant B, when an authenticated user of tenant A requests it by id, then the response is 404 (not 403 — existence is not disclosed).
- [ ] AC-25: Given a workspace list request from tenant A, when the response is returned, then it contains only workspaces whose `tenant_id` is A, for any number of tenants present in the database.
- [ ] AC-26: Given the operator has more than one workspace, when a workspace is selected in the UI, then subsequent link and settings screens display data for only that workspace.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS.**

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
