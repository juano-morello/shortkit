import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The marker is imported rather than hand-copied because the fixture owns the value: it is
// this suite's own string, not something the module under test produces. The child imports
// the controller and its path for itself, through the module URL below.
import { RESPONSE_OBJECT_ONLY_MARKER } from '../../test/support/response-object-probe.controller';

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
 *
 * ============================================================================
 * F-273 — THE SECOND COPY, ADDED 2026-08-09
 * ============================================================================
 *
 * The quoted fragment above exists TWICE on the exception Nest hands the filter: on
 * `message`, and inside the object `getResponse()` returns. `error-envelope.md`'s
 * `includeMessage` policy stands in front of the first copy only — the second is an ordinary
 * key on an ordinary object, and a filter edit that logs or forwards it is not covered by
 * withholding `err_message`. Nothing pinned that the second copy stays off the wire.
 *
 * Three things were added for it, and the third is what makes the first two mean something:
 *
 *   1. The child now records `getResponse()` for every exception the filter receives, so the
 *      second copy is observable at all.
 *   2. The suite now asserts on the HTTP RESPONSE BODIES as well as the log lines. The
 *      finding names both surfaces; only the lines were covered.
 *   3. `test/support/response-object-probe.controller.ts` adds one route whose exception
 *      carries a marker in the response object and NOWHERE ELSE — the `message: string[]`
 *      shape, where Nest leaves `exception.message` as class-name text. Its marker is
 *      distinct from the two request-body markers above, so an assertion on it fails for the
 *      second copy alone and cannot be satisfied by the defence that covers the first.
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

/**
 * What the framework-400 arm puts under `_form` instead of the exception's own text
 * (ADR-0026, `error-envelope.md`'s message constants). Hand-read off the contract rather than
 * imported, for the same reason `FRAMEWORK_400_CONTEXT` is: a value read out of the module
 * under test agrees with it whatever it says.
 */
const FRAMEWORK_BAD_REQUEST_FORM_MESSAGE = 'The request could not be parsed.';

/** The three fields `errorLogFields` builds, and the line may carry no fourth. */
const POLICY_ERROR_FIELDS = ['err_name', 'err_message', 'err_stack'];

interface ReceivedException {
  readonly constructorName: string;
  /** Every own enumerable property, JSON-encoded, which is where a leak would be. */
  readonly ownEnumerableJson: string;
  readonly ownPropertyNames: readonly string[];
  readonly message: string | null;
  /**
   * `exception.getResponse()`, JSON-encoded. F-273's subject: the copy of the quoted bytes
   * that does not travel on `message` and that the `includeMessage` policy therefore does not
   * govern. `null` when the throwable has no `getResponse`.
   */
  readonly responseJson: string | null;
}

interface Observations {
  readonly statuses: readonly number[];
  readonly bodies: readonly string[];
  readonly received: readonly ReceivedException[];
}

/**
 * F-273's child, which sends ONE request at the probe route. It is a second process rather
 * than a third request in the first one so that `observations`, and every assertion the
 * F-244 tests make about how many lines the framework-400 arm wrote, keep the exact subject
 * they had before this finding: two malformed bodies and nothing else.
 */
interface ProbeObservations {
  readonly status: number;
  readonly body: string;
  readonly received: ReceivedException | null;
}

/**
 * What both children do before they send anything: load this workspace's TypeScript, wrap the
 * filter's `catch` to record what Nest hands it, build the app and listen on loopback.
 */
function childPreamble(withProbeController: boolean): string {
  const hooks = new URL('../../test/support/typescript-module-hooks.mjs', import.meta.url).href;
  const appModule = new URL('../app.module.ts', import.meta.url).href;
  const filterModule = new URL('../common/errors/exception-filter.ts', import.meta.url).href;
  const probeModule = new URL(
    '../../test/support/response-object-probe.controller.ts',
    import.meta.url,
  ).href;

  return `
import { writeFileSync } from 'node:fs';

import '${hooks}';
import 'reflect-metadata';

const { Test } = await import('@nestjs/testing');
const { AppModule } = await import('${appModule}');
const { ApiExceptionFilter } = await import('${filterModule}');
${
  withProbeController
    ? `const { ResponseObjectProbeController, RESPONSE_OBJECT_PROBE_PATH } = await import('${probeModule}');`
    : ''
}

// Records what Nest hands our filter. It delegates to the original, so the response and the
// log line are exactly what they would be without it.
const received = [];
const inherited = ApiExceptionFilter.prototype.catch;
ApiExceptionFilter.prototype.catch = function (exception, host) {
  const ownEnumerable = {};
  for (const key of Object.keys(exception ?? {})) {
    try { ownEnumerable[key] = exception[key]; } catch { ownEnumerable[key] = '<threw>'; }
  }

  // F-273: the second copy. Reading it here changes nothing — \`getResponse()\` returns the
  // object the exception was constructed with — and it is the only way to see a value the
  // filter is required never to emit.
  let responseJson = null;
  try {
    responseJson =
      typeof exception?.getResponse === 'function' ? JSON.stringify(exception.getResponse()) : null;
  } catch {
    responseJson = '<threw>';
  }

  received.push({
    constructorName: exception?.constructor?.name ?? typeof exception,
    ownEnumerableJson: JSON.stringify(ownEnumerable),
    ownPropertyNames: Object.getOwnPropertyNames(exception ?? {}),
    message: typeof exception?.message === 'string' ? exception.message : null,
    responseJson,
  });

  return inherited.call(this, exception, host);
};

// The probe controller, when there is one, is registered BESIDE \`AppModule\` rather than in
// it: it is a test fixture, \`app.module.ts\` belongs to TASK-003's implementer, and
// \`APP_FILTER\` is global, so the real filter answers for its route exactly as it does for
// every other.
const moduleRef = await Test.createTestingModule({
  imports: [AppModule],
${withProbeController ? '  controllers: [ResponseObjectProbeController],' : ''}
}).compile();
// \`logger: false\` silences NEST's own logger. The pino singleton is untouched — its lines
// are the subject.
const app = moduleRef.createNestApplication({ logger: false });
await app.listen(0, '127.0.0.1');
const baseUrl = await app.getUrl();
`;
}

/** The two malformed POSTs, in order. */
function malformedBodyChildSource(observationsPath: string): string {
  return `${childPreamble(false)}
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

/** F-273: one GET at the route whose exception hides its marker in the response object. */
function responseObjectProbeChildSource(observationsPath: string): string {
  return `${childPreamble(true)}
const response = await fetch(baseUrl + '/' + RESPONSE_OBJECT_PROBE_PATH);
const status = response.status;
const body = await response.text();

await app.close();

writeFileSync('${observationsPath}', JSON.stringify({ status, body, received: received[0] ?? null }));
`;
}

interface EmittedLine {
  readonly raw: string;
  readonly record: Record<string, unknown>;
}

let lines: readonly EmittedLine[];
let observations: Observations;
let probeLines: readonly EmittedLine[];
let probeObservations: ProbeObservations;
let workspace: string;

/**
 * Runs one child to completion and returns the bytes it wrote to file descriptor 1 alongside
 * the observations it recorded. A child that half-ran would let every assertion below pass
 * vacuously, so a non-zero exit or anything at all on stderr throws here instead.
 */
function runChild<T>(source: (observationsPath: string) => string, name: string): {
  readonly lines: readonly EmittedLine[];
  readonly observations: T;
} {
  const observationsPath = join(workspace, `${name}.json`);
  const run = spawnSync(
    process.execPath,
    ['--no-warnings', '--input-type=module', '-e', source(observationsPath)],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, LOG_LEVEL: 'error', NODE_ENV: 'test' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  if (run.status !== 0 || run.stderr !== '') {
    throw new Error(
      `the ${name} API child did not run cleanly (status ${String(run.status)}).\nstderr:\n${run.stderr}\nstdout:\n${run.stdout}`,
    );
  }

  return {
    observations: JSON.parse(readFileSync(observationsPath, 'utf8')) as T,
    lines: run.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((raw) => ({ raw, record: JSON.parse(raw) as Record<string, unknown> })),
  };
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'shortkit-framework-400-'));

  const malformed = runChild<Observations>(malformedBodyChildSource, 'malformed-body');
  observations = malformed.observations;
  lines = malformed.lines;

  const probe = runChild<ProbeObservations>(
    responseObjectProbeChildSource,
    'response-object-probe',
  );
  probeObservations = probe.observations;
  probeLines = probe.lines;
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

/** What a `validation_failed` body carries, read only as far as these tests need it. */
interface EnvelopeRead {
  readonly code?: unknown;
  readonly details?: { readonly fieldErrors?: unknown };
}

describe("the copy of a credential inside an exception's response object", () => {
  it("F-273: the framework's own 400 carries the quoted bytes a second time, under getResponse()", () => {
    // The hazard, named. `BadRequestException` keeps what it was constructed with in two
    // places: on `message`, which the F-108 test above pins, and inside the object
    // `getResponse()` returns, which is this one. `error-envelope.md`'s `includeMessage`
    // policy governs the first and says nothing about the second, so the guards below are
    // guarding a value that really is there.
    //
    // Red if Nest stops carrying the constructor argument in the response body it builds
    // (`HttpException.createBody`). That would be good news and it should be read rather than
    // absorbed: it is the premise F-273 rests on.
    const [, leadingMarkerRequest] = observations.received;
    const response = JSON.parse(leadingMarkerRequest.responseJson ?? 'null') as {
      readonly message?: unknown;
    };

    expect(String(response.message)).toContain(QUOTED_BODY_PREFIX);
  });

  it('F-273: the probe route holds its credential in the response object and in no field the log policy reaches', () => {
    // What makes the two guards below load-bearing rather than restatements of F-244. The
    // probe's marker is in `getResponse().message` and NOWHERE else on the exception: Nest
    // derives `this.message` from the response object only when `response.message` is a
    // string, and the probe's is an array. So withholding `err_message` cannot be what keeps
    // this marker off a line, and forwarding the exception's own message cannot be what puts
    // it in a body — only reaching for `getResponse()` can do either.
    const received = probeObservations.received;

    expect(received?.constructorName).toBe('BadRequestException');
    expect(received?.responseJson ?? '').toContain(RESPONSE_OBJECT_ONLY_MARKER);
    expect(received?.message).toBeTypeOf('string');
    expect(received?.message ?? '').not.toContain(RESPONSE_OBJECT_ONLY_MARKER);
  });

  it("F-273: no byte of the response object's copy reaches a log line", () => {
    // GC-9, on the bytes the process wrote to file descriptor 1. The precondition first: the
    // framework-400 arm has to have run and written its line, or a process that logged
    // nothing at all would satisfy the assertion.
    const logged = probeLines.filter((line) => line.record.msg === FRAMEWORK_400_CONTEXT);

    expect(logged).toHaveLength(1);
    expect(logged[0].record.request_id).toBeTypeOf('string');
    expect(logged[0].record.err_name).toBe('BadRequestException');

    for (const line of probeLines) {
      expect(line.raw).not.toContain(RESPONSE_OBJECT_ONLY_MARKER);
    }
  });

  it("F-273: no byte of the response object's copy reaches an HTTP response body", () => {
    // The second surface the finding names, and the one nothing measured end to end. ADR-0026
    // says every body is built from strings this repository chose; the `_form` assertion is
    // what stops "no marker" being bought by an empty or unbranded body, and it is hand-read
    // off `error-envelope.md` rather than imported from the filter.
    const answered = [
      ...observations.bodies.map((body) => ({
        body,
        forbidden: [BODY_MARKER, LEADING_MARKER, QUOTED_BODY_PREFIX],
      })),
      { body: probeObservations.body, forbidden: [RESPONSE_OBJECT_ONLY_MARKER] },
    ];

    expect(probeObservations.status).toBe(400);

    for (const { body, forbidden } of answered) {
      const envelope = JSON.parse(body) as EnvelopeRead;

      expect(envelope.code).toBe(VALIDATION_FAILED);
      expect(envelope.details?.fieldErrors).toEqual({
        _form: [FRAMEWORK_BAD_REQUEST_FORM_MESSAGE],
      });

      for (const bytes of forbidden) {
        expect(body).not.toContain(bytes);
      }
    }
  });
});
