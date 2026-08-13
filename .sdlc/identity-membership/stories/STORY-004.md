---
id: STORY-004
epic: EPIC-001
title: An operator creates, renames and archives client workspaces
status: planned
tasks: [TASK-011, TASK-012, TASK-013, TASK-017]
depends_on: [STORY-002, STORY-003]
---

## User story

As an agency operator, I want to split my agency into one workspace per client and rename
or archive them as the client list changes, so that the structure in shortkit matches the
structure of the business.

## Acceptance criteria

- [ ] AC-21: Given a signed-in operator whose tenant holds no workspaces, when they create a workspace named `Acme`, then the response status is 201 carrying that workspace's id and name, and a subsequent list request returns exactly one workspace, with that id and that name.
- [ ] AC-22: Given a workspace that exists, when its name is changed to `Acme Group`, then the response status is 200, a subsequent list shows `Acme Group`, and the workspace's id is unchanged.
- [ ] AC-23: Given a workspace that exists, when it is archived, then the response status is 200, a subsequent default list does not contain it, and a list explicitly requesting archived workspaces does contain it with its archived state set.
- [ ] AC-24: Given a create request whose `name` violates the workspace contract, when it is sent, then the response status is the one `ERROR_CODE_STATUS` maps for the validation code, the body matches the error envelope, `details` keys at least one issue under `name`, and no `workspaces` row is created.
- [ ] AC-25: Given the migration that creates `workspaces`, when it has been applied and `pnpm db:check-policies` is run, then it exits 0 and reports `workspaces` carrying the full statement set `tenantScopedPolicies('workspaces')` produces — row-level security enabled, forced, the `FOR ALL` policy with matching `USING` and `WITH CHECK` on `tenant_id`, the privileged-erase `FOR DELETE` policy, and the `tenant_id` index.
- [ ] AC-26: Given a `workspaces` relation present in the database with no `registerTenantScopedSurfaces()` call naming it in `apps/api/test/isolation/registrations.ts`, when the isolation suite runs, then the run fails and its output names `workspaces` as the unregistered table.
- [ ] AC-27: Given the workspace list screen showing two workspaces, when the operator creates a third through the screen, then the third appears in the list without the operator reloading the page by hand.
- [ ] AC-28: Given a machine with only Docker and a clone of this repository, when the composed stack is driven through signup, then sign-in, then workspace creation, in that order and through the web app, then all three succeed against a database with no seed data and with no manual step between them.

## Definition of Ready

**PASS with two concerns.**

- [x] ACs are testable and unambiguous
- [x] Dependencies identified — needs the guard and tenant binding from STORY-002 and the web transport from STORY-003
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run; `workspaces.md` and `rls-policy-template.md` are named by the TASKs that need them
- [x] No blocking open questions

**Concern 1 — "archive" has no shape on record.** No approved artifact says whether
archiving is a nullable `archived_at` timestamp, a boolean, or a status enum, and none says
whether an archived workspace is still readable, renamable, or unarchivable. AC-23 is
written against the observable — it leaves the default list and stays visible when
explicitly requested — so it holds under any of the three. Design fixes the column; this
STORY does not.

**Concern 2 — AC-26 asserts an existing mechanism rather than a new one.**
`apps/api/test/isolation/coverage.ts` already cross-checks the registry against the database
on every run (`tenantScopedTableDrift`), so the build-fails clause of SC-1 holds today for a
table that does not yet exist. The AC is worth keeping because it is the clause SC-1 states,
and because a plan that omitted it would leave SC-1 partially unmapped. Its cost is that it
is verified by deliberately removing a registration in a test rather than by new production
code.

## Definition of Done

- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids
