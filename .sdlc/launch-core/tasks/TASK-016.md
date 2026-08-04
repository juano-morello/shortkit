---
id: TASK-016
story: STORY-007
epic: EPIC-002
title: Membership and role schema with RLS
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-013]
paths: ["apps/api/src/db/schema/**", "apps/api/drizzle/**"]
contracts: [design/contracts/rls-policy-template.md, design/contracts/tenant-context.md, design/contracts/workspace-authorization.md]
test_files: []
acceptance: [AC-29, AC-105]
rework_count: 0
---

## Intent

Model who belongs to which workspace with what role.

## Approach

**GC-5** — RLS policy template applied; membership is per-workspace, not per-tenant; the tenant owner role is distinct from workspace roles; a tenant must always retain at least one owner.

**The role set is fixed by Amendment A-1** and is not open for reinterpretation: `TenantRole` = `owner | admin`; `WorkspaceRole` = `workspace_admin | member | viewer`, ranked so `viewer` is read-only. **The rank is data, not scattered conditionals**, so TASK-017 enforces it in one place.

## Out of scope for this TASK

The authorization guard (TASK-017), member endpoints (TASK-018), invitations (TASK-020), UI.

**Nothing in `launch-core` reads or grants `viewer`.** It exists so the schema and the authorization ranking are correct before SP7 reporting needs it. Do not add a consumer, a UI affordance, or a seeded viewer outside test fixtures.

## Interfaces

**Consumes**

`workspaces`, `workspaceRepository`, RLS template (TASK-013).

**Produces**

`memberships` table — `id`, `tenant_id`, `workspace_id`, `user_id`, `role`, RLS enabled; `TenantRole` = `owner | admin`; `WorkspaceRole` = `workspace_admin | member | viewer`; `roleRank(role)` for the guard; `membershipRepository` with `listForUser`, `listForWorkspace`, `setRole`, `remove`, `countOwners`.
