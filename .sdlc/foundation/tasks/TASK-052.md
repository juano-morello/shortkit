---
id: TASK-052
story: STORY-018
epic: EPIC-005
title: Web handling of rate-limit responses
status: deferred
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-008, TASK-051]
paths: ["apps/web/src/lib/api/**", "apps/web/src/components/errors/**"]
contracts: [design/contracts/error-envelope.md, design/contracts/rate-limit.md, design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-87]
rework_count: 0
---

## Intent

A rate-limited operator understands what happened and does not lose their input.

## Approach

The message states the limit was hit and when to retry, using `Retry-After`; **form state is preserved across the failure**; handled centrally in the API client so no screen reimplements it.

## Out of scope for this TASK

Automatic retry, client-side pre-emptive throttling.

## Interfaces

**Consumes**

`apiClient`, `ApiError`, ~~`<ErrorMessage />`~~ (TASK-008); `rate_limited` code and `Retry-After` (TASK-051).

> **`<ErrorMessage />` DOES NOT EXIST. Do not import it.** Deferred by the F-291 ruling of
> 2026-08-10 along with `serverApiClient`, `buildUpstreamUrl` and `mapBetterAuthError` — each
> serves the BFF proxy or the auth surface, both of which left with EPIC-002.
> `error-envelope.md:545` still specifies its fallback behaviour normatively; that
> specification stands and nothing has implemented it.
>
> **And one more thing this card is owed**, disclosed by TASK-008 rather than discovered later:
> `ApiError.retryAfterSeconds` ships as a declared seam and is **always `undefined`**, so
> `web-api-client.md` invariant 3 is unmet while this TASK sits deferred. Populating it is this
> TASK's work, not TASK-008's.
>
> Written here 2026-08-11 under **F-308**. Until now the only record was a sentence inside
> TASK-008's card — F-288's shape exactly, a rule recorded where the downstream reader has no
> reason to look.

**Produces**

Rate-limit handling in `apiClient` and its rendered message.
