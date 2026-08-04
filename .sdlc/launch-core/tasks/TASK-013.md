---
id: TASK-013
story: STORY-006
epic: EPIC-002
title: Tenant and workspace schema, RLS, and tenant creation on signup
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-005, TASK-009]
paths: ["apps/api/src/db/schema/**", "apps/api/drizzle/**", "apps/api/src/auth/**"]
contracts: []
test_files: []
acceptance: [AC-22]
rework_count: 0
---

## Intent

Make the agency-and-workspaces shape real in the database and created automatically at signup.

## Approach

**GC-5** — `workspaces` carries `tenant_id` and applies the RLS policy template from TASK-005; the tenant and its owner record are created **in the same transaction as the user**, so no account can exist without a tenant.

## Out of scope for this TASK

Workspace endpoints (TASK-014), membership and roles (TASK-016), branding fields (TASK-045), any UI.

## Interfaces

**Consumes**

`withTenantTransaction`, `db`, `tenants`, RLS policy template (TASK-005); `onUserCreated` (TASK-009).

**Produces**

`workspaces` table — `id`, `tenant_id`, `name`, `created_at`, RLS enabled; `tenantRepository` and `workspaceRepository` with tenant-scoped read/write methods; signup creates exactly one tenant with the signing-up user as owner.
