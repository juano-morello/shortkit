---
id: STORY-002
epic: EPIC-001
title: An authenticated request is bound to its caller's tenant
status: planned
tasks: [TASK-005, TASK-006]
depends_on: [STORY-001]
---

## User story

As an agency operator holding a session, I want every request I make to be recognised as
mine and executed inside my own tenant's context, so that the database — not the code that
happens to be running — decides what I can reach.

## Acceptance criteria

- [ ] AC-10: Given any tenant-scoped endpoint, when a request arrives carrying no `Authorization` header, then the response status is 401, the body matches the error envelope with `code` equal to `unauthenticated`, and the controller handler is never entered.
- [ ] AC-11: Given a bearer token whose signature does not verify against the key set served at `/api/auth/jwks`, when it is presented to a tenant-scoped endpoint, then the response status is 401 with `code` equal to `unauthenticated`.
- [ ] AC-12: Given a bearer token whose `exp` claim is in the past, when it is presented to a tenant-scoped endpoint, then the response status is 401 with `code` equal to `token_expired`.
- [ ] AC-13: Given a correctly signed bearer token whose `tid` claim is absent, empty, or not uuid-shaped, when it is presented to a tenant-scoped endpoint, then the response status is 401 with `code` equal to `unauthenticated`, and the failure is a 401 rather than the 500 that `withTenantTransaction`'s own uuid validation would have produced one layer down.
- [ ] AC-14: Given a valid bearer token whose `tid` claim is tenant T, when a tenant-scoped handler runs, then a statement issued inside that handler observes `current_setting('app.tenant_id', true)` equal to T, `currentTenantId()` returns T, and the transaction commits when the handler returns and rolls back when it throws.
- [ ] AC-15: Given a route decorated with `@Public('<justification>')`, when a request with no `Authorization` header reaches it, then the handler runs, the response is not 401, and no tenant transaction is opened for that request.

## Definition of Ready

**PASS with one concern.** Every AC is a request-level observation with a stated status code
or a stated database reading.

- [x] ACs are testable and unambiguous
- [x] Dependencies identified — needs STORY-001's mount, claim set and JWKS endpoint
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run; `auth-tokens.md` step order and `tenant-context.md` are named by the TASKs that need them
- [x] No blocking open questions

**Concern — AC-14's tenant binding has two candidate mechanisms and this STORY does not pick
one.** `withTenantTransaction` can be opened by a Nest interceptor running after the guard
(ADR-0002's ordering), or by each repository method. The AC is written against the
observable — what a statement inside the handler sees — so it holds under either. Design
picks the mechanism; TASK-006 names the interceptor because `tenant-context.ts` already
carries a `NoTenantTransaction()` decorator whose docblock describes one, and that
docblock is the closest thing to a decision on record.

## Definition of Done

- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids
