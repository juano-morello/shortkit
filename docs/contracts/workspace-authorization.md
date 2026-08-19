# Contract: roles, ranking, and the authorization surface

- **Boundary:** every authenticated write and every workspace-scoped read.
- **Normative form:** `packages/contracts/src/roles.ts` (role values, brands, ranks) and `apps/api/src/common/authorization/roles.ts` (enforcement). The first file exists and its design stub was retired 2026-08-11 under ADR-0039, TASK-007 having closed. ~~The second is not yet written; the design stub at `design/stubs/apps/api/src/common/authorization/roles.ts` stands in until TASK-017 lands it and is retired then.~~ **Amended 2026-08-18 (TASK-1b-05, item 1b).** The enforcement half is shipped, and it is three files under `apps/api/src/common/authorization/`: `roles.ts` (`RequireWorkspaceRole`, `RequireTenantRole`, the two metadata keys), `workspace-authorizer.ts` (`WorkspaceAuthorizer`, Form B and Form C, and the two rank functions both forms share), and `workspace-authorization.interceptor.ts` (Form A — an **interceptor**, not a guard; see "The two enforcement forms"). Beside them: `errors.ts` (the four `DomainError` refusals), `actor-context.ts` (how Form B learns the caller), `authorization.module.ts`. The repositories they read are `apps/api/src/memberships/{membership,tenant-membership}.repository.ts`.
- **Producer attribution in `packages/contracts/src/roles.ts` is stale and this line is the correction.** The shipped file's header reads `Produced by: TASK-016`, the spelling F-068 corrected on 2026-08-05. TASK-016 cannot write that file: its paths are `apps/api/src/db/schema/**` and `apps/api/drizzle/**`. The producer is TASK-007. Recorded 2026-08-11 when the stub carrying the correction was retired.
- **Produced by:** TASK-007 (role values, branded types, constants, casts, rank tables), ~~TASK-017 (guard, decorators, authorizer)~~ **TASK-1b-05 (the interceptor, decorators, authorizer, `MembershipRepository`, `TenantMembershipRepository`; 2026-08-18)**. TASK-016 consumes both and defines no role type of its own; corrected 2026-08-05 (F-068).
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
export declare function RequireWorkspaceRole(min: WorkspaceRole): MethodDecorator & ClassDecorator;
export declare function RequireTenantRole(min: AuthorisingTenantRole): MethodDecorator & ClassDecorator;
```

`WorkspaceGuard` resolves the workspace id from `params.workspaceId`, then
`body.workspaceId`, then `query.workspaceId`, in that order. None present is 400
`workspace_id_required`.

> **Amended 2026-08-18 (TASK-1b-05, D-05): Form A is an INTERCEPTOR registered after
> `TenantTransactionInterceptor`, and the name `WorkspaceGuard` above is a name, not a
> mechanism.** Nest runs every guard before any interceptor, so a `CanActivate` cannot run
> inside the transaction the tenant interceptor opens — and "its membership lookup is under
> RLS", "with no active context it throws" are the load-bearing properties in this contract;
> the noun is not. The shipped enforcement point is `WorkspaceAuthorizationInterceptor`, the
> **third** `APP_INTERCEPTOR` in `app.module.ts` (RequestLog → TenantTransaction →
> WorkspaceAuthorization; the order is a ruling and `app.module.spec.ts` asserts it). The
> tenant interceptor calls `next.handle()` inside `withTenantTransaction`, so the third
> interceptor's `intercept()` runs under the ambient store: it reads the two metadata keys
> (handler first, then class — a class-level decorator covers every handler), resolves the
> workspace id in the order above (a value that is not a non-empty string counts as absent),
> looks the caller up through `MembershipRepository.roleFor` / `TenantMembershipRepository.roleFor`
> — both `tenantDb()`-only, so with no active transaction they throw
> `TenantContextMissingError` before any statement (500, never a pass) — sets
> `RequestContext.workspaceId` / `workspaceRole` / `tenantRole`, applies the status table
> below with every 404 decided before any 403, and hands over to the handler. A route carrying
> neither key is untouched. Everywhere else in this document, read `WorkspaceGuard` as this
> interceptor. Consequence recorded under Form C: **Form A cannot be used on a
> `@NoTenantTransaction` route** (or a `@Public()` one) — the interceptor throws
> `AuthorizationMisconfiguredError` (500) at the first request to such a route.
>
> **The tenant role is read from `tenant_memberships` inside the same transaction**, under
> `tenant_memberships_tenant_isolation` (the ordinary template policy admits the current
> tenant's rows). This is not `withMembershipLookup` (`tenant-membership-lookup.md`), which
> stays the token-mint path with one caller; the JWT carries no role claim (invariant 6), so
> a request-time read is the only source.

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

> **Amended 2026-08-18 (TASK-1b-05).** The signature takes no caller, so `WorkspaceAuthorizer`
> reads the caller from an ambient store (`actor-context.ts`, `currentActor()`) that
> `WorkspaceAuthorizationInterceptor` establishes around `next.handle()` for every
> authenticated route — decorated or not — from the `RequestContext` the guard wrote. A Form B
> call outside a request (a Better Auth hook, a boot script) throws
> `ActorContextMissingError` (500); it never answers for nobody. `assert` and `assertTenant`
> throw exactly what Form A throws — the same four classes in `errors.ts`, through the same
> `requireWorkspaceRank` / `requireTenantRank` — and set nothing on the `RequestContext`.

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

> **Amended 2026-08-18 (TASK-1b-05).** Two rows the table above implied and now states. (a)
> The 404 for "no membership" / "another tenant" / "not a uuid" carries **the same body as
> `WorkspaceRepository`'s `WorkspaceNotFoundError`** (`WorkspaceAccessNotFoundError`,
> `not_found`, `Workspace not found.`); a spec asserts the two envelopes are byte-equal, so
> the shape of the 404 cannot say which of the two happened. (b) A `RequireTenantRole` /
> `assertTenant` check for a caller with **no `tenant_memberships` row in the tenant** is
> **404 `not_found`** (`TenantMembershipNotFoundError`), not 403 — error-envelope.md
> invariant 6 reserves the two `insufficient_*` codes for a member whose role is too low.
> Reachable only inside a token's 300 s life after the row is removed (the mint refuses
> without one). On a route carrying both decorators every absence is decided before any rank.

## Minimum role per surface

Normative. A TASK adding a route adds a row here in the same commit.

| Surface | Requirement |
|---|---|
| `GET /api/workspaces` | ~~any workspace membership~~ **membership-filtered list, no decorator** (D-10; the statement joins `memberships` on the caller, owner-qualified; TASK-1b-06) |
| `GET /api/workspaces/:workspaceId` | any workspace membership (Form A, `viewer`; TASK-1b-06 — the param is `:workspaceId`, D-07) |
| `POST /api/workspaces` | tenant `admin` (Form A `RequireTenantRole`); creates the workspace **and** the creator's `workspace_admin` membership in one transaction (D-10; TASK-1b-06) |
| `PATCH /api/workspaces/:workspaceId`, `POST /api/workspaces/:workspaceId/archive` | `workspace_admin` (Form A; TASK-1b-06). There is no `DELETE`; archive is the retirement path (`workspaces.md`) |
| `GET /api/members` | `member` — **not built in 1b** |
| `PATCH /api/members/:id/workspace-role` | `workspace_admin` — **not built in 1b** |
| `DELETE /api/members/:id/workspace/:workspaceId` (remove from one workspace) | `workspace_admin` — **not built in 1b** |
| **`GET /api/tenant/members`** (tenant roles) | tenant **`owner`** — **not built in 1b** |
| **`PATCH /api/tenant/members/:id/tenant-role`** | tenant **`owner`** — **not built in 1b** |
| **`DELETE /api/tenant/members/:id`** (remove from the tenant entirely) | tenant **`owner`** — **not built in 1b** |
| `POST /api/invitations` | `workspace_admin` on **every** named workspace — Form B, before any write; a workspace the caller is not admin of, another tenant's, or a non-uuid → 404 (D-09; TASK-1b-08) |
| `GET /api/invitations?workspaceId=<uuid>` | `workspace_admin` — Form A on `query.workspaceId` (**new row, 2026-08-18**; D-09; TASK-1b-08) |
| `DELETE /api/invitations/:id` | `workspace_admin` on every workspace the invitation names — Form B (D-09; TASK-1b-08) |
| `POST /api/invitations/lookup` | `@Public()`; the token travels in the body (D-03) |
| `POST /api/invitations/accept` | authenticated, **no role decorator** — the token authorises; a token for another tenant is 409 `invitation_tenant_conflict` (D-04) |
| ~~`GET /api/invitations/:token`, `POST /api/invitations/:token/accept`~~ | ~~`@Public()`~~ — superseded 2026-08-18 by the two rows above (D-03, D-04): the raw token never travels in a URL path |
| ~~`GET /api/links`, `GET /api/links/:id`~~ | ~~`viewer`~~. Superseded 2026-08-19 by the five rows below (TASK-2-05, D-2-12) |
| ~~`POST`/`PATCH`/`DELETE /api/links`~~ | ~~`member`~~. Superseded, same |
| **`POST /api/links`** | `member`, **Form A on `body.workspaceId`** (TASK-2-05). 201 `linkContract`. An ARCHIVED workspace is 400 `validation_failed` under `workspaceId`; a supplied slug's violation is 400 under `slug`; a taken one is 409 `slug_taken` |
| **`GET /api/links?workspaceId=<uuid>&limit=&cursor=`** | `viewer`, **Form A on `query.workspaceId`** (TASK-2-05). 200 `paginated(linkContract)`, newest first, keyset `(created_at DESC, id DESC)`, `paginationQueryContract` bounds. A cursor this endpoint did not issue is 400 under `cursor` |
| **`GET /api/links/:linkId`** | `viewer`, **Form B in the service** (TASK-2-05). 200 `linkContract` |
| **`PATCH /api/links/:linkId`** | `member`, **Form B**. 200 `linkContract`; an empty patch is valid and still fires `onLinkMutated` |
| **`DELETE /api/links/:linkId`** | `member`, **Form B**. 200 `linkContract` carrying the row it removed (hard delete; the link's `click_events` cascade). Not 204: `packages/contracts/src/links/link.ts`'s route table, `DELETE /api/invitations/:id`'s precedent and TASK-2-13's response narrowing all name a body |
| `GET /api/links/:id/audit` | `member`, **not built in item 2** (item 4's) |

> **Why the three by-id rows are Form B and carry no decorator (2026-08-19, TASK-2-05).**
> Form A resolves the workspace id from `params.workspaceId`, then `body.workspaceId`, then
> `query.workspaceId`. A link route carries the LINK's id and the workspace nowhere, so
> `@RequireWorkspaceRole` there resolves nothing and answers 400 `workspace_id_required` on
> every request. This contract already names the case as Form B's ("resource routes such as
> `/api/links/:id`, where the workspace is a property of the resource"), and the shipped
> handlers do exactly what it prescribes: load through `LinkRepository`, which answers
> `null` for another tenant's id, an id nobody issued and a non-uuid alike (404 before any
> role is read, AC-2-6), then `authorizer.assert(link.workspaceId, min)`.
| `GET /api/domains` | `viewer` |
| `POST`/`DELETE /api/domains`, `POST /api/domains/:id/verify`, `.../retry-certificate` | `workspace_admin` |
| `GET /api/workspaces/:id/branding` | `viewer` |
| `PATCH /api/workspaces/:id/branding` | `workspace_admin` |
| `POST /api/gdpr/export` | tenant **`owner`** (AC-105), Form A |
| `POST /api/gdpr/delete` | tenant **`owner`** plus confirmation (AC-105, AC-92, AC-106). **Form C**, checked in-handler: see below |
| ~~`GET /api/invitations/:token`, `POST /api/invitations/:token/accept`~~ `POST /api/invitations/lookup` | `@Public()`; authorisation **is** the capability token (ADR-0021). Path form superseded 2026-08-18 (D-03) |

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
(`tenant-context.md`) so it can run its three-phase erasure, which means ~~**there is no
ambient tenant context when guards run**~~ **Form A cannot be used on it** (amended
2026-08-18, TASK-1b-05: there is never an ambient tenant context when guards run, on any
route — that is why Form A is an interceptor; what a `@NoTenantTransaction` route lacks is
the transaction the interceptor would run inside, because the handler is where it now
begins). `WorkspaceGuard`'s membership lookup needs one.

Left unstated, an implementer meets a guard that throws on the only irreversible route in
the system, and the cheapest green fix is to make `WorkspaceGuard` tolerate a missing
context. That removes the owner check from tenant erasure and lets any tenant `member`
destroy the whole tenant.

Normative:

- **A `@NoTenantTransaction` route may not carry `@RequireTenantRole` or
  `@RequireWorkspaceRole`.** TASK-056 asserts that combination never exists. ~~The
  decorators are guards, guards run before the handler, and the handler is where the
  transaction now begins.~~ The decorators are read by an interceptor that runs before the
  handler, and the handler is where the transaction now begins; until TASK-056's static
  assertion exists, the interceptor throws `AuthorizationMisconfiguredError` (500) at the
  first request to such a route (2026-08-18).
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

- `WorkspaceGuard` — `WorkspaceAuthorizationInterceptor` since 2026-08-18 — runs after
  `AuthGuard` and inside the tenant transaction, so its membership lookup is itself under
  RLS. **With no active context it throws. It never returns true.** Asserted in
  `apps/api/src/common/authorization/workspace-authorization.interceptor.spec.ts` (fake
  transaction, fake repositories that still call `tenantDb()`) and
  `apps/api/test/authorization/workspace-authorization.int-spec.ts` (live database; an
  application whose chain lacks the tenant interceptor answers 500 with the repository
  having thrown before any statement).
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
