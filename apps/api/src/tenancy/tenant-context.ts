/**
 * Contract: design/contracts/tenant-context.md
 * ADR: adr-0002-tenant-context-binding.md, adr-0003-rls-policy-template-and-roles.md
 * Produced by: TASK-005 (withTenantTransaction, tenantDb), TASK-011 (interceptor, RequestContext)
 *
 * GC-5 lives here. Every tenant-scoped read or write runs inside a transaction that
 * has set `app.tenant_id`. THIS IS THE ONLY FILE THAT MAY SET IT outside tests, and
 * the isolation suite asserts that by grep. The literal name is TENANT_ID_SETTING in
 * ../db/rls.ts, imported below, because the policies that READ the flag live there:
 * ADR-0003's grep then finds the string in exactly one non-test source file, and the
 * statement that sets it cannot drift from the policies that depend on it.
 *
 * SQL issued (F-007, 2026-08-04):
 *   BEGIN;
 *   SELECT set_config('statement_timeout', $1, true);
 *   SELECT set_config('app.tenant_id',     $2, true);
 *
 * NEVER `SET LOCAL app.tenant_id = $1`. PostgreSQL's SET accepts no bind parameter,
 * and the shortest repair is string interpolation at the one statement all of RLS
 * depends on. set_config is parameterised with identical transaction-local semantics.
 * NO CONTEXT FLAG IS EVER SET BY CONCATENATION.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { TenantRole, WorkspaceRole } from '@shortkit/contracts';
import { databaseTransaction } from '../db/client';
import { TENANT_ID_SETTING } from '../db/rls';
import type * as schema from '../db/schema';

declare const tenantScopedBrand: unique symbol;

/**
 * Branded transaction handle. The unbranded Drizzle client is never exported from
 * apps/api/src/db/client.ts, so this is the only way a repository reaches a connection.
 *
 * The `any` query-result and table-relation type params are the normative form in
 * design/contracts/tenant-context.md, supplied by drizzle-orm's own generics rather
 * than by this module.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TenantDb = PgTransaction<any, typeof schema, any> & {
  readonly [tenantScopedBrand]: true;
};

export interface TenantContext {
  readonly tenantId: string;
  readonly db: TenantDb;
}

export interface TenantTransactionOptions {
  /**
   * Runs after COMMIT succeeds. Third-party network I/O (mail, Fly, DNS) belongs
   * here, NEVER inside `fn`: the transaction holds a pooled connection for its
   * whole lifetime (ADR-0002).
   * A throw here is logged and does not propagate.
   */
  readonly afterCommit?: () => Promise<void> | void;
  /** Postgres statement_timeout for the transaction, in ms. Default 5000. */
  readonly statementTimeoutMs?: number;
}

export class TenantContextMissingError extends Error {
  constructor() {
    super('No tenant transaction is active. Call withTenantTransaction first.');
    this.name = 'TenantContextMissingError';
  }
}

export class TenantContextMismatchError extends Error {
  constructor(outer: string, inner: string) {
    super(`Nested tenant transaction for ${inner} inside an active context for ${outer}.`);
    this.name = 'TenantContextMismatchError';
  }
}

/**
 * The context as this module holds it. `afterCommit` is mutable and internal: a
 * nested call reuses the outer transaction, so its hook has to wait for the outer
 * COMMIT rather than run at the end of its own frame, where nothing has committed
 * yet (contract invariants 5 and 6 together). TenantContext, which is what callers
 * see, stays exactly as the contract declares it.
 */
interface ActiveTenantContext extends TenantContext {
  readonly afterCommit: AfterCommitHook[];
}

type AfterCommitHook = () => Promise<void> | void;

/**
 * Module-private. Never exported: every other module reaches it only through
 * withTenantTransaction, tenantDb and currentTenantId below.
 */
const tenantStorage = new AsyncLocalStorage<ActiveTenantContext>();

// TASK-003 replaces this with the pino logger.
const logger = new Logger('TenantTransaction');

/** design/contracts/tenant-context.md, TenantTransactionOptions.statementTimeoutMs. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;

/**
 * Opens a transaction, sets app.tenant_id via set_config, runs `fn` inside it.
 * Commits on resolve, rolls back on throw and rethrows the original error (AC-11).
 * Nesting with the same tenantId reuses the outer transaction and opens no savepoint.
 * Nesting with a different tenantId throws TenantContextMismatchError.
 *
 * MUST validate `tenantId` as a uuid before it reaches set_config. For ADR-0021's
 * capability-token routes it arrives from an unauthenticated URL segment.
 *
 * The tenant id reaches here by exactly one of three sanctioned sources:
 *   1. the `tid` JWT claim                      (authenticated routes)
 *   2. crypto.randomUUID() in application code  (onUserCreated, uninvited branch)
 *   3. a capability token's routing prefix      (ADR-0021, digest verified FIRST)
 * Anything else is a defect.
 */
export async function withTenantTransaction<T>(
  tenantId: string,
  fn: (db: TenantDb) => Promise<T>,
  options?: TenantTransactionOptions,
): Promise<T> {
  const scopedTo = assertUuid(tenantId);
  const active = tenantStorage.getStore();

  if (active !== undefined) {
    if (active.tenantId !== scopedTo) {
      throw new TenantContextMismatchError(active.tenantId, scopedTo);
    }

    // Reuses the outer transaction and opens no savepoint. A savepoint here would
    // let an inner failure be swallowed while the outer transaction still commits,
    // which is the opposite of AC-11.
    if (options?.afterCommit !== undefined) {
      active.afterCommit.push(options.afterCommit);
    }

    return fn(active.db);
  }

  const afterCommit: AfterCommitHook[] =
    options?.afterCommit === undefined ? [] : [options.afterCommit];

  const result = await databaseTransaction(async (tx) => {
    const db = tx as TenantDb;

    // Both values are bound, never interpolated. `set_config` is the parameterised
    // form of SET LOCAL, which accepts no bind parameter at all (F-007).
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(options?.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS)}, true)`,
    );
    await tx.execute(sql`select set_config(${TENANT_ID_SETTING}, ${scopedTo}, true)`);

    return tenantStorage.run({ tenantId: scopedTo, db, afterCommit }, () => fn(db));
  });

  // Only reached once COMMIT has returned: a throw inside `fn` rolls the transaction
  // back and rethrows before this line, so no hook runs for work that was undone.
  for (const hook of afterCommit) {
    try {
      await hook();
    } catch (error) {
      // The transaction is already committed and the caller's result is already
      // decided, so this is reported and not propagated (contract invariant 6).
      logger.error(
        `afterCommit hook failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
  }

  return result;
}

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`Tenant id is not a uuid: ${JSON.stringify(value)}`);
    this.name = 'InvalidTenantIdError';
  }
}

/**
 * Any of the eight uuid versions, since the three sanctioned sources are
 * crypto.randomUUID (v4), a `tid` JWT claim and a capability token's routing prefix,
 * and the last two carry whatever a future signup wrote. Shape is the whole point:
 * a value that is not a uuid must not reach set_config, whatever it looks like.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws InvalidTenantIdError. Called before every set_config of a tenant id. */
export function assertUuid(value: string): string {
  if (!UUID.test(value)) {
    throw new InvalidTenantIdError(value);
  }

  return value;
}

/** Reads the ambient context. Throws when none is active. Never returns an unscoped client. */
export function tenantDb(): TenantDb {
  return activeContext().db;
}

export function currentTenantId(): string {
  return activeContext().tenantId;
}

function activeContext(): ActiveTenantContext {
  const active = tenantStorage.getStore();

  if (active === undefined) {
    throw new TenantContextMissingError();
  }

  return active;
}

/** Populated by AuthGuard from JWT claims only. NO DATABASE READ. */
export interface RequestContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly emailVerified: boolean;
  workspaceId?: string;
  workspaceRole?: WorkspaceRole;
  tenantRole?: TenantRole;
}

/**
 * Exempts a route from AuthGuard and from TenantTransactionInterceptor.
 * The justification is REQUIRED and is printed by TASK-056's coverage report.
 *
 * A @Public() route that touches a tenant-scoped table MUST reach it through a
 * capability-token entry point (ADR-0021). TASK-056 asserts this.
 */
export function Public(_justification: string): MethodDecorator & ClassDecorator {
  throw new Error('not implemented');
}

export const PUBLIC_ROUTE_METADATA = Symbol('PUBLIC_ROUTE_METADATA');

/**
 * Keeps AuthGuard, skips ONLY TenantTransactionInterceptor, so the handler opens its
 * own transactions. Exactly one route in launch-core uses it: POST /api/gdpr/delete,
 * which needs an ordinary tenant transaction for the census, a separate
 * privileged-erase transaction, and a third for the residue check.
 *
 * NOT an escape: every statement still runs inside withTenantTransaction or
 * privilegedTenantEraser. TASK-056 enumerates these alongside @Public().
 *
 * ============================================================================
 * F-020. THERE IS NO AMBIENT TENANT CONTEXT WHEN GUARDS RUN ON THIS ROUTE.
 * ============================================================================
 *
 * WorkspaceGuard's membership lookup needs one. DO NOT make WorkspaceGuard tolerate a
 * missing context to get this route green: that removes the owner check from the only
 * irreversible-destruction route in the system and lets any tenant `member` erase the
 * whole tenant.
 *
 *   1. A @NoTenantTransaction route MAY NOT carry @RequireTenantRole or
 *      @RequireWorkspaceRole. TASK-056 asserts the combination never exists.
 *   2. Authorization and the AC-92 confirmation run INSIDE the handler's first
 *      withTenantTransaction, before any other statement, via the same
 *      WorkspaceAuthorizer with the same error codes.
 *      See workspace-authorization.md "Form C".
 *   3. WorkspaceGuard FAILS CLOSED: no context -> throws -> 500. Never returns true.
 */
export function NoTenantTransaction(
  _justification: string,
): MethodDecorator & ClassDecorator {
  throw new Error('not implemented');
}

export const NO_TENANT_TRANSACTION_METADATA = Symbol('NO_TENANT_TRANSACTION_METADATA');

/** Marks a provider for TASK-056's repository enumeration (ADR-0020). */
export function TenantScopedRepository(): ClassDecorator {
  throw new Error('not implemented');
}

export const TENANT_SCOPED_REPOSITORY = Symbol('TENANT_SCOPED_REPOSITORY');
