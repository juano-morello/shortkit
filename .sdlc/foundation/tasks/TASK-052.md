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

`apiClient`, `ApiError`, `<ErrorMessage />` (TASK-008); `rate_limited` code and `Retry-After` (TASK-051).

**Produces**

Rate-limit handling in `apiClient` and its rendered message.
