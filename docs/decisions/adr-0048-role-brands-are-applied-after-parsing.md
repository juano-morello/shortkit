---
id: ADR-0048
slug: identity-membership
title: Role brands are applied after parsing, so no contract's inferred type carries one
status: accepted
supersedes: null
amends: null
date: 2026-08-12
---

## Context

TASK-001 must declare `tenantMembershipContract` with a `role` field and must implement
`asTenantRole`, which has thrown `not implemented` since `roles.ts` shipped. Its card says
`role` "is a `TenantRole` and is constructed through `asTenantRole`", and also that
`type TenantMembership = z.infer<typeof tenantMembershipContract>`.

Those two sentences cannot both hold without putting a brand in an inferred contract type,
and `roles.ts:150-156` forbids exactly that:

> UNBRANDED, deliberately. This feeds `z.enum()` in the invitation contract, and a branded
> member type would carry the brand into the inferred contract type — a brand at a JSON
> boundary, which ADR-0023 forbids. A brand is a compile-time claim about where a value has
> been validated; a value arriving in a request body has been nowhere.
>
> RULE: every zod enum sources from an unbranded array — `TENANT_ROLES`,
> `WORKSPACE_ROLES`, or this one. Branding happens after parsing, via `asTenantRole` /
> `asWorkspaceRole`.

The rule already names the resolution — "branding happens after parsing" — and no artifact
says what the after-parsing step looks like or who owns it. `asTenantRole` has no caller
today, which is why it could stay a stub through a whole initiative.

This is the first membership shape in the system, so whatever `members/` does is what
`workspaces/` copies in wave 7 and what invitations copy in item 1b.

## Decision

**A contract's inferred type never carries a brand. Branding is a separate, exported,
named step that runs on the parsed value.**

`packages/contracts/src/members/` exports both halves:

```ts
/** The wire shape. `role` is a plain union; nothing here has been validated as a role. */
export const tenantMembershipContract = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  userId: z.string().min(1),
  role: z.enum(TENANT_ROLES),
  createdAt: z.iso.datetime(),
});

/** What `z.infer` gives: `role` is `TenantRoleValue`, unbranded. */
export type TenantMembershipWire = z.infer<typeof tenantMembershipContract>;

/** The domain shape. Declared, not inferred, because its `role` is branded. */
export interface TenantMembership {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantRole;
  readonly createdAt: string;
}

/** Parses, then brands. The one sanctioned way to obtain a `TenantMembership`. */
export function parseTenantMembership(value: unknown): TenantMembership;
```

`parseTenantMembership` is where `asTenantRole` is called, which gives that function its
first caller and its first test.

`asTenantRole` itself validates membership in `TENANT_ROLES` before branding and throws on
anything else, so the brand keeps meaning "this value was checked", and the check is not
merely the zod parse that happened one line earlier.

**`asWorkspaceRole` and `roleRank` stay throwing.** Workspace membership is out of scope
(refinement, Scope/Out), and implementing them would ship two functions with no caller. Only
`asTenantRole` and `tenantRoleRank` are implemented, which is what TASK-001's card already
says.

**The same split applies to every later contract with a role.** `workspaces/` in wave 7 and
invitations in item 1b declare a wire contract with `z.enum(...)`, a declared domain
interface, and a `parseX` that brands. Any contract that infers a branded type is a defect.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| `role: z.enum(TENANT_ROLES).transform(asTenantRole)` inside the contract, and let `z.infer` carry the brand | One declaration, one type, one name. Callers get a branded role from `parse()` with nothing extra to remember | The inferred type is branded, which is the thing `roles.ts:150-156` names and refuses. It also breaks the schema for its other job: a schema with an output transform is no longer usable to validate a value the client is about to send, because the input and output types differ, and `apps/web` builds request bodies against these types. And it makes the brand a claim zod makes rather than one `asTenantRole` makes, so the "only sanctioned casts" comment at `roles.ts:75-85` stops being true | Contradicts an accepted ADR's stated rule, in the file that states it |
| Leave `role` unbranded everywhere and delete the brands | Simplest possible. No second type, no parse function | Throws away ADR-0023, whose whole purpose was to make `assertTenant('member')` a compile error after a Form B escalation got through review. It also leaves `asTenantRole` and `tenantRoleRank` stubbed for a second initiative, so `meetsTenantRole` — which every tenant-role check will call — still throws | Reverses an accepted ADR to save one function |
| Brand at the consumer: no `parseTenantMembership`, each caller writes `asTenantRole(row.role)` | Nothing new in the contracts package | Puts the branding step at every call site, which is where ADR-0023 says a mistake gets made. It also gives `asTenantRole` a caller in `apps/api` and none in `packages/contracts`, so the function that defines the boundary lives on one side of it | The point of a single sanctioned cast is that it has few call sites, not many |

## Consequences

### Positive

- `roles.ts:150-156`'s rule holds without reinterpretation, and the pattern it prescribes now
  exists in code rather than only in a comment.
- `asTenantRole` and `tenantRoleRank` get callers and unit tests, so two of the four stubbed
  functions in `roles.ts` retire.
- Request bodies and response bodies are described by schemas whose input and output types
  are identical, so `apps/web` can build a body from the same type it parses one into.
- The wire type and the domain type are separately nameable, which is what wave 7 and item 1b
  will need when a workspace carries both a role and an archive state.

### Negative / accepted cost

- **Two types per shape instead of one**, and a naming convention (`TenantMembership` versus
  `TenantMembershipWire`) that every later contract has to follow or the package becomes
  inconsistent. Nothing enforces it.
- **This contradicts TASK-001's card**, which says
  `type TenantMembership = z.infer<typeof tenantMembershipContract>`. The card's line is the
  one being changed, and the change is recorded here rather than made silently in the card.
- A caller who uses `tenantMembershipContract.parse()` directly gets an unbranded role and no
  warning. `parseTenantMembership` is a convention, not a mechanism; the schema is still
  exported because the web client needs it for response validation.
- `TenantMembership` is hand-declared, so a field added to the schema and not to the
  interface compiles until something tries to read it. A `satisfies` check between the two
  is possible for the unbranded fields and is not required here, because the shape is five
  fields fixed by ADR-0015.

### Follow-ups this creates

- TASK-001 implements `asTenantRole` and `tenantRoleRank`, exports `parseTenantMembership`,
  and unit-tests that `asTenantRole('nonsense')` throws.
- TASK-012 (wave 7) follows the same split for `workspaces/`.
- Item 1b follows it for invitations and for `memberships`.
