---
id: ADR-0045
slug: identity-membership
title: Token-mint tenant resolution reads one membership row through a third context flag
status: accepted
supersedes: null
amends: ADR-0002, ADR-0020
date: 2026-08-12
---

## Context

`definePayload` must put `tid` in every token (ADR-0013, GC-D). `tid` comes from
`tenantIdForUser(user.id)`, a single-row lookup on `tenant_memberships`'
`UNIQUE (user_id)` index (ADR-0015). It runs at token-mint time, when no tenant is known —
that is the whole reason the claim exists.

`tenant_memberships` is a tenant-scoped table. GC-A and GC-E fix that: it carries
`tenant_id` and it gets `tenantScopedPolicies('tenant_memberships')` hand-appended to its
migration. Its isolation policy reads
`tenant_id = current_setting('app.tenant_id', true)::uuid`.

So the obvious implementation returns nothing. `databaseTransaction` sets no flag,
`current_setting` returns NULL with the second argument true, `tenant_id = NULL` is NULL,
zero rows. `withTenantTransaction` is not available either: it needs the tenant id this
function exists to produce. The lookup is fail-closed against itself.

Three artifacts already priced the escape hatch:

- `design/contracts/tenant-context.md`, "Admitting a fifth": a fifth consumer of
  `databaseTransaction` "qualifies only if it is one of the two `ISOLATION_EXCLUSIONS`, or
  if it reads `pg_catalog` and `information_schema` only and runs before the process serves
  traffic. **Anything else needs an ADR superseding ADR-0002.**"
- `design/contracts/isolation-coverage.md`, "Exclusions: exactly two": "A third exclusion
  fails the length assertion. Raising the number is a one-line diff a reviewer sees, and
  ADR-0020 requires a written justification with it."
- `apps/api/src/db/rls.ts:72,87`: "Exclusion 1 of exactly 2", "Exclusion 2 of exactly 2".

This is that ADR and that justification.

## Decision

**A third context flag, `app.membership_lookup_user`, and a `FOR SELECT` policy on
`tenant_memberships` that admits exactly one user's row.**

### The policy

Built in `apps/api/src/db/rls.ts`, which is the only file besides a flag's setter that may
contain a flag string (isolation-coverage.md clause A2), and which sets nothing (clause A3):

```ts
/**
 * The token-mint lookup escape. Applied to `tenant_memberships` ONLY.
 * FOR SELECT only. Set only by withMembershipLookup, which additionally issues
 * SET TRANSACTION READ ONLY.
 *
 * Exclusion 3 of exactly 3 (ADR-0045).
 */
export function membershipLookupPolicy(): PolicySet {
  return {
    table: 'tenant_memberships',
    statements: [
      `CREATE POLICY tenant_memberships_membership_lookup ON tenant_memberships\n` +
        `  FOR SELECT\n` +
        `  USING (user_id = current_setting('app.membership_lookup_user', true));`,
    ],
  };
}
```

The table name is a literal rather than a parameter. This policy applies to one table by
design and a parameter would invite a second.

`user_id` is `text` and `current_setting` returns `text`, so no cast appears. With the flag
unset `current_setting` returns NULL, `user_id = NULL` is NULL, and the policy admits
nothing: an ordinary tenant transaction is unaffected, because PostgreSQL ORs permissive
policies and this one contributes no rows.

### The setter

`apps/api/src/auth/membership-lookup.ts`, a new file, following the shape of the two
existing escapes — each lives in its own feature directory, not in `tenancy/`.

```ts
export type MembershipLookupDb = PgTransaction<any, typeof schema, any> & {
  readonly [membershipLookupBrand]: true;
};

export async function withMembershipLookup<T>(
  userId: string,
  fn: (db: MembershipLookupDb) => Promise<T>,
): Promise<T>;
```

SQL issued, in this order:

```
BEGIN;
SET TRANSACTION READ ONLY;
SELECT set_config('statement_timeout',                   '5000', true);
SELECT set_config('idle_in_transaction_session_timeout',  '5000', true);
SELECT set_config('app.membership_lookup_user',          $1,     true);
```

`SET TRANSACTION READ ONLY` is not redundant with the `FOR SELECT` policy. The handle also
reaches the five RLS-exempt Better Auth tables (ADR-0044), where a write would be
unconstrained; read-only closes the transaction rather than one table.

`MembershipLookupDb` carries its own brand, so it is not assignable to `TenantDb` and a
repository written against tenant context cannot be handed one by mistake.

`withMembershipLookup` never sets `app.tenant_id` and never enters `tenantStorage`, so
`tenantDb()` and `currentTenantId()` keep throwing inside `fn`. It is the fifth sanctioned
consumer of `databaseTransaction`.

`userId` is asserted non-empty and at most 255 characters before it reaches `set_config`.
The value is bound as `$1`, so this is a shape check and not an injection defence.

### The caller

`apps/api/src/auth/tenant-id-for-user.ts`:

```ts
export async function tenantIdForUser(userId: string): Promise<string>;
export class NoTenantMembershipError extends Error;
```

It resolves to the lower-cased uuid on that user's single membership row, and throws
`NoTenantMembershipError` when there is no row — never `null`, never `''`. It contains no
flag string and does not import `databaseTransaction`; `withMembershipLookup` is its only
database reach.

**`NoTenantMembershipError.message` carries an eight-character prefix of the user id and its
length, never the whole id.** The full value is on a readable `userId` property for the
mint path. This is F-132's rule and it is load-bearing here for a different reason:
`serializers.err` reduces a logged error to `err_name` and `err_stack`, and `Error.stack`
begins with the message, so anything interpolated into the message reaches the log line
whatever `LOGGABLE_FIELDS` says. Whether a user identifier joins that allowlist is a
separate decision this initiative has not made.

### The exclusion

`ISOLATION_EXCLUSIONS` in `apps/api/test/isolation/coverage.ts` gains a third entry, and the
AC-12 assertion in `cross-tenant-isolation.int-spec.ts` moves from `toHaveLength(2)` to
`toHaveLength(3)` with the id added to its `toEqual` list:

```ts
{
  id: 'repo:TenantMembershipLookup.tenantIdForUser' as SurfaceId,
  justification:
    'Token minting runs before a tenant is known: the claim this reads produces is what a tenant context is later opened from. Narrowed by ADR-0045 to a FOR SELECT policy admitting one user_id, inside a READ ONLY transaction, in one file. Reachable only from definePayload.',
}
```

**TASK-002 makes both edits, in wave 1, in the same commit as the policy.** Landing the
escape in wave 1 and its exclusion entry in wave 9 would leave eight waves in which the
suite is green and an unlisted escape exists, which is the failure mode the length assertion
was built to prevent.

### What keeps it narrow

Four controls, three of which already exist:

1. **Clause A1** — `app.membership_lookup_user` is set in exactly one file in the scan set,
   `apps/api/src/auth/membership-lookup.ts`.
2. **Clause A2** — the string appears in exactly that file and `rls.ts`.
3. **The `databaseTransaction` file list** in `tenant-context.md` grows from four paths to
   five, and TASK-056's grep asserts set equality.
4. **New: `withMembershipLookup` is imported by exactly one file**,
   `apps/api/src/auth/tenant-id-for-user.ts`, and `tenantIdForUser` by exactly one,
   `apps/api/src/auth/auth.config.ts`. File-level and by grep, like control 3 and for the
   same reason. This is what stops a request-path caller reaching the escape; there is no
   runtime guard.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Denormalise the tenant id onto Better Auth's `user` table via `user.additionalFields`, written by `onUserCreated`, read by `definePayload` from the `user` object | **No database read at mint time at all**, no third flag, no third exclusion, exclusion count stays at two. Cheapest by a wide margin | The column would be named `tenantId`. `check-policies.mts`'s cross-check reads `pg_attribute` for a column named literally `tenant_id`, so `user` keeps its exemption while carrying tenant data — the guardrail is defeated by camelCase. Naming it `tenant_id` instead makes the cross-check refuse the exemption and demand RLS on `user`, and Better Auth's login-by-email lookup runs with no tenant context, so sign-in returns zero rows for everyone. It also creates a second source of truth for a fact `UNIQUE (user_id)` was chosen to make structural, with no constraint keeping the two equal | Honest naming breaks authentication; dishonest naming defeats the check. ADR-0015 rejected the same shape for the RLS half of this reason and the naming half is worse |
| A separate lookup table `user_tenant_index(user_id text PRIMARY KEY, tenant_id uuid)`, unscoped | Keeps `tenant_memberships` purely tenant-scoped | It carries a `tenant_id` column, so `check-policies.mts` refuses to exempt it and demands the standard policy set, which puts it back behind `app.tenant_id`. Exempting it needs the same camelCase evasion as above. And it duplicates the row `tenant_memberships` already holds, without the unique constraint that makes the cardinality structural | Same dead end, plus a second copy of the data |
| A `SECURITY DEFINER` function owned by `shortkit_migrator` returning the tenant id | No new flag, no new policy, no application-side escape | `FORCE ROW LEVEL SECURITY` applies policies to the table owner too, so a definer function running as the owner is still filtered — it works only if its owner holds `BYPASSRLS`, which `assertRuntimeRoleCannotBypassRls` exists to forbid. Worse, an escape expressed as a function body is invisible to `check-policies.mts`, to the four grep clauses and to the `pg_policies` shape assertion | Moves the escape somewhere no control can enumerate it, and needs the one role attribute the boot check refuses |
| Make `tenant_memberships` a second cascade root with a bespoke policy set instead of `tenantScopedPolicies()` | One policy set instead of a template plus an addendum | Contradicts GC-A, GC-E and TASK-002's card, all of which fix `tenantScopedPolicies('tenant_memberships')`, and removes the standard isolation policy that in-tenant member reads will need in item 1b. It also does not avoid the second predicate: the mint-time read has no tenant whatever the policy set is called | Changes an approved shape without removing the problem |
| Read `tenant_memberships` through `databaseTransaction` and accept zero rows | No design at all | `tid` is never minted, no token works, the product does not function | Not an option; recorded because it is what the code does if nobody decides |

## Consequences

### Positive

- `tenantIdForUser` reads exactly one row, chosen by the caller's own authenticated user id,
  inside a read-only transaction, under a policy that cannot return a second row.
- The escape is enumerable by every mechanism the repository already has: a named policy in
  `pg_policies`, a named flag under clauses A1 to A4, a named file in the
  `databaseTransaction` list, and a named entry in `ISOLATION_EXCLUSIONS`.
- `tenant_memberships` keeps its standard isolation policy, so item 1b's member-list reads
  need no new policy work.
- The failure mode of an orphaned `user` row stays exactly what ADR-0015 specified: no
  membership row, no `tid`, no token.

### Negative / accepted cost

- **The exclusion count goes from two to three, and "exactly two" appears in five artifacts
  that all become wrong**: `rls.ts:72`, `rls.ts:87`, `coverage.ts:490-499`,
  `cross-tenant-isolation.int-spec.ts:1360-1368`, and `tenant-context.md`'s "Deliberate
  exclusions" table plus its "**`ISOLATION_EXCLUSIONS` stays at two**" sentence. Each is a
  deliberate edit in TASK-002's commit, and each is a place a future reader can find a stale
  count if one is missed.
- **ADR-0015 argued against the `user.tenant_id` alternative partly on the grounds that
  "SC-1's exclusion count is exactly two".** That argument no longer distinguishes. The
  alternative is still rejected, for the stronger reason in the table above, but an accepted
  ADR's stated reasoning is weakened by this decision and that is recorded rather than
  quietly outgrown.
- A third flag means a third thing a reviewer has to hold in mind when reading a policy, and
  clause A4's permitted-name list is now three `app.` flags rather than two escapes plus
  tenancy.
- **The narrowing control on the caller is a grep over file names, not a type or a runtime
  guard.** Any module can import `withMembershipLookup`; nothing throws if a controller
  does. The guarantee is that the import is a reviewed diff, and TASK-056 is what turns it
  into an assertion — until then it is a rule.
- The escape returns a tenant uuid for any user id the caller supplies. In the mint path the
  user id is the authenticated subject, so this is not a leak; if the file-level control
  ever fails, the leak is a routing identifier rather than tenant data. Stated so it is not
  discovered later.
- `withMembershipLookup` takes a pooled connection for the duration of a token mint, so
  token minting now competes with request handling for the ten connections `POOL_MAX`
  allows. A 5-minute token lifetime means roughly twelve mints an hour per active session
  (ADR-0014).
- The `pg_policies` shape assertion that would reject an unapproved policy is TASK-056's and
  does not exist. Until it does, nothing mechanically checks that
  `tenant_memberships_membership_lookup` is the policy this ADR describes rather than a
  wider one someone edited. `check-policies.mts` asserts `ENABLE` and `FORCE` and reads no
  policy body.

### Follow-ups this creates

- TASK-002 writes `membershipLookupPolicy()` in `rls.ts`, hand-appends its statement to
  migration `0001` beside `tenantScopedPolicies('tenant_memberships')`, writes
  `membership-lookup.ts` and `tenant-id-for-user.ts`, adds the fifth entry to `client.ts`'s
  docblock caller list, adds the third `ISOLATION_EXCLUSIONS` entry, and corrects the
  five "exactly two" sites.
- TASK-002 ships two integration controls in
  `apps/api/test/auth/tenant-memberships.int-spec.ts`: with the flag set to user A, a
  `select * from tenant_memberships` returns A's row and not B's; with no flag set, it
  returns zero rows.
- TASK-056 (deferred): clause A1's flag table gains a third row; the
  `databaseTransaction` file list gains a fifth path; control 4 above becomes an assertion.
- `design/contracts/tenant-context.md` is amended in this initiative — the fifth consumer,
  the third exclusion, and the four-versus-three caller-count note at `client.ts:21-22`
  that was already stale.
