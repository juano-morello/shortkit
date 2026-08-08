import { spawnSync } from 'node:child_process';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * F-244 — the shared logger does not write an error's incidental fields, or its
 * message, into a log line.
 *
 * Contract: `design/contracts/logging-and-headers.md`, "What may never appear in a log
 * line" and "What the implementer must guarantee". Policy:
 * `design/contracts/error-envelope.md`, "What the 500 log line carries, and who owns
 * changing it". Enforces GC-9 — no PII in log bodies.
 *
 * WHY THIS SUITE EXISTS AND WHY IT IS SHAPED THIS WAY. F-244 was a live credential
 * leak. pino's default `err` serialiser copies every own enumerable property of the
 * error onto the record, and body-parser attaches the VERBATIM REQUEST BODY to
 * `err.body` on the 400 it raises for malformed JSON — so one idiomatic
 * `log.error({ err }, '…')` wrote an unauthenticated POST's password in the clear. The
 * remedy is configuration on a logger every later TASK imports, and configuration is
 * exactly the shape that let F-244 exist: a policy held by convention rather than by
 * mechanism. A future edit that drops `serializers.err` reintroduces the leak with
 * every gate green.
 *
 * So these tests assert THE PROPERTY, not the configuration. A test that read
 * `logger.options.serializers` would pass against a config that emits the wrong bytes.
 * What is asserted here is what the process actually writes to file descriptor 1.
 *
 * HOW. `logger` is a module-level singleton whose destination is pino's default, fd 1,
 * and it is written to synchronously. Rather than rebuild an equivalent pino instance —
 * which would assert against a copy of the config and could not catch a change to the
 * real one — the suite spawns a Node process, imports THE SHIPPED MODULE, emits one
 * line per call shape, and captures stdout. Every assertion below is made against those
 * bytes.
 *
 * Two things are asserted per line where both apply: that the marker is absent from the
 * RAW line text, which catches a leak at any nesting depth or under any key name, and
 * that the parsed record still carries what an operator needs. The second half matters:
 * a "fix" that logged nothing at all would satisfy the first half and destroy the
 * diagnostic value the policy exists to preserve.
 *
 * The subprocess costs one spawn for the whole file, in `beforeAll`. It opens no
 * network and no database, so `pnpm test` still runs from a clean clone (ADR-0001).
 */

/**
 * The raw request body, as body-parser 2.3.0 attaches it to the `SyntaxError` it raises
 * for a malformed JSON POST. This is F-244's reproduction verbatim: the attacker path is
 * an unauthenticated POST to any `/api` route with a credential in a body that does not
 * parse.
 */
const RAW_REQUEST_BODY_MARKER = 'hunter2-raw-request-body-marker';

/**
 * Stands in for the class of value an error MESSAGE carries and a stack's first line
 * therefore repeats: a URL-style Postgres DSN on a connection failure, an internal host
 * on a Redis timeout, a fragment of an unauthenticated request body on the
 * framework-400 arm (F-108). `error-envelope.md` names the message as the risky field
 * and the frames as the safe one.
 */
const ERROR_MESSAGE_MARKER = 'sk_live-inside-the-message-marker';

/**
 * A line INSIDE an error message that is shaped like a V8 stack frame. It is here
 * because it is the one input that separates the two halves of the header strip: a
 * filter that keeps only frame-shaped lines would keep this one, so only stripping the
 * `name: message` header by prefix removes it.
 */
const FAKE_FRAME_MARKER = 'fake-frame-marker';

/** A credential sitting at the TOP level of the logged record, which is where a call site that spreads a parsed body reaches first. */
const TOP_LEVEL_SECRET_MARKER = 'top-level-secret-marker';

/**
 * `logging-and-headers.md`, "What the implementer must guarantee": the serialised output
 * contains neither value and contains `[redacted]`. Hand-copied from the contract rather
 * than imported from `logger.ts` — an expected value read out of the code under test
 * agrees with it whatever it does.
 */
const CENSOR = '[redacted]';

/** The context strings the emitter passes, asserted where a call shape must preserve them. */
const FRAMEWORK_400_CONTEXT = 'framework exception with a 400 status';
const POSITIONAL_CONTEXT = 'the same error, passed positionally';

/**
 * Lines are addressed by ORDINAL, not by their `msg`. pino writes fd 1 synchronously so
 * the order is the emission order — and, unlike a `msg` lookup, an ordinal still
 * addresses the right line when a regression changes what `msg` says, which is precisely
 * the regression the positional cases below exist to catch.
 */
const LINE = {
  frameworkErrorUnderErrKey: 0,
  positionalErrorWithContext: 1,
  positionalErrorWithoutContext: 2,
  topLevelSecrets: 3,
  messageSpanningLines: 4,
  hostileAccessors: 5,
  frameworkErrorUnderErrorKey: 6,
  frameworkErrorUnderCauseKey: 7,
  frameworkErrorOneLevelDown: 8,
  errorChainedThroughCause: 9,
} as const;

const EXPECTED_LINE_COUNT = Object.keys(LINE).length;

/** The three fields `errorLogFields` builds. `error-envelope.md`'s policy: no fourth, whatever the error hangs off itself. */
const POLICY_ERROR_FIELDS = ['err_name', 'err_message', 'err_stack'];

/** A stack line, as V8 writes them. */
const STACK_FRAME = /^\s+at /;

/**
 * Emitted in a subprocess so that the module under test is the real singleton writing to
 * the real file descriptor. Held as source text rather than as a sibling `.ts` file for
 * one reason: it has to do to an `Error` what a JavaScript library does to one — bolt
 * `body` onto a `SyntaxError`, redefine `name` as a throwing getter — and expressing
 * that in checked TypeScript would take casts that hide the shape being reproduced.
 *
 * `LOG_LEVEL` and `NODE_ENV` are pinned by the caller so the output does not depend on
 * the developer's shell.
 */
function emitterSource(loggerModule: string): string {
  return `
import { logger } from '${loggerModule}';

// What body-parser 2.3.0 raises for a malformed JSON body: a SyntaxError with the RAW
// REQUEST BODY on \`err.body\`, plus its own status fields. Nest wraps it in a
// BadRequestException and rethrows the same shape into the exception filter.
const parseFailure = new SyntaxError('Unexpected token } in JSON at position 41, ${ERROR_MESSAGE_MARKER}');
parseFailure.body = '{"email":"a@b.test","password":"${RAW_REQUEST_BODY_MARKER}"';
parseFailure.status = 400;
parseFailure.statusCode = 400;
parseFailure.type = 'entity.parse.failed';

// 0. The idiomatic shape, and the one F-244 was reproduced against.
logger.error({ err: parseFailure }, '${FRAMEWORK_400_CONTEXT}');

// 1. The positional shape with a context string. pino puts the error under \`err\` itself.
logger.error(parseFailure, '${POSITIONAL_CONTEXT}');

// 2. The positional shape with NO context string. pino copies \`err.message\` into
//    \`msg\`, which is a top-level key no redact path can censor without censoring every
//    log line's text.
const noContext = new SyntaxError('Unexpected token } in JSON at position 41, ${ERROR_MESSAGE_MARKER}');
noContext.body = '{"email":"a@b.test","password":"${RAW_REQUEST_BODY_MARKER}"';
logger.error(noContext);

// 3. Secrets on the record itself rather than one level down.
logger.error(
  {
    password: '${TOP_LEVEL_SECRET_MARKER}',
    token: '${TOP_LEVEL_SECRET_MARKER}',
    ip: '${TOP_LEVEL_SECRET_MARKER}',
    req: { body: { password: '${TOP_LEVEL_SECRET_MARKER}' } },
  },
  'a record spread from a parsed request body',
);

// 4. A message spanning lines, one of which is shaped like a frame.
const multiline = new Error(
  'connect failed: postgres://app:${ERROR_MESSAGE_MARKER}@db.internal:5432\\n    at ${FAKE_FRAME_MARKER}',
);
logger.error({ err: multiline }, 'a driver failure whose message spans lines');

// 5. name, message and stack are ordinary properties and an error is free to define any
//    of them as a throwing getter. The exception filter's headersSent arm has nowhere
//    left to escape to, so a throw out of the log call is unrecoverable there. The
//    catch emits a line at the same ordinal so the failure is an assertion, not a
//    missing line.
const hostile = new Error('unused');
for (const property of ['name', 'message', 'stack']) {
  Object.defineProperty(hostile, property, {
    get() { throw new Error('the ' + property + ' getter is hostile'); },
  });
}
try {
  logger.error({ err: hostile }, 'an error whose accessors throw');
} catch (thrown) {
  logger.error({ logging_the_error_threw: String(thrown) }, 'an error whose accessors throw');
}

// 6. F-248: the same error under \`error\` rather than \`err\`. A serialiser is keyed by
//    field name, so nothing about this shape distinguishes it at the call site.
logger.error({ error: parseFailure }, 'the same error under the error key');

// 7. F-248: under \`cause\`, which is ES2022's own name for a chained error.
logger.error({ cause: parseFailure }, 'the same error under the cause key');

// 8. F-248: one level down, under a key the call site chose.
logger.error({ ctx: { err: parseFailure } }, 'the same error one level down');

// 9. F-248: reached ONLY through \`err.cause\`. Safe before the fix because nothing walked
//    it; asserted so a walk added for the shapes above cannot start.
const chained = new Error('a wrapper around the parse failure', { cause: parseFailure });
logger.error({ err: chained }, 'an error chained to the leaking one');
`;
}

interface EmittedLine {
  /** The exact bytes of the line, which is what a leak has to be absent from. */
  readonly raw: string;
  readonly record: Record<string, unknown>;
}

let lines: readonly EmittedLine[];

beforeAll(() => {
  const loggerModule = new URL('./logger.ts', import.meta.url).href;

  const run = spawnSync(
    process.execPath,
    ['--no-warnings', '--input-type=module', '-e', emitterSource(loggerModule)],
    {
      encoding: 'utf8',
      env: { ...process.env, LOG_LEVEL: 'error', NODE_ENV: 'test' },
    },
  );

  // A harness that half-ran would let every assertion below pass vacuously, so it is
  // checked loudly here rather than silently in each test.
  if (run.status !== 0 || run.stderr !== '') {
    throw new Error(
      `the log emitter did not run cleanly (status ${String(run.status)}).\nstderr:\n${run.stderr}\nstdout:\n${run.stdout}`,
    );
  }

  const emitted = run.stdout.split('\n').filter((line) => line !== '');

  if (emitted.length !== EXPECTED_LINE_COUNT) {
    throw new Error(
      `expected ${String(EXPECTED_LINE_COUNT)} log lines, got ${String(emitted.length)}:\n${run.stdout}`,
    );
  }

  lines = emitted.map((raw) => ({ raw, record: JSON.parse(raw) as Record<string, unknown> }));
});

/** The `err` object pino wrote, as a record, for the line at `ordinal`. */
function errorFields(ordinal: number): Record<string, unknown> {
  const err = lines[ordinal].record.err;

  expect(err, 'the line carries no `err` object at all').toBeTypeOf('object');

  return err as Record<string, unknown>;
}

describe('what the shared logger writes when an error reaches a log call', () => {
  it('F-244: the raw request body a framework error carries never reaches the log line', () => {
    // The leak itself. body-parser hangs the verbatim body off `err.body`, pino's default
    // `err` serialiser copies every own enumerable property, and REDACT_PATHS cannot help
    // because `err.body` is a string and no path reaches inside one.
    expect(lines[LINE.frameworkErrorUnderErrKey].raw).not.toContain(RAW_REQUEST_BODY_MARKER);
  });

  it("F-244: an error's message never reaches the log line under the `err` key", () => {
    // `includeMessage: false` in the serialiser. The message is the field that carries a
    // DSN, an internal host, or a fragment of an unauthenticated body.
    expect(lines[LINE.frameworkErrorUnderErrKey].raw).not.toContain(ERROR_MESSAGE_MARKER);
  });

  it('F-244: no property a library hung off the error reaches the log line, whatever it is named', () => {
    // The durable half, and the reason the serialiser was preferred to appending
    // `err.body` to REDACT_PATHS: `body` is body-parser's choice of name, not a standard,
    // and the next library to decorate an error picks a different one. The record carries
    // the fields the policy builds and no fourth. `body`, `status`, `statusCode` and
    // `type` are all on the error the emitter logged.
    const unpolicied = Object.keys(errorFields(LINE.frameworkErrorUnderErrKey)).filter(
      (field) => !POLICY_ERROR_FIELDS.includes(field),
    );

    expect(unpolicied).toEqual([]);
  });

  it('F-244: the line still names the error and carries its frames', () => {
    // Withholding everything would satisfy every assertion above and leave an operator
    // with a 500 and nothing to debug it with. `error-envelope.md` keeps the frames
    // precisely because they name files and functions and carry no request data.
    const err = errorFields(LINE.frameworkErrorUnderErrKey);

    expect(err.err_name).toBe('SyntaxError');
    expect(err.err_stack).toBeTypeOf('string');

    const frames = String(err.err_stack).split('\n');

    expect(frames.length).toBeGreaterThanOrEqual(1);
    for (const frame of frames) {
      expect(frame).toMatch(STACK_FRAME);
    }
  });

  it('F-244: log.error(err, context) — the positional form — is covered the same way', () => {
    // pino files a positional Error under `err` itself, so this shape reaches the same
    // serialiser. Asserted rather than assumed: it is a different pino code path, and the
    // hook that guards the no-context form must leave this one alone.
    const line = lines[LINE.positionalErrorWithContext];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);
    expect(line.record.msg).toBe(POSITIONAL_CONTEXT);
  });

  it('F-244: log.error(err) with no context string does not put the message into msg', () => {
    // The second door onto the same hole, measured with the serialiser already in place:
    // pino copies `err.message` into `msg` when an Error is the only argument, and `msg`
    // is a top-level key no redact path can censor without censoring every log line's
    // text. This is the case `hooks.logMethod` exists for.
    const line = lines[LINE.positionalErrorWithoutContext];

    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);
    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    // Still a usable line: some message, and the error still reported.
    expect(line.record.msg).toBeTypeOf('string');
    expect(String(line.record.msg).length).toBeGreaterThan(0);
    expect(errorFields(LINE.positionalErrorWithoutContext).err_name).toBe('SyntaxError');
  });

  it('F-244: a secret at the top level of the record is censored, not only one level down', () => {
    // A pino wildcard path matches EXACTLY ONE level, so `*.password` covers
    // `req.body.password` and does not cover `password` on the record itself — which is
    // where a call site that spreads a parsed body reaches first.
    const line = lines[LINE.topLevelSecrets];
    const record = line.record as { req: { body: Record<string, unknown> } };

    expect(line.raw).not.toContain(TOP_LEVEL_SECRET_MARKER);
    expect(line.record.password).toBe(CENSOR);
    expect(line.record.token).toBe(CENSOR);
    expect(line.record.ip).toBe(CENSOR);
    expect(record.req.body.password).toBe(CENSOR);
  });

  it('F-244: the frames carry no name-and-message header, even when the message itself contains a frame-shaped line', () => {
    // `err.stack` begins with `${name}: ${message}`, so serialising an error the standard
    // way reinstates the message inside the stack (F-111). The header is stripped by
    // prefix and then by shape, and this input needs both: keeping only frame-shaped
    // lines would keep the message's own `    at …` line.
    const line = lines[LINE.messageSpanningLines];

    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);
    expect(line.raw).not.toContain(FAKE_FRAME_MARKER);
    for (const frame of String(errorFields(LINE.messageSpanningLines).err_stack).split('\n')) {
      expect(frame).toMatch(STACK_FRAME);
    }
  });

  it('F-244: an error whose name, message and stack getters throw is logged, not thrown out of the log call', () => {
    // `errorLogFields` runs inside the exception filter's `headersSent` arm, which sits
    // outside the try/catch F-092 added, and inside `main.ts`'s last-chance boot handler.
    // Both are places with nowhere left to escape to, so a throwing accessor there
    // replaces a logged error with an unhandled one.
    const line = lines[LINE.hostileAccessors];

    expect(line.record.logging_the_error_threw).toBeUndefined();
    expect(errorFields(LINE.hostileAccessors).err_name).toBeTypeOf('string');
  });

  it('F-248: the same error under any other key, or one level down, is covered the same way', () => {
    // A serialiser is keyed by FIELD NAME, so `serializers.err` covers exactly `err`.
    // `message` and `stack` are non-enumerable and do not survive pino's ordinary object
    // path — but body-parser ASSIGNS `body`, so it is own and enumerable and travels under
    // whatever key the call site picked. `{ error: e }` is as idiomatic as `{ err: e }`,
    // `cause` is ES2022's own name for a chained error, and `{ ctx: { err: e } }` is the
    // same key one level down. Adding `serializers.error` and `serializers.cause` is the
    // enumeration F-244 rejected — one key name later it is back — so what is asserted here
    // is the property: no error's incidental fields reach a line, under any key.
    const shapes = [
      [LINE.frameworkErrorUnderErrorKey, (record: Record<string, unknown>) => record.error],
      [LINE.frameworkErrorUnderCauseKey, (record: Record<string, unknown>) => record.cause],
      [
        LINE.frameworkErrorOneLevelDown,
        (record: Record<string, unknown>) => (record.ctx as Record<string, unknown>).err,
      ],
    ] as const;

    for (const [ordinal, read] of shapes) {
      expect(lines[ordinal].raw).not.toContain(RAW_REQUEST_BODY_MARKER);
      expect(lines[ordinal].raw).not.toContain(ERROR_MESSAGE_MARKER);

      // Not bought by logging nothing: the operator still gets the name and the frames,
      // and nothing outside the three fields the policy builds.
      const fields = read(lines[ordinal].record) as Record<string, unknown>;

      expect(fields.err_name).toBe('SyntaxError');
      expect(Object.keys(fields).filter((field) => !POLICY_ERROR_FIELDS.includes(field))).toEqual(
        [],
      );
    }
  });

  it('F-248: an error reached only through `err.cause` is still not walked into', () => {
    // `cause` is own but NON-ENUMERABLE when set through the Error constructor, so nothing
    // reached it before this round and the chained error's body never leaked. A fix that
    // replaces errors wherever it finds them must not START walking it: `errorLogFields`
    // is the boundary, and it descends into nothing.
    const line = lines[LINE.errorChainedThroughCause];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);
    expect(errorFields(LINE.errorChainedThroughCause).err_name).toBe('Error');
  });
});
