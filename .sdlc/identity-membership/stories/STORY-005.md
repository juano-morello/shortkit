---
id: STORY-005
epic: EPIC-001
title: Cross-tenant isolation is proved per shipped table and per shipped endpoint
status: planned
tasks: [TASK-014, TASK-015]
depends_on: [STORY-004]
---

## User story

As Juano, I need the isolation claim to rest on attempts the suite actually runs against
this initiative's own tables and endpoints, so that SC-1 stops being a criterion about an
empty set and starts being a measurement.

## Acceptance criteria

- [ ] AC-29: Given tenant A holding workspaces and tenant B signed in concurrently with its own valid session, when the isolation harness attempts every shipped authenticated endpoint in both directions — A against B's rows and B against A's rows — then no attempt returns a row belonging to the other tenant, no attempt modifies or deletes a row belonging to the other tenant, and every attempt is recorded in the run's report as a named outcome rather than skipped.
- [ ] AC-30: Given the isolation report written by a completed run, when it is read, then it names at least one negative control for each authenticated endpoint this initiative ships and for each of the tenant-scoped tables it ships, and its coverage-boundary string states which tables and endpoints the run covered and which it did not.
- [ ] AC-31: Given a control table shaped exactly like `workspaces` but with `ENABLE ROW LEVEL SECURITY` omitted, and a control endpoint reading it, when the harness runs the same table attempts and the same endpoint attempts over them, then every one of those attempts reports `fail` — which is what proves the harness would have seen a real leak.
- [ ] AC-32: Given `tenant_memberships` present in the database, when the isolation suite runs, then it is a registered subject, its cross-tenant attempts run in both directions, and every one reports `pass`.

## Definition of Ready

**PASS with one concern, and it is the concern `roadmap.md` already ruled on.**

- [x] ACs are testable and unambiguous
- [x] Dependencies identified — needs every endpoint STORY-004 ships
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run; `isolation-coverage.md` is named by both TASKs
- [x] No blocking open questions

**Concern — the harness proves the shapes someone thought of, and this STORY multiplies the
surface it must cover.** Juano's 2026-08-11 ruling records that three consecutive audit
rounds each found a statement shape the harness did not check, and F-341 names five more
that are still not built (`INSERT ... ON CONFLICT DO UPDATE`, `MERGE`, eviction,
cascade/trigger effects, `SELECT ... FOR UPDATE`). This STORY adds endpoint-level attempts,
which is a **new attempt category** rather than a new table under an existing one, so the
same class of gap should be expected here and expected on the endpoints rather than on the
tables. AC-31's controls are the mitigation and they are bounded by the same imagination.
Generative mutation of the policy set is roadmap item 4 and is not scheduled here.

## Definition of Done

- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids
