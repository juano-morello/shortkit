---
id: STORY-008
epic: EPIC-002
title: Email invitations scoped to workspaces
status: todo
tasks: [TASK-020, TASK-021, TASK-022]
depends_on: [STORY-007]
---

## User story

As an agency operator, I invite a teammate by email to a chosen set of workspaces, so onboarding does not require me to create their account.

## Acceptance criteria

- [ ] AC-32: Given an owner invites `x@example.com` to workspaces {W1, W3} with role `member`, when the invitation is created, then exactly one email is dispatched to that address and a pending invitation records exactly {W1, W3}.
- [ ] AC-33: Given a valid pending invitation, when the invitee accepts and completes account creation, then they have membership in exactly {W1, W3} and requesting W2 returns 404.
- [ ] AC-34: Given an invitation that has been accepted, when the same link is used again, then it is rejected with a stable error `code` and no additional membership is created.
- [ ] AC-35: Given an invitation past its expiry, when the link is opened, then it is rejected with a distinct `code` and no membership is created.
- [ ] AC-36: Given a pending invitation, when the inviting owner revokes it, then opening the link is rejected and no membership is created.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS** (was conditional on STORY-007's role set, which is now decided).

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
