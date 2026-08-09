---
id: STORY-011
epic: EPIC-003
title: The redirect hot path
status: deferred
tasks: [TASK-029, TASK-030, TASK-031, TASK-032]
depends_on: [STORY-009]
---

## User story

As a visitor, I click a short link and land on the destination fast, or I get a branded page — never an error.

## Acceptance criteria

- [ ] AC-48: Given an active link at `(host H, slug S)`, when `GET https://H/S` is requested, then the response is a 302 whose `Location` is the exact destination URL.
- [ ] AC-49: Given the same link has already been resolved once, when it is requested again, then the request is served without a query to Postgres (verified by a counter or structured-log assertion on database calls during the second request).
- [ ] AC-50: Given a slug that exists on host H2 but not on host H1, when `GET https://H1/that-slug` is requested, then the response is the branded 404 with status 404.
- [ ] AC-51: **(SC-3)** Given a link's destination is updated via the API, when its short URL is requested more than 5 seconds after the write, then the `Location` is the new destination — and this test still passes with the cache TTL configured to one hour.
- [ ] AC-52: **(SC-7)** Given Redis is unreachable, when an existing link's short URL is requested, then the response is still a 302 with the correct destination, and no 5xx is returned to the visitor.
- [ ] AC-53: **(SC-7)** Given Redis is unreachable and the requested slug does not exist, when the short URL is requested, then the response is the branded 404 with status 404 and not a 5xx.
- [ ] AC-54: Given Redis was unreachable and becomes reachable again, when a link is requested twice after recovery, then the second request is served without a Postgres query (the cache resumes without a restart).
- [ ] AC-55: Given the redirect module, when the application's module graph is inspected in a test, then the redirect module does not import the link-management, auth, workspace, or member modules.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS.** AC-49 depends on an observable database-call counter; TASK-030 produces it in the same TASK.

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
