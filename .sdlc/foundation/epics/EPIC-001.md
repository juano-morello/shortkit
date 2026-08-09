---
id: EPIC-001
slug: foundation
title: Foundation and tenancy substrate
status: in-progress
stories: [STORY-001, STORY-002, STORY-003, STORY-004]
---

## Outcome

A deployable, CI-gated monorepo whose data layer cannot be read across tenants.

## Success criteria

Carried by the STORIEs listed above. See `../refinement.md` for the initiative's
SC-1 … SC-7 and `../plan.md` for the SC → AC coverage table.

## Out of scope

Any feature behaviour. This EPIC builds the substrate every later EPIC stands on and nothing a user would recognise.

## Re-scope 2026-08-09

**This EPIC is now the whole initiative.** EPIC-002 through EPIC-006 were split out under
`phases/plan.md` step 7 and are named entries in `.sdlc/roadmap.md` with no ids, no
acceptance criteria and no design. Their cards are kept and marked `status: deferred`.

The sentence above — "the substrate every later EPIC stands on" — was written as a
disclaimer and is now the scope statement. Nothing about this EPIC's outcome changed; what
changed is that it ships on its own instead of as the first layer of a 58-TASK batch.
