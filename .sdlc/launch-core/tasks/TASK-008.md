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
