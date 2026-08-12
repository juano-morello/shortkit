---
id: TASK-016
story: STORY-007
epic: EPIC-002
title: Membership and role schema with RLS
status: deferred
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

**You do not write `packages/contracts/src/roles.ts`.** TASK-007 produces the role values,
the branded types, the pre-branded constants, both cast functions and the rank tables
(F-068, ADR-0023 as amended 2026-08-05). Import them. Drizzle columns are typed
`TenantRoleValue` and `WorkspaceRoleValue`, unbranded; the membership repository brands rows
on the way out through `asTenantRole` and `asWorkspaceRole`, which are the only two
sanctioned casts in the codebase. **The rank is data, not scattered conditionals**, so
TASK-017 enforces it in one place.

**Do not take the role set from this file.** ADR-0023 and `design/contracts/roles.md` carry
the current values; Amendment A-8 added a tenant `member` that supersedes A-1's set, and any
enum quoted here would be a second copy going stale.

## Out of scope for this TASK

The authorization guard (TASK-017), member endpoints (TASK-018), invitations (TASK-020), UI.

**Nothing in `launch-core` reads or grants `viewer`.** It exists so the schema and the authorization ranking are correct before SP7 reporting needs it. Do not add a consumer, a UI affordance, or a seeded viewer outside test fixtures.

## Interfaces

**Consumes**

`workspaces`, `workspaceRepository`, RLS template (TASK-013).

**Produces**

`memberships` table — `id`, `tenant_id`, `workspace_id`, `user_id`, `role`, RLS enabled;
`membershipRepository` with `listForUser`, `listForWorkspace`, `setRole`, `remove`,
`countOwners`.

**Consumes** `@shortkit/contracts` for the role types, the branded constants, the cast
functions and `roleRank` — all produced by TASK-007.

**Amended 2026-08-05 (F-068, ruled by sdlc-architect, applied by the orchestrator).** This
block previously claimed `TenantRole`, `WorkspaceRole` and `roleRank(role)` as its own
output. It cannot produce them: its `paths` are `apps/api/src/db/schema/**` and
`apps/api/drizzle/**`, which do not reach `packages/contracts/**`, and it runs three waves
after the first consumer. The enum values quoted here were also stale against Amendment A-8.
