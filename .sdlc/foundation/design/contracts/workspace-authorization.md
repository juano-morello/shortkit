# Contract: roles, ranking, and the authorization surface

- **Boundary:** every authenticated write and every workspace-scoped read.
- **Normative form:** `packages/contracts/src/roles.ts` (role values, brands, ranks) and `apps/api/src/common/authorization/roles.ts` (enforcement) — stubs at the matching paths under `design/stubs/`.
- **Produced by:** TASK-007 (role values, branded types, constants, casts, rank tables), TASK-017 (guard, decorators, authorizer). TASK-016 consumes both and defines no role type of its own; corrected 2026-08-05 (F-068).
- **Consumed by:** TASK-014, 018, 021, 025, 040, 045, 049, 051, 053, 054, 056.
- **ADRs:** ADR-0015. Role set fixed by Amendment A-1.

## Roles

```ts
/** Amendment A-8 (2026-08-04) supersedes A-1's tenant enum. `member` is new. */
export const TENANT_ROLES = ['owner', 'admin', 'member'] as const;
/** Amendment A-1, unchanged. */
export const WORKSPACE_ROLES = ['workspace_admin', 'member', 'viewer'] as const;

/** Unbranded. Storage columns and zod enum sources only. */
export type TenantRoleValue    = (typeof TENANT_ROLES)[number];
export type WorkspaceRoleValue = (typeof WORKSPACE_ROLES)[number];

/** Branded (ADR-0023). No bare literal is assignable to either. */
export type TenantRole    = Branded<TenantRoleValue, 'tenant'>;
export type WorkspaceRole = Branded<WorkspaceRoleValue, 'workspace'>;

/** The minimum for a tenant check. `member` is excluded by type. */
export type AuthorisingTenantRole = Branded<'owner' | 'admin', 'tenant'>;

export const TENANT_ROLE    = { owner: …, admin: …, member: … } as const;
export const WORKSPACE_ROLE = { workspace_admin: …, member: …, viewer: … } as const;

/** Rank tables are keyed by the UNBRANDED value types: a branded type cannot index. */
export const WORKSPACE_ROLE_RANK: Record<WorkspaceRoleValue, number> =
  { workspace_admin: 30, member: 20, viewer: 10 };
export const TENANT_ROLE_RANK: Record<TenantRoleValue, number> =
  { owner: 20, admin: 10, member: 0 };

export function roleRank(role: WorkspaceRole): number;
export function tenantRoleRank(role: TenantRole): number;

/** The only two sanctioned casts, at the Drizzle-row and zod-parse boundaries. */
export function asTenantRole(value: string): TenantRole;
export function asWorkspaceRole(value: string): WorkspaceRole;
```

Rank is data, in one table, as TASK-016 requires. No conditional anywhere else compares
role names.

`viewer` is rank 10 and is denied every write, enforced once in `WorkspaceAuthorizer`.
**Nothing in `launch-core` grants `viewer` outside test fixtures**, no UI offers it, and
TASK-021's API accepts it while TASK-022's picker does not.

**Tenant `member` is rank 0 and grants nothing at tenant level.** It exists so an
invitee can hold a `tenant_memberships` row without holding tenant privileges. Their
access comes entirely from workspace roles. Every `@RequireTenantRole` in this contract
has a minimum of `admin` or `owner`, so `member` passes none of them.

Storage: `TenantRole` lives in `tenant_memberships` (TASK-013, ADR-0015);
`WorkspaceRole` lives in `memberships` (TASK-016).

### The two enums both contain `member`, and the types make them incompatible

Revised 2026-08-04 (F-023, Juano's ruling). This section previously listed three process
rules. They were rules, and the residual hole is two adjacent lines with one word
different: a Form B handler meaning `assert(resource.workspaceId, TENANT_ROLE.member)`
that writes `assertTenant(…)` got a check passing for **every authenticated user in the
tenant**. A convention does not fail a build.

Both role types are **nominally branded** (ADR-0023):

- No bare literal is assignable to `TenantRole` or to `WorkspaceRole`. Call sites use
  `TENANT_ROLE.owner` and `WORKSPACE_ROLE.member`.
- Neither branded type is assignable to the other.
- `assertTenant` and `@RequireTenantRole` take `AuthorisingTenantRole`, so
  `TENANT_ROLE.member` cannot be passed as a minimum at all.
- `asTenantRole` and `asWorkspaceRole` are the **only** sanctioned casts, for the Drizzle
  row and the zod parse. TASK-056 greps for `as TenantRole` and `as WorkspaceRole`
  elsewhere and fails on a third.

One rule survives, because it is about the wire format rather than about types:
**a request body carrying a role names which enum it is for, `workspaceRole` or
`tenantRole`, never a bare `role`.** A JSON field is a string until it is parsed, and no
brand reaches it.

## The two enforcement forms

Both call the same authorizer. Which one applies depends on where the workspace id is.

**Form A, declarative.** For routes carrying the workspace id in the request.

```ts
export declare function RequireWorkspaceRole(min: WorkspaceRole): MethodDecorator;
export declare function RequireTenantRole(min: AuthorisingTenantRole): MethodDecorator;
```

`WorkspaceGuard` resolves the workspace id from `params.workspaceId`, then
`body.workspaceId`, then `query.workspaceId`, in that order. None present is 400
`workspace_id_required`.

**Form B, imperative.** For resource routes such as `/api/links/:id`, where the
workspace is a property of the resource and cannot be known before loading it.

```ts
export interface WorkspaceAuthorizer {
  assert(workspaceId: string, min: WorkspaceRole): Promise<void>;        // throws 403
  assertTenant(min: AuthorisingTenantRole): Promise<void>;               // throws 403
}
```

`assertTenant` takes `AuthorisingTenantRole`, not `TenantRole`: `TENANT_ROLE.member` is
rank 0 and would authorise every user in the tenant, so it is excluded by type
(ADR-0023).

The handler loads the resource through a tenant-scoped repository first. RLS returns
nothing for another tenant, so cross-tenant access is already 404 before any role check
runs (AC-41, AC-69, AC-81). Then it calls `assert(resource.workspaceId, 'member')`.

**Every authenticated write route uses exactly one of the two forms.** TASK-056's
enumeration flags a route using neither.

## Status rules

Normative, and the most-mistaken part of this contract.

| Situation | Status | Code |
|---|---|---|
| no membership in the workspace | **404** | `not_found` (AC-27) |
| workspace belongs to another tenant | **404** | `not_found` (AC-24) |
| member, role rank below the minimum | **403** | `insufficient_workspace_role` (AC-28) |
| tenant `admin` invoking an owner-only surface | **403** | `insufficient_tenant_role` (AC-105) |
| `viewer` attempting any write | **403** | `insufficient_workspace_role` (AC-104) |
| `viewer` reading | **200** | (AC-104) |
| no workspace id resolvable in form A | **400** | `workspace_id_required` |

404 before 403. Existence is never disclosed to a non-member.

## Minimum role per surface

Normative. A TASK adding a route adds a row here in the same commit.

| Surface | Requirement |
|---|---|
| `GET /api/workspaces`, `GET /api/workspaces/:id` | any workspace membership |
| `POST /api/workspaces` | tenant `admin` |
| `PATCH`/`DELETE /api/workspaces/:id` | `workspace_admin` |
| `GET /api/members` | `member` |
| `PATCH /api/members/:id/workspace-role` | `workspace_admin` |
| `DELETE /api/members/:id/workspace/:workspaceId` (remove from one workspace) | `workspace_admin` |
| **`GET /api/tenant/members`** (tenant roles) | tenant **`owner`** |
| **`PATCH /api/tenant/members/:id/tenant-role`** | tenant **`owner`** |
| **`DELETE /api/tenant/members/:id`** (remove from the tenant entirely) | tenant **`owner`** |
| `POST /api/invitations`, `DELETE /api/invitations/:id` | `workspace_admin` |
| `GET /api/invitations/:token`, `POST /api/invitations/:token/accept` | `@Public()` |
| `GET /api/links`, `GET /api/links/:id` | `viewer` |
| `POST`/`PATCH`/`DELETE /api/links` | `member` |
| `GET /api/links/:id/audit` | `member` |
| `GET /api/domains` | `viewer` |
| `POST`/`DELETE /api/domains`, `POST /api/domains/:id/verify`, `.../retry-certificate` | `workspace_admin` |
| `GET /api/workspaces/:id/branding` | `viewer` |
| `PATCH /api/workspaces/:id/branding` | `workspace_admin` |
| `POST /api/gdpr/export` | tenant **`owner`** (AC-105), Form A |
| `POST /api/gdpr/delete` | tenant **`owner`** plus confirmation (AC-105, AC-92, AC-106). **Form C**, checked in-handler: see below |
| `GET /api/invitations/:token`, `POST /api/invitations/:token/accept` | `@Public()`; authorisation **is** the capability token (ADR-0021) |

### Tenant-role mutation, added 2026-08-04 (F-011)

The table previously had no row for mutating a *tenant* role while AC-31 requires that
surface to exist, so the gate was the implementer's to pick and the adjacent row said
`workspace_admin`. That path let a member invited to one client workspace promote
themselves to tenant `owner` and then call `POST /api/gdpr/export` for the whole agency.

Normative rules, beyond the table:

- **Only a tenant `owner` may grant or revoke any tenant role.** A tenant `admin` may
  not grant `owner`, may not revoke `owner`, and may not grant `admin`.
- Tenant-role mutation and workspace-role mutation are **separate routes on separate
  controllers**. No handler takes a role string spanning both enums.
- Removing a member from the tenant (`DELETE /api/tenant/members/:id`) cascades their
  workspace memberships. Removing them from one workspace
  (`DELETE /api/members/:id/workspace/:workspaceId`) leaves the tenant membership.
  AC-30 is the second of these.
- The last-owner check (AC-31) applies to `tenant_memberships`, and runs on both the
  tenant-role mutation and the tenant-member removal routes.

### Form C: routes that open their own transaction

Added 2026-08-04 (F-020). `POST /api/gdpr/delete` carries `@NoTenantTransaction`
(`tenant-context.md`) so it can run its three-phase erasure, which means **there is no
ambient tenant context when guards run**. `WorkspaceGuard`'s membership lookup needs one.

Left unstated, an implementer meets a guard that throws on the only irreversible route in
the system, and the cheapest green fix is to make `WorkspaceGuard` tolerate a missing
context. That removes the owner check from tenant erasure and lets any tenant `member`
destroy the whole tenant.

Normative:

- **A `@NoTenantTransaction` route may not carry `@RequireTenantRole` or
  `@RequireWorkspaceRole`.** TASK-056 asserts that combination never exists. The
  decorators are guards, guards run before the handler, and the handler is where the
  transaction now begins.
- **Authorization runs inside phase 1's `withTenantTransaction`, before the census**,
  through `WorkspaceAuthorizer.assertTenant(TENANT_ROLE.owner)`. Same authorizer, same
  RLS-backed membership lookup, same 403 and the same error code. Only the call site
  moves.
- **AC-92's confirmation check runs in the same place, before the census**, so a request
  without it is rejected before anything is read.
- **`WorkspaceGuard` fails closed.** With no active tenant context it throws
  `TenantContextMissingError`, producing a 500. It **never** returns true, and it never
  degrades to an unchecked pass. A 500 on a misconfigured route is correct; a silent pass
  on the erasure route is not.

Order inside `POST /api/gdpr/delete`:

```
1. AuthGuard                          -> 401 / 403 email_not_verified
2. RateLimitGuard                     -> 429
3. handler opens withTenantTransaction(ctx.tenantId)
4.   assertTenant(TENANT_ROLE.owner)  -> 403 insufficient_tenant_role   <- AC-105
5.   assert body.confirmation         -> 400 confirmation_required      <- AC-92
6.   collectTenantCensus()
7. commit, then phase 2 and phase 3
```

## Invariants a caller may rely on

1. A tenant must always retain at least one `owner`. Removing or demoting the last one
   is 409 `last_owner_protected`, checked **inside the same transaction as the change**
   (AC-31), on both routes that can cause it.
2. `viewer` never succeeds at a write, on any surface, without any per-endpoint code
   (AC-104).
3. Tenant `admin` never reaches export or deletion (AC-105), **including on
   `POST /api/gdpr/delete`, where the check moves into the handler and does not
   disappear**.
4. **An invitee holds tenant role `member`, which passes no tenant check in this
   contract.** Accepting an invitation grants workspace access and nothing at tenant
   level (Amendment A-8, ADR-0015).
5. **No route lets a workspace role change a tenant role.** Privilege cannot escalate
   from workspace scope to tenant scope.
6. Role changes take effect on the next request. There is no cached authorization
   (AC-30). The JWT carries no role claim, which is why.
7. A member removed from W1 gets 404 on W1 resources and is unaffected on W2 (AC-30).
8. **Every authenticated route is authorised by exactly one of Form A, Form B or
   Form C.** Form A is a decorator and route enumeration sees it; Forms B and C are
   calls, so TASK-056 additionally scans each handler and one level of delegation for an
   `authorizer.assert*` call. **A route it cannot resolve fails the suite as
   `unverified` rather than passing.** Mechanism in `isolation-coverage.md`.

## What the implementer must guarantee

- `WorkspaceGuard` runs after `AuthGuard` and inside the tenant transaction, so its
  membership lookup is itself under RLS. **With no active context it throws. It never
  returns true.**
- **An integration test asserts `POST /api/gdpr/delete` returns 403 for a tenant
  `member` and for a tenant `admin`, and succeeds for an `owner`.** Route enumeration
  cannot see an in-handler check, so this test is the only coverage for AC-105 on that
  route.
- The last-owner check is a `SELECT ... FOR UPDATE` count inside the mutating
  transaction. A read-then-write outside one races.
- The frontend hiding a control is never the enforcement point (TASK-019, TASK-015).

## Versioning

`WORKSPACE_ROLES` is fixed by Amendment A-1. `TENANT_ROLES` is fixed by Amendment A-8,
which superseded A-1's tenant enum on 2026-08-04. Neither may be changed without a
refinement amendment. Rank values are internal; only their ordering is contractual.
