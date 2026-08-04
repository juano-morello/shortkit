---
id: TASK-007
story: STORY-004
epic: EPIC-001
title: Shared contracts package foundation and error envelope
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: ["packages/contracts/**"]
contracts: []
test_files: []
acceptance: [AC-13, AC-14]
rework_count: 0
---

## Intent

Define the one error shape and the shared primitives every endpoint and screen uses.

## Approach

zod contracts (already decided); error bodies carry a stable machine-readable `code`; contract changes must break `apps/web` typecheck rather than fail at runtime.

## Out of scope for this TASK

Any feature-specific contract (each feature TASK adds its own), the web client (TASK-008), API exception filter wiring beyond the shared envelope.

## Interfaces

**Consumes**

`packages/contracts` workspace (TASK-001).

**Produces**

`ErrorEnvelope` — `{ code: string, message: string, details?: unknown }`; `ErrorCode` — the extensible union of stable codes; `Paginated<T>`; `Id` scalar; the API-side exception filter that serialises thrown errors into `ErrorEnvelope`.
