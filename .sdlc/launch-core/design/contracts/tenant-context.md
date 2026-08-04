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
SELECT set_config('statement_timeout', $1, true);
SELECT set_config('app.tenant_id',     $2, true);
-- fn runs here
COMMIT;   -- or ROLLBACK if fn throws
```

**`set_config(name, value, true)`, never `SET LOCAL`.** Revised 2026-08-04 (F-007):
PostgreSQL's `SET`/`SET LOCAL` accept no bind parameters, so `SET LOCAL app.tenant_id =
$1` raises a syntax error at `$1`, and the shortest repair is string interpolation at
the one statement all of RLS depends on. `set_config` is parameterised with identical
transaction-local semantics: the third argument `is_local = true` scopes it to the
transaction, which is AC-11.

**No context flag is ever set by string concatenation, in any file.** `tenantId` is
validated as a uuid before it reaches `set_config`; for ADR-0021's capability-token
routes it arrives from an unauthenticated URL segment.

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

This is **not** an escape either: every statement still runs inside
`withTenantTransaction` or `privilegedTenantEraser`. TASK-056 enumerates these routes
alongside `@Public()` and prints the justification.

## Invariants a caller may rely on

1. Inside `fn`, every query against a tenant-scoped table sees only rows whose
   `tenant_id` equals `tenantId`. Enforced by RLS (see `rls-policy-template.md`), not
   by an application `where` clause (AC-25).
2. `fn` throwing rolls the transaction back and rethrows the original error. Nothing is
   committed (AC-11).
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
  does not export it. `tenantDb()`, `withTenantTransaction`, `withRedirectRead` and
  `privilegedTenantEraser` are the only consumers.
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
