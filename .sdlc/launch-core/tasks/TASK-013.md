---
id: TASK-013
story: STORY-006
epic: EPIC-002
title: Tenant and workspace schema, RLS, and tenant creation on signup
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-005, TASK-009]
paths: ["apps/api/src/db/schema/**", "apps/api/drizzle/**", "apps/api/src/auth/**"]
contracts: [design/contracts/auth-tokens.md, design/contracts/rls-policy-template.md, design/contracts/tenant-context.md]
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

`withTenantTransaction`, `db`, `tenants`, RLS policy template (TASK-005); `onUserCreated` **and the Better Auth `before` hook seam** (TASK-009).

**Amended 2026-08-04 (Design round 3).** This TASK owns a `before` hook as well
as `onUserCreated`, which the Produces block below did not anticipate.

`databaseHooks.user.after` cannot roll back the insert that triggered it, so
ADR-0021's "reject the signup — no user, no tenant, no membership" was not
implementable as written. Invitation validation moved to a **`before` hook**,
the same seam the email rate-limit bucket uses, where a throw prevents user
creation entirely. The `after` hook then repeats the verified read to obtain the
tenant id.

**Load-bearing half, do not relax:** the tenant id comes from
`invitation.tenantId` on the verified row, never from the token string. If the
membership write fails the residue is an orphaned `user` row with no
`tenant_memberships` — which cannot obtain a `tid` claim and so cannot
authenticate anywhere. **Do not relax step 5 to avoid the orphan.**

**Produces**

`workspaces` table — `id`, `tenant_id`, `name`, `created_at`, RLS enabled; **`tenant_memberships` table with `UNIQUE (user_id)`** (required by ADR-0015 / Amendment A-6 — it stores the owner record this TASK already promises, and the unique constraint is what makes one-tenant-per-user structural); `tenantRepository` and `workspaceRepository` with tenant-scoped read/write methods; signup creates exactly one tenant with the signing-up user as owner.
