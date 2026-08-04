---
id: TASK-047
story: STORY-016
epic: EPIC-004
title: Web branding settings and preview
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-015, TASK-045]
paths: ["apps/web/app/(app)/settings/branding/**", "apps/web/src/components/branding/**"]
contracts: []
test_files: []
acceptance: [AC-74, AC-78]
rework_count: 0
---

## Intent

Let the operator set the client's logo, colour, and fallback, and see the result.

## Approach

**The preview renders the same composition the 404 uses** so the operator is not surprised; an invalid colour is rejected inline against the field.

## Out of scope for this TASK

The served 404 itself (TASK-046), theme editing beyond logo, colour, and fallback URL.

## Interfaces

**Consumes**

Authenticated layout, navigation registry (TASK-015); `brandingContract` and the branding endpoints (TASK-045).

**Produces**

Route `/settings/branding`; `<BrandPreview />`; the settings section shell reused by TASK-055.
