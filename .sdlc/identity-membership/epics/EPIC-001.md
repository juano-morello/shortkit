---
id: EPIC-001
slug: identity-membership
title: Identity, tenancy and membership
status: planned
stories: [STORY-001, STORY-002, STORY-003, STORY-004, STORY-005, STORY-006]
---

## Outcome

An agency operator opens shortkit in a browser against `docker compose up`, creates an
account with an email address and a password, and structures their agency into client
workspaces. Signup mints exactly one tenant and exactly one `tenant_memberships` row for
that operator. Every read and write they make afterwards is scoped to their own tenant by
row-level security rather than by application code, and that scoping is proved by a
negative control per shipped table and per shipped authenticated endpoint in the isolation
harness rather than asserted in prose.

This is the first request path in shortkit. The tenancy substrate `foundation` shipped has
never carried a real request: `withTenantTransaction` has only ever been driven by fixtures
the isolation suite created for itself, and `foundation`'s SC-1 closed **untestable**
because it quantified over an empty set of endpoints and repository methods. This EPIC is
what makes that set non-empty for the first time.

## Success criteria

Copied from `refinement.md` (approved 2026-08-12). The refinement is authoritative; these
are restated so a reader of this card does not have to hold two files open.

**SC-1.** Every authenticated endpoint and every tenant-scoped table this initiative ships
is covered by the isolation harness with at least one negative control, and the build fails
if a tenant-scoped table is unregistered.

**SC-2.** An operator completes signup, sign-in and workspace creation in a browser against
`docker compose up`, with no seed data and no manual step.

**SC-3.** Signup creates exactly one tenant and exactly one `tenant_memberships` row, and
the `UNIQUE (user_id)` constraint from ADR-0015 rejects a second tenant for that user at the
database. Proved by a test that attempts it.

**SC-4.** A second tenant's operator, signed in concurrently, cannot read or write the first
tenant's workspaces through any shipped endpoint. One negative control per endpoint, in the
isolation harness rather than in a controller test.

**SC-5.** No credential, session token or email address reaches a log line. The allowlist in
ADR-0028 is the mechanism; the criterion is that a test asserts it for the new fields rather
than that the allowlist exists.

## Out of scope

Taken verbatim from `refinement.md`'s **Out** list. Nothing below may acquire a STORY, a
TASK or an acceptance criterion in this initiative.

- **Invitations, capability tokens and mail.** The whole second-human path. It carries
  F-018, F-300/F-362 and F-386/F-401 with it; those obligations keep their carrier in
  `roadmap.md` under item 1b and do not move here.
- **Workspace-level membership and `WorkspaceRole` enforcement.** The `memberships` table is
  not built. A workspace in this increment has exactly one human who can see it. Design
  records what 1b adds and why the existing policy set survives it, as an ADR clause rather
  than as a table.
- **Email verification.** Off, as a dated decision with a stated trigger, because
  `MAIL_TRANSPORT` unset binds `NoopMailSender` and requiring verification would make signup
  uncompletable.
- **Password reset.** It is a mail path, and mail is out.
- **Links, redirects, custom domains, GDPR export and erasure.** Roadmap items 2, 3 and 4.

Two adjacent items are also out, recorded here because a reader will reach for them:

- **Route and repository auto-discovery in the isolation harness.** `discoverRoutes()`,
  `discoverRepositoryMethods()`, `undecoratedRepositoryClasses()` and
  `tablesWithoutRepository()` in `apps/api/test/isolation/coverage.ts` all throw
  `TASK-056 owns ...` and stay that way. This initiative registers its endpoints explicitly.
  SC-1's build-fails clause is about **tables**, and the mechanism for it already ships.
- **Session revocation backed by Redis.** ADR-0013 specifies `revoked:jti:<jti>` and
  `databaseHooks.session.delete.after`. `redisClient` does not exist in this repository
  (deferred TASK-030). The hook seam and the port are in scope; a Redis binding is not.
