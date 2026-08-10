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
 * A library-assigned field on a NON-`Error` thrown value, logged under `err`. `catch (err)`
 * binds `unknown`, so `logger.error({ err }, '…')` — the most idiomatic shape in the
 * codebase — reaches this arm whenever the thrown value is a plain object. F-254.
 */
const NON_ERROR_BODY_MARKER = 'nonerror-body-marker';

/** A field the CALL SITE put on the record, which no fix for `msg` may discard. F-252. */
const CALLER_FIELD_MARKER = 'caller-field-marker';

/**
 * The binding a PARENT child logger carries, read off a GRANDCHILD's line. F-264: the
 * wrapper is installed as an own property of the singleton and a child receives it only
 * through the prototype chain, so nothing about a grandchild is installed — and nothing
 * has ever built one.
 */
const GRANDCHILD_PARENT_BINDING_MARKER = 'grandchild-parent-binding-marker';

/**
 * A value the ROOT logger censors today, logged through the root and through a child that
 * brought its own `redact` (F-263). Nothing below asserts that this key is censored — the
 * two lines are compared with each other, so the property holds whatever `REDACT_PATHS`
 * becomes.
 */
const REDACT_PROBE_MARKER = 'redact-probe-marker';

/** The key the redact probe sits under. See `REDACT_PROBE_MARKER` for why it is not asserted directly. */
const REDACT_PROBE_KEY = 'password';

/**
 * What the emitter appends to the CONTEXT STRING when a child-options call REFUSED rather
 * than emitted. F-263's required change is "refuse or merge", and the tests below accept
 * either — asserting one of the two would pick the implementation instead of the property.
 *
 * IN `msg`, NOT UNDER A KEY OF ITS OWN, and the reason is ADR-0028. This signal used to be
 * `{ child_options_refused: true }` on the record. Under a field allowlist a key this suite
 * invented is not a named field, so it would be emitted as `[redacted]`, the three tests
 * below would stop taking their early return, and each would fail reading a record that
 * carries nothing else — three failures that say "F-263 regressed" when nothing about F-263
 * moved. `msg` is a named field by construction, so the signal survives either policy.
 */
const CHILD_OPTIONS_REFUSED = ' [child options refused]';

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
  childBindingUnderErrorKey: 10,
  childBindingOneLevelDown: 11,
  childBindingUnderErrKey: 12,
  errorRecordWithoutContext: 13,
  nonErrorUnderErrKey: 14,
  chainedErrorUnderErrorKey: 15,
  errorAtTheDeepestScannedLevel: 16,
  objectPlaceholder: 17,
  jsonPlaceholder: 18,
  stringPlaceholder: 19,
  placeholderAfterACallerRecord: 20,
  errorInTheMessagePosition: 21,
  argumentWithNoPlaceholder: 22,
  redactProbeThroughTheRoot: 23,
  redactProbeThroughAChildWithItsOwnRedact: 24,
  childWithItsOwnErrSerialiser: 25,
  childWithItsOwnLogFormatter: 26,
  grandchildBinding: 27,
  // `setBindings` stays LAST. See the emitter.
  bindingsSetUnderErrKey: 28,
  bindingsSetUnderOtherKeys: 29,
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

// 9. F-248: reached ONLY through \`err.cause\`, under the TOP-LEVEL \`err\` key — so this line
//    is built by \`serializers.err\`, and what it locks is that \`errorLogFields\` does not
//    descend. The walk's own non-descent is ordinal 15 (F-256).
const chained = new Error('a wrapper around the parse failure', { cause: parseFailure });
logger.error({ err: chained }, 'an error chained to the leaking one');

// 10-12. F-251: the same three shapes again, as CHILD-LOGGER BINDINGS rather than as the
//        record handed to a log method. pino builds bindings through \`asChindings\`, a
//        different code path, and the exception filter already creates a child logger per
//        request — so this is the same door with a different handle on it.
logger.child({ error: parseFailure }).error('a child binding under the error key');
logger.child({ ctx: { err: parseFailure } }).error('a child binding one level down');
logger.child({ err: parseFailure }).error('a child binding under the err key');

// 13. F-252: the record form with NO context string. \`hooks.logMethod\` fires on a
//     POSITIONAL Error, so this shape walks past it, and pino then copies the error's
//     message into \`msg\`. The caller's own field is on the record so that a fix cannot buy
//     a clean \`msg\` by throwing the record away.
logger.error({ request_id: '${CALLER_FIELD_MARKER}', err: parseFailure });

// 14. F-254: a NON-\`Error\` under the top-level \`err\` key. \`catch (err)\` binds \`unknown\`,
//     and a library is free to throw a decorated plain object. This is the one shape that
//     needs BOTH halves of the partition: \`serializers.err\` reduces it, and it only reaches
//     that serialiser because the scan skips the top-level \`err\` key.
logger.error(
  { err: { body: '${NON_ERROR_BODY_MARKER}', status: 400 } },
  'a non-error throwable under the err key',
);

// 15. F-256: the chained error under a key the WALK owns. Ordinal 9 never reaches
//     \`errorsReplaced\` at all, so a walk that started following \`cause\` would leave it
//     green; this line is the one that goes red.
logger.error({ error: chained }, 'an error chained to the leaking one, under the error key');

// 16. F-257: an error at the deepest level the scan is documented to reach. Written out by
//     hand rather than built from \`MAX_ERROR_SCAN_DEPTH\`, which would agree with the
//     source whatever the source says.
logger.error({ a: { b: { c: { err: parseFailure } } } }, 'an error four levels into the record');

// 17-19. F-260, DOOR SIX. pino builds \`msg\` out of the call's ARGUMENTS, through
//        quick-format-unescaped, BEFORE \`write()\` runs — so a format placeholder
//        interpolates whatever the argument is into the one top-level field no redact path
//        may censor. \`hooks.logMethod\` reads only args[0] and args[1], and neither
//        \`serializers.err\`, nor \`formatters.log\`, nor either bindings wrapper is on this
//        path at all. %o and %j reach the properties a library hung off the error; %s
//        reaches its message.
logger.error('parse failed: %o', parseFailure);
logger.error('parse failed: %j', parseFailure);
logger.error('parse failed: %s', parseFailure);

// 20. F-260, the object-first shape. The caller's own field is on the record so that a fix
//     cannot buy a clean \`msg\` by discarding what the call site supplied.
logger.error({ request_id: '${CALLER_FIELD_MARKER}' }, 'parse failed: %o', parseFailure);

// 21. F-260, an Error in the MESSAGE position. pino writes the second argument as \`msg\`
//     with no placeholder involved, so the whole error lands there as a JSON object.
logger.error({ request_id: '${CALLER_FIELD_MARKER}' }, parseFailure);

// 22. F-269: a trailing argument with NO matching placeholder. quick-format drops it today,
//     so nothing leaks and nothing is reported either — one character from the line above.
//     Asserted so that a fix for F-260 that folds stray arguments into the record cannot
//     reopen the leak here.
logger.error('parse failed', parseFailure);

// 23-24. F-263: pino's child OPTIONS replace the instance's \`redact\` outright
//        (\`proto.js:157-165\`, "redact must place before asChindings and only replace if
//        exist"). The wrapper installed for F-251 scans the bindings and hands \`options\`
//        to pino unexamined, so one child-scoped redact path removes every path the root
//        censors, on that child, with no diagnostic.
//
//        THE PAIR IS THE ASSERTION: the same record goes through the root and through the
//        child, and the test compares the two lines rather than naming which keys are
//        censored.
const redactProbe = { ${REDACT_PROBE_KEY}: '${REDACT_PROBE_MARKER}' };

logger.error(redactProbe, 'the redact probe through the root logger');
try {
  logger
    .child({ scope: 'redact-probe' }, { redact: { paths: ['nothing.the.root.censors'], censor: 'x' } })
    .error(redactProbe, 'the redact probe through a child with its own redact');
} catch {
  logger.error('the redact probe through a child with its own redact${CHILD_OPTIONS_REFUSED}');
}

// 25. F-263: child options merge serialisers PER KEY (\`proto.js:118-134\`), so a child that
//     supplies its own \`err\` serialiser replaces the one that owns the top-level \`err\` key —
//     the half of the partition the scan deliberately does not cover.
try {
  logger
    .child({ request_id: '${CALLER_FIELD_MARKER}' }, { serializers: { err: (thrown) => thrown } })
    .error({ err: parseFailure }, 'a child with its own err serialiser');
} catch {
  logger.error('a child with its own err serialiser${CHILD_OPTIONS_REFUSED}');
}

// 26. F-263: child options replace \`formatters.log\` (\`proto.js:136-143\`), which is the scan
//     that owns every key OTHER than the top-level \`err\`.
try {
  logger
    .child({ request_id: '${CALLER_FIELD_MARKER}' }, { formatters: { log: (record) => record } })
    .error({ error: parseFailure }, 'a child with its own log formatter');
} catch {
  logger.error('a child with its own log formatter${CHILD_OPTIONS_REFUSED}');
}

// 27. F-264: a GRANDCHILD, which nothing has ever built. Both halves are on this one line —
//     the parent's binding survives the wrapper's receiver, and the grandchild's own
//     bindings are still scanned.
logger
  .child({ request_id: '${GRANDCHILD_PARENT_BINDING_MARKER}' })
  .child({ error: parseFailure })
  .error('a grandchild binding under the error key');

// 28-29. F-258: \`setBindings\` is the OTHER door onto \`asChindings\`, and it is not the one
//        \`child\` was wrapped for. THESE TWO CALLS ARE LAST ON PURPOSE: \`setBindings\`
//        appends to the singleton's chindings permanently, so every line after them would
//        carry their bindings too. The \`err\` shape is bound FIRST, while it is the only
//        binding, so that its line is not polluted by the leak the next call adds.
logger.setBindings({ err: parseFailure });
logger.error('an error bound under the err key by setBindings');

logger.setBindings({ error: parseFailure, ctx: { err: parseFailure } });
logger.error('an error bound under other keys by setBindings');
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
    //
    // WHAT THIS LINE DOES AND DOES NOT LOCK (F-256). A top-level `err` is skipped by the
    // scan and handled by `serializers.err`, so the boundary this line holds is
    // `errorLogFields`' — which is worth holding: pino-std-serializers, the default this
    // serialiser displaced, DOES follow `cause` and appends the chained error to the stack,
    // so dropping the override reopens the leak here. The walk's own non-descent is a
    // different line; see the F-256 test below.
    const line = lines[LINE.errorChainedThroughCause];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);
    expect(errorFields(LINE.errorChainedThroughCause).err_name).toBe('Error');
  });

  it('F-256: an error the walk replaced is not descended into through `cause` either', () => {
    // The line above is built by the SERIALISER. This one is built by the WALK: `error` is
    // a key `errorsReplaced` owns, so a change that made the walk follow a replaced error's
    // `cause` — the plausible "improve the error serialiser" edit — shows up here and only
    // here. Same property, aimed at the other mechanism.
    const line = lines[LINE.chainedErrorUnderErrorKey];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    const fields = line.record.error as Record<string, unknown>;

    expect(fields.err_name).toBe('Error');
    expect(Object.keys(fields).filter((field) => !POLICY_ERROR_FIELDS.includes(field))).toEqual([]);
  });

  it("F-251: an error in a child logger's bindings is covered under a key other than `err`", () => {
    // A child logger is a second door onto the same line, through a different pino code
    // path: bindings are serialised once at `logger.child(…)` by `asChindings`, which
    // applies `formatters.bindings` and `serializers[key]` and never `formatters.log`. The
    // exception filter already builds a child logger per request, so the shape is one
    // idiomatic edit away, and what it writes today is F-244's payload verbatim.
    const line = lines[LINE.childBindingUnderErrorKey];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    // Not bought by binding nothing: the operator still gets the name and the frames.
    const fields = line.record.error as Record<string, unknown>;

    expect(fields.err_name).toBe('SyntaxError');
    expect(Object.keys(fields).filter((field) => !POLICY_ERROR_FIELDS.includes(field))).toEqual([]);
  });

  it("F-251: an error nested inside a child logger's bindings is covered too", () => {
    // The nested shape, asserted separately from the flat one because a fix that only
    // re-keyed the top level of the bindings would pass the test above and leak here.
    const line = lines[LINE.childBindingOneLevelDown];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    const fields = (line.record.ctx as Record<string, unknown>).err as Record<string, unknown>;

    expect(fields.err_name).toBe('SyntaxError');
    expect(Object.keys(fields).filter((field) => !POLICY_ERROR_FIELDS.includes(field))).toEqual([]);
  });

  it('F-251: an error under `err` in child bindings still reports the policy fields, not `non-error throwable`', () => {
    // THE SEAM, on the bindings path. `asChindings` applies `formatters.bindings` BEFORE
    // `serializers[key]`, exactly as `_asJson` applies `formatters.log` before them — so a
    // bindings-side scan that replaced the top-level `err` would hand `serializers.err` an
    // ordinary object, and this line would degrade to `non-error throwable (object)` with
    // no frames. This shape is the one child binding that is safe today; it must stay safe.
    const line = lines[LINE.childBindingUnderErrKey];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    const fields = line.record.err as Record<string, unknown>;

    expect(fields.err_name).toBe('SyntaxError');
    expect(fields.err_stack).toBeTypeOf('string');
  });

  it('F-252: log.error({ err }) with no context string does not put the message into msg', () => {
    // The third door. `hooks.logMethod` rewrites the POSITIONAL form, but pino also fills
    // `msg` from the record's own `err.message` when a log call carries no message of its
    // own — so the record form walks past the hook and lands the message in the one
    // top-level field no redact path can censor without censoring every line's text. On the
    // framework-400 arm that message quotes raw request bytes (F-108).
    const line = lines[LINE.errorRecordWithoutContext];

    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);
    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);

    // Still a usable line, and the caller's own fields survive: a fix that emptied the
    // record, or dropped the error, would satisfy the two assertions above.
    expect(line.record.msg).toBeTypeOf('string');
    expect(String(line.record.msg).length).toBeGreaterThan(0);
    expect(line.record.request_id).toBe(CALLER_FIELD_MARKER);
    expect(errorFields(LINE.errorRecordWithoutContext).err_name).toBe('SyntaxError');
  });

  it('F-254: a non-Error under the top-level `err` key is still reduced to the policy fields', () => {
    // THE ONE PROPERTY THAT NEEDS BOTH HALVES OF THE PARTITION. `serializers.err` reduces a
    // non-`Error` under `err` to `err_name`, and it only ever receives that value because
    // the scan skips the top-level `err` key. Drop either half alone and another test goes
    // red; drop BOTH — "these two mechanisms overlap, let me unify them", the one refactor a
    // later reader is most likely to propose — and this is the only test that fires. What
    // ships instead is the value verbatim, with `password` censored by name, which is the
    // enumeration F-244 rejected.
    const line = lines[LINE.nonErrorUnderErrKey];

    expect(line.raw).not.toContain(NON_ERROR_BODY_MARKER);

    const fields = errorFields(LINE.nonErrorUnderErrKey);

    expect(fields.err_name).toBe('non-error throwable (object)');
    expect(Object.keys(fields).filter((field) => !POLICY_ERROR_FIELDS.includes(field))).toEqual([]);
  });

  it('F-257: an error four levels into the record is still replaced', () => {
    // The FLOOR of the documented guarantee, which the rest of the suite defends only to
    // depth 2 — so the bound can be narrowed to 3 or to 2 today with every gate green, and
    // the docblock would still claim 4. Only the floor is asserted: a test that the level
    // BELOW leaks would encode the residual as a requirement and fire red on a security
    // improvement.
    const line = lines[LINE.errorAtTheDeepestScannedLevel];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    const nested = line.record.a as Record<string, Record<string, Record<string, unknown>>>;
    const fields = nested.b.c.err as Record<string, unknown>;

    expect(fields.err_name).toBe('SyntaxError');
    expect(Object.keys(fields).filter((field) => !POLICY_ERROR_FIELDS.includes(field))).toEqual([]);
  });

  it('F-258: an error bound through `setBindings` is covered under a key other than `err`', () => {
    // The second door onto `asChindings`, and the one `child` was not wrapped for.
    // `setBindings` hands its argument to the same function child bindings go through, so the
    // shapes leak identically — and it needs no child logger, so a call site reaches it with
    // one line. Both shapes are read off the same line because one `setBindings` call carries
    // them; a fix that re-keyed only the top level would still leave `ctx.err` here.
    const line = lines[LINE.bindingsSetUnderOtherKeys];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    // Not bought by binding nothing: the operator still gets the name and the frames under
    // each key.
    const shapes = [
      line.record.error as Record<string, unknown>,
      (line.record.ctx as Record<string, unknown>).err as Record<string, unknown>,
    ];

    for (const fields of shapes) {
      expect(fields.err_name).toBe('SyntaxError');
      expect(Object.keys(fields).filter((field) => !POLICY_ERROR_FIELDS.includes(field))).toEqual(
        [],
      );
    }
  });

  it('F-258: an error under `err` in `setBindings` still reports the policy fields, not `non-error throwable`', () => {
    // THE SEAM, on the `setBindings` path — MEASURED to exist here, not assumed to carry over
    // from `child`: `asChindings` consults `serializers[key]` for these bindings too, so this
    // shape is already covered and already carries frames. A scan added for the line above
    // that replaced the top-level `err` would hand `serializers.err` an ordinary object and
    // degrade this line to `non-error throwable (object)` with nothing to debug from.
    const line = lines[LINE.bindingsSetUnderErrKey];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    const fields = line.record.err as Record<string, unknown>;

    expect(fields.err_name).toBe('SyntaxError');
    expect(fields.err_stack).toBeTypeOf('string');
  });

  it('F-260: a format placeholder never interpolates an error into `msg`', () => {
    // DOOR SIX, and a mechanism distinct from every one above it. pino builds `msg` from
    // the call's ARGUMENTS through quick-format-unescaped before `write()` is reached, so
    // none of `serializers.err`, `formatters.log`, the `child` wrapper or the `setBindings`
    // wrapper is on this path — they all act on the RECORD or on BINDINGS, and this is
    // neither. `hooks.logMethod` is the only thing that sees the arguments and it reads
    // args[0] and args[1] only.
    //
    // %o and %j reach the properties a library assigned to the error — body-parser's
    // verbatim request body among them. %s reaches `String(error)`, which is
    // `${name}: ${message}`, and the message is the field the policy withholds everywhere
    // else.
    // Every shape is reported together rather than one assertion each, so a failure names
    // ALL the placeholders that leak instead of stopping at the first.
    const shapes = [
      ['%o', LINE.objectPlaceholder],
      ['%j', LINE.jsonPlaceholder],
      ['%s', LINE.stringPlaceholder],
    ] as const;

    const leaking = shapes
      .filter(
        ([, ordinal]) =>
          lines[ordinal].raw.includes(RAW_REQUEST_BODY_MARKER) ||
          lines[ordinal].raw.includes(ERROR_MESSAGE_MARKER),
      )
      .map(([placeholder]) => placeholder);

    expect(leaking).toEqual([]);

    // Not bought by dropping the line's text: the call site's own words survive.
    for (const [, ordinal] of shapes) {
      expect(String(lines[ordinal].record.msg)).toContain('parse failed');
    }
  });

  it("F-260: the object-first format shape is covered, and the caller's own fields survive", () => {
    // `log.error({ request_id }, 'parse failed: %o', err)` — the shape a request-scoped
    // call site writes. pino takes args[0] as the record and formats args[1..] into `msg`,
    // so the hook's second argument is the format STRING and the error is never inspected.
    const line = lines[LINE.placeholderAfterACallerRecord];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);
    expect(line.record.request_id).toBe(CALLER_FIELD_MARKER);
    expect(String(line.record.msg)).toContain('parse failed');
  });

  it('F-260: an Error in the message position never becomes the message', () => {
    // No placeholder involved: pino writes args[1] as `msg` directly, so the whole error —
    // every own enumerable property a library hung off it — lands in the one top-level
    // field no redact path may censor.
    const line = lines[LINE.errorInTheMessagePosition];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    // Still a usable line: the caller's field survives and `msg` is a string an aggregator
    // can index, not an object.
    expect(line.record.request_id).toBe(CALLER_FIELD_MARKER);
    expect(line.record.msg).toBeTypeOf('string');
  });

  it('F-269: an argument with no matching placeholder puts no fragment of the error on the line', () => {
    // GREEN TODAY, and named anyway: quick-format DROPS a trailing argument that no
    // placeholder consumes, so `log.error('parse failed', err)` reports nothing at all —
    // one character from the leaking shape above. This asserts the security half only. A
    // fix for F-260 that folds stray arguments into the record instead of discarding them
    // is a legitimate answer to the silence, and this is what stops that answer from
    // reopening the leak here.
    const line = lines[LINE.argumentWithNoPlaceholder];

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);
  });

  it('F-263: a child that supplies its own `redact` still censors what the root censors', () => {
    // pino's child options REPLACE the instance's redact list outright — `proto.js` says
    // so in a comment, "replace redact directly" — and the wrapper installed for F-251
    // scans the bindings and then hands `options` to pino unexamined. So a TASK adding one
    // child-scoped redact path silently removes every path the root censors, on that
    // child, with nothing in the output to say so.
    //
    // THE ASSERTION IS DIFFERENTIAL, ON PURPOSE. The same record goes through the root and
    // through the child, and what is compared is the two lines' treatment of it — never
    // which spellings `REDACT_PATHS` happens to hold, which is being decided elsewhere.
    // The property survives that decision whatever it lands on.
    //
    // KNOWN LIMIT: if the redaction policy ever stops censoring this probe's key, both
    // sides emit the raw value and this test quietly stops covering the redact vector. It
    // cannot go red for the wrong reason, but it can go quiet, and the probe's key has to
    // be re-chosen when that happens.
    const child = lines[LINE.redactProbeThroughAChildWithItsOwnRedact];

    // Refusing the options outright is the other half of F-263's required change, and it
    // closes this door as completely as merging does.
    if (String(child.record.msg).includes(CHILD_OPTIONS_REFUSED)) {
      return;
    }

    const root = lines[LINE.redactProbeThroughTheRoot];

    expect(child.record[REDACT_PROBE_KEY]).toEqual(root.record[REDACT_PROBE_KEY]);
    expect(child.raw.includes(REDACT_PROBE_MARKER)).toBe(root.raw.includes(REDACT_PROBE_MARKER));
  });

  it('F-263: a child that supplies its own `err` serialiser still reduces the error to the policy fields', () => {
    // Child options merge serialisers PER KEY, so a child supplying `serializers.err`
    // displaces the one that owns the top-level `err` key — the half of the partition the
    // record scan deliberately skips. Nothing else covers that key, so the error arrives
    // at `JSON.stringify` with every property a library assigned to it.
    const line = lines[LINE.childWithItsOwnErrSerialiser];

    if (String(line.record.msg).includes(CHILD_OPTIONS_REFUSED)) {
      return;
    }

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    // Not bought by dropping the error: the operator still gets the name and the frames.
    const fields = line.record.err as Record<string, unknown>;

    expect(fields.err_name).toBe('SyntaxError');
    expect(Object.keys(fields).filter((field) => !POLICY_ERROR_FIELDS.includes(field))).toEqual([]);
  });

  it('F-263: a child that supplies its own `formatters.log` still covers an error under any other key', () => {
    // The third replacement vector, and the widest: `formatters.log` is the scan that owns
    // every key other than the top-level `err`, at every depth. A child that supplies one —
    // to add a field to every line, say — removes F-248's entire mechanism on that child.
    const line = lines[LINE.childWithItsOwnLogFormatter];

    if (String(line.record.msg).includes(CHILD_OPTIONS_REFUSED)) {
      return;
    }

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    const fields = line.record.error as Record<string, unknown>;

    expect(fields.err_name).toBe('SyntaxError');
    expect(Object.keys(fields).filter((field) => !POLICY_ERROR_FIELDS.includes(field))).toEqual([]);
  });

  it("F-264: a grandchild keeps its parent's bindings and still covers an error in its own", () => {
    // NOTHING HAS EVER BUILT ONE. Both wrappers are installed as OWN properties of the
    // singleton, and a child has zero own properties — it receives them through the
    // prototype chain `Object.create(this)` builds. So grandchild coverage is inherited
    // rather than installed, and the two ways it disappears are both silent: a wrapper
    // that called pino's `child` on the SINGLETON rather than on its own receiver would
    // strip the parent's bindings off every grandchild with the whole suite green, and a
    // pino release that stops deriving a child from its parent would strip the scan.
    //
    // Both halves are read off the one line, because one line is where a call site meets
    // both: the request-scoped parent's `request_id`, and an error in the grandchild's own
    // bindings.
    const line = lines[LINE.grandchildBinding];

    expect(line.record.request_id).toBe(GRANDCHILD_PARENT_BINDING_MARKER);

    expect(line.raw).not.toContain(RAW_REQUEST_BODY_MARKER);
    expect(line.raw).not.toContain(ERROR_MESSAGE_MARKER);

    const fields = line.record.error as Record<string, unknown>;

    expect(fields.err_name).toBe('SyntaxError');
    expect(Object.keys(fields).filter((field) => !POLICY_ERROR_FIELDS.includes(field))).toEqual([]);
  });
});
