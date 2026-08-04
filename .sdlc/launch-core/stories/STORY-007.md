---
id: STORY-007
epic: EPIC-002
title: Members and per-workspace roles
status: todo
tasks: [TASK-016, TASK-017, TASK-018, TASK-019]
depends_on: [STORY-006]
---

## User story

As an agency operator, I grant a teammate access to specific workspaces and no others, so that client data stays compartmentalised.

## Acceptance criteria

- [ ] AC-27: Given a member with membership in workspace W1 only, when they request workspace W2 (same tenant) by id, then the response is 404.
- [ ] AC-28: Given a member with the `member` role in W1, when they attempt to change another member's role in W1, then the response is 403 with a stable error `code`; when a `workspace_admin` in W1 performs the same action, then it succeeds.
- [ ] AC-29: Given a tenant owner, when they list members, then the response includes, per member, the set of workspaces they belong to and their role in each.
- [ ] AC-30: Given a member is removed from W1, when they next request any resource scoped to W1, then the response is 404 and their access to W2 is unaffected.
- [ ] AC-31: Given a tenant with exactly one owner, when a request attempts to remove or demote that owner, then it is rejected with a stable error `code` and the tenant still has an owner.
- [ ] AC-104: Given a membership with the `viewer` role in W1 seeded directly, when that user issues any write to a W1-scoped resource, then the response is 403 with a stable error `code`, and the resource is unmodified; when the same user issues a read of that resource, then it returns 200.
- [ ] AC-105: Given a tenant `admin` (not `owner`), when they invoke tenant data export or account deletion, then the response is 403 with a stable error `code`; when the tenant `owner` invokes either, then it is permitted.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS with a note** (was FAIL until 2026-08-03). The role set is ruled by Amendment A-1: tenant `owner` / `admin`; workspace `workspace_admin` / `member` / `viewer`.

Note carried from the planner: AC-105's owner/admin boundary is *derived* from the owner-only constraint TASK-053 and TASK-054 already carried, not from an independent statement in `refinement.md`. If tenant `admin` should hold a wider or narrower set, say so before TASK-016 dispatches.

`viewer` is read-only and **nothing in `launch-core` reads or grants it.** It exists so the schema and the authorization ranking are correct before SP7 reporting needs it.

- [x] ACs are testable and unambiguous
- [x] Dependencies identified
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run yet
- [x] No blocking open questions

## Definition of Done
- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids
