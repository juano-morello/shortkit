---
id: TASK-012
story: STORY-005
epic: EPIC-002
title: Web signup, login, and verification screens
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-008, TASK-009, TASK-010]
paths: ["apps/web/app/(auth)/**", "apps/web/src/lib/session/**"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md, design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-16, AC-18, AC-19, AC-20, AC-21]
rework_count: 0
---

## Intent

The operator's entry into the product.

## Approach

Token storage and refresh handled in one place; unverified users are shown what to do next rather than a raw 403; copy is human-facing prose (GC-12). **Never place a JWT or refresh token anywhere client JavaScript can read it.**

## Out of scope for this TASK

Invitation accept screen (TASK-022), workspace UI (TASK-015), landing page (TASK-057).

## Interfaces

**Consumes**

`apiClient`, `ApiError`, `<ErrorMessage />` (TASK-008); `signupContract`, `loginContract`, `sessionContract` (TASK-009); `verificationContract` (TASK-010).

**Produces**

Routes `/signup`, `/login`, `/verify`; `useSession()` → `{ user, status }`; `requireAuth()` route guard used by every authenticated screen.
