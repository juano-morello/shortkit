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
SET LOCAL statement_timeout = <statementTimeoutMs>;
SET LOCAL app.tenant_id = $1;
-- fn runs here
COMMIT;   -- or ROLLBACK if fn throws
```

`SET LOCAL`, never `SET`. The setting dies with the transaction, which is AC-11.

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
  `AuthGuard`, and skips handlers marked `@Public()`.
- `AuthGuard` issues no database query. `tenantId` comes from the JWT `tid` claim
  (`auth-tokens.md`).
- Boot-time assertion: the connected role has `rolbypassrls = false` and
  `is_superuser = off`. The process exits non-zero otherwise.

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
