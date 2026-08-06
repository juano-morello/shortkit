/**
 * STORY-003 — AC-8, AC-9, AC-10, AC-11.
 *
 * Integration only, by ADR-0001 and test-strategy.md: row-level security cannot be
 * faked in a mock. A mocked repository proves the mock honours tenancy, not that
 * Postgres does. Every assertion here runs against a live Postgres 17, as the
 * `shortkit_app` role, which holds neither `SUPERUSER` nor `BYPASSRLS` — the
 * fixture refuses to run otherwise, because an exempt role makes all of it vacuous.
 *
 * Nothing here reaches for `tenantStorage`, the pool, or any other internal: the
 * subject is the contract in design/contracts/tenant-context.md plus the policy
 * template in design/contracts/rls-policy-template.md.
 *
 * ---------------------------------------------------------------------------
 * Round 1 rework, 2026-08-05. Everything below the six AC suites covers a finding:
 * F-120 (a driver error caught INSIDE fn), F-121 (a context that outlives its
 * transaction), F-123 (the pool), F-125 (a nested afterCommit hook that fires for
 * work that never happened), F-129 (the boot check's third property) and F-128,
 * which is the absence of coverage for contract invariants 4, 5 and 6 and for
 * AC-9's re-parenting case. Invariant 4 needs no database and lives in
 * `src/tenancy/tenant-context.spec.ts`; the rest need this harness.
 *
 * ⚠ ONE INTEGRATION FILE, ON PURPOSE. `test/support/rls-fixture.ts` drops and
 * recreates `tenants` and `rls_fixture_rows` per test, and vitest runs FILES in
 * parallel while running the tests inside one file sequentially. A second
 * `.int-spec.ts` sharing this fixture fails with `relation "rls_fixture_rows" does
 * not exist` roughly half the time — observed, not predicted. Splitting this file
 * needs `fileParallelism: false` in `vitest.integration.config.ts` first, which is
 * TASK-005's file rather than the test architect's.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  postgresErrorCode,
  postgresErrorConstraint,
} from '../../src/db/client';
import { assertRuntimeRoleCannotBypassRls } from '../../src/db/rls';
import type { TenantDb } from '../../src/tenancy/tenant-context';
import {
  TenantContextMismatchError,
  TenantContextMissingError,
  tenantDb,
  withTenantTransaction,
} from '../../src/tenancy/tenant-context';
import {
  appDsn,
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
  RLS_FIXTURE_TABLE,
  TENANT_A,
  TENANT_A_LABEL,
  TENANT_B,
  TENANT_B_LABEL,
} from '../support/rls-fixture';
import { querySql } from '../support/psql';

interface FixtureRow extends Record<string, unknown> {
  tenant_id: string;
  label: string;
}

/** Postgres `insufficient_privilege`, raised when a row fails a policy's WITH CHECK. */
const RLS_VIOLATION = '42501';

const FORGED_ROW_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ROLLED_BACK_ROW_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const table = sql.identifier(RLS_FIXTURE_TABLE);

/**
 * Deliberately unfiltered. The isolation under test is the database's, so a
 * `where tenant_id = ...` here would assert the query rather than the policy.
 */
async function visibleRows(db: TenantDb): Promise<FixtureRow[]> {
  const result = await db.execute<FixtureRow>(
    sql`select tenant_id, label from ${table} order by label`,
  );

  return result.rows;
}

async function rejectionOf(work: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { code: failure.code, message: failure.message ?? String(error) };
  }

  throw new Error('expected the call to reject, but it resolved');
}

function labelsOf(rows: FixtureRow[]): string[] {
  return rows.map((row) => row.label);
}

type Settled =
  | { readonly status: 'fulfilled'; readonly value: unknown }
  | { readonly status: 'rejected'; readonly reason: unknown };

/**
 * Records how a promise settled instead of letting it reject into the runner. The
 * detached work below is created inside a transaction and settles after it, so a
 * bare `rejects` matcher attached later races with the rejection itself.
 */
function settle(work: Promise<unknown>): Promise<Settled> {
  return work.then(
    (value): Settled => ({ status: 'fulfilled', value }),
    (reason: unknown): Settled => ({ status: 'rejected', reason }),
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;

  while (!condition() && Date.now() < until) {
    await sleep(100);
  }
}

describe('tenant-scoped persistence', () => {
  beforeAll(() => {
    assertAppRoleCannotBypassRls();
  });

  beforeEach(() => {
    createRlsFixture();
  });

  afterAll(() => {
    dropRlsFixture();
  });

  it("AC-8: a read inside tenant A's transaction returns A's row and not B's", async () => {
    const rows = await withTenantTransaction(TENANT_A, (db) => visibleRows(db));

    expect(rows).toEqual([{ tenant_id: TENANT_A, label: TENANT_A_LABEL }]);
  });

  it("AC-9: an insert carrying tenant B's tenant_id is refused inside tenant A's transaction", async () => {
    const failure = await rejectionOf(
      withTenantTransaction(TENANT_A, async (db) => {
        await db.execute(
          sql`insert into ${table} (id, tenant_id, label)
              values (${FORGED_ROW_ID}::uuid, ${TENANT_B}::uuid, ${'planted-by-tenant-a'})`,
        );
      }),
    );

    expect(failure.code).toBe(RLS_VIOLATION);

    const rowsOfB = await withTenantTransaction(TENANT_B, (db) => visibleRows(db));
    expect(rowsOfB).toEqual([{ tenant_id: TENANT_B, label: TENANT_B_LABEL }]);
  });

  it("AC-9: an update of tenant B's row affects zero rows inside tenant A's transaction", async () => {
    const affected = await withTenantTransaction(TENANT_A, async (db) => {
      const result = await db.execute(
        sql`update ${table} set label = ${'taken-over-by-tenant-a'} where tenant_id = ${TENANT_B}::uuid`,
      );

      return result.rowCount as number;
    });

    expect(affected).toBe(0);

    const rowsOfB = await withTenantTransaction(TENANT_B, (db) => visibleRows(db));
    expect(rowsOfB).toEqual([{ tenant_id: TENANT_B, label: TENANT_B_LABEL }]);
  });

  it("AC-9: re-parenting tenant A's own row to tenant B is refused inside tenant A's transaction", async () => {
    // F-128. The update above is refused by USING, which never lets tenant A's
    // statement see B's row. This one is the other half of AC-9: the row is A's, so
    // USING admits it and only WITH CHECK stands between a tenant and moving its own
    // data under another tenant's id. A policy written with USING alone passes every
    // other test in this file and fails this one.
    const failure = await rejectionOf(
      withTenantTransaction(TENANT_A, async (db) => {
        await db.execute(
          sql`update ${table} set tenant_id = ${TENANT_B}::uuid where tenant_id = ${TENANT_A}::uuid`,
        );
      }),
    );

    expect(failure.code).toBe(RLS_VIOLATION);

    const rowsOfA = await withTenantTransaction(TENANT_A, (db) => visibleRows(db));
    expect(rowsOfA).toEqual([{ tenant_id: TENANT_A, label: TENANT_A_LABEL }]);

    const rowsOfB = await withTenantTransaction(TENANT_B, (db) => visibleRows(db));
    expect(rowsOfB).toEqual([{ tenant_id: TENANT_B, label: TENANT_B_LABEL }]);
  });

  it('AC-10: a read issued outside any tenant-context transaction returns zero rows', () => {
    // The table is seeded, so zero rows below is the policy denying, not an empty
    // table. Read through the owner with a context set, since FORCE ROW LEVEL
    // SECURITY subjects the owner to the policy too.
    const seeded = querySql<{ label: string }>(
      migrationDsn(),
      `select label from ${RLS_FIXTURE_TABLE}`,
      { tenantId: TENANT_A },
    );
    expect(seeded).toEqual([{ label: TENANT_A_LABEL }]);

    const withoutContext = querySql<FixtureRow>(
      appDsn(),
      `select tenant_id, label from ${RLS_FIXTURE_TABLE}`,
    );

    expect(withoutContext).toEqual([]);
  });

  it('AC-11: a throw inside the wrapped function rolls the transaction back', async () => {
    const boom = new Error('deliberate failure inside the tenant transaction');

    const failure = await rejectionOf(
      withTenantTransaction(TENANT_A, async (db) => {
        await db.execute(
          sql`insert into ${table} (id, tenant_id, label)
              values (${ROLLED_BACK_ROW_ID}::uuid, ${TENANT_A}::uuid, ${'written-then-rolled-back'})`,
        );

        throw boom;
      }),
    );
    expect(failure.message).toBe(boom.message);

    const rowsOfA = await withTenantTransaction(TENANT_A, (db) => visibleRows(db));
    expect(rowsOfA).toEqual([{ tenant_id: TENANT_A, label: TENANT_A_LABEL }]);
  });

  it('AC-11: tenant context does not leak to the next transaction after a throw', async () => {
    const boom = new Error('deliberate failure inside the tenant transaction');

    await rejectionOf(
      withTenantTransaction(TENANT_A, async () => {
        throw boom;
      }),
    );

    // Sequential use returns the same pooled connection, so this is the read that
    // catches a session-level `SET`, or an AsyncLocalStorage store left un-exited
    // by the failed transaction.
    const rowsOfB = await withTenantTransaction(TENANT_B, (db) => visibleRows(db));

    expect(rowsOfB).toEqual([{ tenant_id: TENANT_B, label: TENANT_B_LABEL }]);
  });
});

/**
 * F-120. drizzle wraps a failed statement in `DrizzleQueryError` at the STATEMENT
 * boundary; `databaseTransaction` unwraps it at the TRANSACTION boundary. Everything
 * caught inside `fn` therefore still holds the wrapper, whose `code` is `undefined`
 * and whose `message` is `Failed query: ${query}\nparams: ${params}` — the SQL text
 * and every bound value.
 *
 * The caller this exists to protect is TASK-025's collision loop, whose shape is
 * fixed by design/contracts/slug.md: `SAVEPOINT slug_try`, insert, catch `23505` on a
 * named constraint, `ROLLBACK TO SAVEPOINT`, redraw. The catch is inside `fn`, so the
 * loop cannot tell a collision it must retry from a failure it must surface.
 *
 * The two accessors are normative in tenant-context.md, "Driver errors inside `fn`".
 */
describe('a database error caught inside the wrapped function', () => {
  const COLLIDING_ROW_ID = '77777777-7777-4777-8777-777777777777';
  const REDRAWN_ROW_ID = '88888888-8888-4888-8888-888888888888';
  const REDRAWN_LABEL = 'redrawn-after-the-collision';

  /**
   * Read off the constraint the fixture's `id uuid PRIMARY KEY` produces, not computed
   * from the table name: `slug.md`'s loop compares the constraint by name, so an
   * accessor that returned the table, the index or `undefined` must fail here.
   */
  const VIOLATED_CONSTRAINT = 'rls_fixture_rows_pkey';

  beforeEach(() => {
    createRlsFixture();
  });

  afterAll(() => {
    dropRlsFixture();
  });

  it('F-120: a unique violation caught inside fn reads as 23505 on a named constraint through the accessors', async () => {
    const seenInsideFn: { code?: string; constraint?: string }[] = [];

    const outcome = await withTenantTransaction(TENANT_A, async (db) => {
      await db.execute(sql`savepoint slug_try`);
      await db.execute(
        sql`insert into ${table} (id, tenant_id, label)
            values (${COLLIDING_ROW_ID}::uuid, ${TENANT_A}::uuid, ${'first-draw'})`,
      );

      try {
        // The same primary key twice: a real 23505 from a real constraint, which is
        // the same class of failure `links_domain_id_slug_unique` raises on a slug
        // collision. Nothing is faked, so the error has the shape a caller really sees.
        await db.execute(
          sql`insert into ${table} (id, tenant_id, label)
              values (${COLLIDING_ROW_ID}::uuid, ${TENANT_A}::uuid, ${'second-draw'})`,
        );

        return 'the insert did not collide';
      } catch (error) {
        seenInsideFn.push({
          code: postgresErrorCode(error),
          constraint: postgresErrorConstraint(error),
        });

        await db.execute(sql`rollback to savepoint slug_try`);
        await db.execute(
          sql`insert into ${table} (id, tenant_id, label)
              values (${REDRAWN_ROW_ID}::uuid, ${TENANT_A}::uuid, ${REDRAWN_LABEL})`,
        );

        return 'redrawn';
      }
    });

    expect(seenInsideFn).toEqual([{ code: '23505', constraint: VIOLATED_CONSTRAINT }]);
    expect(outcome).toBe('redrawn');

    // The loop recovered inside the same transaction and the transaction committed:
    // an accessor that reported the code but left the caller unable to continue would
    // satisfy the first assertion and not this one.
    const rows = await withTenantTransaction(TENANT_A, (db) => visibleRows(db));
    expect(labelsOf(rows)).toContain(REDRAWN_LABEL);
  });
});

/**
 * F-121. `tenantStorage.run` binds INSIDE the `databaseTransaction` callback, so the
 * store and the handle it carries outlive the transaction. Node keeps that store
 * visible to every continuation descended from inside the callback — which is what a
 * fire-and-forget `void this.warmCache()` inside `fn` is — and `pg` does not disable
 * `query` on a released client. The continuation therefore reaches a connection the
 * pool has already handed on.
 */
describe('the tenant context after its transaction has settled', () => {
  /**
   * Runs `work` in a continuation registered INSIDE a tenant transaction and resolved
   * only after that transaction has returned. This is the ordinary shape of the bug:
   * an unawaited promise chain started in `fn`, resuming after COMMIT.
   */
  async function afterTheTransactionSettles(work: () => Promise<unknown>): Promise<Settled> {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    let detached: Promise<Settled> | undefined;

    await withTenantTransaction(TENANT_A, async () => {
      detached = settle(gate.then(work));
    });

    open();

    if (detached === undefined) {
      throw new Error('the detached continuation was never registered');
    }

    return detached;
  }

  it('F-121: reading the ambient context from a continuation that resumes after COMMIT throws', async () => {
    // `tenantDb()`, not the `db` argument: F-121's guard belongs on the path
    // everything else uses, since `fn` holds its own handle directly and no flag on
    // this module can take that away from it.
    const outcome = await afterTheTransactionSettles(async () => {
      const result = await tenantDb().execute(sql`select 1 as reached_the_database`);
      return result.rows;
    });

    expect(outcome).toEqual({
      status: 'rejected',
      reason: expect.any(TenantContextMissingError),
    });
  });

  it('F-121: a nested withTenantTransaction that resumes after COMMIT does not reuse the settled transaction', async () => {
    // The reuse branch opens no BEGIN and issues no set_config, so this is the path
    // that runs a tenant-scoped statement with no transaction and no context flag at
    // all — GC-5's hole, reached without touching anything the contract forbids.
    const outcome = await afterTheTransactionSettles(async () =>
      withTenantTransaction(TENANT_A, async (db) => {
        const result = await db.execute(sql`select 1 as reached_the_database`);
        return result.rows;
      }),
    );

    expect(outcome).toEqual({
      status: 'rejected',
      reason: expect.any(TenantContextMissingError),
    });
  });
});

/**
 * Contract invariant 5, which had no coverage (F-128), and F-125, which is a live
 * defect inside it: a nested frame registers its `afterCommit` hook before its `fn`
 * runs, so the hook still fires when that `fn` throws and the outer frame swallows
 * the throw.
 */
describe('nested tenant transactions', () => {
  const NESTED_ROW_ID = '55555555-5555-4555-8555-555555555555';
  const OUTER_ROW_ID = '66666666-6666-4666-8666-666666666666';

  beforeEach(() => {
    createRlsFixture();
  });

  afterAll(() => {
    dropRlsFixture();
  });

  it('invariant 5: a nested frame runs inside the outer transaction and sees its uncommitted writes', async () => {
    const seenByTheNestedFrame = await withTenantTransaction(TENANT_A, async (outer) => {
      await outer.execute(
        sql`insert into ${table} (id, tenant_id, label)
            values (${OUTER_ROW_ID}::uuid, ${TENANT_A}::uuid, ${'written-by-the-outer-frame'})`,
      );

      return withTenantTransaction(TENANT_A, (db) => visibleRows(db));
    });

    // A second transaction on a second connection could not see this row: it is not
    // committed yet. Seeing it is what "reuses the outer transaction" means.
    expect(labelsOf(seenByTheNestedFrame)).toContain('written-by-the-outer-frame');
  });

  it('invariant 5: statements a nested frame issued commit with the outer, because nesting opens no savepoint', async () => {
    await withTenantTransaction(TENANT_A, async () => {
      try {
        await withTenantTransaction(TENANT_A, async (db) => {
          await db.execute(
            sql`insert into ${table} (id, tenant_id, label)
                values (${NESTED_ROW_ID}::uuid, ${TENANT_A}::uuid, ${'written-by-a-nested-frame'})`,
          );

          throw new Error('the nested frame failed after its write');
        });
      } catch {
        // The outer frame builds a partial-success response, as it is entitled to.
      }
    });

    // A savepoint around the nested frame would have taken this row back. Nesting
    // opens none, and F-125's repair must not introduce one to get its own test green.
    const rows = await withTenantTransaction(TENANT_A, (db) => visibleRows(db));
    expect(labelsOf(rows)).toContain('written-by-a-nested-frame');
  });

  it('invariant 5: nesting a different tenant id throws TenantContextMismatchError', async () => {
    let innerRan = false;

    await expect(
      withTenantTransaction(TENANT_A, async () =>
        withTenantTransaction(TENANT_B, async () => {
          innerRan = true;
          return 'never';
        }),
      ),
    ).rejects.toBeInstanceOf(TenantContextMismatchError);

    expect(innerRan).toBe(false);
  });

  it('F-125: a nested afterCommit hook does not run when the nested frame throws', async () => {
    const hooksThatRan: string[] = [];
    const swallowed: string[] = [];

    await withTenantTransaction(TENANT_A, async () => {
      try {
        await withTenantTransaction(
          TENANT_A,
          async () => {
            throw new Error('the nested frame failed before writing anything');
          },
          {
            afterCommit: () => {
              hooksThatRan.push('nested');
            },
          },
        );
      } catch (error) {
        swallowed.push((error as Error).message);
      }

      return 'partial success';
    });

    expect(swallowed).toEqual(['the nested frame failed before writing anything']);

    // In production that hook is `sendInviteMail` and the row it announces was never
    // inserted. The top-level path already behaves this way: a throw rolls back and
    // no hook runs.
    expect(hooksThatRan).toEqual([]);
  });
});

/**
 * Contract invariant 6, which had no coverage (F-128): `afterCommit` runs exactly
 * once, after COMMIT returns; a throw in it is logged, does not propagate, and does
 * not affect the committed transaction.
 */
describe('afterCommit', () => {
  const COMMITTED_ROW_ID = '44444444-4444-4444-8444-444444444444';
  const COMMITTED_LABEL = 'committed-before-the-hook-ran';

  beforeEach(() => {
    createRlsFixture();
  });

  afterAll(() => {
    dropRlsFixture();
  });

  it('invariant 6: afterCommit runs exactly once, and the transaction is committed by then', async () => {
    const rowsVisibleToTheHook: FixtureRow[][] = [];

    await withTenantTransaction(
      TENANT_A,
      async (db) => {
        await db.execute(
          sql`insert into ${table} (id, tenant_id, label)
              values (${COMMITTED_ROW_ID}::uuid, ${TENANT_A}::uuid, ${COMMITTED_LABEL})`,
        );
      },
      {
        // A separate transaction on a separate connection. It can only see the row if
        // COMMIT has already returned, which is what "after COMMIT" has to mean for
        // the third-party I/O this hook exists to carry.
        afterCommit: async () => {
          rowsVisibleToTheHook.push(await withTenantTransaction(TENANT_A, (db) => visibleRows(db)));
        },
      },
    );

    expect(rowsVisibleToTheHook).toHaveLength(1);
    expect(labelsOf(rowsVisibleToTheHook[0] ?? [])).toContain(COMMITTED_LABEL);
  });

  it('invariant 6: afterCommit does not run when fn throws', async () => {
    const hooksThatRan: string[] = [];

    await rejectionOf(
      withTenantTransaction(
        TENANT_A,
        async (db) => {
          await db.execute(
            sql`insert into ${table} (id, tenant_id, label)
                values (${COMMITTED_ROW_ID}::uuid, ${TENANT_A}::uuid, ${COMMITTED_LABEL})`,
          );

          throw new Error('deliberate failure after the write');
        },
        {
          afterCommit: () => {
            hooksThatRan.push('top-level');
          },
        },
      ),
    );

    expect(hooksThatRan).toEqual([]);

    const rows = await withTenantTransaction(TENANT_A, (db) => visibleRows(db));
    expect(labelsOf(rows)).not.toContain(COMMITTED_LABEL);
  });

  it('invariant 6: a throw inside afterCommit does not reach the caller or the committed work', async () => {
    const result = await withTenantTransaction(
      TENANT_A,
      async (db) => {
        await db.execute(
          sql`insert into ${table} (id, tenant_id, label)
              values (${COMMITTED_ROW_ID}::uuid, ${TENANT_A}::uuid, ${COMMITTED_LABEL})`,
        );

        return 'the caller result';
      },
      {
        afterCommit: () => {
          throw new Error('the hook failed after the transaction had committed');
        },
      },
    );

    expect(result).toBe('the caller result');

    const rows = await withTenantTransaction(TENANT_A, (db) => visibleRows(db));
    expect(labelsOf(rows)).toContain(COMMITTED_LABEL);
  });
});

/**
 * F-123. The pool is built with `allowExitOnIdle` and nothing else: no `'error'`
 * listener, no `max`, no `connectionTimeoutMillis`.
 */
describe('the connection pool', () => {
  /** Long enough for a closed socket to surface in the client; the kill itself is confirmed server-side first. */
  const SOCKET_GRACE_MS = 1000;

  function backendExists(pid: number): boolean {
    const [row] = querySql<{ present: boolean }>(
      migrationDsn(),
      `select count(*) > 0 as present from pg_stat_activity where pid = ${String(pid)}`,
    );

    return row?.present === true;
  }

  it('F-123: an error on an idle pooled connection is handled instead of taking the process down', async () => {
    // A pg `DatabaseError` serialises its socket, its connection parameters and its
    // buffers, so the projection is what keeps a failure here readable.
    const fatal: string[] = [];
    const capture = (error: unknown): void => {
      fatal.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    };

    // Without this listener the assertion below cannot be written at all: Node
    // rethrows an unhandled `'error'` event, so the failure is the runner dying
    // rather than a test reporting. The listener is the observation, not the fix —
    // the fix is `pool.on('error', ...)` inside client.ts.
    process.on('uncaughtException', capture);

    try {
      const pid = await withTenantTransaction(TENANT_A, async (db) => {
        // The routine trigger F-123 names: ADR-0002 targets Neon, which drops idle
        // connections on scale-to-zero. A restart, a failover and this setting all
        // reach the client the same way — a FATAL on a connection sitting in the pool.
        await db.execute(sql`select set_config('idle_session_timeout', '500', false)`);

        const result = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        return result.rows[0]?.pid;
      });

      expect(pid).toBeTypeOf('number');

      await waitUntil(() => !backendExists(pid as number), 15_000);
      expect(backendExists(pid as number)).toBe(false);
      await sleep(SOCKET_GRACE_MS);

      expect(fatal).toEqual([]);

      // ...and the pool still serves. An error listener that logged but left the dead
      // client in the pool would satisfy the assertion above and fail this one.
      await expect(
        withTenantTransaction(TENANT_A, async () => 'served after the connection died'),
      ).resolves.toBe('served after the connection died');
    } finally {
      process.off('uncaughtException', capture);
    }
  }, 60_000);

  it('F-123: an exhausted pool fails the attempts it cannot serve rather than waiting forever', async () => {
    /** Above any `max` a single API instance should hold against a Neon pooled endpoint. */
    const CONCURRENT = 40;
    /**
     * A connection acquisition that has not resolved in six seconds is not a bounded
     * failure by any definition an HTTP request can use — the default
     * `statement_timeout` this module sets is five.
     */
    const WINDOW_MS = 6000;

    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    let acquired = 0;
    const failures: unknown[] = [];

    const attempts = Array.from({ length: CONCURRENT }, () =>
      withTenantTransaction(TENANT_A, async () => {
        acquired += 1;
        await gate;
        return 'held a connection';
      }).catch((reason: unknown) => {
        failures.push(reason);
        return 'never got a connection';
      }),
    );

    await waitUntil(() => acquired + failures.length === CONCURRENT, WINDOW_MS);

    const stillWaitingForAConnection = CONCURRENT - acquired - failures.length;

    open();
    await Promise.all(attempts);

    // Some transactions must have run: a pool that fails everything would satisfy the
    // assertion below and serve nobody.
    expect(acquired).toBeGreaterThan(0);

    // Every attempt has either been served or been told it cannot be. None is still
    // waiting with no error and no timeout, which is what `connectionTimeoutMillis: 0`
    // means for the eleventh concurrent request.
    expect(stillWaitingForAConnection).toBe(0);

    for (const reason of failures) {
      expect(reason).toBeInstanceOf(Error);
    }
  }, 60_000);
});

/**
 * F-129. ADR-0003 states the problem as "TASK-005 already forbids BYPASSRLS;
 * ownership is the part that gets missed", and the shipped check reads
 * `rolbypassrls` and `is_superuser` only. A table's owner is exempt from its policies
 * wherever `FORCE ROW LEVEL SECURITY` is absent, and that line is hand-appended per
 * table with nothing verifying it (F-122).
 */
describe('the boot-time runtime-role assertion', () => {
  interface RolePrivileges extends Record<string, unknown> {
    role: string;
    superuser: boolean;
    bypassrls: boolean;
    tables_owned_in_public: number;
  }

  const ROLE_PRIVILEGES = `
    select current_user                           as role,
           current_setting('is_superuser') = 'on' as superuser,
           rolbypassrls                           as bypassrls,
           (select count(*)::int
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public'
               and c.relkind = 'r'
               and c.relowner = current_user::regrole) as tables_owned_in_public
      from pg_roles
     where rolname = current_user`;

  function privilegesOf(dsn: string): RolePrivileges | undefined {
    return querySql<RolePrivileges>(dsn, ROLE_PRIVILEGES)[0];
  }

  /**
   * `client.ts` reads `DATABASE_URL` once and caches the pool, and exports no way to
   * point it somewhere else — `closeDatabase()` is the seam. Restored in `finally`,
   * and the pool is dropped again on the way out so the next test rebuilds it against
   * the runtime role.
   */
  async function connectedAs<T>(dsn: string, work: () => Promise<T>): Promise<T> {
    const original = process.env.DATABASE_URL;

    await closeDatabase();
    process.env.DATABASE_URL = dsn;

    try {
      return await work();
    } finally {
      await closeDatabase();
      process.env.DATABASE_URL = original;
    }
  }

  beforeEach(() => {
    createRlsFixture();
  });

  afterAll(() => {
    dropRlsFixture();
  });

  it('F-129: the boot check refuses a role that owns tables in schema public', async () => {
    const migrator = privilegesOf(migrationDsn());

    // Stated first so the rejection below can only be about ownership: this role is
    // clean on both properties the check already reads.
    expect(migrator).toMatchObject({ superuser: false, bypassrls: false });
    expect(migrator?.tables_owned_in_public).toBeGreaterThan(0);

    const outcome = await connectedAs(migrationDsn(), () =>
      settle(assertRuntimeRoleCannotBypassRls()),
    );

    expect(outcome.status).toBe('rejected');
  });

  it('F-129: the boot check accepts the runtime role, which owns nothing', async () => {
    expect(privilegesOf(appDsn())).toMatchObject({
      superuser: false,
      bypassrls: false,
      tables_owned_in_public: 0,
    });

    // The other half of F-129: a check that counted every table rather than the ones
    // `current_user` owns would refuse the role the API actually connects as, and the
    // process would exit non-zero on a correctly provisioned database.
    await expect(assertRuntimeRoleCannotBypassRls()).resolves.toBeUndefined();
  });
});
