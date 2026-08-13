# Contract: the token-mint membership lookup

- **Boundary:** `tenantIdForUser`, between the TASK that implements it (TASK-002) and the
  `definePayload` that calls it (TASK-003); and `withMembershipLookup`, between
  `tenant-id-for-user.ts` and the database.
- **Normative form:** the TypeScript signatures and the SQL below.
- **Produced by:** TASK-002.
- **Consumed by:** TASK-003 (`definePayload`), TASK-015 (isolation controls), TASK-054
  (deferred; `privilegedTenantEraser` reads `tenant_memberships.user_id`).
- **ADRs:** ADR-0045, ADR-0015, ADR-0013, ADR-0002, ADR-0003.

## Scope

One read: a user id in, that user's tenant id out. It exists because `tid` must be in the
token and no tenant context can be open before `tid` is known.

It is not a repository, it has no update path, and it is not reachable from a request
handler. It is the third and last exception to GC-5 (ADR-0045).

## The table

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

Fixed by ADR-0015 and GC-E. `tenant_id` is declared through `TENANT_ID_COLUMN_SQL`
(`apps/api/src/db/rls.ts:103-104`) and must match it character for character. `user_id` is
`text` because Better Auth's `user.id` is `text` (`auth-schema.md`); it is the only non-uuid
foreign key in the schema.

`tenant_role` is a Postgres enum carrying exactly `owner`, `admin`, `member`, sourced from
`TENANT_ROLES` in `packages/contracts/src/roles.ts`.

## The policies

Three, and all three land in migration `0001`, hand-appended in the same commit as the
`CREATE TABLE` (GC-A, F-239).

```
tenantScopedPolicies('tenant_memberships')   -- rls.ts:57-80, four statements plus the index
membershipLookupPolicy()                     -- rls.ts, one statement, ADR-0045
```

`membershipLookupPolicy()` emits exactly:

```sql
CREATE POLICY tenant_memberships_membership_lookup ON tenant_memberships
  FOR SELECT
  USING (user_id = current_setting('app.membership_lookup_user', true));
```

`FOR SELECT` and it stays `FOR SELECT`. `user_id` and `current_setting` are both `text`, so
there is no cast. With the flag unset `current_setting` returns NULL, `user_id = NULL` is
NULL, and the policy admits nothing, so an ordinary tenant transaction is unaffected.

## `withMembershipLookup`

`apps/api/src/auth/membership-lookup.ts`. The **fifth** sanctioned consumer of
`databaseTransaction`, and the only file in the scan set that may set
`app.membership_lookup_user` (isolation-coverage.md clause A1).

```ts
declare const membershipLookupBrand: unique symbol;

/** Not assignable to TenantDb. A repository cannot be handed one by mistake. */
export type MembershipLookupDb = PgTransaction<any, typeof schema, any> & {
  readonly [membershipLookupBrand]: true;
};

export class InvalidLookupUserIdError extends Error {
  readonly name = 'InvalidLookupUserIdError';
}

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
SELECT set_config('idle_in_transaction_session_timeout', '5000', true);
SELECT set_config('app.membership_lookup_user',          $1,     true);
```

Every flag name is an inline quoted literal and only the value is bound (clause A4, and the
rule at `tenant-context.ts:36-39`). No named constant for the flag name.

`SET TRANSACTION READ ONLY` is not redundant with the `FOR SELECT` policy: the handle also
reaches the five RLS-exempt Better Auth tables, where a write would be unconstrained.

`userId` is asserted non-empty and at most 255 characters before it reaches `set_config`,
and `InvalidLookupUserIdError` is thrown otherwise. Its message carries an eight-character
prefix and the length, never the whole value — the F-132 rule, and load-bearing here for the
reason in `tenantIdForUser` below.

## `tenantIdForUser`

`apps/api/src/auth/tenant-id-for-user.ts`.

```ts
export class NoTenantMembershipError extends Error {
  readonly name = 'NoTenantMembershipError';
  /** The full user id, for the caller. Never interpolated into `message`. */
  readonly userId: string;
}

/**
 * The tenant id on this user's single tenant_memberships row, lower-cased.
 * Throws NoTenantMembershipError when there is no row.
 * Never returns null. Never returns an empty string.
 */
export async function tenantIdForUser(userId: string): Promise<string>;
```

The statement, inside `withMembershipLookup(userId, ...)`:

```sql
SELECT tenant_id FROM tenant_memberships WHERE user_id = $1
```

The `UNIQUE (user_id)` constraint means at most one row. A second row is impossible at the
database; if one is ever returned, the function throws rather than choosing.

The result is lower-cased before it is returned. PostgreSQL normalises `uuid` output to
lower case already; the call is there so the value is the canonical form
`assertUuid` (`tenant-context.ts:308-314`) returns, and so a later equality test against a
row's `tenant_id` cannot disagree by case (F-130).

**`NoTenantMembershipError.message` must not contain the raw user id.** `serializers.err`
reduces a logged error to `err_name` and `err_stack`, and `Error.stack` begins with the
message, so anything interpolated into the message reaches the log line whatever
`LOGGABLE_FIELDS` says (ADR-0028, GC-G). Whether a user identifier joins that allowlist is
a decision this initiative has not made. The message carries an eight-character prefix and
the length; the full value is on `.userId`.

**No email address appears in either error, in any form.** GC-G bans `email` from log lines
and this is the one path that holds a user id and an email at the same time.

## What the caller may assume

1. A resolved value is a lower-cased uuid matching
   `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, so it passes
   `assertUuid` unchanged.
2. A user with no membership row produces a rejected promise carrying
   `NoTenantMembershipError`, never a resolved `null`, `undefined` or `''`. Token minting
   therefore fails and an orphaned account never receives a JWT — ADR-0015's primary stop.
3. The read touches exactly one user's row. It cannot return another user's membership, and
   it cannot return a second row.
4. No tenant context is opened, entered or required. `tenantDb()` and `currentTenantId()`
   still throw inside `fn`.
5. Nothing is written. The transaction is read-only and the policy grants no write.
6. A driver error is unwrapped at the transaction boundary by `databaseTransaction`, so a
   caught error answers to `postgresErrorCode` (`tenant-context.md`, "Driver errors inside
   `fn`").

## What the implementer must guarantee

1. `tenant-id-for-user.ts` contains no `set_config` call, no `app.` flag string and no
   import of `databaseTransaction`. `withMembershipLookup` is its only database reach.
2. `membership-lookup.ts` is the only file in `apps/api/src/**/*.ts` (excluding `*.spec.ts`)
   containing the string `app.membership_lookup_user`, other than `apps/api/src/db/rls.ts`.
3. `withMembershipLookup` is imported by exactly one file,
   `apps/api/src/auth/tenant-id-for-user.ts`. `tenantIdForUser` is imported by exactly one,
   `apps/api/src/auth/auth.config.ts`. **There is no runtime guard**: this is a file-level
   rule until TASK-056 asserts it, and it is what keeps the escape off the request path.
4. `apps/api/src/db/client.ts`'s docblock caller list names `withMembershipLookup` as its
   fifth entry, in the same commit.
5. `ISOLATION_EXCLUSIONS` gains `repo:TenantMembershipLookup.tenantIdForUser`, and the
   AC-12 assertion in `cross-tenant-isolation.int-spec.ts` moves to `toHaveLength(3)` with
   the id added — **in TASK-002's commit, not a later one**.
6. The three "exactly two" claims at `rls.ts:72`, `rls.ts:87` and `coverage.ts:490-499` are
   corrected to three in the same commit.

## Error cases

| Situation | Thrown | Message content |
|---|---|---|
| No membership row | `NoTenantMembershipError` | eight-character prefix of the user id, its length, and the sentence that this account cannot obtain a `tid` claim. No email, no full id |
| More than one row | `Error` | the constraint name `tenant_memberships_user_unique` and nothing user-derived |
| `userId` empty or over 255 characters | `InvalidLookupUserIdError` | eight-character prefix and length (F-132) |
| Statement timeout | driver error, SQLSTATE `57014` | unchanged; read through `postgresErrorCode` |
| Connection failure | driver error | `client.ts`'s listeners log it as `err`; the promise rejects |

`tenantIdForUser` throwing during `definePayload` fails the token mint. Better Auth's
`/token` endpoint answers 500. That is correct and intended: an account with no membership
must not receive a credential.

## Invariants

1. `UNIQUE (user_id)` is the mechanism, not a convenience index. It is what makes
   one-tenant-per-user structural (ADR-0015) and what bounds this lookup to one row.
2. The lookup policy admits exactly the rows whose `user_id` equals the flag. It cannot be
   widened to a tenant, a list, or a truthy sentinel without a new ADR.
3. `withMembershipLookup` sets no tenant context and never will. A caller needing tenant
   context calls `withTenantTransaction` instead.
4. The escape is enumerable four ways: a named policy in `pg_policies`, a named flag under
   clauses A1 to A4, a fifth path in `tenant-context.md`'s `databaseTransaction` list, and a
   third entry in `ISOLATION_EXCLUSIONS`.

## Isolation controls this owes

TASK-002 ships both in `apps/api/test/auth/tenant-memberships.int-spec.ts`:

1. With `app.membership_lookup_user` set to user A, `SELECT * FROM tenant_memberships`
   returns A's row and does not return tenant B's row.
2. With no flag set, the same statement returns zero rows.

Both run as `shortkit_app`. A refusal is not a pass: row-level security denies a read by
returning zero rows and never by raising (isolation-coverage.md, corrected statement 2), so
a test that throws proves nothing and must be treated as a defect in the test.

TASK-002 also registers the table with the harness:

```ts
registerTenantScopedSurfaces({
  subject: 'TenantMembershipsTableAccess',
  table: 'tenant_memberships',
  ownerColumn: 'tenant_id',
  // ...
});
```

**`tableAccess` as shipped cannot cover this table without one change.** Its update shapes
assign the literal string `'overwritten-by-another-tenant'` to `mutableColumn`
(`registrations.ts:391`). `tenant_memberships` has no free-text column: `user_id` is
`UNIQUE` and a foreign key, and `role` is an enum. Either assignment fails with a
constraint or enum error rather than a policy refusal, and the harness scores that
`unverified`. `TableAccessSpec` therefore gains an optional `mutableValue`, defaulting to
the current literal, and this registration passes `mutableColumn: 'role'` with a valid
`tenant_role` value different from the planted row's. `registrations.ts` is TASK-002's file,
so this is in scope for it.

## Versioning and compatibility

Internal to `apps/api`. Changing `tenantIdForUser`'s signature, widening the lookup policy,
or adding a second caller of `withMembershipLookup` each require a new ADR superseding
ADR-0045.

Item 1b adds workspace membership and does not change this contract: `memberships` is a
separate table and the tenant-level lookup is unaffected.
