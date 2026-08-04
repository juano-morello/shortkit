# Contract: roles, ranking, and the authorization surface

- **Boundary:** every authenticated write and every workspace-scoped read.
- **Normative form:** `apps/api/src/common/authorization/roles.ts` (stub: `design/stubs/apps/api/src/common/authorization/roles.ts`).
- **Produced by:** TASK-016 (roles, `roleRank`), TASK-017 (guard, decorators, authorizer).
- **Consumed by:** TASK-014, 018, 021, 025, 040, 045, 049, 051, 053, 054, 056.
- **ADRs:** ADR-0015. Role set fixed by Amendment A-1.

## Roles

```ts
export const TENANT_ROLES = ['owner', 'admin'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const WORKSPACE_ROLES = ['workspace_admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> =
  { workspace_admin: 30, member: 20, viewer: 10 };
export const TENANT_ROLE_RANK: Record<TenantRole, number> = { owner: 20, admin: 10 };

export function roleRank(role: WorkspaceRole): number;
export function tenantRoleRank(role: TenantRole): number;
```

Rank is data, in one table, as TASK-016 requires. No conditional anywhere else compares
role names.

`viewer` is rank 10 and is denied every write, enforced once in `WorkspaceAuthorizer`.
**Nothing in `launch-core` grants `viewer` outside test fixtures**, no UI offers it, and
TASK-021's API accepts it while TASK-022's picker does not.

Storage: `TenantRole` lives in `tenant_memberships` (TASK-013, ADR-0015);
`WorkspaceRole` lives in `memberships` (TASK-016).

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
| `PATCH /api/members/:id/role`, `DELETE /api/members/:id` | `workspace_admin` |
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

## Invariants a caller may rely on

1. A tenant must always retain at least one `owner`. Removing or demoting the last one
   is 409 `last_owner_protected`, checked **inside the same transaction as the change**
   (AC-31).
2. `viewer` never succeeds at a write, on any surface, without any per-endpoint code
   (AC-104).
3. Tenant `admin` never reaches export or deletion (AC-105).
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

`TENANT_ROLES` and `WORKSPACE_ROLES` are fixed by Amendment A-1 and may not be changed
without a refinement amendment. Rank values are internal; only their ordering is
contractual.
