---
id: TASK-023
story: STORY-009
epic: EPIC-003
title: Domains and links schema with per-domain slug uniqueness
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-013]
paths: ["apps/api/src/db/schema/**", "apps/api/drizzle/**"]
contracts: [design/contracts/rls-policy-template.md, design/contracts/slug.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-38, AC-39, AC-41]
rework_count: 0
---

## Intent

The core data shape of the product, including a system default domain so links exist before custom domains do.

## Approach

**GC-6** — uniqueness is a database constraint on `(domain_id, slug)` and **must not be global**; **GC-5** — RLS applied to both tables; a system default domain row exists so every workspace can create links without EPIC-004; a link belongs to a workspace and carries `tenant_id`.

## Out of scope for this TASK

Code generation (TASK-024), endpoints (TASK-025), expiry fields (TASK-027), domain verification and certificate state (TASK-038), click events (TASK-033).

## Interfaces

**Consumes**

`workspaces`, `workspaceRepository`, RLS template (TASK-013).

**Produces**

`domains` table — `id`, `tenant_id`, `workspace_id`, `hostname`, `is_system_default`, RLS enabled; `links` table — `id`, `tenant_id`, `workspace_id`, `domain_id`, `slug`, `destination_url`, `created_at`, RLS enabled; unique constraint `links_domain_id_slug_unique` on `(domain_id, slug)`; `linkRepository` and `domainRepository`; the seeded system default domain hostname.
