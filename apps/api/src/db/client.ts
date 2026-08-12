/**
 * Contract: design/contracts/tenant-context.md
 * ADR: adr-0002-tenant-context-binding.md
 * Produced by: TASK-005
 *
 * THE ONLY FILE THAT CONSTRUCTS THE DRIZZLE CLIENT, AND IT DOES NOT EXPORT IT.
 *
 * An exported client is a query path that reaches every tenant's rows with no
 * transaction and no context flag, which is the hole GC-5 exists to close. What
 * leaves this module is `databaseTransaction`, and its only sanctioned callers are
 * `withTenantTransaction` (tenancy/tenant-context.ts), `withRedirectRead`
 * (TASK-029), `privilegedTenantEraser` (TASK-054) and
 * `assertRuntimeRoleCannotBypassRls` (db/rls.ts). TASK-056 asserts that list.
 *
 * The fourth entry was added 2026-08-05 (F-126). The boot check reads pg_roles and
 * pg_class before the app accepts traffic, so it runs no tenant-scoped statement;
 * it is on the list because an enumeration that is silently untrue is worse than a
 * longer one. The guarantee is not that `databaseTransaction` is unreachable — any
 * module can import it — but that a transaction opened without a context flag sees
 * zero rows and can write none, which is fail-closed by policy.
 * `design/contracts/tenant-context.md` still names three; that file is the
 * architect's and the amendment is reported rather than made here.
 *
 * Driver: `pg` with `drizzle-orm/node-postgres` (ADR-0002). Not
 * `@neondatabase/serverless`: its HTTP driver takes a transaction as an array of
 * statements decided up front, and GC-5 needs an interactive transaction whose
 * statements the application chooses as it runs.
 */
import { DrizzleQueryError } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import pg from 'pg';

import { logger } from '../observability/logger';
import * as schema from './schema';

/** An open transaction on the runtime connection. Carries no tenant context yet. */
export type DatabaseTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Built on first use, not at import. `apps/api` is imported by unit suites that
 * never reach a database and by `vitest.config.ts`'s module graph, and a pool
 * constructed at import would make every one of them require DATABASE_URL.
 */
let pool: pg.Pool | undefined;
let database: NodePgDatabase<typeof schema> | undefined;

/**
 * Connections this process holds open against Neon's pooled endpoint (ADR-0002).
 *
 * Ten is `pg`'s own default, written out because it is a capacity decision rather
 * than a default worth inheriting silently. A tenant transaction holds its
 * connection for the whole request (ADR-0002's accepted cost), so this is the
 * dashboard API's concurrency limit, per instance. Neon's pooler multiplexes many
 * client connections onto far fewer Postgres backends, and the smallest compute
 * sizes cap those backends in the low hundreds — so the number that has to stay
 * small is this one, multiplied by the number of Fly machines, not the pooler's.
 * Raising it trades a bounded queue for a longer one; it does not create capacity.
 */
const POOL_MAX = 10;

/**
 * How long an acquisition waits before it fails (F-123). Zero — `pg`'s default —
 * means the eleventh concurrent transaction waits forever with no error and no
 * timeout, so the process looks alive and the platform health check passes while
 * requests hang.
 *
 * Two seconds, deliberately under the 5 s `statement_timeout` this module's callers
 * set: waiting for a connection is dead time before any work starts, so it should
 * expire well inside the budget the request itself has.
 */
const CONNECTION_TIMEOUT_MS = 2000;

/**
 * The one log line both connection-error listeners write, and since 2026-08-11 it goes
 * through the shared pino instance (AC-116, F-278). It used to go through
 * `new Logger('Database')` from `@nestjs/common`, which reaches neither `LOGGABLE_FIELDS`
 * nor `serializers.err`: an ANSI-coloured, locale-clocked line on the same descriptor the
 * JSON goes to, with no `level`, no `service`, no `env` and no ISO timestamp on it. That
 * was the whole of this site's defect — the CONTENT was already within policy — and it is
 * the benign half of F-278. The leaking half was `tenancy/tenant-context.ts`.
 *
 * Name and SQLSTATE and nothing else: tenant-context.md rule 2 closes the readable fields
 * of a caught database error to that allowlist and does not exempt a connection-level
 * error. `detail`, `where` and `internalQuery` carry row values and SQL text and are not
 * read here; passing the error under `err` is what keeps them off the line, because
 * `serializers.err` reduces it to `err_name` and `err_stack` rather than copying its own
 * enumerable properties the way pino's default serialiser does (F-244).
 *
 * THE NAME IS A POLICY FIELD AND THE SQLSTATE IS NOT, which is why one is on the record
 * and the other is in `msg`. `LOGGABLE_FIELDS` has no name for a SQLSTATE, and adding one
 * is an edit to `logging-and-headers.md`'s normative fence, which is the architect's file.
 * A SQLSTATE is a five-character code from a closed vocabulary and `where` is one of two
 * module-literal strings, so nothing a caller or a driver controls is interpolated here —
 * which is the property ADR-0028's message-position ruling is about, not the position.
 *
 * On a connection that died while idle in the pool both listeners fire, because the
 * client carries the 'connect' listener and pg-pool re-attaches its idle one. Two
 * lines for one failure is the accepted cost of covering both states.
 */
function discardedConnection(where: string, error: Error): void {
  logger.warn(
    { err: error },
    `${where} failed and was discarded (sqlstate ${postgresErrorCode(error) ?? 'none'})`,
  );
}

function connectionString(): string {
  const value = process.env.DATABASE_URL;

  if (value === undefined || value.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set. It authenticates as shortkit_app, the runtime role ' +
        'that owns nothing and holds no BYPASSRLS (ADR-0003).',
    );
  }

  return value;
}

function client(): NodePgDatabase<typeof schema> {
  if (database === undefined) {
    pool = new pg.Pool({
      connectionString: connectionString(),
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      // An idle pooled connection otherwise keeps the event loop alive on its own,
      // so a test run or a one-shot script finishes its work and then hangs.
      allowExitOnIdle: true,
    });

    // A connection sitting IDLE IN THE POOL (F-123). `pg-pool` has already removed
    // that client by the time it emits, so there is nothing to clean up and nobody
    // to reject; logging and discarding is the whole handler. Without a listener
    // Node turns the emit into an uncaughtException and the API exits, and the
    // trigger is routine rather than exotic: ADR-0002 targets Neon, which terminates
    // idle connections when a compute scales to zero, as do restarts, failovers and
    // idle_session_timeout.
    pool.on('error', (error: Error) => {
      discardedConnection('idle pooled connection', error);
    });

    // A connection that dies while it is CHECKED OUT (F-137). Different event,
    // different listener, and `pool.on('error')` above does not cover it: that one
    // is attached through pg-pool's makeIdleListener and only while the client is in
    // the pool. pg-pool removes it in _acquireClient, and drizzle's
    // NodePgSession.transaction attaches nothing of its own, so a client in the
    // middle of a transaction has NO error listener at all. Postgres killing that
    // backend — a Neon scale-to-zero, a failover, a restart, or the
    // idle_in_transaction_session_timeout withTenantTransaction sets — reaches
    // client.emit('error') with nobody listening, and Node takes the process down.
    //
    // 'connect', not 'acquire': pg-pool emits 'connect' once per newly created
    // client, so the listener survives every later checkout, and pg-pool never
    // removes a listener it did not add. 'acquire' fires on every checkout and would
    // stack one listener per use.
    //
    // The in-flight statement is not rescued and is not meant to be: `pg` rejects it
    // separately and the caller sees a connection failure. This listener exists so
    // that failure stays a rejected promise instead of a dead process.
    pool.on('connect', (checkedOut: pg.PoolClient) => {
      checkedOut.on('error', (error: Error) => {
        discardedConnection('checked-out connection', error);
      });
    });

    database = drizzle(pool, { schema });
  }

  return database;
}

/**
 * Opens a transaction and hands it to `fn`. Commits when `fn` resolves, rolls back
 * and rethrows the original error when it throws.
 *
 * This sets no context flag: a transaction opened here sees zero rows on every
 * tenant-scoped table until its caller sets one. Callers are enumerated above.
 */
export async function databaseTransaction<T>(
  fn: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await client().transaction(fn);
  } catch (error) {
    throw unwrapDriverError(error);
  }
}

/**
 * drizzle-orm 0.44 began wrapping a failed statement in `DrizzleQueryError`, whose
 * `cause` is the driver's own error and whose message is the literal
 * `Failed query: ${query}\nparams: ${params}` — the SQL text and every bound value.
 *
 * CORRECTED 2026-08-05 (F-120). THE WRAPPER DOES LEAVE THIS MODULE. drizzle wraps at
 * the STATEMENT boundary and this unwrap runs at the TRANSACTION boundary, so a
 * `catch` inside `fn` sits between the two and holds the wrapper — with `code` and
 * `constraint` undefined and the bound parameters in `message`. The previous comment
 * here claimed the opposite and downstream TASKs read it. Unwrapping at the
 * transaction boundary is still right for the error a caller of
 * `withTenantTransaction` receives (contract invariant 2), and it is not sufficient:
 * `postgresErrorCode` and `postgresErrorConstraint` below are what make a caught
 * database error the same shape at every catch site, inside `fn` or outside it.
 *
 * Nothing is swallowed: the driver's error is the one Postgres raised, and it is
 * rethrown with its own stack.
 */
function unwrapDriverError(error: unknown): unknown {
  return error instanceof DrizzleQueryError && error.cause !== undefined ? error.cause : error;
}

/**
 * The driver's own error behind whatever was caught, or undefined when what was
 * caught did not come from the driver at all. A `catch` block binds whatever was
 * thrown — including `undefined`, `null` and strings — so this answers for all of
 * them rather than throwing a second error out of the caller's catch.
 *
 * THE ONLY PLACE IN apps/api THAT NAMES `DrizzleQueryError` OR `pg.DatabaseError`
 * (tenant-context.md, "What the implementer must guarantee"). A second unwrap site
 * is a second place to get it wrong.
 */
function driverError(error: unknown): pg.DatabaseError | undefined {
  const unwrapped = unwrapDriverError(error);

  return unwrapped instanceof pg.DatabaseError ? unwrapped : undefined;
}

/**
 * The five-character SQLSTATE of a caught database error, or undefined when it is
 * not one. Normative in design/contracts/tenant-context.md, "Driver errors inside
 * `fn`": every catch that branches on a Postgres condition goes through here, and
 * reading `.code` off a caught error directly is a defect — inside `fn` a silent
 * one, because the branch simply never matches.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  return driverError(error)?.code;
}

/**
 * The name of the constraint or unique index the statement violated, or undefined
 * when the driver reported none. `23505` alone does not say WHICH constraint fired,
 * and both callers that need this — slug.md's collision loop and
 * domain-provisioning.md's verify transition — must retry on one named constraint
 * and surface everything else.
 *
 * The constraint name is a schema identifier and carries no row values. The fields
 * that do — `detail`, `where`, `internalQuery` — are outside the allowlist and this
 * module exposes no accessor for them.
 */
export function postgresErrorConstraint(error: unknown): string | undefined {
  return driverError(error)?.constraint;
}

/**
 * Releases the pool. Called from shutdown and from a script that has finished its
 * work; the process otherwise exits only because `allowExitOnIdle` lets it.
 */
export async function closeDatabase(): Promise<void> {
  const open = pool;

  pool = undefined;
  database = undefined;

  await open?.end();
}
