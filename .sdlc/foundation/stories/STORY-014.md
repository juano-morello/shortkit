---
id: STORY-014
epic: EPIC-004
title: Custom domain add and DNS verification
status: deferred
tasks: [TASK-038, TASK-039, TASK-040, TASK-041]
depends_on: [STORY-009, STORY-007]
---

## User story

As an agency operator, I add my client's branded domain and am told exactly which DNS records to create, so I can hand precise instructions to whoever runs their DNS.

## Acceptance criteria

- [ ] AC-65: Given an authenticated operator adds `links.client.example`, when the domain is created, then it is returned in a `pending_verification` state together with the exact record type, name, and value to create.
- [ ] AC-66: **(SC-4)** Given a domain whose required DNS record is absent or has the wrong value, when verification runs, then the domain remains unverified and the API and UI state the record type, the record name, the expected value, and the value actually observed.
- [ ] AC-67: Given a domain whose required DNS record is correct, when verification runs, then the domain transitions to verified without human intervention.
- [ ] AC-68: Given `links.client.example` is already verified on tenant B, when tenant A attempts to add the same hostname, then the request is rejected with a stable error `code` and no second domain row is created.
- [ ] AC-69: Given a domain owned by tenant B, when tenant A requests or deletes it by id, then the response is 404.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**BLOCKED on dispatch — not on scope.** The ACs are well-formed; they cannot all be executed until an apex domain is registered.

**Corrected 2026-08-03:** less of this STORY is blocked than first reported. TASK-038, 039, 040 and 041 do **not** require a registered domain — TASK-039 produces `FakeDnsResolver` precisely so the verification state machine and the diagnostics UI are testable without live DNS. Only AC-67's *live* form waits on a real domain; record its unit-level pass as provisional so `sdlc-product-auditor` does not read it as end-to-end.

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
