---
id: TASK-024
story: STORY-009
epic: EPIC-003
title: Short-code generation
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-023]
paths: ["apps/api/src/links/codes/**"]
contracts: [design/contracts/slug.md]
test_files: []
acceptance: [AC-37, AC-40]
rework_count: 0
---

## Intent

Produce slugs that are collision-tolerant within a domain and validate user-supplied ones.

## Approach

**GC-6** — collision is resolved per domain; the alphabet, length, and reserved-word list **must be documented** so AC-40 has a definition to test against; collision handling must be deterministic in tests.

## Out of scope for this TASK

Endpoints (TASK-025), UI.

## Interfaces

**Consumes**

`links`, `linkRepository`, `links_domain_id_slug_unique` (TASK-023).

**Produces**

`generateSlug(domainId)` → an unused slug for that domain; `validateSlug(slug)` → ok or a named violation; the documented allowed alphabet, length bounds, and reserved slugs.


## ⚠ Import the reserved-slug list from the root specifier (ADR-0005, F-045, 2026-08-04)

Import from `@shortkit/contracts`, **never** `@shortkit/contracts/slug`. The subpath map
was removed and a subpath import will not typecheck. If the symbol is missing from the
root barrel, add its re-export line to `packages/contracts/src/index.ts` rather than
reaching around it.
