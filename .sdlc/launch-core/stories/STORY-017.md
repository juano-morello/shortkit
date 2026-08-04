---
id: STORY-017
epic: EPIC-005
title: Audit log of link changes
status: todo
tasks: [TASK-048, TASK-049, TASK-050]
depends_on: [STORY-009]
---

## User story

As an agency operator, I can see who changed a link's destination and when, so a bad redirect is attributable.

## Acceptance criteria

- [ ] AC-79: Given a link's destination is changed from U1 to U2 by member M, when the audit log for that link is read, then it contains an entry naming M, the link, U1 as previous value, U2 as new value, and a timestamp.
- [ ] AC-80: Given a link is created and later deleted, when the audit log for that link is read, then it contains one creation entry and one deletion entry, each with an actor and timestamp.
- [ ] AC-81: Given an audit entry belonging to tenant B, when a user of tenant A queries audit entries, then no entry of B's is returned and a direct request by entry id returns 404.
- [ ] AC-82: Given an audit entry exists, when an update or delete against it is attempted through the application's data layer, then no such interface exists (append-only, verified via repository enumeration).

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
