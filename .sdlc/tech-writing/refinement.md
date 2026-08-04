---
slug: tech-writing
title: Publish the launch-core engineering posts
type: feature
created: 2026-08-03
status: deferred
---

## Problem

`launch-core` is a portfolio-first initiative. Under that framing the evaluator
decides whether the work was worth doing, and the evaluator arrives through
writing. The system can be finished and still fail its own stated purpose if
nobody writes about it.

SC-8 originally lived in `launch-core`. The Plan phase found that it could not
pass Definition of Ready: `refinement.md` required four *published* posts and
never said where they publish, and one candidate answer (publishing on the
Shortkit site) needs a blog surface nobody had planned. Juano chose to settle
the writing after implementation rather than guess, so the criterion moved here.

See `launch-core/refinement.md`, Amendment A-3.

## Outcome

_Not yet refined. This initiative is a stub._

## Success criteria

- **SC-8 (inherited from `launch-core`)** — Four published posts, each carrying
  a real artifact: a benchmark, a diagram, or an ADR. The four subjects, as
  originally scoped: multi-tenancy with RLS; the redirect hot path and its
  numbers; custom-domain TLS automation; the agent-driven SDLC workflow itself.

## Scope

### In

_Not yet refined._

### Out

_Not yet refined._

## Constraints

The artifacts these posts cite are produced by `launch-core` and exist before
this initiative starts:

- `docs/performance/redirect-baseline.md` — the recorded latency target (TASK-036)
- the documented end-to-end domain provisioning flow (TASK-043)
- the machine-readable tenant-isolation coverage report (TASK-056)

## Open questions

| Q | Owner | Blocking? | Answer |
|---|---|---|---|
| Where do the posts publish: externally, on the Shortkit site, or external-canonical linked from the landing page? | Juano | Yes | Unresolved. Deferred until `launch-core` implementation is done. If the answer is "on the Shortkit site", this initiative also has to scope a blog surface in `apps/web`, which nobody has planned. |

## Risks & unknowns

- Deferring writing until after implementation is the common way portfolio
  projects end up with a finished system nobody reads about. The risk is real
  and the mitigation is this file existing rather than the commitment
  evaporating.

## Existing-system notes

Depends on `launch-core` reaching at least its EPIC-003 cut line. Nothing here
can be written before the system it describes exists.
