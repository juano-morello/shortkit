---
id: ADR-0023
slug: launch-core
title: Role types are nominally branded, so no bare literal is assignable to either
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

Amendment A-8 put `member` in both role enums: `TenantRole = owner | admin | member` and
`WorkspaceRole = workspace_admin | member | viewer`. I recorded the collision as an
accepted cost of the ruling and mitigated it with three process rules: distinct routes
and guards, request bodies naming `tenantRole` or `workspaceRole` rather than a bare
`role`, and separate rank functions that throw on an unknown key.

The security re-review found the residual hole those rules do not close, and it is
narrower and worse than I described. The type system already does most of the work: a
variable typed `TenantRole` is not assignable to `WorkspaceRole`, because `owner` and
`admin` are not members of it, so confusing `ctx.tenantRole` with `ctx.workspaceRole` was
already a compile error. **Only the bare literal slips through.**

The path it slips through is Form B, the imperative authorization used by every
resource route. A handler that means

```ts
await authorizer.assert(resource.workspaceId, 'member');
```

and instead writes

```ts
await authorizer.assertTenant('member');
```

compiles, and passes for every authenticated user in the tenant. A tenant member with
access to one client workspace can then write in another. Two adjacent lines, one word
different, no compiler complaint, and the wrong one silently authorises everybody.

Juano ruled on the stronger fix rather than on keeping the process rules.

## Decision

**Brand both role types nominally.**

```ts
declare const roleBrand: unique symbol;

type Branded<TValue extends string, TBrand extends string> = TValue & {
  readonly [roleBrand]: TBrand;
};

export type TenantRoleValue    = 'owner' | 'admin' | 'member';
export type WorkspaceRoleValue = 'workspace_admin' | 'member' | 'viewer';

export type TenantRole    = Branded<TenantRoleValue, 'tenant'>;
export type WorkspaceRole = Branded<WorkspaceRoleValue, 'workspace'>;
```

The brand is a required property, so `'member'` is assignable to neither. The brands
differ, so neither type is assignable to the other.

**Pre-branded constants carry the ergonomic load.** Call sites write
`TENANT_ROLE.owner` and `WORKSPACE_ROLE.member`, never a bare string and never a cast.

**Two sanctioned casts, and only two.** `asTenantRole(value)` and
`asWorkspaceRole(value)` validate membership then brand. They exist for the two
boundaries where a role arrives as a plain string: a Drizzle row and a zod parse.
An `as TenantRole` anywhere else is a defect, and the isolation suite greps for it.

**Belt and braces on the minimum.** `AuthorisingTenantRole = Branded<'owner' | 'admin',
'tenant'>` is the parameter type for `assertTenant` and `@RequireTenantRole`.
`workspace-authorization.md` already said no tenant check in `launch-core` has a
minimum below `admin`; this makes passing `TENANT_ROLE.member` as a minimum a compile
error rather than a rule someone has to remember. It is an addition to the ruling, not
a substitute for it: on its own it would leave every other bare-literal confusion open.

**Storage and wire formats are unbranded.** Drizzle columns are `TenantRoleValue` and
`WorkspaceRoleValue`; zod contracts are `z.enum(TENANT_ROLES)`. Branding happens on the
way in, at the repository and at the parse. Nothing about the database or the JSON
changes.

**Now, not after Implement.** These are stubs and prose today. The same change after
implementation touches every guard, every repository, every contract and every test.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Keep the three process rules from A-8 | Zero type ceremony; already written | They are rules, and the Form B confusion is two adjacent lines with one word different. Rules do not fail a build. The re-review found the hole precisely because the rules were already in place | Juano's ruling, 2026-08-04. A rule that authorises everyone when broken needs a mechanism, not a convention |
| Rename one enum's value, for example `WorkspaceRole.member` to `contributor` | No branding, no casts; the collision disappears | `WORKSPACE_ROLES` is frozen by Amendment A-1 and appears in AC-28, AC-104 and the invitation contract. Renaming needs a refinement amendment and reopens the Refine gate for a naming change | Costs an approved-artifact amendment, and it fixes only this collision rather than the class |
| Type `assertTenant(min: Exclude<TenantRole, 'member'>)` alone | One line; closes the exact reported path | Closes that call and nothing else. `assertTenant(ctx.workspaceRole)` and any future bare-literal confusion stay open, and it reads as a special case with no stated principle | Adopted **as well**, not instead. It is the belt to branding's braces |
| Runtime validation: `assertTenant` throws if the value is not in `TENANT_ROLES` | Catches it at test time; no type ceremony | `'member'` is in `TENANT_ROLES`, so the reported failure passes validation. It is a valid tenant role being used as the wrong kind of check | Does not detect the actual bug |

## Consequences

### Positive

- The reported escalation is a compile error. So is every other bare-literal confusion
  between the two enums, which is the class rather than the instance.
- Passing `member` as a tenant minimum is a compile error independently of the brand.
- The cast sites are two named functions, so a reviewer looking for where an unvalidated
  string becomes a role has two places to look.
- Nothing about the stored data or the API payloads changes, so there is no migration
  and no contract version bump.

### Negative / accepted cost

- Every literal role in every call site, fixture and test becomes `TENANT_ROLE.owner`
  rather than `'owner'`. That is a real readability tax paid on hundreds of lines,
  most heavily in test fixtures where roles appear most often.
- `Record<TenantRole, number>` no longer works, because a branded type is not a valid
  index signature source. The rank tables are keyed by the unbranded value types, so
  there are now two names for each role concept and a reader has to know which is which.
- Branded types leak into error messages. A mismatch reports
  `Branded<"owner" | "admin", "tenant">` rather than something a person wants to read,
  and the first developer to meet it will lose time.
- `asTenantRole` and `asWorkspaceRole` are unchecked casts internally. They are only as
  good as their validation, and nothing outside code review stops someone adding a third
  cast site.
- This is type-level only. It does nothing at a JSON boundary, so a role arriving in a
  request body is still just a string until it is parsed.

### Follow-ups this creates

- TASK-016 defines the branded types, the constants, both cast functions, and the rank
  tables keyed by the value types.
- TASK-017 types `assertTenant` and `@RequireTenantRole` with `AuthorisingTenantRole`.
- Every TASK consuming a role imports the constants rather than writing a literal.
- TASK-056 greps for `as TenantRole` and `as WorkspaceRole` outside the two sanctioned
  functions and fails on a third.
- `workspace-authorization.md` replaces the three process rules with this mechanism, and
  keeps the request-body naming rule because it is about the wire format rather than
  about types.
