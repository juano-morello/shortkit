---
id: TASK-007
story: STORY-004
epic: EPIC-001
title: Shared contracts package foundation and error envelope
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: ["packages/contracts/**", "apps/api/src/common/errors/**"]
contracts: [design/contracts/error-envelope.md, design/contracts/slug.md]
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


## ⚠ Contracts entry point is normative (ADR-0005, F-045, 2026-08-04)

`@shortkit/contracts` has **exactly one entry point**. `packages/contracts/package.json`
declares `"exports": { ".": "./src/index.ts" }` and `"sideEffects": false`, with **no
`"./*"` key**. Both apps' tsconfig `paths` carry
`"@shortkit/contracts": ["../../packages/contracts/src/index.ts"]` and nothing else.

Do not add a subpath pattern. ADR-0005 records why: a subpath import must fail at
typecheck rather than resolve one way in the bundler and another in `tsc`. The previous
`"./*": "./src/*/index.ts"` resolved nothing at all — every subpath it advertised was dead.

Every symbol reaches consumers through `src/index.ts`, one re-export line per producing
TASK, alphabetical. `sideEffects: false` is what lets the web bundler drop re-exports a
page does not use; it also means a contract module that runs code at import time gets
silently dropped, so contracts must stay declaration-only.
