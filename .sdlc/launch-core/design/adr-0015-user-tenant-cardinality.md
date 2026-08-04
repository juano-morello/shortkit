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

`tenant_memberships` holds the `TenantRole`; `memberships` (TASK-016) holds the
`WorkspaceRole` per workspace. Two tables, two levels.

**Amendment A-8 (2026-08-04) supersedes A-1's tenant enum: `TenantRole = owner | admin |
member`,** with `member` at rank 0 granting nothing at tenant level. A-1's workspace
enum is unchanged.

The first version of this ADR attached every invitee to the inviting tenant as `admin`,
whatever workspace roles the invitation actually granted. A freelancer invited as
`viewer` on one client workspace ended up holding the tenant role that gates
`POST /api/workspaces` and every future tenant-level surface, and no screen in
`launch-core` reads or writes tenant roles, so the operator could neither see it nor
revoke it. Juano ruled A-8 over the alternative of re-gating every tenant-`admin`
surface to `owner`, on the grounds that the latter leaves `admin` granting nothing and
the next tenant-level route added would be gated at `admin` by default, reintroducing
the hole silently.

**Signup creates a tenant. Invited signup does not.** `onUserCreated` receives the
invitation token when one is present in the signup request. Either way exactly one
`tenant_memberships` row exists when the transaction commits, inside the same
transaction as the user insert.

**Uninvited branch.** Generate a tenant id with `crypto.randomUUID()`, open
`withTenantTransaction` on it (ADR-0021), insert the `tenants` row under
`tenants_self_insert`, and make the user its `owner`.

**Invited branch. The tenant id comes from the verified invitation row, never from the
token the caller supplied.** Added 2026-08-04 (F-021): this section previously said
only "attaches the user to the inviting tenant", with no mention of digest
verification, and it is the artifact TASK-013 reads. That branch is the single anonymous
path that writes `tenant_memberships`, and because the Better Auth mount sits outside
the Nest graph it is also the one path TASK-056's route enumeration structurally cannot
see. An implementer who opens the transaction before verifying gives an attacker who
signs up with `invitationToken = "<victim-tenant-uuid>.<random>"` a membership row in
the victim's tenant.

Validation runs in a **`before` hook**, because `databaseHooks.user.after` cannot roll
back the insert that triggered it and rejecting there would leave a user row behind.

```
hooks.before, on /sign-up/email, when body.invitationToken is present:
  1. invitation = await invitationRepository.findByCapabilityToken(body.invitationToken)
       -> parses, opens withTenantTransaction, verifies the digest as its FIRST statement
  2. null                        -> throw APIError(404). NO USER IS CREATED.
  3. expired / revoked / accepted -> throw with that state's code

databaseHooks.user.after (onUserCreated), invited branch:
  4. invitation = findByCapabilityToken(body.invitationToken)   -- same verified read
  5. tenantId := invitation.tenantId          <- FROM THE VERIFIED ROW
  6. create tenant_memberships at TENANT_ROLE.member and the named workspace
     memberships, in one transaction with token consumption
```

Parsing the token for a tenant id anywhere outside `findByCapabilityToken` is a defect.

**Residue if step 6 fails after the user commits:** a `user` row with no
`tenant_memberships` row. That account cannot obtain a `tid` claim and so cannot
authenticate to any tenant-scoped route, and it holds no membership in the inviting
tenant. An orphaned unusable account is the acceptable failure; a membership row in a
tenant nobody proved access to is not. **Do not relax step 5 to avoid the orphan.**
Route enumeration cannot reach this path, so **an integration test is its only
coverage**: sign up with a token whose tenant half names another tenant and whose secret
half is random, and assert no user and no membership row is created in that tenant.

**Only a tenant `owner` grants or revokes a tenant role**, on a route distinct from the
workspace-role route (`workspace-authorization.md`). Nothing a workspace role can do
changes a tenant role.

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
| Keep `TenantRole = owner \| admin` and re-gate every tenant-`admin` surface to `owner` | No refinement amendment; A-1's enum stands; invitees can keep `admin` because `admin` would grant nothing | It leaves a role in the enum that authorises nothing, so the next tenant-level route added is gated at `admin` by default and the escalation returns silently. It also makes `admin` a lie in the data | Juano's ruling, 2026-08-04. Rejected in favour of A-8 |
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
- Under A-8 an invitee holds the least tenant privilege that lets them exist, so
  accepting an invitation grants workspace access and nothing else. Adding a
  tenant-level route later gates it at `admin` or `owner` and an invitee still passes
  neither, which is the property the alternative ruling would not have preserved.

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
- **A-8 puts `member` in both role enums.** `'member'` is assignable to `TenantRole` and
  to `WorkspaceRole`, so the compiler will not catch a tenant check written with a
  workspace role in mind. Three mitigations are normative in
  `workspace-authorization.md` and none of them is the type system. This is the price of
  the ruling and it will eventually cost someone an afternoon.
- Tenant roles now need their own routes, guards and last-owner checks, which is surface
  TASK-018 did not scope. `viewer` and tenant `member` are both roles nothing in
  `launch-core` grants through a UI, so two of the six roles exist only to be correct
  later.

### Follow-ups this creates

- TASK-013 creates `tenant_memberships` with its unique constraint and the RLS policy
  set, and branches `onUserCreated` on the invitation token, taking the tenant id from
  `findByCapabilityToken`'s verified row on the invited branch. It also owns the
  integration test that route enumeration cannot replace. This is more than its
  `Produces` block enumerates; see the TASK constraints in the design return.
- TASK-016 keeps `memberships` workspace-scoped and reads `TenantRole` from
  `tenant_memberships`.
- TASK-021 adds `invitation_tenant_conflict` and threads the token through signup.
- TASK-022 renders distinct copy for it.
- TASK-054 deletes `user` rows after the tenant cascade and asserts no `session`
  survives.
