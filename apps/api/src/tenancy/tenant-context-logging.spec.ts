import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * AC-116, SITE 1 — F-247. The `afterCommit` failure line.
 *
 * Contract: `design/contracts/logging-and-headers.md`, "Consumed by: every API TASK.
 * Nothing may opt out" and "What may never appear in a log line". Policy: ADR-0028, the
 * field allowlist. Invariant: `design/contracts/tenant-context.md` invariant 6 — a throw
 * out of an `afterCommit` hook "is logged and does not propagate". Enforces GC-9.
 *
 * ============================================================================
 * WHAT IS WRONG WITH THE LINE TODAY, AND WHY THE MECHANISM MATTERS TO THE FIX
 * ============================================================================
 *
 * `tenant-context.ts:247` writes
 *
 *   logger.error(`afterCommit hook failed: ${error.name}: ${error.message}`)
 *
 * through a `Logger` constructed from `@nestjs/common` at line 136. THE LINE NEVER REACHES
 * pino AT ALL. It is not a redaction gap inside the pipeline — it is outside the pipeline,
 * so there is no `level`, no `service`, no `env`, no timestamp, no field allowlist and no
 * `serializers.err` anywhere on its path, and what lands on fd 1 is an ANSI-coloured
 * unstructured line beside the JSON. Measured at HEAD:
 *
 *   [Nest] 39562  - 08/11/2026, 5:23:28 PM   ERROR [TenantTransaction] afterCommit hook
 *   failed: Error: connect failed: postgres://app:DSNMARK@db.internal:5432/x
 *
 * F-274 was filed against this line claiming the message was interpolated into `msg`
 * "before pino sees it", and that premise is false — it was corrected. It matters here
 * because it names the WRONG FIX: routing this call through pino's MESSAGE ARGUMENT
 * reproduces the seven-door problem ADR-0028 exists to solve, and door seven (F-277) was a
 * blocker closed only days ago. `msg` is on `LOGGABLE_FIELDS` and is free text by
 * construction, so a message-interpolating fix puts `error.message` back on the line with
 * every gate green.
 *
 * So the assertions below are written against the ALLOWLIST, not against the channel. The
 * hook error carries two markers: one inside its `message`, shaped like the DSN a pg
 * connection failure carries, and one on an OWN ENUMERABLE PROPERTY, which is the shape
 * body-parser gave F-244 and the shape `serializers.err` — and only `serializers.err` —
 * reduces away. A fix that reaches pino but interpolates fails the first; a fix that
 * reaches a SECOND pino instance rather than the registered one fails the second and the
 * `service`/`env` assertion, because those come from the registered instance's `base`.
 *
 * ============================================================================
 * HOW, AND WHAT IS FAKED
 * ============================================================================
 *
 * The child imports THE SHIPPED `tenant-context.ts` and calls `withTenantTransaction` for
 * real — the same function a request path calls — so the emission under test is the real
 * one and not a copy of it. The shared logger writes fd 1 synchronously, and the only way
 * to read another process's fd 1 is to be its parent (`src/observability/logger.spec.ts`
 * established this shape).
 *
 * BOTH STREAMS ARE COLLECTED, and that is not tidiness. Measured on this repository's
 * @nestjs/common 11.1.28: `ConsoleLogger` routes `error` and `fatal` to **fd 2** and every
 * other level to fd 1, so at HEAD the line under test is not on stdout at all. A harness
 * that read fd 1 alone would see nothing, and "no marker on the line" would hold because
 * there was no line — the vacuous pass this suite exists to make impossible. So the child's
 * two streams are unioned into one ordered set of lines, the count is asserted, and WHICH
 * stream carried it is part of the first assertion: the registered instance writes fd 1.
 * The child runs under `--no-warnings` and writes nothing of its own to either stream, so
 * anything unexpected on them shows up as a line-count failure that prints every line.
 *
 * THE ONLY THING REPLACED IS THE SOCKET. `pg.Pool` is subclassed — the REAL `pg.Pool`, so
 * drizzle receives the object it expects — with `connect()` overridden to hand back a
 * client that answers every statement with an empty result. `client.ts` reads `pg.Pool`
 * lazily inside `client()`, so the swap lands before the pool is built. Postgres is a
 * genuine external boundary and `pnpm test` runs from a clean clone with no database
 * (ADR-0001); everything above the socket — drizzle's transaction, the three `set_config`
 * statements, the settled-context guard, the hook loop — is the shipped code.
 *
 * `LOG_LEVEL=trace` so that the assertions do not depend on which level the fix chooses.
 */

/**
 * Inside the hook error's MESSAGE, shaped like the DSN a `pg` connection failure carries.
 * ADR-0028 makes `err_message` default-deny for exactly this reason, and the card for this
 * TASK names the two payloads: "a pg error there carries the DSN; an application hook's
 * error can carry row data".
 */
const HOOK_ERROR_MESSAGE_MARKER = 'hook-error-message-marker';

/**
 * An OWN ENUMERABLE PROPERTY on the hook error, which is what body-parser does to the 400
 * it raises (F-244) and what any library is free to do to anything it throws. It is here to
 * separate "reached pino" from "reached THE registered pino": a bare pino instance copies
 * every own enumerable property of an error onto the record, and the registered one routes
 * the `err` key through `errorLogFields` and emits three fields and no fourth.
 */
const HOOK_ERROR_PROPERTY_MARKER = 'hook-error-own-property-marker';

/**
 * `base` on the registered instance, hand-copied from `logging-and-headers.md`'s fence
 * rather than imported from `logger.ts` — an expected value read out of the code under test
 * agrees with it whatever it does.
 */
const SERVICE = 'shortkit-api';

/** A uuid, because `assertUuid` refuses anything else before `set_config` is reached. */
const TENANT_ID = '11111111-2222-4333-8444-555555555555';

/** What `fn` resolves to. Used by the vacuity guard, not by any assertion. */
const CALLER_RESULT = 'the caller result';

/** The three fields `errorLogFields` builds (`error-envelope.md`). `err_message` is opt-in and is not opted into here. */
const POLICY_ERROR_FIELDS_WITHOUT_THE_MESSAGE = ['err_name', 'err_stack'];

/** A stack line, as V8 writes them. */
const STACK_FRAME = /^\s+at /;

interface Observations {
  /** `withTenantTransaction`'s return value. Invariant 6: the hook's throw does not change it. */
  readonly result: string | null;
  /** Non-null iff the hook's throw propagated out of `withTenantTransaction`, which it may not. */
  readonly propagated: string | null;
}

interface EmittedLine {
  /** The exact bytes of the line. A leak has to be absent from these, at any depth and under any key. */
  readonly raw: string;
  /** Which descriptor carried it. The registered pino instance writes fd 1; Nest's `Logger.error` writes fd 2. */
  readonly stream: 'stdout' | 'stderr';
  /** The parsed record, or `undefined` when the line is not a JSON object at all — which is the state at HEAD. */
  readonly record: Record<string, unknown> | undefined;
}

function childSource(observationsPath: string): string {
  const hooks = new URL('../../test/support/typescript-module-hooks.mjs', import.meta.url).href;
  const tenantContext = new URL('./tenant-context.ts', import.meta.url).href;

  return `
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';

import '${hooks}';

// The socket, and only the socket. \`client.ts\` reads \`pg.Pool\` lazily inside \`client()\`,
// so replacing it here lands before the pool is built; \`OfflinePool\` extends the REAL pool
// so drizzle receives the object it type-checks against.
const pg = (await import('pg')).default;
const RealPool = pg.Pool;

class OfflineClient extends EventEmitter {
  async query() {
    return { rows: [], rowCount: 0, fields: [], command: 'SELECT', oid: 0 };
  }
  release() {}
}

class OfflinePool extends RealPool {
  async connect() {
    return new OfflineClient();
  }
}

pg.Pool = OfflinePool;
process.env.DATABASE_URL = 'postgres://offline@127.0.0.1:1/none';

const { withTenantTransaction } = await import('${tenantContext}');

// What a third-party call inside an afterCommit hook throws. The message is DSN-shaped and
// the own enumerable property is body-parser's shape (F-244).
const hookFailure = new Error(
  'connect ECONNREFUSED postgres://app:${HOOK_ERROR_MESSAGE_MARKER}@db.internal:5432/shortkit',
);
hookFailure.body = '{"email":"a@b.test","password":"${HOOK_ERROR_PROPERTY_MARKER}"}';

let result = null;
let propagated = null;

try {
  result = await withTenantTransaction('${TENANT_ID}', async () => '${CALLER_RESULT}', {
    afterCommit: () => {
      throw hookFailure;
    },
  });
} catch (thrown) {
  propagated = String(thrown);
}

writeFileSync('${observationsPath}', JSON.stringify({ result, propagated }));
`;
}

let workspace: string;
let lines: readonly EmittedLine[];

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'shortkit-tenant-context-logging-'));

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
      `the afterCommit child did not run cleanly (status ${String(run.status)}).\nstderr:\n${run.stderr}\nstdout:\n${run.stdout}`,
    );
  }

  // THE VACUITY GUARD. Every assertion below is about a line the hook loop writes, and the
  // hook loop is reached only after COMMIT. A child whose transaction threw, or whose hook
  // never ran, emits nothing and turns "no marker on the line" into "no line" — which is
  // the shape that passes a leak assertion while proving nothing. It is also invariant 6
  // itself, so a fix that lets the hook's throw propagate fails here loudly rather than
  // silently.
  const observations = JSON.parse(readFileSync(observationsPath, 'utf8')) as Observations;

  if (observations.result !== CALLER_RESULT || observations.propagated !== null) {
    throw new Error(
      'the child did not reach the afterCommit hook loop with the transaction committed, ' +
        `so nothing below is measuring the line under test: ${JSON.stringify(observations)}`,
    );
  }

  lines = [
    ...emitted(run.stdout, 'stdout'),
    ...emitted(run.stderr, 'stderr'),
  ];
}, 60_000);

function emitted(stdio: string, stream: 'stdout' | 'stderr'): EmittedLine[] {
  return stdio
    .split('\n')
    .filter((line) => line !== '')
    .map((raw) => ({ raw, stream, record: asRecord(raw) }));
}

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

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

function afterCommitLine(): EmittedLine {
  expect(
    lines.map((line) => `${line.stream}: ${line.raw}`),
    'the hook failure must be reported on exactly one line, across both descriptors',
  ).toHaveLength(1);

  return lines[0];
}

function afterCommitRecord(): Record<string, unknown> {
  const line = afterCommitLine();

  expect(
    line.record,
    `the hook failure line is not a JSON record, so it did not come from the shared pino ` +
      `instance. The bytes on ${line.stream} were:\n${line.raw}`,
  ).toBeTypeOf('object');

  return line.record ?? {};
}

/**
 * The error fields on the line, whichever of the two sanctioned shapes the call site used:
 * under the `err` key, which `serializers.err` owns, or spread at the top level, which is
 * what `main.ts` does with `errorLogFields`. Both are the policy; neither is asserted as
 * "the" one, because the AC is about which pipeline the line went through and not about
 * which of two allowed call shapes was picked.
 */
function reportedErrorFields(record: Record<string, unknown>): Record<string, unknown> {
  const under = record.err;

  if (typeof under === 'object' && under !== null && !Array.isArray(under)) {
    return under as Record<string, unknown>;
  }

  return Object.fromEntries(Object.entries(record).filter(([key]) => key.startsWith('err_')));
}

describe('the line tenant-context writes when an afterCommit hook throws', () => {
  it('AC-116 site 1 (F-247): the hook failure is one JSON record on fd 1, not an unstructured Nest line on fd 2', () => {
    // The channel. At HEAD this is `[Nest] … ERROR [TenantTransaction] afterCommit hook
    // failed: …` on STDERR — ANSI escapes, a locale-formatted clock, no JSON — while every
    // other line this process writes is JSON on stdout. Nothing downstream can index it,
    // and a collector reading fd 1 never sees it at all.
    const line = afterCommitLine();

    expect(line.stream, `the bytes were:\n${line.raw}`).toBe('stdout');
    expect(line.record, `the bytes were:\n${line.raw}`).toBeTypeOf('object');
  });

  it('AC-116 site 1 (F-247): the line carries the base fields the registered pino instance stamps on every line', () => {
    // `service` and `env` are `base` on the ONE instance registered at the composition
    // root, `level` is `formatters.level`, and `timestamp` is `pino.stdTimeFunctions.isoTime`.
    // A second pino instance built anywhere else carries `pid` and `hostname` and none of
    // these, so this is what separates "reached pino" from "reached THE pino instance".
    const record = afterCommitRecord();

    expect(record.service).toBe(SERVICE);
    expect(record.env).toBe('test');
    expect(record.level).toBeTypeOf('string');
    expect(String(record.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("AC-116 site 1 (F-247): the hook error's message never reaches the line", () => {
    // THE LEAK. `error.message` is the field ADR-0028 makes default-deny everywhere else,
    // and this is a per-request tenant path: a pg error here carries the DSN, an
    // application hook's error can carry row data. Asserted against the RAW BYTES, so it
    // holds wherever the message would land — inside `msg`, inside `err_message`, or
    // interpolated into a format argument. A fix that routes the call through pino's
    // MESSAGE ARGUMENT rather than through the field allowlist fails exactly here, which
    // is the fix F-274's false premise pointed at.
    expect(afterCommitLine().raw).not.toContain(HOOK_ERROR_MESSAGE_MARKER);
  });

  it('AC-116 site 1 (F-247): the line reports the error through the policy fields and carries no other property of it', () => {
    // The allowlist half, and the half that keeps the line worth having. `err_name` and
    // `err_stack` are what `errorLogFields` builds with `includeMessage: false`; a fourth
    // field means the record went through pino's DEFAULT `err` serialiser, which copies
    // every own enumerable property — F-244's exact mechanism — and `err_message` means
    // the message was opted back in. Requiring `err_name` is what stops a "fix" that
    // silences the line: invariant 6 says the throw IS logged.
    const record = afterCommitRecord();
    const fields = reportedErrorFields(record);

    expect(fields.err_name).toBe('Error');
    expect(
      Object.keys(fields).filter(
        (field) => !POLICY_ERROR_FIELDS_WITHOUT_THE_MESSAGE.includes(field),
      ),
    ).toEqual([]);
    expect(afterCommitLine().raw).not.toContain(HOOK_ERROR_PROPERTY_MARKER);

    for (const frame of String(fields.err_stack).split('\n')) {
      expect(frame).toMatch(STACK_FRAME);
    }
  });
});
