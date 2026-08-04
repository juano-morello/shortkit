---
id: TASK-004
story: STORY-002
epic: EPIC-001
title: Web deployable on Vercel
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-001]
paths: ["apps/web/**", "vercel.json"]
contracts: []
test_files: []
acceptance: [AC-7]
rework_count: 0
---

## Intent

Get the Next.js deployable serving on the internet.

## Approach

One frontend deployable (GC-7); Vercel free tier (GC-3); App Router.

## Out of scope for this TASK

Apex-domain binding — blocked on the unresolved apex-domain question, so this ships on the Vercel-provided hostname and is rebound later. Landing page content (TASK-057), auth screens.

## Interfaces

**Consumes**

`apps/web` workspace (TASK-001).

**Produces**

Deployed web base URL; root layout at `apps/web/app/layout.tsx`; environment variable `NEXT_PUBLIC_API_BASE_URL`.
