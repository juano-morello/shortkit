---
id: TASK-007
story: STORY-004
epic: EPIC-001
title: Shared contracts package foundation and error envelope
status: tests-red
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: ["packages/contracts/**", "apps/api/src/common/errors/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/error-envelope.md, design/contracts/slug.md]
test_files: ["apps/api/src/common/errors/exception-filter.spec.ts"]
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

## ⚠ Paths widened 2026-08-05 (F-070 — ruled by Juano)

**`apps/api/src/app.module.ts`** added to `paths`. This TASK Produces the API-side exception
filter, and a filter that is never registered does nothing — registration means `APP_FILTER`
in the composition root, which the previous paths list excluded.

The red tests make this unavoidable rather than merely convenient: they boot `AppModule` and
assert on real HTTP responses, precisely because calling `catch()` on a filter instance would
still pass if the filter were never wired. AC-13 cannot go green without this file.

`app.module.ts` is a declared structural serialisation point in `plan.md`'s wave table, shared
by every TASK that registers a Nest module. No other wave-1 TASK touches it — verified — so
wave 1 stays parallel-safe. Later waves must merge it deliberately.

**Still unsettled at the time of writing: F-071** (the filter must recognise a `ZodError`, but
zod is not resolvable from `apps/api`). `sdlc-architect` is ruling whether the check belongs in
`packages/contracts/src/errors.ts` — which you already own — or whether this TASK needs
`apps/api/package.json` as well. Do not invent a duck-type check on error shape in the meantime;
it stops matching silently when zod changes its internals.
