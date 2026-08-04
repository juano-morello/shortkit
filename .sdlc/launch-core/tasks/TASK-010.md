---
id: TASK-010
story: STORY-005
epic: EPIC-002
title: Email dispatch adapter and verification flow
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-009]
paths: ["apps/api/src/mail/**", "apps/api/src/auth/verification/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/mail-sender.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-16, AC-18, AC-19]
rework_count: 0
---

## Intent

Make email verification work end to end and give invitations (TASK-021) a mail interface to reuse.

## Approach

The provider is a Design decision (Resend / Postmark / SES — free tier is sufficient, GC-3); the adapter must be substitutable and test-fakeable so **no test sends real mail**; tokens are single-use and expiring; email bodies are human-facing prose (GC-12).

## Out of scope for this TASK

Invitation emails (TASK-021), the 403-when-unverified guard (TASK-011), any UI.

## Interfaces

**Consumes**

Auth routes, `AuthUser`, `onUserCreated` (TASK-009); `db` (TASK-005).

**Produces**

`MailSender.send({ to, template, data })` — provider-agnostic dispatch; `FakeMailSender` capturing sent messages for tests; verification token issue/consume endpoints; `verificationContract`.
