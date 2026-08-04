---
id: ADR-0015
slug: launch-core
title: A user belongs to exactly one tenant, enforced by a unique constraint
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

Nobody named this decision, and three approved artifacts already disagree about it.

TASK-013 says signup creates exactly one tenant with the signing-up user as owner.
TASK-021 says an invitee accepts an invitation and completes account creation, ending
with membership in exactly the named workspaces of the inviting tenant. Run those two
rules together and an invitee owns a fresh empty tenant while also holding memberships
in someone else's. ADR-0002 then has no answer for what `tid` means in that user's
token.

AC-91 settles it from the other direction. Deleting a tenant must make its members
unable to log in. That behaviour is only correct if a member's account belongs to the
tenant. If a user could serve two agencies, deleting one would take their access to the
other, which no agency would accept.

So the approved acceptance criteria already imply one tenant per user. What is missing
is the mechanism and the error case.

## Decision

**One tenant per user, enforced in the database.**

```sql
CREATE TABLE tenant_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role        tenant_role NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_memberships_user_unique UNIQUE (user_id)
);
```

The `UNIQUE (user_id)` is the decision. Everything else follows from it.

`tenant_memberships` holds the `TenantRole` from Amendment A-1 (`owner`, `admin`).
`memberships` (TASK-016) holds the `WorkspaceRole` per workspace. Two tables, two
levels, matching A-1's two-level taxonomy.

**Signup creates a tenant. Invited signup does not.** `onUserCreated` receives the
invitation token when one is present in the signup request. With a token it attaches
the user to the inviting tenant as `admin` and creates the named workspace
memberships. Without one it creates a new tenant and makes the user its `owner`.
Either way exactly one `tenant_memberships` row exists when the transaction commits,
inside the same transaction as the user insert.

**An existing user accepting an invitation from a different tenant is rejected** with
`409 invitation_tenant_conflict`. The message tells them to accept from a different
email address. Accepting an invitation from their own tenant is fine and adds only the
workspace memberships.

**`tid` resolution is a single-row lookup** by `user_id` on the unique index. It runs
once at token mint time (ADR-0013), never per request.

**Tenant deletion cascades to users.** `privilegedTenantEraser` collects
`tenant_memberships.user_id` for the tenant, deletes the tenant (cascading every
`tenant_id`-bearing table), then deletes those `user` rows, which cascades Better
Auth's `session`, `account` and `verification`. That is what makes AC-91's "their login
fails" true rather than aspirational.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Many-to-many: a user joins any number of tenants, and picks one per request | Matches how consultants actually work; an agency contractor could serve three agencies from one login | `tid` can no longer be a token claim, so ADR-0002's guard needs a database read outside tenant context to validate the requested tenant, which is the exact hole GC-5 forbids. AC-91 also becomes false: deleting one tenant would have to leave the account alive, contradicting an approved AC | Breaks GC-5's enforcement mechanism and contradicts AC-91 |
| Every user gets their own tenant; cross-tenant access is a separate grant table | Signup logic stays uniform | Produces empty tenants for every invitee, which then appear in exports, in deletion, and in any tenant count. It also does not remove the many-to-many problem, it hides it | Complexity of the many-to-many option with none of its benefit |
| Put `tenant_id` directly on Better Auth's `user` table as an additional field | One fewer table; `tid` is a column read | Makes `user` a tenant-scoped table, so RLS applies to it, so Better Auth's login-by-email lookup runs outside tenant context and becomes a third GC-5 exclusion. SC-1's exclusion count is exactly two | Costs an exclusion, which is the initiative's headline claim |
| Model tenant roles as rows in `memberships` with a null `workspace_id` | One membership table | A nullable foreign key that changes the meaning of the row, and a `role` column holding values from two different enums. Every query needs a null check to know which taxonomy it is reading | Cheaper to write, more expensive to read and to get right in the authorization guard |

## Consequences

### Positive

- `tid` is a stable claim, so `AuthGuard` opens the tenant transaction with no query
  and ADR-0002's ordering problem stays solved.
- AC-91 becomes a mechanical consequence of the cascade rather than a special case.
- Two enums live in two tables, so TASK-017's guard reads `TenantRole` and
  `WorkspaceRole` from unambiguous sources and AC-105's owner-only check is a single
  lookup.
- The unique constraint means the ambiguity can never be introduced by a later TASK
  without a migration that someone has to justify.

### Negative / accepted cost

- **A person cannot serve two agencies from one email address.** A freelancer working
  with two Shortkit customers needs two accounts. That is a real product limitation and
  it will be the first thing a multi-agency user complains about.
- Removing the constraint later is a genuine migration: the token claim shape changes,
  the guard gains a tenant-selection step, and AC-91's behaviour has to be redefined.
  This decision is cheap now and expensive to reverse.
- `invitation_tenant_conflict` is an error code the plan did not anticipate, so
  TASK-021's contract and TASK-022's copy both grow a case that was not in their
  acceptance criteria.
- The signup path branches on whether an invitation token is present, so it has two
  code paths and two tests where TASK-013 assumed one.

### Follow-ups this creates

- TASK-013 creates `tenant_memberships` with its unique constraint and the RLS policy
  set, and branches `onUserCreated` on the invitation token. This is more than its
  `Produces` block enumerates; see the TASK constraints in the design return.
- TASK-016 keeps `memberships` workspace-scoped and reads `TenantRole` from
  `tenant_memberships`.
- TASK-021 adds `invitation_tenant_conflict` and threads the token through signup.
- TASK-022 renders distinct copy for it.
- TASK-054 deletes `user` rows after the tenant cascade and asserts no `session`
  survives.
