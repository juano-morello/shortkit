---
id: STORY-018
epic: EPIC-005
title: Per-tenant rate limiting on API writes
status: deferred
tasks: [TASK-051, TASK-052]
depends_on: [STORY-009, STORY-011]
---

## User story

As Juano, I need one tenant's write volume bounded so it cannot degrade another tenant's service.

## Acceptance criteria

- [ ] AC-83: Given tenant A exceeds the configured write limit within the window, when it issues a further write, then the response is 429 with a `Retry-After` header and a stable error `code`, and the write does not occur.
- [ ] AC-84: Given tenant A is being rate-limited, when tenant B issues a write within B's own limit, then B's write succeeds with 2xx (limits are per tenant, not global).
- [ ] AC-85: Given tenant A was rate-limited, when the window elapses, then A's next write succeeds with 2xx.
- [ ] AC-86: Given the redirect path, when a host is requested at a rate exceeding the API write limit, then redirects continue to return 302 (the redirect path is not subject to the API write limiter).
- [ ] AC-87: Given a 429 response, when the web app receives it, then it shows the user a message stating the limit was hit and when to retry, and does not silently discard the user's input.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS with a design dependency.** The limiter's behaviour when Redis is unavailable is unspecified — SC-7 covers the redirect path only. Design must decide fail-open or fail-closed for API writes. Either is testable, so this does not block the STORY.

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
