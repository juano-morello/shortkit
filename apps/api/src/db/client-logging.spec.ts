import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * AC-116, SITE 3 — F-278. The two connection-error lines `db/client.ts` writes.
 *
 * Contract: `docs/contracts/logging-and-headers.md`, "Consumed by: every API TASK.
 * Nothing may opt out"; `docs/contracts/tenant-context.md` rule 2, which closes the
 * readable fields of a caught database error to name and SQLSTATE. Enforces GC-9.
 *
 * ============================================================================
 * THIS IS THE BENIGN HALF, AND IT IS TESTED APART FROM SITE 1 ON PURPOSE
 * ============================================================================
 *
 * `client.ts:55` constructs `new Logger('Database')` from `@nestjs/common` and
 * `discardedConnection` at line 93 writes through it. The CONTENT of that line is already
 * within policy — the error's name and its SQLSTATE and nothing else, which is what
 * `tenant-context.md` rule 2 allows — so the defect here is the PIPELINE alone, not a leak.
 *
 * Grading this together with `tenancy/tenant-context.ts:247` is what made F-243 clause 3
 * read as "two stale logger comments" for six days while a raw `error.message` sat on a
 * per-request tenant path. So it has its own file, its own harness and its own assertions,
 * and the assertions here are about structure and diagnostic value rather than about a
 * leak. The leak assertions live in `src/tenancy/tenant-context-logging.spec.ts`.
 *
 * What this site still owes AC-116: the line must come out of the pino instance registered
 * at the composition root, so an operator can filter it by `level`, correlate it by
 * `service` and `env`, and get a timestamp that is not a locale-formatted clock. And what
 * no fix may spend to get there: the two connection states have to stay distinguishable —
 * `client.ts` writes TWO lines for one dead connection by design, because both listeners
 * fire when a pooled client dies idle — and the SQLSTATE has to survive, because it is the
 * only thing on the line that says what Postgres did.
 *
 * ============================================================================
 * HOW, AND WHAT IS FAKED
 * ============================================================================
 *
 * `discardedConnection` is module-private and its only two entry points are the listeners
 * `client()` attaches to the pool. So the child builds the real pool through the real
 * `databaseTransaction` — the only thing that reaches `client()` — and then fires the two
 * events `pg` fires: `pool.on('error')` for a connection that died IDLE IN THE POOL
 * (F-123), and the `client.on('error')` that `pool.on('connect')` installs for one that
 * died while CHECKED OUT (F-137).
 *
 * THE ONLY THING REPLACED IS THE SOCKET. `OfflinePool` extends the REAL `pg.Pool`, so it is
 * the object drizzle expects and the object whose events `client.ts` subscribes to; only
 * `connect()` is overridden. `client.ts` reads `pg.Pool` lazily inside `client()`, so the
 * swap lands before the pool is built. Postgres is a genuine external boundary and
 * `pnpm test` runs from a clean clone with no database (ADR-0001).
 *
 * BOTH STREAMS ARE COLLECTED. Measured on @nestjs/common 11.1.28: `ConsoleLogger` routes
 * `error` and `fatal` to fd 2 and every other level, `warn` included, to fd 1. Reading one
 * descriptor would make the harness depend on which level a fix picks, and a line that
 * moved streams would look like a line that vanished — which turns every assertion below
 * into a vacuous pass. `LOG_LEVEL=trace` for the same reason.
 */

/**
 * `pg.DatabaseError.detail`. Postgres puts the offending ROW in it on a constraint
 * violation, so it is outside `tenant-context.md` rule 2's allowlist and outside
 * `LOGGABLE_FIELDS`. Here to catch a "fix" that spreads the driver error onto the record.
 */
const DRIVER_DETAIL_MARKER = 'driver-detail-row-data-marker';

/** `pg.DatabaseError.internalQuery`. The SQL text, with its literals. Outside the same allowlist. */
const DRIVER_INTERNAL_QUERY_MARKER = 'driver-internal-query-marker';

/**
 * `57P01`, `admin_shutdown`. What Neon raises when a compute scales to zero, which is the
 * trigger `client.ts` names for both listeners. Hand-written rather than read off the error.
 */
const SQLSTATE = '57P01';

/** `base` on the registered instance, hand-copied from `logging-and-headers.md`'s fence. */
const SERVICE = 'shortkit-api';

/** How `client.ts` names the two connection states. An operator needs to keep telling them apart. */
const IDLE_POOLED = 'idle pooled connection';
const CHECKED_OUT = 'checked-out connection';

interface Observations {
  /** `databaseTransaction`'s return value: proof the pool was built and the listeners attached. */
  readonly built: string | null;
  /** How many pools the child saw constructed. Exactly one, or the events went to the wrong object. */
  readonly pools: number;
}

interface EmittedLine {
  readonly raw: string;
  /** Which descriptor carried it. The registered pino instance writes fd 1. */
  readonly stream: 'stdout' | 'stderr';
  /** The parsed record, or `undefined` when the line is not a JSON object at all — which is the state at HEAD. */
  readonly record: Record<string, unknown> | undefined;
}

function childSource(observationsPath: string): string {
  const hooks = new URL('../../test/support/typescript-module-hooks.mjs', import.meta.url).href;
  const clientModule = new URL('./client.ts', import.meta.url).href;

  return `
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';

import '${hooks}';

const pg = (await import('pg')).default;
const RealPool = pg.Pool;
const pools = [];

class OfflineClient extends EventEmitter {
  async query() {
    return { rows: [], rowCount: 0, fields: [], command: 'SELECT', oid: 0 };
  }
  release() {}
}

class OfflinePool extends RealPool {
  constructor(config) {
    super(config);
    pools.push(this);
  }
  async connect() {
    return new OfflineClient();
  }
}

pg.Pool = OfflinePool;
process.env.DATABASE_URL = 'postgres://offline@127.0.0.1:1/none';

const { databaseTransaction } = await import('${clientModule}');

// The only thing that reaches the private \`client()\`, which is what builds the pool and
// attaches both listeners.
const built = await databaseTransaction(async () => 'built');

writeFileSync('${observationsPath}', JSON.stringify({ built, pools: pools.length }));

// What Postgres raises when it terminates a backend, carrying the two fields
// \`tenant-context.md\` rule 2 keeps off a line.
const terminated = new pg.DatabaseError(
  'terminating connection due to administrator command',
  0,
  'error',
);
terminated.code = '${SQLSTATE}';
terminated.detail = 'Row (id)=(1, ${DRIVER_DETAIL_MARKER}) already exists.';
terminated.internalQuery = "select * from tenants where name = '${DRIVER_INTERNAL_QUERY_MARKER}'";

// 0. F-123: a connection that died IDLE IN THE POOL. pg-pool emits on the pool itself.
pools[0].emit('error', terminated);

// 1. F-137: a connection that died while CHECKED OUT. Different event and different
//    listener — pg-pool's idle listener is removed in _acquireClient, so \`client.ts\`
//    installs its own on 'connect' and that is the one that fires here.
const checkedOut = new EventEmitter();
pools[0].emit('connect', checkedOut);
checkedOut.emit('error', terminated);
`;
}

let workspace: string;
let lines: readonly EmittedLine[];

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'shortkit-client-logging-'));

  const observationsPath = join(workspace, 'observations.json');
  const run = spawnSync(
    process.execPath,
    ['--no-warnings', '--input-type=module', '-e', childSource(observationsPath)],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, LOG_LEVEL: 'trace', NODE_ENV: 'test' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  if (run.status !== 0) {
    throw new Error(
      `the connection-error child did not run cleanly (status ${String(run.status)}).\nstderr:\n${run.stderr}\nstdout:\n${run.stdout}`,
    );
  }

  // THE VACUITY GUARD. Every assertion below is about a line one of the two listeners
  // writes, and neither listener exists until `client()` has built the pool. A child that
  // built no pool, or built two, fires its events at the wrong object and emits nothing —
  // which would make "no forbidden marker on the line" hold because there is no line.
  const observations = JSON.parse(readFileSync(observationsPath, 'utf8')) as Observations;

  if (observations.built !== 'built' || observations.pools !== 1) {
    throw new Error(
      'the child did not build exactly one pool through the shipped `databaseTransaction`, ' +
        `so the events below were fired at nothing: ${JSON.stringify(observations)}`,
    );
  }

  lines = [...emitted(run.stdout, 'stdout'), ...emitted(run.stderr, 'stderr')];
}, 60_000);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function emitted(stdio: string, stream: 'stdout' | 'stderr'): EmittedLine[] {
  return stdio
    .split('\n')
    .filter((line) => line !== '')
    .map((raw) => ({ raw, stream, record: asRecord(raw) }));
}

/** The line as a JSON object, or `undefined` when it is not one. Lenient on purpose: an unparseable line is a test failure, not a suite error. */
function asRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The line for one connection state, found by the state name rather than by ordinal: the
 * two listeners are independent, and a fix that reordered or renamed one should fail the
 * test for that state rather than silently swap two lines' assertions.
 */
function connectionLine(state: string): EmittedLine {
  const matched = lines.filter((line) => line.raw.includes(state));

  expect(
    matched.map((line) => `${line.stream}: ${line.raw}`),
    `exactly one line must report the ${state} failure. Everything both descriptors ` +
      `carried:\n${lines.map((line) => `${line.stream}: ${line.raw}`).join('\n')}`,
  ).toHaveLength(1);

  return matched[0];
}

function connectionRecord(state: string): Record<string, unknown> {
  const line = connectionLine(state);

  expect(
    line.record,
    `the ${state} line is not a JSON record, so it did not come from the shared pino ` +
      `instance. The bytes on ${line.stream} were:\n${line.raw}`,
  ).toBeTypeOf('object');

  return line.record ?? {};
}

describe('the lines db/client writes when a pooled connection dies', () => {
  it('AC-116 site 3 (F-278): the idle pooled connection failure is a JSON record on fd 1, not an unstructured Nest line', () => {
    // F-123's listener. At HEAD: `[Nest] … WARN [Database] idle pooled connection failed
    // and was discarded: error (sqlstate 57P01)` — ANSI escapes and a locale clock, beside
    // the JSON every other line on this process is.
    const line = connectionLine(IDLE_POOLED);

    expect(line.stream, `the bytes were:\n${line.raw}`).toBe('stdout');
    expect(line.record, `the bytes were:\n${line.raw}`).toBeTypeOf('object');
  });

  it('AC-116 site 3 (F-278): the checked-out connection failure is a JSON record on fd 1, not an unstructured Nest line', () => {
    // F-137's listener, and a SEPARATE assertion because it is a separate listener on a
    // separate object: `pool.on('error')` does not cover a client in the middle of a
    // transaction, which is the whole reason `client.ts` installs this one on 'connect'.
    const line = connectionLine(CHECKED_OUT);

    expect(line.stream, `the bytes were:\n${line.raw}`).toBe('stdout');
    expect(line.record, `the bytes were:\n${line.raw}`).toBeTypeOf('object');
  });

  it('AC-116 site 3 (F-278): both lines carry the base fields the registered pino instance stamps on every line', () => {
    // `service` and `env` come from `base` on the ONE instance registered at the
    // composition root, `level` from `formatters.level`, `time` from
    // `pino.stdTimeFunctions.isoTime`. A second pino instance built inside `client.ts`
    // would produce JSON and satisfy the two tests above while carrying `pid` and
    // `hostname` and none of these — which is the hole F-268 names and the reason
    // "structured" is not the property AC-116 asks for.
    for (const state of [IDLE_POOLED, CHECKED_OUT]) {
      const record = connectionRecord(state);

      expect(record.service, state).toBe(SERVICE);
      expect(record.env, state).toBe('test');
      expect(record.level, state).toBeTypeOf('string');
      expect(String(record.time), state).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("AC-116 site 3 (F-278): both lines keep the driver's SQLSTATE and carry no other field of the driver error", () => {
    // The benign content, which is what this site has to still be worth reading for. The
    // SQLSTATE is the only thing on the line that says what Postgres did — `57P01` is a
    // scale-to-zero or a restart, `53300` is a pool that is too large — and a fix that
    // buys structure by dropping it leaves an operator a line saying a connection failed
    // and nothing else. `detail` and `internalQuery` are the other side of the same rule:
    // `tenant-context.md` rule 2 closes the readable fields to name and SQLSTATE, and
    // neither of those two is in `LOGGABLE_FIELDS` either.
    for (const state of [IDLE_POOLED, CHECKED_OUT]) {
      const line = connectionLine(state);

      connectionRecord(state);
      expect(line.raw, state).toContain(SQLSTATE);
      expect(line.raw, state).not.toContain(DRIVER_DETAIL_MARKER);
      expect(line.raw, state).not.toContain(DRIVER_INTERNAL_QUERY_MARKER);
    }
  });
});
