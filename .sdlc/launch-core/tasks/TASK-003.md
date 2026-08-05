---
id: TASK-003
story: STORY-002
epic: EPIC-001
title: API deployable on Fly.io with a health endpoint
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: ["fly.toml", "Dockerfile", "infra/**", "apps/api/src/health/**", "apps/api/src/app.module.ts", "apps/api/src/main.ts"]
contracts: []
test_files: []
acceptance: [AC-6]
rework_count: 0
---

## Intent

Get the NestJS deployable running on the internet before any feature depends on it.

## Approach

One backend deployable only (GC-7); stay inside the $25/month total (GC-3); structured logs via pino (GC-9); the health response must expose the deployed commit SHA.

## Out of scope for this TASK

Custom hostname binding (TASK-043), database connection, Redis, secrets for third-party services.

## Interfaces

**Consumes**

`apps/api` workspace and the composition root (TASK-001).

**Produces**

Deployed API base URL; `GET /health` → `{ status: "ok", commit: <sha> }`; the pino logger instance registered at the composition root, available to all later API TASKs.

## ⚠ main.ts added to paths 2026-08-04 (F-060, ruled by Juano)

`paths` gained `apps/api/src/main.ts`. `design/contracts/logging-and-headers.md` already
gives its Normative form as "`apps/api/src/observability/logger.ts` **and**
`apps/api/src/main.ts`", and its Consumed-by as "every API TASK. Nothing may opt out" —
so the contract always assigned you a file your paths excluded.

Concretely: `main.ts`'s `bootstrap().catch()` currently logs through `console.error`, with
a comment saying you will swap it for pino. Do that. Until you do, the API's boot-failure
log line carries no `level`, no `service`, no `env`, no timestamp and no redaction, which
is exactly the pipeline the contract says nothing may opt out of.

You share `main.ts` with TASK-009, which owns `assertBffProxySecretConfigured()` there.
You are in wave 2 and it is in wave 3, so you land first.
