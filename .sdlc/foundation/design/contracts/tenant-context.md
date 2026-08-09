# Contract: tenant transaction context

- **Boundary:** every tenant-scoped database access in `apps/api`.
- **Normative form:** `apps/api/src/tenancy/tenant-context.ts` (stub: `design/stubs/apps/api/src/tenancy/tenant-context.ts`).
- **Produced by:** TASK-005 (`withTenantTransaction`, `tenantDb`), TASK-011 (interceptor, `RequestContext`, `@Public()`).
- **Consumed by:** TASK-006, 009, 010, 011, 013, 014, 016, 017, 018, 020, 021, 023, 025, 027, 033, 034, 038, 040, 045, 048, 049, 051, 053, 054, 056.
- **ADRs:** ADR-0002, ADR-0003.

## Normative types

```ts
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type * as schema from '../db/schema';

/** Branded transaction handle. The only legitimate way to reach a connection. */
export type TenantDb = PgTransaction<any, typeof schema, any> & {
  readonly __tenantScoped: unique symbol;
};

export interface TenantContext {
  readonly tenantId: string;
  readonly db: TenantDb;
}

export interface TenantTransactionOptions {
  /** Runs after COMMIT succeeds. Third-party network I/O belongs here, never inside fn. */
  readonly afterCommit?: () => Promise<void> | void;
  /** Postgres statement_timeout for the transaction, in ms. Default 5000. */
  readonly statementTimeoutMs?: number;
}

export declare function withTenantTransaction<T>(
  tenantId: string,
  fn: (db: TenantDb) => Promise<T>,
  options?: TenantTransactionOptions,
): Promise<T>;

/** Reads the ambient context. Throws TenantContextMissingError when none is active. */
export declare function tenantDb(): TenantDb;
export declare function currentTenantId(): string;

export class TenantContextMissingError extends Error {}
export class TenantContextMismatchError extends Error {}

/** Populated by AuthGuard from JWT claims only. No database read. */
export interface RequestContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly emailVerified: boolean;
  workspaceId?: string;          // set by WorkspaceGuard (TASK-017)
  workspaceRole?: WorkspaceRole; // set by WorkspaceGuard (TASK-017)
  tenantRole?: TenantRole;       // set by WorkspaceGuard (TASK-017)
}

/** Justification is required, not optional. TASK-056 reports it. */
export declare function Public(justification: string): MethodDecorator & ClassDecorator;
```

## SQL issued by `withTenantTransaction`

```sql
BEGIN;
SELECT set_config('statement_timeout',                   $1, true);
SELECT set_config('idle_in_transaction_session_timeout', $2, true);
SELECT set_config('app.tenant_id',                       $3, true);
-- fn runs here
COMMIT;   -- or ROLLBACK if fn throws
```

All three run before `fn` does. Their order among themselves is not load-bearing.
ADR-0021's requirement that a capability-token digest check be the first statement in
the transaction means the first statement `fn` issues, not the first statement on the
connection.

**`set_config(name, value, true)`, never `SET LOCAL`.** Revised 2026-08-04 (F-007):
PostgreSQL's `SET`/`SET LOCAL` accept no bind parameters, so `SET LOCAL app.tenant_id =
$1` raises a syntax error at `$1`, and the shortest repair is string interpolation at
the one statement all of RLS depends on. `set_config` is parameterised with identical
transaction-local semantics: the third argument `is_local = true` scopes it to the
transaction, which is AC-11.

**No context flag is ever set by string concatenation, in any file.** `tenantId` is
validated as a uuid before it reaches `set_config`; for ADR-0021's capability-token
routes it arrives from an unauthenticated URL segment.

### `idle_in_transaction_session_timeout`, and the client listener it requires

Added 2026-08-05 (F-123), recommended by `sdlc-security-auditor`. `isolation-coverage.md`
clause A4 admits the name; see its permitted-name table.

**Value: `5000`, a module constant.** Not derived from `options.statementTimeoutMs` and
not settable through `TenantTransactionOptions`. The two bound different things and fail
differently: `statement_timeout` cancels one query, this one terminates the connection.
A caller that lowers its statement budget to 200 ms is asking for a tighter query bound,
not for a 200 ms ceiling on the gap between two queries, which garbage collection alone
can exceed on a loaded instance. Adding an option later is an edit to this section.

**What it buys.** `statement_timeout` bounds a query that is running. It does not bound a
gap with no query running, and a third-party call inside `fn` is exactly that gap. Node's
`fetch` has no default timeout, so an `fn` awaiting a hung mail, DNS or Fly API call holds
one of `POOL_MAX` pooled connections until the socket gives up, which can be minutes. Ten
of those take the instance out while `statement_timeout` never fires, the health check
keeps passing and no error is logged anywhere. ADR-0002 recorded the ban on third-party
I/O inside `fn` as "a rule, not a mechanism". This is the mechanism.

**What it does not buy.** It bounds a hang. It does not ban I/O: a 200 ms mail call inside
`fn` still violates the rule and still passes, and no grep catches it. The rule below
under "What the implementer must guarantee" stands on its own.

**The listener is part of the same change. Do not land the `set_config` without it.**

```ts
// in client(), immediately after the pool is constructed
pool.on('connect', (client) => {
  client.on('error', (error: Error) => {
    // name and SQLSTATE only, per rule 2 of "Driver errors inside `fn`"
  });
});
```

Why, in the order the failure runs:

1. On expiry PostgreSQL sends `FATAL: terminating connection due to idle-in-transaction
   timeout`, SQLSTATE `25P03`, then closes the socket.
2. The client is checked out and no query is active, so `pg`'s `_handleErrorMessage`
   finds no active query, calls `_handleErrorEvent`, and reaches `client.emit('error')`
   (`pg@8.22.0`, `lib/client.js`). The socket `end` handler emits a second time.
3. A checked-out client has no `'error'` listener. `pg-pool` removes its own
   `idleListener` in `_acquireClient` (`pg-pool@3.14.0`, line 344) and drizzle's
   `NodePgSession.transaction` calls `pool.connect()` and attaches none.
4. Node throws on an `'error'` emit with no listener. The process dies with an
   uncaughtException, and whichever third party was slow chose the moment.

`pool.on('error')` from the rest of F-123 does not cover this. It fires through
`makeIdleListener`, which is attached only while a client sits idle **in** the pool.
Attach on `'connect'`, which `pg-pool` emits once per newly created client and which
`pg-pool` never removes because it did not add it. Not `'acquire'`, which fires on every
checkout and stacks a listener per use.

**What the caller sees when it fires.** PostgreSQL has already rolled the transaction
back and killed the backend. drizzle then runs `ROLLBACK` on a dead client in its own
catch and rethrows that failure in place of the original, so the error reaching the caller
of `withTenantTransaction` is a `pg` connection error, not a `DatabaseError` carrying
`25P03`. `postgresErrorCode` answers `undefined` for it. Nothing may branch on this error;
the guarantee is that nothing is committed and the connection is discarded.

**This closes an exposure that already exists.** Any mid-transaction connection death
reaches step 3 the same way today: Neon scale-to-zero, a failover, a restart. The new
statement makes that path routine rather than exceptional, and the listener closes both.

## The three sanctioned ways to obtain a tenant id

Normative. A tenant id reaches `withTenantTransaction` by exactly one of these. Anything
else is a defect.

| # | Source | Used by | Guard against a forged id |
|---|---|---|---|
| 1 | The `tid` JWT claim | every authenticated route | signature verification (`auth-tokens.md`) |
| 2 | `crypto.randomUUID()` in application code | `onUserCreated`, uninvited branch (ADR-0015) | the id is new, so it names no existing tenant; `tenants_self_insert` admits only that row |
| 3 | The routing prefix of a capability token | the two `@Public()` invitation routes (ADR-0021) | the digest check, which **must be the first statement in the transaction** |

**Pattern 3 is not a GC-5 escape.** Every statement still runs under
`set_config('app.tenant_id', ...)` and the ordinary `tenant_isolation` policy, on tables
that keep `FORCE ROW LEVEL SECURITY`. No new flag, no new policy,
`ISOLATION_EXCLUSIONS` stays at two. See `invitation-tokens.md`.

## Routes that open their own transaction

`@NoTenantTransaction(justification)` keeps `AuthGuard` and skips only
`TenantTransactionInterceptor`, so the handler opens its own transactions explicitly.
It exists for one route in `launch-core`:

| Route | Why |
|---|---|
| `POST /api/gdpr/delete` | It runs an ordinary tenant transaction for the census, then a separate privileged-erase transaction, then a third for the residue check. Nesting those inside an interceptor-opened transaction would hold two pooled connections and produce a foreign-key error rather than a clean erase. |

This is **not** an escape: every statement still runs inside `withTenantTransaction` or
`privilegedTenantEraser`. TASK-056 enumerates these routes alongside `@Public()` and
prints the justification.

### Authorization moves into the handler, and does not disappear

Added 2026-08-04 (F-020). Skipping the interceptor means **there is no ambient tenant
context when guards run**, and `WorkspaceGuard`'s membership lookup needs one. Left
unstated, an implementer meets a guard that throws on the only irreversible route in the
system, and the cheapest green fix is to make `WorkspaceGuard` tolerate a missing
context. That removes the owner check from tenant erasure and lets any tenant `member`
destroy the whole tenant.

Three rules, all normative:

1. **A `@NoTenantTransaction` route may not carry `@RequireTenantRole` or
   `@RequireWorkspaceRole`.** TASK-056 asserts that combination never exists.
2. **Authorization and the AC-92 confirmation check run inside the handler's first
   `withTenantTransaction`, before any other statement**, through the same
   `WorkspaceAuthorizer` with the same error codes. See `workspace-authorization.md`
   Form C for the ordered sequence.
3. **`WorkspaceGuard` fails closed.** With no active tenant context it throws
   `TenantContextMissingError`, producing a 500. It never returns true and never
   degrades to an unchecked pass. A 500 on a misconfigured route is correct; a silent
   pass on the erasure route is not.

Route enumeration cannot see an in-handler check, so an integration test asserting 403
for a tenant `member` and a tenant `admin` is the only coverage of AC-105 on this route.

## Driver errors inside `fn`

Added 2026-08-05 (F-120), raised independently by `sdlc-reviewer` and
`sdlc-security-auditor`. Normative for every TASK that catches a database error.

**drizzle wraps per statement. `databaseTransaction` unwraps per transaction.** Since
drizzle-orm 0.44 a failed statement throws `DrizzleQueryError`, whose `cause` is the
driver's `pg.DatabaseError` and whose `message` is the literal
`Failed query: ${query}\nparams: ${params}`, so it carries the SQL text and every bound
parameter. `databaseTransaction` unwraps that at the transaction boundary, so the error a caller of
`withTenantTransaction` receives is the driver's own. **A `catch` inside `fn` runs before
that boundary and receives the wrapper.** On the wrapper, `error.code` is `undefined`,
`error.constraint` is `undefined`, and `error.message` carries the row values.

Two accessors, exported from `apps/api/src/db/client.ts`. They are the only sanctioned
way to read a caught database error anywhere in `apps/api`, inside `fn` or outside it.

```ts
/**
 * The five-character SQLSTATE of a caught database error, unwrapping drizzle's
 * per-statement DrizzleQueryError first. Returns undefined for anything that is not a
 * pg.DatabaseError, wrapped or not.
 */
export declare function postgresErrorCode(error: unknown): string | undefined;

/**
 * The name of the constraint or unique index the statement violated, unwrapping the
 * same way. Returns undefined when the driver did not report one.
 */
export declare function postgresErrorConstraint(error: unknown): string | undefined;
```

`postgresErrorConstraint` exists because `postgresErrorCode` alone is not enough for the
two call sites that need this: `slug.md`'s collision loop and
`domain-provisioning.md`'s verify transition both branch on `23505` and both would
otherwise be assuming their table has exactly one unique constraint that can fire.

### The rules

1. **Every catch that branches on a Postgres condition calls `postgresErrorCode`.**
   Reading `error.code` directly is a defect, and inside `fn` it is a silent one: the
   branch never matches, and the error surfaces as a 500 with the wrong code.
2. **Never read `message`, `stack`, `toString()`, `detail`, `hint`, `where`,
   `internalQuery` or `query` off a caught database error.** Not to log it, not to
   include it in an envelope, not to build a diagnostic string. This holds for the
   wrapper and for the unwrapped `pg.DatabaseError` alike, and it holds inside `fn`,
   where TASK-007's exception filter never sees the error and cannot redact it.
3. **The readable fields are a closed allowlist**: the SQLSTATE through
   `postgresErrorCode`, and the constraint name through `postgresErrorConstraint`.
   Nothing else. Widening it needs an edit to this section.
4. **Rethrow what you did not handle, unchanged.** Do not wrap a driver error in a new
   `Error` whose message interpolates the original; that reintroduces rule 2's leak
   through a different field. `error-envelope.md`'s rule holds: a wrapper that is
   genuinely needed is itself a `DomainError`.

### The residual, stated rather than left implicit

An unwrapped `pg.DatabaseError` is **not** value-free. On a unique violation the driver
populates `detail` with the colliding column values verbatim, as in
`Key (slug)=(abc) already exists`. `where` and `internalQuery` can carry query text and
values from a trigger or a function body. Unwrapping the drizzle wrapper strictly reduces
exposure; it does not eliminate it. Rule 2 names those fields for that reason, and rule
3's allowlist is closed rather than "everything except `message`".

The consequence for logging is in `logging-and-headers.md`. The consequence for the error
envelope is that no driver error field ever reaches a response body; `error-envelope.md`
already forbids that, and this section is the reason it matters more than it looks.

## Invariants a caller may rely on

1. Inside `fn`, every query against a tenant-scoped table sees only rows whose
   `tenant_id` equals `tenantId`. Enforced by RLS (see `rls-policy-template.md`), not
   by an application `where` clause (AC-25).
2. `fn` throwing rolls the transaction back and rethrows the original error. Nothing is
   committed (AC-11). Revised 2026-08-05 (F-120): "the original error" means the driver's
   own `pg.DatabaseError`, not drizzle's `DrizzleQueryError` wrapper, because
   `databaseTransaction` unwraps at the transaction boundary. **This invariant says
   nothing about what a `catch` inside `fn` sees**, which is the wrapper. See "Driver
   errors inside `fn`".
3. After `withTenantTransaction` returns, the pooled connection carries no residue of
   `app.tenant_id` (AC-11).
4. `tenantDb()` outside an active context throws `TenantContextMissingError`. It never
   returns an unscoped client.
5. Nesting `withTenantTransaction` with the **same** `tenantId` reuses the outer
   transaction and does not open a savepoint. Nesting with a **different** `tenantId`
   throws `TenantContextMismatchError`.
6. `afterCommit` runs exactly once, after `COMMIT` returns. A throw there is logged and
   does not affect the committed transaction and does not propagate to the caller.
7. A query outside any tenant context returns zero rows rather than all rows (AC-10).

## What the implementer must guarantee

- `apps/api/src/db/client.ts` is the only file constructing the Drizzle client, and it
  does not export it. It additionally exports `postgresErrorCode` and
  `postgresErrorConstraint`, which any file may import.
- **`databaseTransaction` has exactly four sanctioned consumers.** Amended 2026-08-05
  (F-126). This list named three; the fourth arrived when TASK-005 put the boot check in
  `rls.ts`, and TASK-056 needs a list that is true.

  | Consumer | File | Path |
  |---|---|---|
  | `withTenantTransaction` | `apps/api/src/tenancy/tenant-context.ts` | data |
  | `withRedirectRead` | `apps/api/src/redirect/db/redirect-read.ts` | data |
  | `privilegedTenantEraser` | `apps/api/src/gdpr/privileged-eraser.ts` | data |
  | `assertRuntimeRoleCannotBypassRls` | `apps/api/src/db/rls.ts` | control |

  The three data-path consumers reach tenant-scoped tables, and each is narrowed by
  policy in `rls-policy-template.md`. The control-path consumer reads `pg_roles` and
  `pg_class` before the process accepts traffic, touches no tenant-scoped table and
  returns no tenant data, so **`ISOLATION_EXCLUSIONS` stays at two** and the "Deliberate
  exclusions" table below is unchanged. A fourth consumer is not a third exclusion.

  **What the list is for.** Not unreachability: any module can import
  `databaseTransaction`, and no type prevents it. The guarantee is that a transaction
  opened without a context flag sees zero rows on every tenant-scoped table and can write
  none, which is fail-closed by policy rather than by enumeration. The list is what makes
  a fifth caller a reviewed diff instead of an unremarked one.

  **Admitting a fifth.** It qualifies only if it is one of the two `ISOLATION_EXCLUSIONS`,
  or if it reads `pg_catalog` and `information_schema` only and runs before the process
  serves traffic. Anything else needs an ADR superseding ADR-0002.

  **TASK-056 asserts it.** Over `apps/api/src/**/*.ts`, excluding `*.spec.ts` and
  excluding `client.ts` itself, the set of files containing the string
  `databaseTransaction` equals exactly those four paths. File-level and by grep, like
  `isolation-coverage.md` clauses A1 to A3, for the same reason: what a reviewer checks a
  diff against is a list of file names. Timing matches clause A1's. `redirect-read.ts`
  (TASK-029) and `privileged-eraser.ts` (TASK-054) both land before TASK-056's wave, so
  set equality holds when the suite first runs and is not assertable earlier.

  **Known coupling, recorded and not fixed (F-126).** `rls.ts` was a module of policy
  strings that schema files and the frozen policy fixture import. It now imports
  `client.ts`, so importing the policy template pulls in `pg` and `drizzle` transitively.
  Nothing breaks today: `client.ts` builds its pool on first use rather than at import, so
  `check-policies.mts` and every schema file still load without `DATABASE_URL`. The cost
  is a runtime driver in the module graph of a module that only needed strings. Moving the
  boot check into its own file is the repair, and it is not TASK-005's to make:
  `apps/api/test/tenancy/tenant-context.int-spec.ts` imports
  `assertRuntimeRoleCannotBypassRls` from `../../src/db/rls`, so the move edits a test file
  and belongs to `sdlc-test-architect`. F-116 decides where the boot call site lives
  (TASK-003, `main.ts`); whoever settles that decides the check's home with it, and the
  fourth row above moves with it. Deliberately not a TASK-056 assertion: asserting the
  current module graph would freeze the arrangement we want to keep able to change.
- **No file outside `apps/api/src/db/client.ts` imports `DrizzleQueryError` or names it
  in an `instanceof`.** The two accessors are the whole interface to a caught database
  error; a second unwrap site is a second place to get it wrong. TASK-056 greps for this
  alongside its other source-level checks.
- **`.code` is never read off a caught error in `apps/api/src/**`.** Read the SQLSTATE
  through `postgresErrorCode`. Inside `fn` the direct read silently yields `undefined`.
- **No third-party network I/O inside `fn`.** Mail, Fly API and DNS calls go in
  `afterCommit` or after the call returns. The transaction holds a pooled connection
  for its whole lifetime.
- `TenantTransactionInterceptor` is registered as `APP_INTERCEPTOR`, runs after
  `AuthGuard`, and skips handlers marked `@Public()` or `@NoTenantTransaction()`.
- `AuthGuard` issues no database query. `tenantId` comes from the JWT `tid` claim
  (`auth-tokens.md`).
- Boot-time assertion: the connected role has `rolbypassrls = false` and
  `is_superuser = off`. The process exits non-zero otherwise.
- **Validate the tenant id as a uuid before calling `withTenantTransaction`.** Use
  `set_config`, never `SET LOCAL`, and never build a flag value by concatenation.

## Deliberate exclusions

Exactly two paths reach tenant-scoped tables outside this contract. Both are recorded
in `isolation-coverage.md` and narrowed by database policy in `rls-policy-template.md`.

| Path | File | Reach |
|---|---|---|
| `withRedirectRead` | `apps/api/src/redirect/db/redirect-read.ts` | `SELECT` only, on `domains` and `links` only, in a `READ ONLY` transaction |
| `privilegedTenantEraser` | `apps/api/src/gdpr/privileged-eraser.ts` | `DELETE` only, scoped to one `tenant_id` by policy |

A third is a build failure: `isolation-coverage.md` asserts the exclusion list length
is 2, and the grep test asserts each context-flag string appears in exactly one
non-test source file.

## Versioning

Internal to `apps/api`. Changing the signature of `withTenantTransaction` or `tenantDb`
requires a new ADR superseding ADR-0002.
