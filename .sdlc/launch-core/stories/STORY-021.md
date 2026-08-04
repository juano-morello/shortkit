---
id: STORY-021
epic: EPIC-006
title: Public marketing page at the apex domain
status: todo
tasks: [TASK-057]
depends_on: [STORY-002, STORY-004]
---

## User story

As an evaluator, I arrive at the apex domain and understand what Shortkit is within one screen.

## Acceptance criteria

- [ ] AC-97: Given an unauthenticated visitor, when the apex URL is requested, then it returns 200 with a page describing the product and a link whose target is the signup route.
- [ ] AC-98: Given the landing page, when it is requested without any session cookie, then it renders fully (no authentication redirect).
- [ ] AC-99: **(GC-15)** Given the landing page copy, when it is reviewed, then it contains no customer testimonial, no named customer, and no usage or adoption metric.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS with a note.** The dependency on published posts was removed when SC-8 left the initiative (Amendment A-3) — this page does not link to a blog, and no blog surface is built here. Apex binding still waits on the apex-domain answer; the page itself does not, and ships on the Vercel-provided hostname.

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
