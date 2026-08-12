/**
 * Contract: design/contracts/tenant-context.md
 * ADR: adr-0002-tenant-context-binding.md, adr-0003-rls-policy-template-and-roles.md
 * Produced by: TASK-005 (withTenantTransaction, tenantDb), TASK-011 (interceptor, RequestContext)
 *
 * GC-5 lives here. Every tenant-scoped read or write runs inside a transaction that
 * has set `app.tenant_id`. THIS IS THE ONLY FILE THAT MAY SET IT outside tests, and
 * the only file besides ../db/rls.ts that may contain the string at all. rls.ts holds
 * the policies that READ the flag and sets nothing; the isolation suite asserts both
 * halves by grep (design/contracts/isolation-coverage.md, clauses A1 to A4).
 *
 * SQL issued (F-007, 2026-08-04; third statement F-123, 2026-08-05):
 *   BEGIN;
 *   SELECT set_config('statement_timeout',                   $1, true);
 *   SELECT set_config('idle_in_transaction_session_timeout', $2, true);
 *   SELECT set_config('app.tenant_id',                       $3, true);
 *
 * The idle bound is 5000 ms, a module constant, not derived from statementTimeoutMs and
 * not settable through TenantTransactionOptions. statement_timeout bounds a running
 * query; nothing bounded the gap between two queries, which is what a third-party call
 * inside `fn` is. ADR-0002 called the ban on that I/O "a rule, not a mechanism". This is
 * the mechanism, and it catches a hang rather than a fast call.
 *
 * IT DOES NOT SHIP WITHOUT THE CLIENT ERROR LISTENER IN db/client.ts. On expiry
 * Postgres terminates the backend while no query is active, `pg` emits 'error' on the
 * checked-out client, and a checked-out client has no listener: pg-pool removes its own
 * in _acquireClient and drizzle attaches none, so Node turns it into an uncaughtException
 * and the API dies. pool.on('error') does not cover this. See tenant-context.md,
 * "`idle_in_transaction_session_timeout`, and the client listener it requires".
 *
 * NEVER `SET LOCAL app.tenant_id = $1`. PostgreSQL's SET accepts no bind parameter,
 * and the shortest repair is string interpolation at the one statement all of RLS
 * depends on. set_config is parameterised with identical transaction-local semantics.
 * NO CONTEXT FLAG IS EVER SET BY CONCATENATION.
 *
 * WRITE THE FLAG NAME AS AN INLINE SQL LITERAL, NOT AS AN IMPORTED CONSTANT (F-118).
 * Only the value is bound. Clause A4 asserts that every set_config first argument under
 * apps/api/src is a quoted literal, because an identifier there cannot be told apart by
 * grep from an identifier holding a concatenated value.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { TenantRole, WorkspaceRole } from '@shortkit/contracts';
import { databaseTransaction } from '../db/client';
import type * as schema from '../db/schema';
import { logger } from '../observability/logger';

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
  constructor(reason = 'No tenant transaction is active. Call withTenantTransaction first.') {
    super(reason);
    this.name = 'TenantContextMissingError';
  }
}

/**
 * A settled context is not an active one, so this is the same class rather than a new
 * one — but the message has to say which of the two happened, or the developer whose
 * continuation resumed after COMMIT reads "call withTenantTransaction first" and
 * concludes the guard is broken (F-121).
 */
const CONTEXT_HAS_SETTLED =
  'The tenant transaction this context belonged to has already committed or rolled ' +
  'back. Its connection is back in the pool and may now belong to another tenant. ' +
  'Work that outlives the transaction belongs in afterCommit or after the call returns.';

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
 *
 * `settled` is the F-121 guard. AsyncLocalStorage keeps this store visible to every
 * continuation descended from inside the transaction callback, including ones that
 * resume after COMMIT — a fire-and-forget `void warmCache()` inside `fn` is the
 * ordinary way that gets written — and `pg` does not disable `query` on a client it
 * has returned to the pool. Such a statement executes on a connection another
 * request has since checked out, inside that tenant's open transaction. The flag
 * lives on the context rather than on the handle because `fn` holds `db` directly:
 * only the shared read path can be closed.
 */
interface ActiveTenantContext extends TenantContext {
  readonly afterCommit: AfterCommitHook[];
  settled: boolean;
}

type AfterCommitHook = () => Promise<void> | void;

/**
 * Module-private. Never exported: every other module reaches it only through
 * withTenantTransaction, tenantDb and currentTenantId below.
 */
const tenantStorage = new AsyncLocalStorage<ActiveTenantContext>();

/** design/contracts/tenant-context.md, TenantTransactionOptions.statementTimeoutMs. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;

/**
 * How long the transaction may sit between two statements before Postgres ends it
 * (F-123). Fixed, and deliberately not derived from `statementTimeoutMs`: the two
 * bound different things and fail differently — one cancels a query, the other
 * terminates the connection — and a caller lowering its query budget to 200 ms is
 * not asking for a 200 ms ceiling on the gap between two queries, which garbage
 * collection alone can exceed on a loaded instance. No caller in launch-core needs
 * to tune it; making it tunable is an edit to the contract, not a new option.
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000;

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
    // A settled context is not an active one. Taking the reuse branch here would run
    // `fn` against a released handle with no BEGIN and no set_config at all — GC-5's
    // hole, reached without touching anything the contract forbids (F-121).
    if (active.settled) {
      throw new TenantContextMissingError(CONTEXT_HAS_SETTLED);
    }

    if (active.tenantId !== scopedTo) {
      throw new TenantContextMismatchError(active.tenantId, scopedTo);
    }

    // Reuses the outer transaction and opens no savepoint. A savepoint here would
    // let an inner failure be swallowed while the outer transaction still commits,
    // which is the opposite of AC-11.
    const nested = await fn(active.db);

    // Enqueued only now, because `fn` resolved (F-125). Registering the hook before
    // running `fn` fires it for work that never happened: the nested frame throws,
    // the outer one catches to build a partial-success response, COMMIT succeeds,
    // and an invitation email announces a row that was never inserted. The top-level
    // path below already behaves this way — a throw rolls back and no hook runs.
    if (options?.afterCommit !== undefined) {
      active.afterCommit.push(options.afterCommit);
    }

    return nested;
  }

  const afterCommit: AfterCommitHook[] =
    options?.afterCommit === undefined ? [] : [options.afterCommit];
  const statementTimeoutMs = String(
    options?.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
  );

  let context: ActiveTenantContext | undefined;
  let result: T;

  try {
    result = await databaseTransaction(async (tx) => {
      const db = tx as TenantDb;

      // Every value is bound and every flag name is an inline literal. `set_config`
      // is the parameterised form of SET LOCAL, which accepts no bind parameter at
      // all (F-007). The order of the three is not load-bearing.
      await tx.execute(sql`select set_config('statement_timeout', ${statementTimeoutMs}, true)`);
      await tx.execute(
        sql`select set_config('idle_in_transaction_session_timeout', ${String(IDLE_IN_TRANSACTION_TIMEOUT_MS)}, true)`,
      );
      await tx.execute(sql`select set_config('app.tenant_id', ${scopedTo}, true)`);

      context = { tenantId: scopedTo, db, afterCommit, settled: false };

      return tenantStorage.run(context, () => fn(db));
    });
  } finally {
    // Whether it committed or rolled back, the handle is back in the pool from here
    // (F-121). The store stays visible to continuations; what changes is that every
    // read of it now throws.
    if (context !== undefined) {
      context.settled = true;
    }
  }

  // Only reached once COMMIT has returned: a throw inside `fn` rolls the transaction
  // back and rethrows before this line, so no hook runs for work that was undone.
  for (const hook of afterCommit) {
    try {
      await hook();
    } catch (error) {
      // The transaction is already committed and the caller's result is already
      // decided, so this is reported and not propagated (contract invariant 6).
      //
      // ==================================================================
      // THE ERROR GOES ON THE RECORD UNDER `err`. IT IS NEVER INTERPOLATED (F-247).
      // ==================================================================
      //
      // This line used to read `afterCommit hook failed: ${error.name}: ${error.message}`
      // through `new Logger('TenantTransaction')` from `@nestjs/common`, which reached
      // neither pino nor ADR-0028's field allowlist. `error.message` is the field the
      // policy withholds everywhere else, and this is a per-request tenant path: a `pg`
      // failure here carries the DSN, and a hook that talks to mail or DNS can throw
      // something carrying row data. `serializers.err` reduces whatever is under `err` to
      // `err_name` and `err_stack` and no third field, whatever the thrown value hangs off
      // itself (F-244) — and it answers for a non-`Error` too, which is why there is no
      // `instanceof` test left here.
      //
      // THE CONTEXT STRING IS A CONSTANT AND HAS TO STAY ONE. Any property of the error
      // interpolated into it lands in `msg`, which is free text by construction and the one
      // field no key-based scheme can censor (ADR-0028, "Door six"). Routing this call
      // through pino while keeping the interpolation is the plausible wrong fix: it turns
      // the line into JSON and leaves F-247 exactly where it was.
      logger.error({ err: error }, 'afterCommit hook failed');
    }
  }

  return result;
}

/**
 * The rejected value is reported as a short prefix and a length, never in full
 * (F-132). On ADR-0021's capability-token routes it is an unauthenticated URL
 * segment, and this error is a plain Error, so TASK-007's filter logs its message:
 * unbounded attacker-controlled bytes would otherwise sit in the log store forever.
 * Eight characters is enough to recognise a truncated uuid or an obvious typo.
 */
const REPORTED_PREFIX_LENGTH = 8;

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(
      `Tenant id is not a uuid: ${JSON.stringify(value.slice(0, REPORTED_PREFIX_LENGTH))}` +
        `... (${String(value.length)} characters)`,
    );
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

/**
 * Throws InvalidTenantIdError. Called before every set_config of a tenant id.
 *
 * RETURNS THE CANONICAL FORM, which is lower case, and that is the value to compare
 * against anything Postgres returns (F-130): the regex accepts either casing, while
 * Postgres normalises `uuid` to lower case on output. Without this the nesting check
 * below is a case-sensitive compare that raises a spurious mismatch for one tenant
 * spelled two ways, and any later equality test against a row's `tenant_id`
 * disagrees silently.
 */
export function assertUuid(value: string): string {
  if (!UUID.test(value)) {
    throw new InvalidTenantIdError(value);
  }

  return value.toLowerCase();
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

  // F-121. Everything that reads the ambient context comes through here, which is
  // why the flag lives on the context and not on the handle.
  if (active.settled) {
    throw new TenantContextMissingError(CONTEXT_HAS_SETTLED);
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
