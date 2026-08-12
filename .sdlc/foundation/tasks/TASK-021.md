---
id: TASK-021
story: STORY-008
epic: EPIC-002
title: Invitation endpoints and email dispatch
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-020, TASK-010, TASK-018]
paths: ["apps/api/src/invitations/**", "packages/contracts/src/invitations/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md, design/contracts/mail-sender.md, design/contracts/workspace-authorization.md]
test_files: []
acceptance: [AC-32, AC-33, AC-34, AC-35, AC-36]
rework_count: 0
---

## Intent

Create, send, accept, and revoke invitations.

## Approach

Acceptance creates membership in **exactly** the named workspaces and nothing else (AC-33), inside one transaction with token consumption; the accept endpoint is `@Public()` because the invitee may not yet have an account; exactly one email per invitation creation (AC-32).

An invitation carries a `WorkspaceRole` per workspace drawn from the ruled set; **`viewer` is accepted by the API contract but not offered by TASK-022's UI.**

## Out of scope for this TASK

UI (TASK-022), resending invitations, bulk invitation. **Inviting at tenant level — invitations are workspace-scoped only.**

## Interfaces

**Consumes**

`invitationRepository`, `InvitationState` (TASK-020); `MailSender`, `FakeMailSender` (TASK-010); `membershipRepository` (TASK-016); `@RequireWorkspaceRole` (TASK-017).

**Produces**

`POST /invitations`, `DELETE /invitations/:id`, `GET /invitations/:token`, `POST /invitations/:token/accept`; `invitationContract`; error codes `invitation_expired`, `invitation_already_accepted`, `invitation_revoked`.
