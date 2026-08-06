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

## ⚠ F-138 must be closed before this TASK is dispatched (routed 2026-08-05)

`design/contracts/tenant-context.md` invariant 5 promises that nesting `withTenantTransaction`
with the same `tenantId` reuses the outer transaction, **with no exception stated**. The
shipped code (`tenant-context.ts:179-181`, TASK-005 fix round 1) throws
`TenantContextMissingError` when the outer context has already settled. You consume that
contract, so as written it would send you into a fire-and-forget follow-up inside `fn` that
calls `withTenantTransaction`, expects reuse, and gets an unexplained runtime throw — the
behaviour is written down only in `docs/architecture/rls.md`, which is not normative and which
your card does not point at.

Routed to `sdlc-architect` under routing rule 0. **Do not dispatch this TASK until the
contract states the settled-context invariant**: a context is invalidated when its transaction
settles, and `tenantDb`, `currentTenantId` and a nested `withTenantTransaction` all throw
rather than reuse a released handle.
