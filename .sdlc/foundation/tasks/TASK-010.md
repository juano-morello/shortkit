---
id: TASK-010
story: STORY-005
epic: EPIC-002
title: Email dispatch adapter and verification flow
status: deferred
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

## ⚠ You inherit AC-16's email half (ruled by Juano 2026-08-06)

TASK-009 lands signup in wave 2 and **cannot** assert AC-16's second clause, because the fake mail
sender is yours and arrives here in wave 3.

**You own the assertion that signup sends EXACTLY ONE verification email.** Not at-least-one — the
AC says exactly one, and a retry loop or a duplicated hook that sends two satisfies a sloppier
reading while being a real defect a user sees twice in their inbox.

TASK-009's red tests cover account creation, the duplicate-email rejection and the password policy.
The email count is the piece left, and it is recorded here rather than in a report so an implementer
meets it where the work is.
