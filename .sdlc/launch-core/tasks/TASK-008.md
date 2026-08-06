---
id: TASK-008
story: STORY-004
epic: EPIC-001
title: Web typed API client and error surface
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-007, TASK-004]
paths: ["apps/web/src/lib/api/**", "apps/web/src/components/errors/**"]
contracts: [design/contracts/error-envelope.md, design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-15]
rework_count: 0
---

## Intent

Give every screen one way to call the API and one way to render a failure.

## Approach

Responses are validated against the shared contracts; a contract violation raises a distinguishable error rather than returning malformed data; error copy is human-facing prose (GC-12).

## Out of scope for this TASK

Authentication token handling (TASK-012), 429-specific handling (TASK-052), any feature screen.

## Interfaces

**Consumes**

`ErrorEnvelope`, `ErrorCode`, `Paginated<T>` (TASK-007); `NEXT_PUBLIC_API_BASE_URL` (TASK-004).

**Produces**

`apiClient` — typed request function validating responses against a supplied contract; `ApiError` — carries `code` and HTTP status; `ContractViolationError`; `<ErrorMessage code={...} />` renderer.

## ⚠ F-174 — do not give `NEXT_PUBLIC_API_BASE_URL` a hardcoded fallback

Applied by the orchestrator 2026-08-05 from `sdlc-security-auditor`'s round-4 audit of TASK-004.

You write the first read of `NEXT_PUBLIC_API_BASE_URL`. The standard way people write it is:

```ts
const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'https://shortkit-api.fly.dev/api';
```

**Do not.** `apps/web/scripts/assert-no-inlined-secrets.mjs` runs a positive control that proves the
build and the check saw the same environment, by asserting that variable's value appears in the
build output. With a hardcoded fallback the literal lands in `.next` **from the source**, so the
control greens on a build that ran with the variable entirely unset — the one thing it exists to
detect. It becomes a tautology.

Let a missing value fail loudly instead.

**Two more things about this variable that this TASK is the first to encounter.** Per
`adr-0006:112-113`, its value must include `/api` — TASK-001 sets the API's global prefix and
TASK-029 registers the redirect controller *outside* it, so a base URL missing `/api` reaches the
redirect surface rather than the JSON one. And the positive control activates the moment non-test
code under `apps/web` reads it, so `pnpm --filter @shortkit/web assert:no-secrets` — chained into
`vercel.json`'s `buildCommand` — starts requiring the value to actually land in the build output
from that commit onward. That is intended fail-closed behaviour, not a regression to debug.
