---
id: STORY-016
epic: EPIC-004
title: White-label surface
status: todo
tasks: [TASK-045, TASK-046, TASK-047]
depends_on: [STORY-011, STORY-006]
---

## User story

As an agency operator, unknown links on my client's domain show my client's branding, not Shortkit's.

## Acceptance criteria

- [ ] AC-74: Given a workspace with an uploaded logo and a brand colour, when those settings are read back, then both are returned and rendered in the settings preview.
- [ ] AC-75: Given a workspace with branding configured and no fallback URL, when an unknown slug is requested on that workspace's domain, then the 404 page renders that workspace's logo and brand colour and returns status 404.
- [ ] AC-76: Given a workspace with a fallback URL configured, when an unknown slug is requested on its domain, then the response is a 302 to the fallback URL.
- [ ] AC-77: Given a domain with no workspace branding configured, when an unknown slug is requested, then the default Shortkit 404 renders with status 404 (branding is optional, not required).
- [ ] AC-78: Given a brand colour value that is not a valid colour, when it is submitted, then it is rejected with a 400 naming the field, and the stored branding is unchanged.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS.** Fallback semantics are **decided, not assumed** (Amendment A-4): an optional per-workspace fallback URL, 302 on unknown slug, branded 404 when unset.

**Not apex-blocked.** Despite sitting in EPIC-004, none of this STORY's six dependency edges touch a domain TASK. It belongs structurally with the redirect work and runs on schedule regardless of domain registration.

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
