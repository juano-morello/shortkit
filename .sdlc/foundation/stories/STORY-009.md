---
id: STORY-009
epic: EPIC-003
title: Link CRUD with per-domain short codes
status: deferred
tasks: [TASK-023, TASK-024, TASK-025, TASK-026]
depends_on: [STORY-006, STORY-007]
---

## User story

As an agency operator, I create a short link for a client, with a generated or custom slug, so that I can share it.

## Acceptance criteria

- [ ] AC-37: Given an authenticated operator in workspace W1, when a link is created with a destination URL and no slug, then a slug is generated and `GET` of the link returns the destination and the generated slug.
- [ ] AC-38: Given a link exists at `(domain D1, slug "summer")`, when another link is created at `(D1, "summer")`, then the response is 409 with a stable error `code` and no second row is created.
- [ ] AC-39: **(SC-5)** Given workspace W1 on domain D1 owns slug `summer`, when workspace W2 on domain D2 creates slug `summer`, then it succeeds, and both links resolve to their own destinations independently.
- [ ] AC-40: Given a custom slug containing characters outside the documented allowed set, or exceeding the documented length, when creation is attempted, then it is rejected with a 400 whose body names the offending field.
- [ ] AC-41: Given a link owned by tenant B, when an authenticated user of tenant A requests, updates, or deletes it by id, then every one of those returns 404 and the row is unmodified.
- [ ] AC-42: Given a link is updated to a new destination, when it is read back, then it returns the new destination and its slug is unchanged.
- [ ] AC-43: Given a link is deleted, when it is read back through the API, then the response is 404.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS.** AC-40 needs the allowed alphabet and length documented; TASK-024 produces that documentation as part of the TASK, so it is not a pre-condition.

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
