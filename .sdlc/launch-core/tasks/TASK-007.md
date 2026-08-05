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
test_files: ["apps/api/src/common/errors/exception-filter.spec.ts", "apps/api/src/common/errors/domain-error.spec.ts"]
acceptance: [AC-13, AC-14]
rework_count: 0
---

## Intent

Define the one error shape and the shared primitives every endpoint and screen uses.

## Approach

zod contracts (already decided); error bodies carry a stable machine-readable `code`; contract changes must break `apps/web` typecheck rather than fail at runtime.

## Out of scope for this TASK

Any feature-specific contract (each feature TASK adds its own), the web client (TASK-008), API exception filter wiring beyond the shared envelope.

**Corrected 2026-08-05 (found by `sdlc-scout` at dispatch).** Read the clause above as written:
what is out of scope is wiring *beyond* the shared envelope, not the shared envelope's own
registration. **Registering this TASK's filter via `APP_FILTER` in `apps/api/src/app.module.ts`
is IN scope** — that is exactly why the F-070 amendment below widened `paths` to include that
file, and the red tests boot `AppModule` and assert on real HTTP responses, so AC-13 cannot go
green without it. The line predates the amendment and read as barring the very thing the
amendment requires.

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

~~**Still unsettled at the time of writing: F-071**~~ — **SETTLED 2026-08-05 by ADR-0025.**
The note below was stale and is corrected here rather than deleted, so the history stays
readable.

**F-071 resolved: the zod recognition lives in `packages/contracts/src/errors.ts`, which this
TASK already owns. This TASK does NOT gain `apps/api/package.json`, and zod is never added to
`apps/api`.** Add three exports to the contracts package and import them in the filter:

```ts
export function isZodError(value: unknown): value is z.ZodError;
export function toValidationDetails(error: z.ZodError): ValidationDetails;
export const FORM_ERROR_KEY = '_form';
```

`error-envelope.md` step 2 and `adr-0025` both state this; they agree. The original warning
still stands — **do not invent a duck-type check on error shape.** ADR-0025's reasoning is that
zod 4's `ZodError` carries its own `Symbol.hasInstance`, so `instanceof` is a trait check that
survives a second copy of the module; that was verified against the installed zod 4.4.3. Note
also that ADR-0025 found `err.flatten()`, which an earlier draft of the contract mandated,
silently drops root-level `.refine()` failures — which is what `FORM_ERROR_KEY` exists for.
