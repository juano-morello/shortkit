---
id: TASK-045
story: STORY-016
epic: EPIC-004
title: Workspace branding fields and endpoints
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-013, TASK-007]
paths: ["apps/api/src/db/schema/**", "apps/api/drizzle/**", "apps/api/src/workspaces/branding/**", "packages/contracts/src/workspaces/**"]
contracts: [design/contracts/branding.md, design/contracts/error-envelope.md, design/contracts/redirect-cache.md, design/contracts/rls-policy-template.md, design/contracts/tenant-context.md, design/contracts/workspace-authorization.md]
test_files: []
acceptance: [AC-74, AC-78]
rework_count: 0
---

## Intent

Store the logo, brand colour, and fallback URL a workspace's public surface uses.

## Approach

**GC-5** — RLS applied; **branding is optional and its absence is valid** (AC-77); an invalid colour returns 400 naming the field and leaves stored branding unchanged (AC-78); logo storage must stay inside the $25/month ceiling (GC-3).

Fallback semantics are decided (Amendment A-4): optional per-workspace fallback URL, 302 on unknown slug, branded 404 when unset.

**Not apex-blocked** — no dependency edge touches a domain TASK.

## Out of scope for this TASK

Rendering the branded 404 (TASK-046), UI (TASK-047), per-link branding.

## Interfaces

**Consumes**

`workspaces`, `workspaceRepository`, RLS template (TASK-013); `ErrorEnvelope` (TASK-007).

**Produces**

`workspaces` extended with `logo_url`, `brand_color`, `fallback_url`; `GET/PATCH /workspaces/:id/branding`; `brandingContract` — `{ logoUrl, brandColor, fallbackUrl }`; `brandingRepository.getForDomain(domainId)` used by TASK-046.
