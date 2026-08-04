/**
 * Contract: design/contracts/tenant-context.md
 * ADR: adr-0002-tenant-context-binding.md, adr-0003-rls-policy-template-and-roles.md
 * Produced by: TASK-005 (withTenantTransaction, tenantDb), TASK-011 (interceptor, RequestContext)
 *
 * GC-5 lives here. Every tenant-scoped read or write runs inside a transaction that
 * has set `app.tenant_id`. THIS IS THE ONLY FILE THAT MAY CONTAIN THE STRING
 * `app.tenant_id` outside tests. The isolation suite asserts that by grep.
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
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { TenantRole, WorkspaceRole } from '@shortkit/contracts';
import type * as schema from '../db/schema';

declare const tenantScopedBrand: unique symbol;

/**
 * Branded transaction handle. The unbranded Drizzle client is never exported from
 * apps/api/src/db/client.ts, so this is the only way a repository reaches a connection.
 */
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

/** Module-private. Never exported. */
export const tenantStorage = new AsyncLocalStorage<TenantContext>();

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
  _tenantId: string,
  _fn: (db: TenantDb) => Promise<T>,
  _options?: TenantTransactionOptions,
): Promise<T> {
  throw new Error('not implemented');
}

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`Tenant id is not a uuid: ${JSON.stringify(value)}`);
    this.name = 'InvalidTenantIdError';
  }
}

/** Throws InvalidTenantIdError. Called before every set_config of a tenant id. */
export function assertUuid(_value: string): string {
  throw new Error('not implemented');
}

/** Reads the ambient context. Throws when none is active. Never returns an unscoped client. */
export function tenantDb(): TenantDb {
  throw new Error('not implemented');
}

export function currentTenantId(): string {
  throw new Error('not implemented');
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
