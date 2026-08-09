import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * F-244, END TO END, AGAINST A REAL NEST APPLICATION.
 *
 * Contract: `design/contracts/logging-and-headers.md`, "What may never appear in a log line".
 * Policy: `design/contracts/error-envelope.md`, "What the 500 log line carries". Enforces
 * GC-9 — no PII in log bodies.
 *
 * ============================================================================
 * WHY THIS SUITE EXISTS, AND WHAT IT MEASURED THAT NOBODY HAD MEASURED
 * ============================================================================
 *
 * Six findings (F-244, F-248, F-251, F-252, F-258, F-260) describe the same attacker path:
 * an unauthenticated POST whose JSON does not parse, body-parser raising a `SyntaxError`
 * with the VERBATIM REQUEST BODY on `err.body`, and one idiomatic `log.error({ err }, …)`
 * writing a credential in the clear. Every reproduction in all six used a HAND-DECORATED
 * `Error`. Nobody had ever sent the request.
 *
 * MEASURED HERE, on this repository's own body-parser 2.3.0, @nestjs/core 11.1.28 and
 * Node 24.19:
 *
 *   - body-parser DOES attach the verbatim body. `lib/read.js:163` calls
 *     `createError(400, err, { body: str, type: 'entity.parse.failed' })`, and the error it
 *     raises carries `body` as an OWN ENUMERABLE property. That half of the premise holds.
 *   - **That error never reaches our code.** `RoutesResolver.mapExternalException`
 *     (`routes-resolver.js:94-101`) replaces every `SyntaxError` with
 *     `new BadRequestException(err.message)`, so what the shipped exception filter is handed
 *     carries `response`, `status`, `options`, `message`, `name` — and no `body` at all.
 *   - **What survives instead is the message**, and V8 quotes the first ten characters of
 *     the body into it: `Unexpected token 'p', "password=M"... is not valid JSON`. A body
 *     that BEGINS with a credential therefore puts ten characters of it into
 *     `BadRequestException.message`, which is an own enumerable property.
 *
 * So the exposure is real and it is the one `error-envelope.md`'s stack-versus-message
 * policy already answers — not the one six findings described. Both facts are pinned below,
 * because both are load-bearing: the first is why the defence is the policy rather than a
 * redact path, and the second reds the day a Nest release starts forwarding body-parser's
 * original error into the filter with `err.body` still on it.
 *
 * ============================================================================
 * HOW
 * ============================================================================
 *
 * A child process builds an application from `AppModule` — the real composition root, so the
 * real `ApiExceptionFilter` is registered through `APP_FILTER` — listens on 127.0.0.1, and
 * POSTs malformed JSON at it over a real socket. The shipped logger writes to file
 * descriptor 1 synchronously, so the parent captures the child's stdout and every assertion
 * about a leak is made against those bytes.
 *
 * What the FILTER received cannot be read off a log line, by construction — the whole point
 * is that the line does not carry it — so the child wraps `ApiExceptionFilter.prototype.catch`
 * to record its argument and writes the recording to a file the parent reads. The wrapper
 * delegates to the original and changes nothing about the response.
 *
 * NO DATABASE, NO DOCKER, NO NETWORK. `AppModule` is `HealthModule` plus the filter, and the
 * only socket is a loopback listener the child opens and closes. That is why this is a
 * `.spec.ts` under `pnpm test` rather than an `.int-spec.ts`: `test/support/api-server.ts`
 * boots `main.ts`, which refuses to start without Postgres (F-116, F-245), and every
 * `.int-spec.ts` therefore needs `docker-compose.test.yml` up. Nothing here does.
 */

/** A credential sitting deep in the body, past anything V8 quotes into a parse message. */
const BODY_MARKER = 'hunter2-inside-the-request-body';

/**
 * A credential at OFFSET ZERO, which is the placement that reaches the parse message. A raw
 * token posted as the body — a webhook secret, a JWT — has exactly this shape.
 */
const LEADING_MARKER = 'SEKRIT-KEY-at-the-front-of-the-body';

/**
 * The part of `LEADING_MARKER` that V8 quotes into `SyntaxError.message`: the first ten
 * characters of the body, verbatim. Measured on Node 24.19 and written out by hand — the
 * emitted line has to be free of the FRAGMENT, not only of the whole marker, and a fragment
 * derived from the message would agree with the message whatever it said.
 */
const QUOTED_BODY_PREFIX = 'SEKRIT-KEY';

/** The two requests the child sends, in order. */
const MALFORMED_BODIES = [
  `{"email":"a@b.test","password":"${BODY_MARKER}"`,
  `${LEADING_MARKER}=1&other=2`,
] as const;

/**
 * `exception-filter.ts`'s context string for the framework-400 arm. Hand-copied rather than
 * imported: this suite asserts that the arm ran, and reading the string out of the module
 * under test would agree with it whatever it says.
 */
const FRAMEWORK_400_CONTEXT = 'framework exception with a 400 status';

/** What `error-envelope.md` answers a malformed body with. */
const VALIDATION_FAILED = 'validation_failed';

/** The three fields `errorLogFields` builds, and the line may carry no fourth. */
const POLICY_ERROR_FIELDS = ['err_name', 'err_message', 'err_stack'];

interface ReceivedException {
  readonly constructorName: string;
  /** Every own enumerable property, JSON-encoded, which is where a leak would be. */
  readonly ownEnumerableJson: string;
  readonly ownPropertyNames: readonly string[];
  readonly message: string | null;
}

interface Observations {
  readonly statuses: readonly number[];
  readonly bodies: readonly string[];
  readonly received: readonly ReceivedException[];
}

function childSource(observationsPath: string): string {
  const hooks = new URL('../../test/support/typescript-module-hooks.mjs', import.meta.url).href;
  const appModule = new URL('../app.module.ts', import.meta.url).href;
  const filterModule = new URL('../common/errors/exception-filter.ts', import.meta.url).href;

  return `
import { writeFileSync } from 'node:fs';

import '${hooks}';
import 'reflect-metadata';

const { Test } = await import('@nestjs/testing');
const { AppModule } = await import('${appModule}');
const { ApiExceptionFilter } = await import('${filterModule}');

// Records what Nest hands our filter. It delegates to the original, so the response and the
// log line are exactly what they would be without it.
const received = [];
const inherited = ApiExceptionFilter.prototype.catch;
ApiExceptionFilter.prototype.catch = function (exception, host) {
  const ownEnumerable = {};
  for (const key of Object.keys(exception ?? {})) {
    try { ownEnumerable[key] = exception[key]; } catch { ownEnumerable[key] = '<threw>'; }
  }

  received.push({
    constructorName: exception?.constructor?.name ?? typeof exception,
    ownEnumerableJson: JSON.stringify(ownEnumerable),
    ownPropertyNames: Object.getOwnPropertyNames(exception ?? {}),
    message: typeof exception?.message === 'string' ? exception.message : null,
  });

  return inherited.call(this, exception, host);
};

const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
// \`logger: false\` silences NEST's own logger. The pino singleton is untouched — its lines
// are the subject.
const app = moduleRef.createNestApplication({ logger: false });
await app.listen(0, '127.0.0.1');
const baseUrl = await app.getUrl();

const statuses = [];
const bodies = [];

for (const body of ${JSON.stringify(MALFORMED_BODIES)}) {
  const response = await fetch(baseUrl + '/api/anything', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  statuses.push(response.status);
  bodies.push(await response.text());
}

await app.close();

writeFileSync('${observationsPath}', JSON.stringify({ statuses, bodies, received }));
`;
}

interface EmittedLine {
  readonly raw: string;
  readonly record: Record<string, unknown>;
}

let lines: readonly EmittedLine[];
let observations: Observations;
let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'shortkit-framework-400-'));

  const observationsPath = join(workspace, 'observations.json');
  const run = spawnSync(
    process.execPath,
    ['--no-warnings', '--input-type=module', '-e', childSource(observationsPath)],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, LOG_LEVEL: 'error', NODE_ENV: 'test' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  // A harness that half-ran would let every assertion below pass vacuously.
  if (run.status !== 0 || run.stderr !== '') {
    throw new Error(
      `the API child did not run cleanly (status ${String(run.status)}).\nstderr:\n${run.stderr}\nstdout:\n${run.stdout}`,
    );
  }

  observations = JSON.parse(readFileSync(observationsPath, 'utf8')) as Observations;

  lines = run.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((raw) => ({ raw, record: JSON.parse(raw) as Record<string, unknown> }));
}, 60_000);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Every line the framework-400 arm wrote — one per malformed request. */
function frameworkFourHundredLines(): readonly EmittedLine[] {
  return lines.filter((line) => line.record.msg === FRAMEWORK_400_CONTEXT);
}

describe('a malformed JSON POST at a real Nest application', () => {
  it('F-244: is answered with the branded 400 envelope, so the requests below really failed to parse', () => {
    // The precondition every other test rests on. If the requests were answered 404 — a
    // wrong path, a prefix that moved — no parse error was raised and the leak assertions
    // would hold for a reason that has nothing to do with the logger.
    expect(observations.statuses).toEqual([400, 400]);

    for (const body of observations.bodies) {
      expect(JSON.parse(body)).toMatchObject({ code: VALIDATION_FAILED });
    }
  });

  it('F-244: no fragment of the request body reaches any line the process writes', () => {
    // THE HEADLINE, on the bytes the process actually wrote to file descriptor 1. Two
    // placements, because they leak by different routes: a credential deep in the body is
    // reachable only through `err.body`, and one at offset zero is quoted into the parse
    // message by V8 and travels on `BadRequestException.message` (F-108).
    for (const line of lines) {
      expect(line.raw).not.toContain(BODY_MARKER);
      expect(line.raw).not.toContain(LEADING_MARKER);
      expect(line.raw).not.toContain(QUOTED_BODY_PREFIX);
    }
  });

  it('F-244: the failure is still logged, with a request id and the error named', () => {
    // Not bought by logging nothing. `error-envelope.md` invariant 9 is that a failure can
    // be found in the logs by its `request_id`, and the assertion above is satisfied by a
    // process that writes no lines at all.
    const logged = frameworkFourHundredLines();

    expect(logged).toHaveLength(MALFORMED_BODIES.length);

    for (const line of logged) {
      expect(line.record.request_id).toBeTypeOf('string');
      expect(line.record.err_name).toBe('BadRequestException');
      expect(line.record.err_stack).toBeTypeOf('string');
      expect(
        Object.keys(line.record).filter((field) => field.startsWith('err_') && !POLICY_ERROR_FIELDS.includes(field)),
      ).toEqual([]);
    }
  });

  it('F-244: what Nest hands the filter carries the parse message and no request body', () => {
    // THE CHARACTERIZATION THE WHOLE FINDING CHAIN ASSUMED AND NOBODY CHECKED. body-parser
    // does attach the verbatim body to the error it raises — `read.js:163` — but
    // `RoutesResolver.mapExternalException` replaces that error with
    // `new BadRequestException(err.message)` before any filter runs, so `err.body` is gone
    // by the time our code sees it and the exposure is the MESSAGE alone.
    //
    // This goes red the day that stops being true — a Nest release that forwards
    // body-parser's own error would put the verbatim body back in the filter's hands, and
    // that is a change in the threat model, not a version bump.
    for (const exception of observations.received) {
      expect(exception.constructorName).toBe('BadRequestException');
      expect(exception.ownEnumerableJson).not.toContain(BODY_MARKER);
      expect(exception.ownPropertyNames).not.toContain('body');
    }
  });

  it('F-108: a credential at the front of the body does reach the exception message', () => {
    // The other half, and what makes the headline test non-vacuous: the framework really
    // does hand our code ten verbatim characters of an unauthenticated request body, so the
    // line above being clean is the policy working rather than nothing having happened.
    //
    // Red if V8 stops quoting request bytes into a parse message. That would be good news
    // and it should be read, not absorbed: `error-envelope.md` withholds `err_message`
    // because of this, and the reason would have changed.
    const [, leadingMarkerRequest] = observations.received;

    expect(leadingMarkerRequest.message).toContain(QUOTED_BODY_PREFIX);
  });
});
