---
slug: identity-membership
title: Identity, tenancy and membership
type: feature
created: 2026-08-12
status: approved
---

## Problem

Shortkit has a tenancy substrate and no way to reach it. `foundation` shipped one migrated
table with RLS enforced and forced, a tenant-context transaction helper, an isolation harness
with thirteen negative controls, a shared contracts package and a compose stack that comes up
from nothing. Then `app.module.ts:20-23` wires a health check and stops. No auth module, no
guard, no session, no user table, no membership concept.

The acceptance auditor closed that initiative with SC-1 marked **untestable**: the criterion
quantifies over "every repository method and every authenticated endpoint" and both sets are
empty. So the isolation claim rests on fixtures the suite created for itself. No request has
ever carried a tenant through a transaction, and the eight statement shapes the harness fires
are the shapes a human sat down and wrote.

The person who hurts is the operator of a small agency, who cannot use shortkit at all.

## Outcome

An agency operator opens the app in a browser, creates an account, and structures their
agency into client workspaces. Every read they make is scoped to their own tenant by RLS
rather than by application code, and that scoping is proved by a negative control per
surface rather than asserted.

This is the first request path in shortkit, and it is worth as much for what it teaches as
for what it delivers. The substrate has never carried a real request. Learning what that
costs beats stacking a second subsystem on top of an untested one.

## Success criteria

**SC-1 (inherited from `foundation`, reworded).** Every authenticated endpoint and every
tenant-scoped table this initiative ships is covered by the isolation harness with at least
one negative control, and the build fails if a tenant-scoped table is unregistered.

Reworded rather than inherited verbatim. The original quantifies over every endpoint in
shortkit, the shape F-295's rule refuses: vacuously true while the set is empty, and
unfalsifiable once it is not. Bounded to this initiative's surface, it is testable on day one
and grows with the system. The build-fails clause already holds;
`test/isolation/registrations.ts` fails the run on an unregistered table.

**SC-2.** An operator completes signup, sign-in and workspace creation in a browser against
`docker compose up`, with no seed data and no manual step.

**SC-3.** Signup creates exactly one tenant and exactly one `tenant_memberships` row, and the
`UNIQUE (user_id)` constraint from ADR-0015 rejects a second tenant for that user at the
database. Proved by a test that attempts it.

**SC-4.** A second tenant's operator, signed in concurrently, cannot read or write the first
tenant's workspaces through any shipped endpoint. One negative control per endpoint, in the
isolation harness rather than in a controller test.

**SC-5.** No credential, session token or email address reaches a log line. The allowlist in
ADR-0028 is the mechanism; the criterion is that a test asserts it for the new fields rather
than that the allowlist exists.

## Scope

### In

- Better Auth mounted per ADR-0013: the direct handler mount, `authBodyCap` and
  `authRateLimit` ahead of it, in the ordering that ADR fixes.
- Email-and-password signup and sign-in. **Verification off**, as a dated decision with the
  trigger that flips it, not as an omission.
- `tenant_memberships` per ADR-0015, `UNIQUE (user_id)` included. Signup creates the tenant.
- `workspaces`, a tenant-scoped table with `tenantScopedPolicies()`. Create, rename, archive.
- The auth, workspace and membership contracts in `packages/contracts`, replacing the
  commented-out placeholders at `src/index.ts:24-30`.
- Screens in `apps/web`: signup, sign-in, workspace list with create.
- Isolation-harness registrations and negative controls for every new table and endpoint.

### Out

- **Invitations, capability tokens and mail.** The whole second-human path. This is the
  largest deliberate cut, and it takes four carried obligations with it: F-018, F-300/F-362
  and F-386/F-401, which keep their carrier in `roadmap.md` rather than moving here.
- **Workspace-level membership and `WorkspaceRole` enforcement.** `memberships` is not built.
  A workspace in this increment has exactly one human who can see it, so there is nothing to
  scope; a join table with one row per workspace would be a table nothing reads. Design
  records what 1b adds and why the policy set survives it, as an ADR clause rather than a
  table.
- **Email verification**, per the decision above.
- **Links, redirects, custom domains, GDPR export and erasure.** Roadmap items 2, 3 and 4.
- **Password reset.** It is a mail path, and mail is out.

## Constraints

- **Track is `full`, forced not chosen.** `config.yaml`'s `force_full_paths` covers
  `apps/api/src/auth/**`, `apps/api/src/invitations/tokens/**`, `packages/contracts/src/auth/**`,
  `apps/api/drizzle/**` and `apps/api/src/tenancy/**`. Item 1 touches at least three.
- **Three accepted ADRs bind this work before Design starts.** ADR-0013 fixes the auth mount
  and its middleware ordering. ADR-0015 fixes the cardinality, the two-table split and
  amendment A-8's `TenantRole = owner | admin | member`. ADR-0040 fixes the trust boundary.
  Design refines within them or amends them explicitly.
- **No deploy target** (ADR-0030). Nothing to flag, backfill or roll back to; the blast radius
  is a developer's machine and CI. It also means header-trust assumptions have no platform hop
  to lean on, which is what ADR-0040 exists to record.
- **`Dockerfile:83` sets `NODE_ENV=production` unconditionally** under compose. Per the F-386
  ruling, no behavioural choice in this initiative may key on it; bindings go on declared
  properties.
- **A new tenant-scoped table owes three things in one commit**: the column via
  `TENANT_ID_COLUMN_SQL`, `tenantScopedPolicies()` hand-appended to the generated migration,
  and a `registerTenantScopedSurfaces()` call. `pnpm db:check-policies` and the harness each
  fail if one is missing.
- **Logging is an allowlist.** A new field name is invisible until added explicitly
  (ADR-0028). Email addresses are the field to watch.

## Open questions

| Q | Owner | Blocking? | Answer |
|---|---|---|---|
| Does the design auditor rejoin the panel for this initiative? | Juano | no | Recommended yes. The retro dropped it with "revisit when item 3 or item 5 opens" on the grounds that shortkit had four UI files and nothing rendered; this initiative ships three screens, which arrives earlier than that note predicted. Decide at the Plan gate, not here. |
| Does `apps/web`'s stub-drift gate widen now? | `sdlc-implementer-frontend` | no | F-403 says widen `ENFORCED_PREFIXES` when TASK-003's logger stub retires or a source lands under `apps/web`. A session module landing here is the second trigger. |
| Cookie or bearer session, and same-site posture? | `sdlc-architect` | no | Design's call under ADR-0013 and ADR-0040. Named here so it is not mistaken for settled. |

No blocking open questions.

## Risks & unknowns

**The retrofit risk on workspaces gets a paper answer, not a test.** Deferring workspace
membership means 1b adds a boundary to a table and a policy set that never had one. F-236 is
that failure at one remove: a policy fix verified against the policy set and never against a
statement issued under it. The mitigation here is an ADR clause stating what 1b adds and why
the existing policies survive it. An ADR clause is weaker than a test, so of everything in
this refinement, treat this as the item most likely to be wrong.

**The isolation harness proves the shapes someone thought of.** Juano's 2026-08-11 ruling
already records that its coverage is bounded by imagination, and this initiative multiplies
the surface it must cover. TASK-006 needed three blockers and five fix rounds because a
harness is only ever proven against attacks someone thought to run. Expect the same class
here, and expect it on the endpoints rather than on the tables.

**Better Auth owns the `user` table and this repo owns everything else.** ADR-0015's
`tenant_memberships` references `"user"(id)` as `text`, which is Better Auth's shape rather
than this repo's `uuid` convention. Whether Better Auth's own tables can carry RLS at all,
and what `onUserCreated` guarantees transactionally when it creates a tenant, are the two
unknowns most likely to warrant a spike. Neither blocks the gate; both belong in Design's
first dispatch.

**F-157 stops being theoretical.** Its build-output scan is structurally blind to dynamic
routes, and the first authenticated route is exactly that. The finding is closed against
TASK-004 with the residual recorded as real; this is where it lands.

## Existing-system notes

From `sdlc-scout`, 2026-08-12. Full report at `.sdlc/identity-membership/scout-refine.md`.

- `app.module.ts:20-23` wires `HealthModule` and a global exception filter. Nothing else.
- `withTenantTransaction` (`tenancy/tenant-context.ts:164`) opens a transaction, sets a
  statement timeout, an idle timeout and `app.tenant_id` via `set_config`, and hands a branded
  `TenantDb` to a callback. RLS policies at `db/rls.ts:57` read that flag.
- `databaseTransaction` is the only export leaving `db/client.ts`, against an enumerated
  caller list at `client.ts:11-23`.
- Roles are already nominally branded at `packages/contracts/src/roles.ts:38-96`. No bare
  string is assignable to `TenantRole` or `WorkspaceRole`; casts go through `asTenantRole` and
  `asWorkspaceRole`. The type vocabulary for workspace membership exists before the table does.
- `packages/contracts` is zod-only and `apps/web` imports it as TypeScript source. There is no
  codegen step. The auth, workspace, membership and invitation contracts are commented-out
  placeholders at `src/index.ts:24-30`.
- Three test tiers: unit (`*.spec.ts`, no Docker), integration (`*.int-spec.ts`,
  `fileParallelism: false`, shared live Postgres), and the isolation suite under
  `apps/api/test/isolation/`.
- Third-party I/O belongs in `withTenantTransaction`'s `afterCommit`, never in the transaction
  body (ADR-0002).
- CI gates on three jobs, `quality`, `integration` and `compose`, feeding `gate`
  (`ci.yml:382-386`).

**Deferred prior art exists and is history, not authority.** TASK-009 through TASK-022 and
TASK-058 carry the 2026-08-03 breakdown of this subject, and design stubs for
`auth/auth-claims.ts` and `apps/web/src/lib/session/session.ts` were written then. Their ids
are frozen and appear in commit subjects. Wave 2 already corrected some of those cards.

**One scout claim was wrong and was checked rather than repeated.** It reported
`registerTenantScopedSurfaces()` absent from the repo, flagged as unconfirmed. It is exported
from `test/isolation/coverage.ts` and called at `registrations.ts:591`. The scout searched
`src/` and the function lives under `test/`.
