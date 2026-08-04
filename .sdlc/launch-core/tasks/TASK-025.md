---
id: TASK-025
story: STORY-009
epic: EPIC-003
title: Link CRUD endpoints and contracts
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-023, TASK-024, TASK-017, TASK-007]
paths: ["apps/api/src/links/**", "packages/contracts/src/links/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md, design/contracts/link-mutation-events.md, design/contracts/slug.md, design/contracts/tenant-context.md, design/contracts/workspace-authorization.md]
test_files: []
acceptance: [AC-37, AC-38, AC-39, AC-40, AC-41, AC-42, AC-43]
rework_count: 0
---

## Intent

Create, read, update, delete, and list links within a workspace.

## Approach

Duplicate slug returns **409** with a stable `code`; cross-tenant access returns **404**; validation failures return **400** naming the field; **the update path must expose a hook that TASK-031 (cache invalidation) and TASK-048 (audit) attach to**, so neither has to modify this handler later.

## Out of scope for this TASK

Cache invalidation (TASK-031), audit writes (TASK-048), expiry fields (TASK-027), rate limiting (TASK-051), UI.

## Interfaces

**Consumes**

`linkRepository`, `domainRepository` (TASK-023); `generateSlug`, `validateSlug` (TASK-024); `@RequireWorkspaceRole`, `WorkspaceGuard` (TASK-017); `ErrorEnvelope`, `Paginated<T>` (TASK-007).

**Produces**

`POST/GET/PATCH/DELETE /links` and `/links/:id`; `linkContract` — `{ id, workspaceId, domainId, slug, destinationUrl, createdAt }`; `createLinkContract`, `updateLinkContract`; error code `slug_taken`; `onLinkMutated({ linkId, before, after, actorId, action })` hook fired **inside the mutation transaction**.
