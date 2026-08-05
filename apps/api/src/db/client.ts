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
 * (TASK-029) and `privilegedTenantEraser` (TASK-054). TASK-056 asserts that list.
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
      // An idle pooled connection otherwise keeps the event loop alive on its own,
      // so a test run or a one-shot script finishes its work and then hangs.
      allowExitOnIdle: true,
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
 * `cause` is the driver's own error and whose message embeds the SQL text and every
 * bound parameter. Two reasons the wrapper does not leave this module:
 *
 *  - The driver's `code` is how a caller tells an RLS refusal (`42501`) from a
 *    unique violation. Reading it through the wrapper would make every caller
 *    depend on the ORM's error shape.
 *  - The wrapper's message carries bound parameters, so anything that serialises a
 *    caught error — a log line, an error envelope — would carry row values with it.
 *
 * Nothing is swallowed: the driver's error is the one Postgres raised, and it is
 * rethrown with its own stack.
 */
function unwrapDriverError(error: unknown): unknown {
  return error instanceof DrizzleQueryError && error.cause !== undefined ? error.cause : error;
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
