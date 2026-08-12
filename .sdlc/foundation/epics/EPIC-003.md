---
id: EPIC-003
slug: foundation
title: Links and the redirect hot path
status: deferred
stories: [STORY-009, STORY-010, STORY-011, STORY-012, STORY-013]
---

## Outcome

A working multi-tenant URL shortener on the system default domain, with a redirect that is fast, correct under cache edits, degrades under Redis loss, and accumulates click events.

## Success criteria

Carried by the STORIEs listed above. See `../refinement.md` for the initiative's
SC-1 … SC-7 and `../plan.md` for the SC → AC coverage table.

## Out of scope

Custom domains (EPIC-004), analytics dashboards reading the click stream (deferred to SP3), password-protected links and bulk CSV import (both cut from this initiative).
