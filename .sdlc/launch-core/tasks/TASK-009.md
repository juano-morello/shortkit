---
id: TASK-009
story: STORY-005
epic: EPIC-002
title: Better Auth mounted in NestJS: signup, login, logout, session
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-005, TASK-007]
paths: ["apps/api/src/auth/**", "packages/contracts/src/auth/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-16, AC-20, AC-21]
rework_count: 0
---

## Intent

Stand up credential auth and JWT issuance inside the API.

## Approach

Better Auth mounted in NestJS (already decided); JWT for the web app; API keys are reserved for a future MCP server and are **not** built here; passwords never appear in logs (GC-9).

**If this integration resists, escalate for a timeboxed spike rather than improvising** — `refinement.md` names Better Auth inside NestJS as a risk with thinner public prior art than the Next.js pairing.

## Out of scope for this TASK

Email verification and email sending (TASK-010), the request guard and tenant binding (TASK-011), tenant creation on signup (TASK-013), any UI.

## Interfaces

**Consumes**

`db`, `withTenantTransaction` (TASK-005); `ErrorEnvelope`, `ErrorCode` (TASK-007).

**Produces**

Auth routes for signup, login, logout, and current-session; `AuthUser` — `{ id, email, emailVerified: boolean }`; JWT issuance with claims including the user id; `signupContract`, `loginContract`, `sessionContract` in `packages/contracts/src/auth`; `onUserCreated` hook point that TASK-013 attaches tenant creation to.
