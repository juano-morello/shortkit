---
id: STORY-012
epic: EPIC-003
title: Click events accumulate from day one
status: deferred
tasks: [TASK-033, TASK-034]
depends_on: [STORY-011]
---

## User story

As Juano, I need every redirect to append an event I can query later, so a future analytics initiative has history rather than a start date.

## Acceptance criteria

- [ ] AC-56: **(SC-6)** Given a link that has never been clicked, when its short URL is requested once, then exactly one click event exists for that link, carrying the link id, the resolved domain, and a timestamp.
- [ ] AC-57: Given click events exist, when they are queried by link id and time range, then matching events are returned in an order consistent with their timestamps.
- [ ] AC-58: **(GC-9)** Given a redirect request from a known IP address, when the stored click event is inspected, then it contains an `ip_hash` field and contains the raw IP nowhere in the row.
- [ ] AC-59: Given the click-event write fails, when the short URL is requested, then the visitor still receives the 302 with the correct destination and the failure is recorded in structured logs.
- [ ] AC-60 **(revised 2026-08-03, Amendment A-2)**: Given a click event exists, when the **tenant-facing API surface** is enumerated, then it exposes no route and no tenant-scoped repository method that updates or deletes a click event. *(The privileged deletion path of AC-90 is explicitly excluded from this enumeration and is asserted separately by AC-106.)*

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS** (was PASS-with-forward-flag). The tension between append-only and GDPR erasure is resolved by Amendment A-2: append-only is a property of the tenant-facing API, not of the table. AC-60 was rewritten accordingly and the flag is cleared.

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
