---
id: ADR-0046
slug: identity-membership
title: Better Auth's drizzleAdapter gets a non-transactional client typed to its own five tables
status: accepted
supersedes: null
amends: ADR-0002
superseded_in_part_by: ADR-0050
date: 2026-08-12
---

> **Corrected 2026-08-13 (F-028), round 4. THE ONE-POOL PART OF THIS ADR IS REVERSED BY
> ADR-0050. FOUR SENTENCES BELOW ARE NOW FALSE AND ARE STRUCK IN PLACE.**
>
> Everything about *what `betterAuthDatabase()` is* stands: one export, typed over
> `betterAuthSchema`, one caller, `transaction: false`, `betterAuthSchema` passed explicitly.
> None of that changes.
>
> What changes is which pool it is built on. This ADR decided one pool on `DATABASE_URL`,
> and rejected a second pool in its Alternatives table on the cost "doubles the effective
> connection ceiling without doubling the database's". **ADR-0050 accepts that exact cost**,
> because `DATABASE_URL` connects as `shortkit_app` and migration `0001` revokes
> `shortkit_app` on all five auth tables. A single pool on `DATABASE_URL` cannot read `user`,
> so sign-in fails.
>
> **The trap this correction exists to close.** An implementer who builds one pool from this
> ADR gets `permission denied for table user` on the first sign-in. Two repairs make it work:
> add the second pool, or drop the `REVOKE` from migration `0001`. The second is one line in
> a file nobody re-reads, and it restores the account-takeover path F-024 measured and Juano
> reversed a gate decision to close. **If you are here because sign-in is failing, the answer
> is ADR-0050's auth pool. Do not touch the `REVOKE`.**
>
> The rejection was correct against the model it was made in. There was one runtime role, so
> a second pool bought a true sentence in a docblock and nothing else. There are now two
> runtime roles, and a pool is how a process holds a role.

## Context

ADR-0013 fixes `drizzleAdapter(db, { provider: 'pg' })` and says "Better Auth shares the
application's Drizzle client". There is no such thing to share. `apps/api/src/db/client.ts`
constructs the Drizzle client and its header says, in capitals, that it does not export it:

> THE ONLY FILE THAT CONSTRUCTS THE DRIZZLE CLIENT, AND IT DOES NOT EXPORT IT.
> An exported client is a query path that reaches every tenant's rows with no transaction
> and no context flag, which is the hole GC-5 exists to close.

What leaves the module is `databaseTransaction`, and Better Auth cannot use it. The adapter
issues one statement at a time on its own schedule (a select during sign-in, an insert
during sign-up, a delete during sign-out) from inside a handler mounted outside the Nest
graph. There is no callback boundary to hand it.

The docblock's own reasoning is what makes the answer available. It says the guarantee is
not unreachability:

> The guarantee is not that `databaseTransaction` is unreachable (any module can import it)
> but that a transaction opened without a context flag sees zero rows and can write none,
> which is fail-closed by policy.

A client used outside any transaction runs each statement in its own implicit transaction
with no context flag, so the same guarantee holds: on every tenant-scoped table it sees zero
rows and writes none. What it can reach is the five tables that carry no policy, which is
exactly the set Better Auth owns (ADR-0044).

## Decision

**`apps/api/src/db/client.ts` gains one export, `betterAuthDatabase()`, typed over Better
Auth's five tables and nothing else.**

```ts
import { betterAuthSchema } from './schema/auth';

/**
 * The client Better Auth's drizzleAdapter runs on. ONE CALLER: auth.config.ts.
 *
 * Typed over betterAuthSchema, which is the five RLS-exempt tables and no others
 * (ADR-0044). A statement issued here against a tenant-scoped table runs outside any
 * transaction and therefore with no context flag, so it sees zero rows and writes none:
 * the same fail-closed property databaseTransaction relies on.
 */
export function betterAuthDatabase(): NodePgDatabase<typeof betterAuthSchema>;
```

~~It is built from the same `pg.Pool` as `databaseTransaction`'s client, through the same
lazy `client()` path, so both connection-error listeners (F-123, F-137), `POOL_MAX`,
`CONNECTION_TIMEOUT_MS` and `allowExitOnIdle` apply unchanged, and `closeDatabase()`
releases both.~~

**Superseded 2026-08-13 (ADR-0050, F-028).** It is built from the **auth** pool, a second
`pg.Pool` on `DATABASE_AUTH_URL` connecting as `shortkit_auth`, constructed in `client.ts`
beside the application pool through the same lazy path. Both connection-error listeners
(F-123, F-137) are attached to both pools verbatim, `CONNECTION_TIMEOUT_MS` and
`allowExitOnIdle` apply to both, and `closeDatabase()` ends both. The auth pool's max is 5,
not `POOL_MAX`; ADR-0050 states why and prices the sum.

**`betterAuthSchema` is a model map declared in `apps/api/src/db/schema/auth.ts`:**

```ts
export const betterAuthSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  jwks: authJwks,
} as const;
```

The keys are Better Auth's model names because both of the adapter's resolution paths index
by them: `config.schema[model]` and `db.query[model]`
(`@better-auth/drizzle-adapter/dist/index.mjs:92,299-315`). The table constants keep
`auth`-prefixed names so that `export * from './auth'` in the schema barrel does not put
`user`, `session` and `account` into a namespace shared with every product table.

TASK-003 passes it twice, which is deliberate rather than redundant: once through the
client's type and once explicitly, so neither resolution path falls back to scanning:

```ts
drizzleAdapter(betterAuthDatabase(), {
  provider: 'pg',
  schema: betterAuthSchema,
  transaction: false,
});
```

**`transaction: false`** is stated rather than inherited. The adapter's default is already
`false` in 1.6.26, and stating it stops a later default change from opening a transaction on
our pool outside `databaseTransaction`. It matters more than a style point: `onUserCreated`
runs `withTenantTransaction`, which checks out a second connection, and nesting that inside
an adapter-held transaction on a ten-connection pool is a contention path with no owner.

**One caller, asserted by file name.** `betterAuthDatabase` may appear in exactly two files
under `apps/api/src`: `db/client.ts` and `auth/auth.config.ts`. Same control as the
`databaseTransaction` list in `tenant-context.md`, and TASK-056 asserts it the same way.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| A second `pg.Pool` | `client.ts`'s "does not export it" sentence stays literally true | Duplicates the two connection-error listeners that F-123 and F-137 each cost a finding to get right, and a missing one takes the API down on a Neon scale-to-zero rather than rejecting a promise. Doubles the effective connection ceiling without doubling the database's, so `POOL_MAX`'s capacity reasoning stops describing the process. Two pools also need two `closeDatabase` paths, and the one that is forgotten keeps the event loop alive | ~~Buys a true sentence with a second copy of the hardest-won code in the module~~ **TAKEN 2026-08-13 (ADR-0050, F-028).** The Cons column is still accurate and every cost in it is now paid. What it does not buy is a true sentence: it buys a second database role. The second pool is constructed in `client.ts`, not in `auth.config.ts`, so `client.ts` stays the only file constructing a Drizzle client |
| Export the full `NodePgDatabase<typeof schema>` | One export, no model map, adapter resolves everything by itself | Hands every importer a typed path to every product table with no transaction and no flag. RLS still fail-closes, so it is not a data leak, but it makes "reaches only auth tables" a comment instead of a type, and the next author who needs a quick read has a sanctioned tool for it | The narrowing is the whole value of the export; without it this is the hole the docblock describes |
| Pass a raw `pg.Pool` and use Better Auth's built-in Kysely adapter instead of `drizzleAdapter` | No Drizzle schema needed for Better Auth's own reads; no model map | Contradicts ADR-0013, which fixes `drizzleAdapter`. The tables still have to exist in the Drizzle schema for ADR-0004's single migration system and ADR-0019's enumeration, so nothing is saved, and Better Auth's own migrator becomes a second thing that might create tables | Fixed by an accepted ADR, and saves nothing it does not also cost |
| Give the adapter a wrapper that opens `databaseTransaction` per statement | No new export shape; every statement goes through the sanctioned path | The adapter's interface is not statement-at-a-time in a way a wrapper can intercept cleanly, and a transaction per statement on a ten-connection pool serialises sign-in behind whatever else is running. It also adds a fifth `databaseTransaction` consumer whose reach is every auth table | Cost of a transaction per read, to restate a guarantee RLS already gives |

## Consequences

### Positive

- ~~One pool, one set of error listeners, one `closeDatabase`, one capacity number.~~
  **Struck 2026-08-13 (ADR-0050, F-028).** Two pools, two sets of listeners, one
  `closeDatabase` that ends both, and two capacity numbers that add to fifteen. ADR-0050
  carries that cost in its own Negative section.
- ~~The exported type reaches five tables. An author who tries to read `workspaces` through it
  gets a compile error rather than a silent empty result.~~
  **Struck 2026-08-16 (F-172, Juano's ruling). THIS CONSEQUENCE IS FALSE AGAINST THE SHIPPED
  FILE.** `client.ts:41` is `import * as schema from './schema'` and `:259` returns
  `NodePgDatabase<typeof schema>`: the **full product schema**, which is the alternative this
  ADR rejected by name in its own Alternatives table. There is no compile error and never was.
  The narrowing was the stated value of the export and it did not get built.

  **Measured before being priced, and it is not a reach.** As `shortkit_auth`, `SELECT` on
  `tenants` and on `tenant_memberships` both answer `permission denied for table`, and
  enumerating `role_table_grants` shows the role holds DML on exactly the five auth tables: it
  never received a default privilege, so the `REVOKE` never needed to be symmetric. **This is a
  missing compile-time guard over a path the database already refuses.** The reach that matters
  is write access to those five unprotected tables, which ADR-0056's caller-list scans bound.

  Juano ruled the line struck and the type left as shipped: narrowing it now means reopening
  `client.ts`, which belongs to a `done` card, to restore a guard over a refusal that already
  holds.
- `betterAuthSchema` gives TASK-003 the exact object the adapter wants, so neither the
  `db.query[model]` fallback nor the `config.schema` scan is exercised.

### Negative / accepted cost

- **`db/client.ts`'s headline claim becomes false and has to be rewritten.** "IT DOES NOT
  EXPORT IT" was a capitalised, load-bearing sentence that three other files point at. It
  becomes "it exports one client, narrowed to the five tables that carry no policy, to one
  caller". A weaker sentence is a weaker invariant, and the strength was doing work.
- The narrowing is a type, and types erase. `betterAuthDatabase().execute(sql\`select * from
  workspaces\`)` compiles and runs. It returns zero rows because of RLS, not because of the
  type, so the protection is the same protection the rest of the system has and not an
  additional one.
- `docs/contracts/tenant-context.md`'s "What the implementer must guarantee" opens with
  the sentence this decision falsifies. It is amended in this initiative.
- Better Auth's statements now run outside any transaction, so a sign-up that inserts a
  `user` row and then fails has no rollback. That is already true: ADR-0013 and ADR-0015
  both record that signup is not atomic and that an orphaned `user` row is the accepted
  failure mode, but this decision is where the mechanism for it is chosen rather than
  inherited.
- `betterAuthSchema` is a second place the five table names are written, after the Drizzle
  declarations themselves. ADR-0043's drift test compares the Drizzle tables to
  `getSchema()`; it does not check that the model map's keys match. A typo in a key surfaces
  as a `BetterAuthError` at runtime on whichever path first touches that model.

### Follow-ups this creates

- TASK-002 writes `betterAuthDatabase()` and `betterAuthSchema`, and rewrites the two
  affected paragraphs of `client.ts`'s docblock in the same commit: the export sentence
  and the sanctioned-caller list, which also gains `withMembershipLookup` (ADR-0045).
- **Added 2026-08-13 (ADR-0050, F-028): TASK-002 also builds the auth pool.**
  `betterAuthDatabase()` is not implementable from this ADR alone. Read ADR-0050's
  "Two pools, and what bounds them" section with it: second `pg.Pool`, `DATABASE_AUTH_URL`,
  max 5, both listeners, and `closeDatabase()` ending both.
- TASK-003 calls it exactly once, with `schema` and `transaction: false` stated.
- TASK-056 (deferred): `betterAuthDatabase` appears in exactly two files under
  `apps/api/src`.
