---
id: TASK-003
story: STORY-002
epic: EPIC-001
title: API deployable on Fly.io with a health endpoint
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: ["fly.toml", "Dockerfile", "infra/**", "apps/api/src/health/**", "apps/api/src/app.module.ts"]
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
