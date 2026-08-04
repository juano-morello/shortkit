# Contract: roles, ranking, and the authorization surface

- **Boundary:** every authenticated write and every workspace-scoped read.
- **Normative form:** `apps/api/src/common/authorization/roles.ts` (stub: `design/stubs/apps/api/src/common/authorization/roles.ts`).
- **Produced by:** TASK-016 (roles, `roleRank`), TASK-017 (guard, decorators, authorizer).
- **Consumed by:** TASK-014, 018, 021, 025, 040, 045, 049, 051, 053, 054, 056.
- **ADRs:** ADR-0015. Role set fixed by Amendment A-1.

## Roles

```ts
/** Amendment A-8 (2026-08-04) supersedes A-1's tenant enum. `member` is new. */
export const TENANT_ROLES = ['owner', 'admin', 'member'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** Amendment A-1, unchanged. */
export const WORKSPACE_ROLES = ['workspace_admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> =
  { workspace_admin: 30, member: 20, viewer: 10 };
export const TENANT_ROLE_RANK: Record<TenantRole, number> =
  { owner: 20, admin: 10, member: 0 };

export function roleRank(role: WorkspaceRole): number;
export function tenantRoleRank(role: TenantRole): number;
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

### The two enums both contain `member`, and they are not the same value

`'member'` is assignable to both `TenantRole` and `WorkspaceRole`, so TypeScript will
not catch `assertTenant('member')` written where `assert(wsId, 'member')` was meant.
Three mitigations, all normative:

1. **Tenant-role and workspace-role mutation are distinct routes with distinct guards.**
   `@RequireTenantRole` and `@RequireWorkspaceRole` are never applied to the same
   handler, and no handler accepts a role string that could belong to either enum.
2. A request body carrying a role names which enum it is for: `workspaceRole` or
   `tenantRole`. Never a bare `role`.
3. `tenantRoleRank` and `roleRank` are separate functions over separate records. Passing
   a workspace role to `tenantRoleRank` yields `undefined` rather than a wrong number,
   and both throw on an unknown key rather than returning `undefined`.

## The two enforcement forms

Both call the same authorizer. Which one applies depends on where the workspace id is.

**Form A, declarative.** For routes carrying the workspace id in the request.

```ts
export declare function RequireWorkspaceRole(min: WorkspaceRole): MethodDecorator;
export declare function RequireTenantRole(min: TenantRole): MethodDecorator;
```

`WorkspaceGuard` resolves the workspace id from `params.workspaceId`, then
`body.workspaceId`, then `query.workspaceId`, in that order. None present is 400
`workspace_id_required`.

**Form B, imperative.** For resource routes such as `/api/links/:id`, where the
workspace is a property of the resource and cannot be known before loading it.

```ts
export interface WorkspaceAuthorizer {
  assert(workspaceId: string, min: WorkspaceRole): Promise<void>;   // throws 403
  assertTenant(min: TenantRole): Promise<void>;                     // throws 403
}
```

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
| `POST /api/gdpr/export` | tenant **`owner`** (AC-105) |
| `POST /api/gdpr/delete` | tenant **`owner`** plus confirmation (AC-105, AC-92, AC-106) |

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

## Invariants a caller may rely on

1. A tenant must always retain at least one `owner`. Removing or demoting the last one
   is 409 `last_owner_protected`, checked **inside the same transaction as the change**
   (AC-31), on both routes that can cause it.
2. `viewer` never succeeds at a write, on any surface, without any per-endpoint code
   (AC-104).
3. Tenant `admin` never reaches export or deletion (AC-105).
4. **An invitee holds tenant role `member`, which passes no `@RequireTenantRole` check
   in this contract.** Accepting an invitation grants workspace access and nothing at
   tenant level (Amendment A-8, ADR-0015).
5. **No route lets a workspace role change a tenant role.** Privilege cannot escalate
   from workspace scope to tenant scope.
4. Role changes take effect on the next request. There is no cached authorization
   (AC-30). The JWT carries no role claim, which is why.
5. A member removed from W1 gets 404 on W1 resources and is unaffected on W2 (AC-30).

## What the implementer must guarantee

- `WorkspaceGuard` runs after `AuthGuard` and inside the tenant transaction, so its
  membership lookup is itself under RLS.
- The last-owner check is a `SELECT ... FOR UPDATE` count inside the mutating
  transaction. A read-then-write outside one races.
- The frontend hiding a control is never the enforcement point (TASK-019, TASK-015).

## Versioning

`WORKSPACE_ROLES` is fixed by Amendment A-1. `TENANT_ROLES` is fixed by Amendment A-8,
which superseded A-1's tenant enum on 2026-08-04. Neither may be changed without a
refinement amendment. Rank values are internal; only their ordering is contractual.
