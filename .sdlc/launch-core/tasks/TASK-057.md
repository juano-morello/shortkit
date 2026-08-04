---
id: TASK-057
story: STORY-021
epic: EPIC-006
title: Marketing landing page at the apex domain
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-004, TASK-008]
paths: ["apps/web/app/(marketing)/**", "apps/web/src/components/marketing/**"]
contracts: []
test_files: []
acceptance: [AC-97, AC-98, AC-99]
rework_count: 0
---

## Intent

The evaluator's and the operator's front door.

## Approach

**GC-15** — no testimonial, no named customer, no adoption metric. Nobody has been interviewed and the page may not imply otherwise; AC-99 tests this. Renders without a session (AC-98); copy is human-facing prose (GC-12).

**No dependency on published posts** — SC-8 left the initiative (Amendment A-3). **Do not link to a blog that does not exist.**

**Apex-domain binding is blocked on the unresolved apex-domain question** — the page ships on the Vercel-provided hostname and is rebound once that is answered.

## Out of scope for this TASK

Pricing, a blog surface, signup logic (TASK-012).

## Interfaces

**Consumes**

Web deployment and root layout (TASK-004); `/signup` route (TASK-012).

**Produces**

Route `/` serving the landing page.
