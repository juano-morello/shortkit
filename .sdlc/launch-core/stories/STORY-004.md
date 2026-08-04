---
id: STORY-004
epic: EPIC-001
title: Shared contracts and a uniform error surface
status: todo
tasks: [TASK-007, TASK-008]
depends_on: [STORY-001]
---

## User story

As Juano, I need one place that defines request/response shapes and error codes, so the web app and API cannot drift.

## Acceptance criteria

- [ ] AC-13: Given an API endpoint that rejects a request, when the response is returned, then its body validates against the shared error contract and carries a stable machine-readable `code` field.
- [ ] AC-14: Given a contract is changed incompatibly in `packages/contracts`, when `pnpm typecheck` runs at the root, then it exits non-zero because `apps/web` no longer compiles.
- [ ] AC-15: Given the web API client receives a response, when the response body does not validate against the declared contract, then the client raises a distinguishable contract-violation error rather than returning malformed data.

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
