---
id: STORY-010
epic: EPIC-003
title: Link expiry and scheduled activation
status: todo
tasks: [TASK-027, TASK-028]
depends_on: [STORY-009]
---

## User story

As an agency operator, I schedule when a link starts and stops working, so campaign links do not outlive the campaign.

## Acceptance criteria

- [ ] AC-44: Given a link with an expiry timestamp in the past, when its short URL is requested, then the response is the branded 404 and not a 302.
- [ ] AC-45: Given a link with an activation timestamp in the future, when its short URL is requested before that timestamp, then the response is the branded 404; when requested after it, then the response is a 302 to the destination.
- [ ] AC-46: Given a link is edited to set an expiry in the past, when its short URL is requested more than 5 seconds later, then the response is the branded 404 — and this test still passes with the cache TTL configured to one hour.
- [ ] AC-47: Given a link with no expiry and no activation timestamp, when its short URL is requested, then it resolves with a 302 (absence of scheduling is not treated as inactive).

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS.** Cache eviction for expired links is a live Design question (bound TTL by time-to-expiry, or sweep on read), but AC-44..AC-47 are behavioural and testable regardless of which approach Design picks.

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
