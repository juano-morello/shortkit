import { spawnSync } from 'node:child_process';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * ADR-0028 — a log field reaches the line only if its key is named.
 *
 * Decision: `docs/decisions/adr-0028-log-field-allowlist.md`. Contract:
 * `docs/contracts/logging-and-headers.md`, "What may never appear in a log line" and
 * invariant 1. Enforces GC-9 — no PII in log bodies.
 *
 * Findings: F-261, F-262, F-266.
 *
 * ============================================================================
 * WHY THIS FILE IS SEPARATE FROM `logger.spec.ts`
 * ============================================================================
 *
 * `logger.spec.ts` is about ERRORS: what happens to an `Error` and to the properties a
 * library hung off one, under every key and on every path a line is built by. Its subject is
 * a VALUE and its policy.
 *
 * This file is about KEYS. ADR-0028 replaces `REDACT_PATHS` — a list of 25 key paths to
 * censor — with `LOGGABLE_FIELDS`, a list of keys that may carry a value, and censors
 * everything else. The two suites therefore fail for different reasons and a reader chasing
 * one should not have to read the other. They share the emitter shape and nothing else.
 *
 * ============================================================================
 * WHAT THESE TESTS ARE FOR, AND WHY THE FIRST ONE IS THE IMPORTANT ONE
 * ============================================================================
 *
 * `REDACT_PATHS` has failed three audit rounds the same way: it covers the spellings someone
 * thought of. F-244 was `err.body`. F-262 is `clientIp`, `trustedClientIp`, `remoteAddress`,
 * `ipAddress`. F-266 is `sessionToken`, `apiKey`, `api_key`, `passwordHash`, and a bare
 * `authorization` or `cookie`. Appending each round's newly-found names produces a longer
 * list with the same property, so a suite that covered only those names would certify the
 * fourth round of the same fix.
 *
 * So the FIRST test below logs keys that appear NOWHERE in this repository — invented for
 * this file — and asserts they are censored. It is the one that says the mechanism is right
 * rather than that four known spellings are covered. The three finding-named tests after it
 * are the measured shapes each finding was raised against, kept because a finding closes
 * against the reproduction that raised it.
 *
 * ============================================================================
 * AND WHAT STOPS "CENSOR EVERYTHING" PASSING
 * ============================================================================
 *
 * Every assertion above is satisfied by a logger that emits `[redacted]` for every key it is
 * given, which would be useless and would pass silently — ADR-0028's own stated cost is that
 * "typecheck, lint and the suite are all green on a log line whose fields are all censored".
 * Three tests exist against that: the fields the shipped call sites actually emit reach the
 * line with their values, an array element is not treated as a field name, and a key whose
 * value is `undefined` does not become a field. Each is green today for a different reason
 * than it will be green afterwards, so each is proved by mutation in the report rather than
 * assumed.
 *
 * ============================================================================
 * HOW
 * ============================================================================
 *
 * The same shape `logger.spec.ts` uses and for the same reason: a test that read
 * `logger.options.redact` would pass against a configuration that emits the wrong bytes.
 * A Node process imports THE SHIPPED SINGLETON, emits one line per shape to file descriptor
 * 1, and every assertion is made against those bytes.
 *
 * `LOG_LEVEL` is `info`, not `error`. Two reasons, and they are the same reason: the auditor
 * measured every shape below at `info`, and the deployed image sets no `LOG_LEVEL` at all
 * (`Dockerfile`, `ENV NODE_ENV=production`), so `info` is the level the leak is reachable at
 * in production and the level a request-logging middleware would write.
 *
 * No network, no database, no Docker. `pnpm test` still runs from a clean clone (ADR-0001).
 *
 * ============================================================================
 * ROUND 6 ADDITIONS: F-277 (DOOR SEVEN) AND F-279, AND WHY THEY ARE FILED HERE
 * ============================================================================
 *
 * Both are the same question this file was opened to ask — CAN A VALUE REACH A LINE UNDER A
 * KEY NOBODY NAMED — reached through two doors the file did not probe.
 *
 *   - F-277 is the ARGUMENT LIST. Every shape above puts its payload in the RECORD; not one
 *     puts a value in pino's MESSAGE position, and that is the one position nothing scans.
 *     `sdlc-security-auditor`'s required change names this file by name.
 *   - F-279 is `childOptionsChecked`, which ADR-0028 made the only thing standing between a
 *     record and the line when a child supplies its own `formatters`. Its two measured
 *     failures are a NAMED field losing its value (invariant 8's "the key stays on the line",
 *     which is this file's subject) and the scan being disabled outright.
 *
 * They are NOT in `logger.spec.ts`, whose subject is an `Error` and the properties a library
 * hangs off one. The payloads below are credentials and IPs under ordinary keys, which is this
 * file's subject, and `logger.spec.ts`'s emitter cannot take an appended shape safely anyway —
 * its last two lines call `setBindings`, which pollutes the singleton permanently.
 */

/**
 * A value under a key NOBODY HAS NAMED. Six spellings, none of which occurs anywhere in
 * `apps/api/src` — five are ADR-0028's own examples of "every field a TASK invents next
 * quarter", and `attemptCount` is the ADR's rule-6 example, chosen because it is one word
 * away from `attempt`, which IS on the list. A near miss has to be censored like a miss.
 */
const UNNAMED_FIELD_MARKER = 'unnamed-field-marker';

/**
 * The four IP spellings F-262 measured, one distinct literal each so a failure names WHICH
 * key leaked rather than only that one did. Hand-copied from the TASK-003 round-5 security
 * audit § F-262, which measured them against this same singleton, and they are TEST-NET-1
 * addresses (RFC 5737) so nothing here resembles a real client. That audit was one of the
 * process artifacts deleted on 2026-08-17; it is in git history at `c617ebd` and earlier,
 * under `.sdlc/foundation/audits/`.
 *
 * `trustedClientIp` is the one that matters most: it is the accessor the retired design stub
 * `apps/api/src/auth/resolve-rate-limit-principal.ts` already named, so the spelling this
 * system will actually hold is one of the uncensored ones.
 */
const CLIENT_IP = '203.0.113.9';
const TRUSTED_CLIENT_IP = '203.0.113.10';
const REMOTE_ADDRESS = '203.0.113.11';
const IP_ADDRESS = '203.0.113.12';
const IP = '203.0.113.13';

/** The request-shaped record's own IP, kept distinct from the four above (F-261). */
const REQUEST_REMOTE_ADDRESS = '203.0.113.7';
const REQUEST_REMOTE_PORT = 44321;

/**
 * The concrete path on a request-shaped record. "Required fields" forbids it — `route` is the
 * PATTERN, never the path — and the redirect path's concrete paths are the entire click
 * stream in plain text. The query string carries a capability token on top of that.
 */
const REQUEST_URL = '/l/abc?token=SEKRIT-IN-THE-URL';

/** The two request headers the six `req.headers.*` redact paths do not reach when the request IS the record (F-261, widened by the round-5 audit). */
const AUTHORIZATION_HEADER = 'Bearer AAA-authorization-marker';
const COOKIE_HEADER = 'sk_at=BBB-cookie-marker';

/**
 * F-266's eight credential spellings, one marker each. `token` and `password` are NOT here:
 * they are censored today, and they are asserted separately as the coverage this change may
 * not lose.
 */
const SESSION_TOKEN = 'S1-session-token-marker';
const ACCESS_TOKEN = 'S2-access-token-marker';
const REFRESH_TOKEN = 'S3-refresh-token-marker';
const API_KEY_CAMEL = 'S4-apiKey-marker';
const API_KEY_SNAKE = 'S5-api_key-marker';
const PASSWORD_HASH = 'S6-password-hash-marker';

/** The two spellings `REDACT_PATHS` does censor today. Asserted so the change cannot be bought by losing them. */
const TOKEN = 'T-token-marker';
const PASSWORD = 'P-password-marker';

/**
 * The raw request body body-parser 2.3.0 hangs off the `SyntaxError` it raises for a
 * malformed JSON POST. Used only by the container tests below, where the question is whether
 * a container the scan CANNOT INSPECT is censored or passed through.
 */
const RAW_REQUEST_BODY_MARKER = 'hunter2-raw-request-body-marker';

/** A secret inside an object inside an array under a NAMED key. ADR-0028's own measured example. */
const SECRET_INSIDE_AN_ARRAY = 'array-element-secret-marker';

/**
 * `logging-and-headers.md`, "What the implementer must guarantee", and ADR-0028
 * § "`REDACT_CENSOR` keeps its name and its value". Hand-copied from the contract rather than
 * imported from `logger.ts` — an expected value read out of the code under test agrees with
 * it whatever it does.
 */
const CENSOR = '[redacted]';

/**
 * Every field a log call site in `apps/api/src` actually emits today, with a value that is
 * recognisably itself. This is ADR-0028 Migration step 3 — "sweep every log call site and
 * check its fields against the list" — written as an assertion, so a name missing from
 * `LOGGABLE_FIELDS` reds here instead of degrading a line silently at 3am.
 *
 * Sources, one per field:
 *   `request_id`, `route`, `status`, `duration_ms`, `tenant_id` — the contract's
 *      "Required fields" table, and `RequestLogFields` in `logger.ts`.
 *   `boot_precondition`, `attempt`, `retry_in_ms` — `main.ts:198-206` and `:269-277`.
 *   `code` — `exception-filter.ts`, a `DomainError` code (`error-envelope.md`).
 *   `err_name`, `err_message`, `err_stack` — `ErrorLogFields`, spread into records by
 *      `logError` and by `main.ts`.
 *   `msg` — pino's `messageKey`, when a call site supplies its own on the record.
 */
const REQUEST_ID = 'r-1-request-id';
const ROUTE_PATTERN = '/api/links/:id';
const TENANT_ID = 't-1-tenant-id';
const DOMAIN_ERROR_CODE = 'validation_failed';
const CALLER_SUPPLIED_MESSAGE = 'a message the call site put on the record';

/** The context strings the emitter passes, asserted where "not bought by logging nothing" needs one. */
const REQUEST_RECORD_CONTEXT = 'a request-shaped first argument';

/**
 * ============================================================================
 * F-277, DOOR SEVEN. THE VALUES THAT GO IN PINO'S MESSAGE POSITION.
 * ============================================================================
 *
 * `interpolationCovered` reduces `args[1]` only when it `instanceof Error`, and its
 * interpolation loop starts at `message + 1`, so a NON-`Error` value in the message position
 * is inspected by nothing at all — not `LOGGABLE_FIELDS`, not `formatters.log`, not
 * `serializers.err`, not either bindings wrapper. It reaches `msg` verbatim.
 *
 * The call shape is `logger.error({ request_id }, e)` where `e` is what `catch (e)` binds and
 * what a rejected promise carries. `e` is `any` in a `.catch` callback, so it typechecks and
 * lints clean; `logger.ts:199` names that exact shape as covered and `:221-222` claims "A
 * CONTAINER in either position is scanned".
 *
 * Each marker is distinct so a failure names WHICH shape and WHICH key leaked.
 */
const HOSTILE_CLIENT_IP = '203.0.113.31';
const HOSTILE_AUTHORIZATION = 'Bearer M1-message-position-authorization-marker';
const HOSTILE_BODY_PASSWORD = 'M2-message-position-body-password-marker';
const ARRAY_ELEMENT_SECRET = 'M3-message-position-array-element-marker';
const CLASS_INSTANCE_SECRET = 'M4-message-position-class-instance-marker';
const NO_RECORD_SECRET = 'M5-message-position-no-record-marker';
const TRAILING_ARGUMENT_SECRET = 'M6-message-position-trailing-argument-marker';

/**
 * ============================================================================
 * THE EIGHT NAMES THAT PIN THE REGRESSION DIRECTION, AND WHY THEY ARE NOT AN ARBITRARY LIST.
 * ============================================================================
 *
 * F-277 is a REGRESSION, and a guard that only asserted the general property would not have
 * caught it — every shape above leaks in the message position on BOTH singletons.
 *
 * `REDACT_PATHS` carried eight wildcards: `*.password`, `*.token`, `*.secret`, `*.rawToken`,
 * `*.tokenDigest`, `*.verificationToken`, `*.ip`, `*.ipHash`. pino builds a WILDCARD
 * STRINGIFIER out of those and applies it to the `msg` value too — `tools.js:205`,
 * `stringifiers[messageKey] || wildcardStringifier` — so the eight names were censored INSIDE
 * `msg` by accident, and ADR-0028's removal of the list took that with it.
 *
 * MEASURED, both singletons, same process shape, `logger.ts` restored byte-identical
 * afterwards (md5 `88cf0c238633777e375ec5d75cfeed1f`):
 *
 *   `logger.error({ request_id }, { password: …, token: …, secret: …, rawToken: …,
 *                                   tokenDigest: …, verificationToken: …, ip: …, ipHash: … })`
 *
 *   at `45cf578^`  "msg":{"password":"[redacted]","token":"[redacted]", … all eight
 *   at HEAD        "msg":{"password":"W1","token":"W2", … all eight verbatim
 *
 * So THIS shape is the one that discriminates between the two, in the right direction: red at
 * HEAD, green before ADR-0028. The shapes either side of it are the wider class the denylist
 * never covered.
 */
const REGRESSED_PASSWORD = 'G1-regressed-password-marker';
const REGRESSED_TOKEN = 'G2-regressed-token-marker';
const REGRESSED_SECRET = 'G3-regressed-secret-marker';
const REGRESSED_RAW_TOKEN = 'G4-regressed-raw-token-marker';
const REGRESSED_TOKEN_DIGEST = 'G5-regressed-token-digest-marker';
const REGRESSED_VERIFICATION_TOKEN = 'G6-regressed-verification-token-marker';
const REGRESSED_IP = '203.0.113.32';
const REGRESSED_IP_HASH = 'G8-regressed-ip-hash-marker';

/**
 * ============================================================================
 * F-279. THE TWO OPTIONS SHAPES `childOptionsChecked` DOES NOT SEE.
 * ============================================================================
 *
 * `Object.hasOwn` is used for all three refused options, and pino does not read all three the
 * same way: `options.hasOwnProperty('serializers')` (`proto.js:115`) and
 * `options.hasOwnProperty('formatters')` (`:136`) are OWN checks that `Object.hasOwn` matches,
 * but `typeof options.redact === 'object'` (`:161`) is an ORDINARY PROPERTY READ that walks the
 * prototype chain, and `hasOwnProperty` is a METHOD CALL ON THE OPTIONS OBJECT that an options
 * object is free to answer for itself.
 *
 * So the check is wrong in both directions, and both were measured against this singleton:
 * a `redact` on the options PROTOTYPE is accepted and installed, and an options object with a
 * LYING own `hasOwnProperty` takes pino's replacing branch while `Object.hasOwn` says no.
 */
const CHILD_SCOPE = 'a child logger built with hostile options';

/** The record the proto-`redact` child logs. `request_id` IS a named field, so it must reach the line. */
const REDACT_REMOVED_FIELD = 'request_id';

/** What the lying-options child logs, under keys nobody named. Censored unless the scan was disabled. */
const LYING_OPTIONS_PASSWORD = 'X1-lying-child-options-password-marker';
const LYING_OPTIONS_IP = '203.0.113.33';

/**
 * What the emitter appends to the CONTEXT STRING when a child-options call REFUSED rather than
 * emitted, copied from `logger.spec.ts` and for the same two reasons. F-279's required change
 * is "match pino's own predicate per option", and a refusal is what that produces — but a call
 * site that reads the options through pino's accessor and neutralises them instead is an equally
 * good answer, so the tests below accept either rather than picking the implementation.
 *
 * IN `msg`, NOT UNDER A KEY OF ITS OWN: a key this suite invented is not a named field, so it
 * would arrive as `[redacted]` and the tests could not read it. `msg` is named by construction.
 */
const CHILD_OPTIONS_REFUSED = ' [child options refused]';

/**
 * ============================================================================
 * F-282. WHAT SEPARATES THE SHIPPED FIX FOR F-277 FROM THE CHEAPEST WRONG ONE.
 * ============================================================================
 *
 * The three tests in the door-seven describe assert that no payload marker reaches the line and
 * that the caller's record and SOME `msg` survive. `sdlc-reviewer` built the DROP MUTANT —
 * `errorMovedOntoTheRecord` returning `[{ ...record }, POSITIONAL_ERROR_MESSAGE,
 * ...args.slice(2)]`, the caller's argument DISCARDED rather than filed under `err` — and
 * measured all three of them, and `logger.spec.ts`'s Error-in-the-message-position test, GREEN
 * under it. Closing the leak by throwing the container away satisfies every one of them, so the
 * shipped fix and the cheap wrong answer were behaviourally indistinguishable to this suite.
 *
 * What the mutant loses is the DIAGNOSTIC the fix exists to preserve: the line stops saying that
 * anything was thrown. The two values below are what says it, and they are hand-copied from
 * `logging-and-headers.md` invariant 1's measured table rather than imported from `logger.ts` —
 * an expected value read out of the code under test agrees with it whatever it does.
 *
 * `err_name` IS A CONSTANT FOR EVERY NON-`Error` CONTAINER, which the invariant states in place
 * ("what this invariant does not promise is that the object is described"). So this pins that
 * SOMETHING reached `serializers.err`, which is exactly and only what the mutant removes.
 */
const NON_ERROR_THROWABLE = 'non-error throwable (object)';
const POSITIONAL_ERROR_MESSAGE = 'an error was logged with no context string';

/**
 * ============================================================================
 * F-281. PINO REPLACES A REQUEST- OR RESPONSE-SHAPED RECORD BEFORE ANY MECHANISM HERE RUNS.
 * ============================================================================
 *
 * `genLog`'s `LOG` (`tools.js:47-56`) sniffs the record's SHAPE before `write`, and therefore
 * before `formatters.log`, `serializers.err` and both bindings wrappers: `o.method &&
 * o.headers && o.socket` replaces the WHOLE record with `mapHttpRequest(o)`, which is
 * `{ req: … }`, and `typeof o.setHeader === 'function'` — the second door, found by
 * `sdlc-reviewer` — replaces it with `mapHttpResponse(o)`, which is `{ res: … }`. Every other
 * own key of the caller's object is discarded at that point.
 *
 * THERE IS NO LEAK HERE AND THESE TESTS DO NOT ASSERT ONE. `req` and `res` are not named
 * fields, so the replacement pino built is censored whole, and coverage does not depend on the
 * replacement at all: the near-miss line below carries the same payload past the sniff and the
 * allowlist censors it key by key. `sdlc-security-auditor` measured no credential reaching a
 * line on six routes.
 *
 * WHAT IS LOST IS `request_id` AND `route`, GONE RATHER THAN CENSORED, which makes contract
 * invariant 2 false for this record shape. The contract says so in three places — "Door six",
 * invariant 1's measured table, invariant 2's exception — and NOTHING TESTED IT: the
 * request-shaped record at ordinal 2 above has no `socket` key, so it never trips the sniff.
 *
 * PINNED AS IT IS, NOT AS IT SHOULD BE. Today's measured behaviour is fixed in place in both
 * directions — the sniff firing and the near miss not firing — so a pino upgrade that widens,
 * narrows or moves it cannot pass silently.
 */
const REQUEST_SNIFF_AUTHORIZATION = 'Bearer R1-request-sniff-authorization-marker';
const REQUEST_SNIFF_COOKIE = 'sk_at=R2-request-sniff-cookie-marker';
const REQUEST_SNIFF_REMOTE_ADDRESS = '203.0.113.41';
const REQUEST_SNIFF_URL = '/l/abc?token=R3-request-sniff-url-marker';
const RESPONSE_SNIFF_SET_COOKIE = 'sk_at=R4-response-sniff-set-cookie-marker';

/** The context strings for the three F-281 lines, asserted so none of them is bought by silence. */
const REQUEST_SNIFF_CONTEXT = 'a record pino reads as an HTTP request';
const REQUEST_NEAR_MISS_CONTEXT = 'the same record with no socket';
const RESPONSE_SNIFF_CONTEXT = 'a record pino reads as an HTTP response';

/**
 * Lines are addressed by ORDINAL, not by `msg`: an ordinal still addresses the right line
 * when a regression changes what `msg` says, and `msg` is itself a field this decision
 * governs.
 */
const LINE = {
  keysNobodyNamed: 0,
  ipSpellings: 1,
  requestAsTheRecord: 2,
  requestOneKeyDown: 3,
  credentialSpellings: 4,
  fieldsTheCallSitesEmit: 5,
  errorFieldsSpreadOntoTheRecord: 6,
  toJsonContainer: 7,
  classInstanceContainer: 8,
  pastTheDepthBound: 9,
  arrayUnderANamedKey: 10,
  undefinedUnderAnUnnamedKey: 11,
  // F-277, door seven: the MESSAGE position rather than the record.
  messagePositionContainer: 12,
  messagePositionRegressedNames: 13,
  messagePositionArray: 14,
  messagePositionClassInstance: 15,
  messagePositionWithNoRecord: 16,
  messagePositionWithATrailingArgument: 17,
  // F-279: the two child-options shapes pino reads differently from `Object.hasOwn`.
  childWithRedactOnItsOptionsPrototype: 18,
  childWithLyingHasOwnProperty: 19,
  // F-281: the two record shapes pino REPLACES before any mechanism in `logger.ts` runs, and
  // the near miss that does not trip the sniff.
  requestShapedRecordWithNamedFields: 20,
  theSameRecordWithNoSocket: 21,
  responseShapedRecordWithNamedFields: 22,
} as const;

const EXPECTED_LINE_COUNT = Object.keys(LINE).length;

/**
 * Emitted in a subprocess so the module under test is the real singleton writing to the real
 * file descriptor. Held as source text rather than as a sibling `.ts` file because it has to
 * build the shapes a library builds — an error with an assigned `body`, a `toJSON` that
 * returns one, a class instance holding one — and expressing those in checked TypeScript
 * would take casts that hide the shape being reproduced.
 */
function emitterSource(loggerModule: string): string {
  return `
import { logger } from '${loggerModule}';

// What body-parser 2.3.0 raises for a malformed JSON body: a SyntaxError carrying the RAW
// REQUEST BODY as an own enumerable property.
const parseFailure = new SyntaxError('Unexpected token } in JSON at position 41');
parseFailure.body = '{"email":"a@b.test","password":"${RAW_REQUEST_BODY_MARKER}"';
parseFailure.status = 400;

// 0. KEYS NOBODY HAS NAMED. Not one of these six spellings occurs anywhere in apps/api/src.
//    \`attemptCount\` is one word from \`attempt\`, which IS a field main.ts emits.
logger.info(
  {
    principalKey: '${UNNAMED_FIELD_MARKER}',
    subjectIp: '${UNNAMED_FIELD_MARKER}',
    bearer: '${UNNAMED_FIELD_MARKER}',
    authToken: '${UNNAMED_FIELD_MARKER}',
    x_api_key: '${UNNAMED_FIELD_MARKER}',
    attemptCount: '${UNNAMED_FIELD_MARKER}',
  },
  'keys nobody has named',
);

// 1. F-262. Four IP spellings measured verbatim by the round-5 audit, beside the two the
//    denylist does cover and the snake_case column name a raw driver row carries.
logger.info(
  {
    clientIp: '${CLIENT_IP}',
    trustedClientIp: '${TRUSTED_CLIENT_IP}',
    remoteAddress: '${REMOTE_ADDRESS}',
    ipAddress: '${IP_ADDRESS}',
    ip: '${IP}',
    ipHash: 'CAMEL-ip-hash-marker',
    ip_hash: 'SNAKE-ip-hash-marker',
  },
  'the spellings a client IP arrives under',
);

// 2. F-261, THE WIDER SHAPE. The request object is the RECORD ITSELF, so the six
//    \`req.headers.*\` paths do not apply either and a bare authorization header and cookie
//    go on the line beside the IP and the concrete url.
const request = {
  id: 1,
  method: 'GET',
  url: '${REQUEST_URL}',
  headers: {
    host: 'shortkit.test',
    authorization: '${AUTHORIZATION_HEADER}',
    cookie: '${COOKIE_HEADER}',
  },
  remoteAddress: '${REQUEST_REMOTE_ADDRESS}',
  remotePort: ${String(REQUEST_REMOTE_PORT)},
};

logger.info(request, '${REQUEST_RECORD_CONTEXT}');

// 3. F-261 as originally filed: the same object one key down, where the six header paths DO
//    apply and the IP, the port and the concrete url still do not.
logger.info({ req: request }, 'a request-shaped value under a req key');

// 4. F-266. Eight credential spellings, plus the two the denylist covers today.
logger.info(
  {
    sessionToken: '${SESSION_TOKEN}',
    accessToken: '${ACCESS_TOKEN}',
    refreshToken: '${REFRESH_TOKEN}',
    apiKey: '${API_KEY_CAMEL}',
    api_key: '${API_KEY_SNAKE}',
    passwordHash: '${PASSWORD_HASH}',
    authorization: '${AUTHORIZATION_HEADER}',
    cookie: '${COOKIE_HEADER}',
    token: '${TOKEN}',
    password: '${PASSWORD}',
  },
  'the spellings a credential arrives under',
);

// 5. THE OTHER DIRECTION. Every field a shipped call site emits, with a value that is
//    recognisably itself. A logger that censored everything satisfies every assertion above
//    and fails this one.
//
//    NO CONTEXT STRING ON THIS ONE, DELIBERATELY. \`msg\` is on the list because a record
//    may supply its own, and pino uses a positional context string in preference to the
//    record's — so passing one here would assert nothing about the record's \`msg\` key.
logger.info({
  request_id: '${REQUEST_ID}',
  route: '${ROUTE_PATTERN}',
  status: 200,
  duration_ms: 12,
  tenant_id: '${TENANT_ID}',
  boot_precondition: 'database_reachable',
  attempt: 2,
  retry_in_ms: 250,
  code: '${DOMAIN_ERROR_CODE}',
  msg: '${CALLER_SUPPLIED_MESSAGE}',
});

// 6. The three fields \`errorLogFields\` builds, SPREAD onto a record — which is how
//    main.ts:269-277 and exception-filter.ts's logError both write them, so they arrive as
//    ordinary top-level keys and not under \`err\`.
logger.info(
  {
    request_id: '${REQUEST_ID}',
    err_name: 'BootPreconditionError',
    err_message: 'GIT_COMMIT_SHA must be the full 40-character lowercase hex git SHA',
    err_stack: '    at bootstrap (main.ts:1:1)',
  },
  'the error fields a call site spreads onto its record',
);

// 7-9. THE CONTAINERS THE SCAN CANNOT INSPECT. All three reach a line today with the
//      library's assigned properties on them: \`logger.ts:503-526\` states them as residuals
//      1, 2 and 3, and ADR-0028's Consequences table is where each is measured as closing.
//      "Cannot inspect" has to mean CENSORED, not EMITTED WHOLE.
logger.info({ ctx: { toJSON: () => parseFailure } }, 'a container that serialises itself');

class Ctx {
  constructor(held) {
    this.err = held;
  }
}
logger.info({ ctx: new Ctx(parseFailure) }, 'a container the scan declines to walk');

logger.info({ a: { b: { c: { d: { err: parseFailure } } } } }, 'a container past the depth bound');

// 10. An ARRAY under a NAMED key. An array index is not a field name, so the string element
//     survives; an OBJECT inside the array has its keys decided normally, so the secret
//     inside it does not. ADR-0028's own measured example.
logger.info(
  { request_id: '${REQUEST_ID}', route: ['a', { password: '${SECRET_INSIDE_AN_ARRAY}' }] },
  'an array under a named key',
);

// 11. \`undefined\` under an unnamed key. \`JSON.stringify\` drops a key whose value is
//     \`undefined\`, so censoring it would ADD a field where none appeared.
logger.info({ notNamed: undefined, request_id: '${REQUEST_ID}' }, 'an undefined value');

// 12. F-277, DOOR SEVEN, the reproduction as both auditors filed it. \`logger.error(record, e)\`
//     where \`e\` is a NON-Error throwable — what \`catch (e)\` binds and what a rejected promise
//     carries. Not one of these four names is on \`LOGGABLE_FIELDS\` and four of them are on the
//     contract's OWN never-allowlist. \`.error\` rather than \`.info\` because that is the shape
//     that was measured; the hook and the argument list are the same at every level.
const nonErrorThrowable = {
  statusCode: 401,
  clientIp: '${HOSTILE_CLIENT_IP}',
  headers: { authorization: '${HOSTILE_AUTHORIZATION}' },
  body: '{"password":"${HOSTILE_BODY_PASSWORD}"}',
};

logger.error({ request_id: '${REQUEST_ID}' }, nonErrorThrowable);

// 13. F-277, THE REGRESSION SHAPE. The eight names \`REDACT_PATHS\`' wildcards reached inside
//     \`msg\` through pino's wildcard stringifier, and nothing reaches now. Measured
//     \`[redacted]\` at 45cf578^ and verbatim at HEAD, so this line is the one that says the
//     module went BACKWARDS rather than that a hole was always there.
logger.error(
  { request_id: '${REQUEST_ID}' },
  {
    password: '${REGRESSED_PASSWORD}',
    token: '${REGRESSED_TOKEN}',
    secret: '${REGRESSED_SECRET}',
    rawToken: '${REGRESSED_RAW_TOKEN}',
    tokenDigest: '${REGRESSED_TOKEN_DIGEST}',
    verificationToken: '${REGRESSED_VERIFICATION_TOKEN}',
    ip: '${REGRESSED_IP}',
    ipHash: '${REGRESSED_IP_HASH}',
  },
);

// 14. F-277, an ARRAY in the message position. A different container type, and a fix that
//     walked only plain objects would leave it. NOT a regression: \`*.password\` matched one
//     level, so an object inside an array was two levels down and leaked before ADR-0028 too.
logger.error({ request_id: '${REQUEST_ID}' }, ['first', { password: '${ARRAY_ELEMENT_SECRET}' }]);

// 15. F-277, a CLASS INSTANCE in the message position. \`valueCensored\` declines to walk a
//     non-plain prototype and censors it whole, which is the answer the record path gives —
//     and the old wildcard stringifier gave this one \`[redacted]\` as well, so it regressed.
class Held {
  constructor(secret) {
    this.password = secret;
  }
}
logger.error({ request_id: '${REQUEST_ID}' }, new Held('${CLASS_INSTANCE_SECRET}'));

// 16. F-277 with NO RECORD AT ALL. \`messageArgumentIndex\` shifts a leading \`undefined\` past,
//     so the container is still the message argument and there is no record to file it onto.
//     Regressed: \`[redacted]\` at 45cf578^, verbatim at HEAD.
logger.error(undefined, { password: '${NO_RECORD_SECRET}' });

// 17. F-277 with a TRAILING ARGUMENT after the container, which is what puts the message
//     through \`format()\` as a string rather than leaving it an object. Same leak by a
//     different route — measured \`"msg":"{\\"password\\":\\"…\\"} "\` — and regressed.
logger.error({ request_id: '${REQUEST_ID}' }, { password: '${TRAILING_ARGUMENT_SECRET}' }, 'tail');

// 18. F-279. \`redact\` supplied on the OPTIONS PROTOTYPE. \`Object.hasOwn\` does not see it and
//     pino reads it with a plain property read (\`proto.js:161\`), so the child is accepted and
//     the redact is installed — measured, and the line then carries no \`request_id\` at all,
//     from the binding or from the record, under a censoring policy this module documents as
//     refused. \`remove: true\` is what makes the effect visible rather than cosmetic.
try {
  logger
    .child(
      { scope: '${CHILD_SCOPE}' },
      Object.create({ redact: { paths: ['${REDACT_REMOVED_FIELD}'], remove: true } }),
    )
    .info({ request_id: '${REQUEST_ID}' }, 'a child whose options carry redact on their prototype');
} catch {
  logger.info(
    { request_id: '${REQUEST_ID}' },
    'a child whose options carry redact on their prototype${CHILD_OPTIONS_REFUSED}',
  );
}

// 19. F-279, THE CONVERSE, AND IT IS THE ONE THAT LEAKS. pino calls
//     \`options.hasOwnProperty('formatters')\` AS A METHOD ON THE OPTIONS OBJECT, so an options
//     object that answers \`true\` for a \`formatters\` it holds on its PROTOTYPE takes pino's
//     replacing branch while \`Object.hasOwn\` correctly says no. The scan is then gone at every
//     key and every depth — measured: an unnamed \`password\` and a raw \`ip\`, both verbatim.
try {
  const lyingOptions = Object.create({ formatters: { log: (record) => record } });
  lyingOptions.hasOwnProperty = (option) => option === 'formatters';

  logger
    .child({ scope: '${CHILD_SCOPE}' }, lyingOptions)
    .info(
      { request_id: '${REQUEST_ID}', password: '${LYING_OPTIONS_PASSWORD}', ip: '${LYING_OPTIONS_IP}' },
      'a child whose options lie about hasOwnProperty',
    );
} catch {
  logger.info(
    { request_id: '${REQUEST_ID}' },
    'a child whose options lie about hasOwnProperty${CHILD_OPTIONS_REFUSED}',
  );
}

// 20. F-281, DOOR ONE. \`o.method && o.headers && o.socket\` (\`tools.js:51\`) replaces the WHOLE
//     record with \`{ req: … }\` before \`formatters.log\` sees anything, so the two NAMED fields
//     on this record are discarded rather than censored. Every payload here is one the record
//     path already covers — the point of the line is which keys SURVIVE, not which leak.
const requestShaped = {
  request_id: '${REQUEST_ID}',
  route: '${ROUTE_PATTERN}',
  method: 'GET',
  headers: {
    host: 'shortkit.test',
    authorization: '${REQUEST_SNIFF_AUTHORIZATION}',
    cookie: '${REQUEST_SNIFF_COOKIE}',
  },
  socket: { remoteAddress: '${REQUEST_SNIFF_REMOTE_ADDRESS}', remotePort: 44322 },
  url: '${REQUEST_SNIFF_URL}',
};

logger.info(requestShaped, '${REQUEST_SNIFF_CONTEXT}');

// 21. THE NEAR MISS, WHICH IS WHAT MAKES 20 A STATEMENT ABOUT THE SNIFF RATHER THAN ABOUT THE
//     ALLOWLIST. The same record with the \`socket\` key removed does not trip \`tools.js:51\`, so
//     the record reaches \`formatters.log\` intact: both named fields keep their values and the
//     same three payload-carrying keys are censored one by one.
const { socket, ...requestShapedWithNoSocket } = requestShaped;

logger.info(requestShapedWithNoSocket, '${REQUEST_NEAR_MISS_CONTEXT}');

// 22. F-281, DOOR TWO. \`typeof o.setHeader === 'function'\` (\`tools.js:53\`) replaces the record
//     with \`{ res: … }\` by the same mechanism and one line further down. \`resSerializer\` calls
//     \`getHeaders()\`, so a \`Set-Cookie\` this record never held as a key is pulled INTO the
//     replacement — and censored with it.
logger.info(
  {
    request_id: '${REQUEST_ID}',
    route: '${ROUTE_PATTERN}',
    status: 200,
    headersSent: true,
    statusCode: 204,
    setHeader() {},
    getHeaders() {
      return { 'set-cookie': '${RESPONSE_SNIFF_SET_COOKIE}' };
    },
  },
  '${RESPONSE_SNIFF_CONTEXT}',
);
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
      env: { ...process.env, LOG_LEVEL: 'info', NODE_ENV: 'test' },
    },
  );

  // A harness that half-ran would let every assertion below pass vacuously, so it is checked
  // loudly here rather than silently in each test.
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

/**
 * The line's record with only `keys` kept, in the order given. Written so a failure prints
 * one object naming every key that leaked rather than stopping at the first — a suite whose
 * whole subject is "which spelling did nobody think of" should not report them one per run.
 *
 * It carries no expectation of its own: the expected object is a hand-written literal at
 * every call site below.
 */
function fields(ordinal: number, keys: readonly string[]): Record<string, unknown> {
  const record = lines[ordinal].record;

  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}

describe('a key that is not named does not carry a value onto a log line', () => {
  it('ADR-0028: a key nobody has named is censored, and the key stays on the line', () => {
    // THE CLASS TEST, AND THE REASON THIS DECISION EXISTS. Not one of these six spellings
    // occurs in `apps/api/src`, in `REDACT_PATHS`, or in any finding — they were invented
    // here. `REDACT_PATHS` covers the spellings someone thought of, so it emits all six
    // verbatim, and it would still emit them after F-261, F-262 and F-266 were each closed
    // by appending the names they found. That is the fourth audit round, and it is what this
    // asserts against.
    //
    // The keys stay on the line (ADR-0028 rule 6). A dropped key tells an operator nothing;
    // `"attemptCount":"[redacted]"` tells them which field exists, what it is called, and
    // that one line in `LOGGABLE_FIELDS` is what it needs. That visibility is the whole
    // mitigation for the cost this decision accepts, so it is asserted rather than implied.
    expect(lines[LINE.keysNobodyNamed].raw).not.toContain(UNNAMED_FIELD_MARKER);

    expect(
      fields(LINE.keysNobodyNamed, [
        'principalKey',
        'subjectIp',
        'bearer',
        'authToken',
        'x_api_key',
        'attemptCount',
      ]),
    ).toEqual({
      principalKey: CENSOR,
      subjectIp: CENSOR,
      bearer: CENSOR,
      authToken: CENSOR,
      x_api_key: CENSOR,
      attemptCount: CENSOR,
    });
  });

  it('F-262: every spelling a client IP arrives under is censored, not only the key spelled `ip`', () => {
    // MEASURED, this repository's own pino 10.3.1, round-5 audit and reproduced here:
    //   {"clientIp":"203.0.113.9","trustedClientIp":"…","remoteAddress":"…",
    //    "ipAddress":"…","ip":"[redacted]","ipHash":"[redacted]","ip_hash":"SNAKE"}
    // Four raw IPv4 literals in the clear beside two censored keys. GC-9's first prohibition
    // is "a raw IP address, in any field, from any header", and the field the system will
    // actually hold is `trustedClientIp` — the accessor already named in
    // `design/stubs/apps/api/src/auth/resolve-rate-limit-principal.ts:28`.
    //
    // `ip` and `ipHash` are asserted alongside so the fix cannot be bought by losing the
    // coverage that already exists, and `ip_hash` — the Postgres column name a raw driver row
    // carries — closes the residual the contract names at "Which casing `REDACT_PATHS` is
    // keyed to".
    for (const literal of [CLIENT_IP, TRUSTED_CLIENT_IP, REMOTE_ADDRESS, IP_ADDRESS, IP]) {
      expect(lines[LINE.ipSpellings].raw).not.toContain(literal);
    }

    expect(
      fields(LINE.ipSpellings, [
        'clientIp',
        'trustedClientIp',
        'remoteAddress',
        'ipAddress',
        'ip',
        'ipHash',
        'ip_hash',
      ]),
    ).toEqual({
      clientIp: CENSOR,
      trustedClientIp: CENSOR,
      remoteAddress: CENSOR,
      ipAddress: CENSOR,
      ip: CENSOR,
      ipHash: CENSOR,
      ip_hash: CENSOR,
    });
  });

  it('F-261: logging a whole request emits no IP, no credential, no cookie and no concrete path', () => {
    // CONTRACT INVARIANT 1, WHICH IS MEASURED FALSE TODAY AND SAYS SO IN PLACE. The finding
    // named `remoteAddress`, `remotePort` and the concrete `url`; the round-5 audit measured
    // it WIDER — when the request object is the RECORD ITSELF rather than the value of a
    // `req` key, the six `req.headers.*` paths do not apply either, so a bare `authorization`
    // header and a `Cookie` go on the line as well:
    //
    //   {"id":1,"method":"GET","url":"/l/abc?token=SEKRIT",
    //    "headers":{"host":"x","authorization":"Bearer AAA","cookie":"sk_at=BBB"},
    //    "remoteAddress":"203.0.113.7","remotePort":44321}
    //
    // The list reads as though logging a whole request were a covered act, which is what
    // makes it dangerous rather than obvious. Under ADR-0028 the invariant becomes true for a
    // stronger reason than it claims: no key of a request object is a named field, so there
    // is no header list to keep current.
    for (const value of [
      REQUEST_REMOTE_ADDRESS,
      REQUEST_URL,
      AUTHORIZATION_HEADER,
      COOKIE_HEADER,
      String(REQUEST_REMOTE_PORT),
    ]) {
      expect(lines[LINE.requestAsTheRecord].raw).not.toContain(value);
    }

    expect(
      fields(LINE.requestAsTheRecord, [
        'id',
        'method',
        'url',
        'headers',
        'remoteAddress',
        'remotePort',
      ]),
    ).toEqual({
      id: CENSOR,
      method: CENSOR,
      url: CENSOR,
      headers: CENSOR,
      remoteAddress: CENSOR,
      remotePort: CENSOR,
    });

    // Not bought by writing no line: the call site's own words survive.
    expect(lines[LINE.requestAsTheRecord].record.msg).toBe(REQUEST_RECORD_CONTEXT);
  });

  it('F-261: a request-shaped value one key down is censored whole, headers included', () => {
    // The shape as originally filed, asserted separately because it leaks by a DIFFERENT
    // route: here the six `req.headers.*` paths DO apply, so today's line censors the two
    // headers and emits the IP, the port and the concrete `url` anyway. A fix that only
    // widened the header list would pass the header half of this and still leak the IP.
    //
    // ADR-0028's Consequences table measures this row as `"req":"[redacted]"` — the whole
    // object, because `req` is not a named field.
    for (const value of [
      REQUEST_REMOTE_ADDRESS,
      REQUEST_URL,
      AUTHORIZATION_HEADER,
      COOKIE_HEADER,
      String(REQUEST_REMOTE_PORT),
    ]) {
      expect(lines[LINE.requestOneKeyDown].raw).not.toContain(value);
    }

    expect(lines[LINE.requestOneKeyDown].record.req).toBe(CENSOR);
  });

  it('F-266: every spelling a credential arrives under is censored, not only `token` and `password`', () => {
    // MEASURED, unchanged from round 4 and re-measured in round 5:
    //   {"sessionToken":"S1","accessToken":"S2","refreshToken":"S3","apiKey":"S4",
    //    "api_key":"S5","passwordHash":"S6","authorization":"Bearer AAA",
    //    "cookie":"sk_at=BBB","token":"[redacted]","password":"[redacted]"}
    // Eight credential-shaped spellings in the clear, two censored. `authorization` and
    // `cookie` are covered under `req.headers` and nowhere else, so a call site that lifts
    // one header onto a record writes it in the clear.
    //
    // `token` and `password` are asserted here too: they are what the denylist buys today,
    // and an allowlist that lost them would be a regression wearing a new mechanism.
    for (const marker of [
      SESSION_TOKEN,
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      API_KEY_CAMEL,
      API_KEY_SNAKE,
      PASSWORD_HASH,
      AUTHORIZATION_HEADER,
      COOKIE_HEADER,
      TOKEN,
      PASSWORD,
    ]) {
      expect(lines[LINE.credentialSpellings].raw).not.toContain(marker);
    }

    expect(
      fields(LINE.credentialSpellings, [
        'sessionToken',
        'accessToken',
        'refreshToken',
        'apiKey',
        'api_key',
        'passwordHash',
        'authorization',
        'cookie',
        'token',
        'password',
      ]),
    ).toEqual({
      sessionToken: CENSOR,
      accessToken: CENSOR,
      refreshToken: CENSOR,
      apiKey: CENSOR,
      api_key: CENSOR,
      passwordHash: CENSOR,
      authorization: CENSOR,
      cookie: CENSOR,
      token: CENSOR,
      password: CENSOR,
    });
  });

  it('ADR-0028: a container the scan cannot inspect is censored, not emitted whole', () => {
    // THE INVERSION, AND THE THREE RESIDUALS IT CLOSES. Today "cannot inspect" means "emit
    // whole", which is backwards: a `toJSON` the scan never sees the output of (F-265), a
    // class instance `isWalkable` declines to walk (F-255's residual 2), and anything past
    // the depth bound (residual 1) all reach the line carrying whatever a library assigned.
    // All three are stated at `logger.ts:503-526` and all three were re-measured leaking by
    // the round-5 audit.
    //
    // Under an allowlist none of them needs inspecting: `ctx` and `a` are not named fields,
    // so the container is censored before the question of walking it arises. That is why
    // ADR-0028 closes three residuals nobody filed as a class this round.
    //
    // Reported together so a failure names ALL the containers that leak rather than the
    // first.
    const containers = [
      ['a toJSON that returns the error', LINE.toJsonContainer, 'ctx'],
      ['a class instance holding the error', LINE.classInstanceContainer, 'ctx'],
      ['a container past the depth bound', LINE.pastTheDepthBound, 'a'],
    ] as const;

    const leaking = containers
      .filter(([, ordinal]) => lines[ordinal].raw.includes(RAW_REQUEST_BODY_MARKER))
      .map(([name]) => name);

    expect(leaking).toEqual([]);

    for (const [, ordinal, key] of containers) {
      expect(lines[ordinal].record[key]).toBe(CENSOR);
    }
  });

  it('ADR-0028: an object inside an array under a named key still has its own keys decided', () => {
    // An array index is not a field name, so `elementsCensored` applies no key decision to
    // the elements — but an OBJECT inside the array is walked by the ordinary key rule, and
    // its keys are decided normally. ADR-0028 measures exactly this:
    //   { request_id: 'r-1', route: ['a', { password: 'P' }] }
    //     -> "route":["a",{"password":"[redacted]"}]
    //
    // Today `*.password` matches one level and this secret is two levels down under `route`,
    // so it goes on the line in the clear.
    expect(lines[LINE.arrayUnderANamedKey].raw).not.toContain(SECRET_INSIDE_AN_ARRAY);

    const route = lines[LINE.arrayUnderANamedKey].record.route as readonly unknown[];

    expect(route[1]).toEqual({ password: CENSOR });
  });
});

describe('what the allowlist may not censor, so that a line still says something', () => {
  it('ADR-0028: every field a shipped call site emits reaches the line with its value', () => {
    // THE TEST THAT STOPS "CENSOR EVERYTHING" PASSING, and the one ADR-0028's own stated cost
    // asks for: "a field a TASK forgets to name ships as `[redacted]` … nothing in the build
    // catches it: typecheck, lint and the suite are all green on a log line whose fields are
    // all censored". This is the build catching it, for the fields that exist today.
    //
    // The record is Migration step 3's sweep: `main.ts:198-206` and `:269-277`
    // (`boot_precondition`, `attempt`, `retry_in_ms`), `exception-filter.ts` (`code`,
    // `request_id`), and the contract's "Required fields" table (`request_id`, `route`,
    // `status`, `duration_ms`, `tenant_id`). `msg` is here because a record may supply its
    // own and pino then does not derive one.
    //
    // GREEN TODAY, for a different reason than it will be green afterwards: nothing censors
    // these names now, and afterwards they are censored unless named. Proved by mutation in
    // the round's report rather than assumed.
    expect(
      fields(LINE.fieldsTheCallSitesEmit, [
        'request_id',
        'route',
        'status',
        'duration_ms',
        'tenant_id',
        'boot_precondition',
        'attempt',
        'retry_in_ms',
        'code',
        'msg',
      ]),
    ).toEqual({
      request_id: REQUEST_ID,
      route: ROUTE_PATTERN,
      status: 200,
      duration_ms: 12,
      tenant_id: TENANT_ID,
      boot_precondition: 'database_reachable',
      attempt: 2,
      retry_in_ms: 250,
      code: DOMAIN_ERROR_CODE,
      msg: CALLER_SUPPLIED_MESSAGE,
    });
  });

  it("ADR-0028: the three fields `errorLogFields` builds survive being spread onto a record", () => {
    // `main.ts:269-277` and `exception-filter.ts`'s `logError` both SPREAD `errorLogFields`
    // into their record, so `err_name`, `err_message` and `err_stack` arrive as ordinary
    // top-level keys — they do not travel under `err` and `serializers.err` never sees them.
    // Censoring them would leave the API's boot-failure line and every 500's line naming
    // nothing at all, which is `error-envelope.md` invariant 9 broken by the fix for GC-9.
    //
    // This is also the coupling ADR-0028's Consequences names: renaming any of these three
    // now silently censors it as well as breaking every saved log query.
    expect(fields(LINE.errorFieldsSpreadOntoTheRecord, ['err_name', 'err_message', 'err_stack'])).toEqual({
      err_name: 'BootPreconditionError',
      err_message: 'GIT_COMMIT_SHA must be the full 40-character lowercase hex git SHA',
      err_stack: '    at bootstrap (main.ts:1:1)',
    });
  });

  it('ADR-0028: an array element is not a field name, so a plain value in one survives', () => {
    // The other half of the array rule, and the plausible wrong implementation it catches: a
    // scan that ran the key check on array INDICES censors every element of every array,
    // because `'0'` and `'1'` are not on any allowlist and never will be. That turns a named
    // field holding a list into `["[redacted]","[redacted]"]` with the whole suite otherwise
    // green.
    const route = lines[LINE.arrayUnderANamedKey].record.route as readonly unknown[];

    expect(route[0]).toBe('a');
  });

  it('ADR-0028: a key whose value is `undefined` does not become a field on the line', () => {
    // `JSON.stringify` drops a key whose value is `undefined`, so censoring one would ADD a
    // field where none appeared — an operator would read `"notNamed":"[redacted]"` and go
    // looking for a value that was never there. The record's own named field is asserted
    // beside it so this cannot pass against a line that carries nothing at all.
    expect(lines[LINE.undefinedUnderAnUnnamedKey].record).not.toHaveProperty('notNamed');
    expect(lines[LINE.undefinedUnderAnUnnamedKey].record.request_id).toBe(REQUEST_ID);
  });
});

describe("door seven: the argument list is a place a line is built, and nothing scans it", () => {
  it('F-277: a value in the message position reaches the line under the same policy as one in the record', () => {
    // THE BLOCKER, FOUND INDEPENDENTLY BY BOTH AUDITORS IN THE SAME PASS. `logger.ts:221-222`
    // says "A CONTAINER in either position is scanned"; the line below it
    // (`interpolationCovered`, `:239`) reduces the message argument only when it
    // `instanceof Error`, and the interpolation loop starts at `message + 1`, so nothing ever
    // looks at `args[1]`. Neither `LOGGABLE_FIELDS`, nor `formatters.log`, nor
    // `serializers.err`, nor either bindings wrapper is anywhere near this path — they act on
    // the RECORD or on BINDINGS, and this is neither.
    //
    // MEASURED against the shipped singleton, and this is the finding's own reproduction:
    //   {"request_id":"r-9","msg":{"statusCode":401,"clientIp":"203.0.113.9",
    //    "headers":{"authorization":"Bearer LEAKED-TOKEN"},
    //    "body":"{\"password\":\"LEAKED-PASSWORD\"}"}}
    // A raw client IP, a bearer token and a password on one line. Four of those five names are
    // on the contract's own never-allowlist, which is GC-9's first three prohibitions and
    // invariant 1 word for word.
    //
    // FIVE SHAPES, REPORTED TOGETHER so a partial fix names every shape still leaking rather
    // than stopping at the first. Each is a different route to the same position: a plain
    // container, an array, a class instance, a call with no record at all (`messageArgumentIndex`
    // shifts the leading `undefined` past), and a call with a trailing argument (which puts the
    // message through `format()` as a string instead of leaving it an object).
    //
    // WHAT IS DELIBERATELY NOT ASSERTED: the SHAPE the covered message takes. Moving the
    // container onto the record under `err` — where `serializers.err` reduces it to
    // `err_name: 'non-error throwable (object)'` — and reducing it in place through
    // `valueCensored` are both answers to this finding, and `sdlc-reviewer` ruled the choice
    // Design's rather than the implementer's. Asserting either one here would pick it.
    const shapes = [
      ['a non-Error throwable', LINE.messagePositionContainer, HOSTILE_CLIENT_IP],
      ['a non-Error throwable', LINE.messagePositionContainer, HOSTILE_AUTHORIZATION],
      ['a non-Error throwable', LINE.messagePositionContainer, HOSTILE_BODY_PASSWORD],
      ['an array', LINE.messagePositionArray, ARRAY_ELEMENT_SECRET],
      ['a class instance', LINE.messagePositionClassInstance, CLASS_INSTANCE_SECRET],
      ['no record at all', LINE.messagePositionWithNoRecord, NO_RECORD_SECRET],
      ['a trailing argument', LINE.messagePositionWithATrailingArgument, TRAILING_ARGUMENT_SECRET],
    ] as const;

    const leaking = shapes
      .filter(([, ordinal, marker]) => lines[ordinal].raw.includes(marker))
      .map(([shape, , marker]) => `${shape}: ${marker}`);

    expect(leaking).toEqual([]);
  });

  it('F-277: covering the message position does not cost the line its record or its message', () => {
    // NOT BOUGHT BY LOGGING NOTHING, which is the half every "no marker on the line" assertion
    // needs beside it. Dropping the message argument, or the caller's record with it, satisfies
    // the test above completely and leaves an operator with a line that says nothing.
    //
    // `msg` is asserted as PRESENT rather than as a string or as a particular value: both
    // answers Design may take produce one — the fixed positional string if the container is
    // moved onto the record, the censored container if it is reduced in place — and neither is
    // this test's to choose.
    const withARecord = [
      LINE.messagePositionContainer,
      LINE.messagePositionRegressedNames,
      LINE.messagePositionArray,
      LINE.messagePositionClassInstance,
      LINE.messagePositionWithATrailingArgument,
    ];

    for (const ordinal of withARecord) {
      expect(lines[ordinal].record.request_id, `line ${String(ordinal)}`).toBe(REQUEST_ID);
    }

    for (const ordinal of [...withARecord, LINE.messagePositionWithNoRecord]) {
      expect(lines[ordinal].record, `line ${String(ordinal)}`).toHaveProperty('msg');
    }
  });

  it('F-277: the message position keeps the censoring the deleted redact list gave `msg`', () => {
    // THE REGRESSION, PINNED IN ITS DIRECTION RATHER THAN AS AN ABSOLUTE PROPERTY. Every other
    // shape in this describe leaks on BOTH singletons, so a guard built only from them would
    // have passed before ADR-0028 as well and would not have caught what today's work broke.
    //
    // These eight names are exactly the wildcards `REDACT_PATHS` carried — `*.password`,
    // `*.token`, `*.secret`, `*.rawToken`, `*.tokenDigest`, `*.verificationToken`, `*.ip`,
    // `*.ipHash`. pino builds a WILDCARD STRINGIFIER from them and applies it to the `msg`
    // value too (`tools.js:205`, `stringifiers[messageKey] || wildcardStringifier`), so the
    // eight were censored inside `msg` by accident of the denylist's shape, and removing the
    // list took that with it.
    //
    // MEASURED on both singletons, same process shape, `logger.ts` restored byte-identical:
    // all eight `[redacted]` at `45cf578^`, all eight verbatim at HEAD. This test is therefore
    // RED at HEAD and GREEN before ADR-0028 — which is what "the fix may not ship a module that
    // is worse than the one it replaced" means as an assertion.
    const regressed = [
      ['password', REGRESSED_PASSWORD],
      ['token', REGRESSED_TOKEN],
      ['secret', REGRESSED_SECRET],
      ['rawToken', REGRESSED_RAW_TOKEN],
      ['tokenDigest', REGRESSED_TOKEN_DIGEST],
      ['verificationToken', REGRESSED_VERIFICATION_TOKEN],
      ['ip', REGRESSED_IP],
      ['ipHash', REGRESSED_IP_HASH],
    ] as const;

    const line = lines[LINE.messagePositionRegressedNames];
    const leaking = regressed.filter(([, marker]) => line.raw.includes(marker)).map(([name]) => name);

    expect(leaking).toEqual([]);
  });

  it("F-282: the caller's container is MOVED onto the record, not dropped on the way", () => {
    // THE GAP THE THREE TESTS ABOVE LEAVE, AND IT IS A GAP IN THIS FILE'S OWN RED STEP. The
    // wrong-fix guard directly above them catches dropping the RECORD and dropping the MESSAGE.
    // It does not catch dropping the CALLER'S ARGUMENT, which is the actual cheap wrong answer
    // to F-277: close the leak by throwing the container away instead of filing it under `err`.
    //
    // MEASURED by `sdlc-reviewer` against a mutant of `errorMovedOntoTheRecord` that returns
    // `[{ ...record }, POSITIONAL_ERROR_MESSAGE, ...args.slice(2)]`: all three F-277 tests and
    // `logger.spec.ts`'s Error-in-the-message-position test stay GREEN. The leak is closed
    // either way — which is why this is a diagnostic gap and not a security one — and the suite
    // reported success on a module that had stopped saying anything was thrown.
    //
    // WHAT IS ASSERTED IS THE ARRIVAL, NOT THE PAYLOAD. `err_name` is the same constant for
    // every non-`Error` container, by `serializers.err`'s own policy and by invariant 1's "what
    // this invariant does not promise is that the object is described". Its PRESENCE is what
    // the mutant removes, so its presence is what this pins — on the emitted bytes, beside the
    // fixed `msg` that the same move produces. Both values are hand-copied from the contract.
    //
    // Reported as one array so a partial regression names every shape that lost its error
    // rather than stopping at the first.
    const shapes = [
      ['a non-Error throwable', LINE.messagePositionContainer],
      ['the eight regressed names', LINE.messagePositionRegressedNames],
      ['an array', LINE.messagePositionArray],
      ['a class instance', LINE.messagePositionClassInstance],
      ['no record at all', LINE.messagePositionWithNoRecord],
      ['a trailing argument', LINE.messagePositionWithATrailingArgument],
    ] as const;

    expect(
      shapes.map(([shape, ordinal]) => [
        shape,
        lines[ordinal].record.err,
        lines[ordinal].record.msg,
      ]),
    ).toEqual([
      ['a non-Error throwable', { err_name: NON_ERROR_THROWABLE }, POSITIONAL_ERROR_MESSAGE],
      ['the eight regressed names', { err_name: NON_ERROR_THROWABLE }, POSITIONAL_ERROR_MESSAGE],
      ['an array', { err_name: NON_ERROR_THROWABLE }, POSITIONAL_ERROR_MESSAGE],
      ['a class instance', { err_name: NON_ERROR_THROWABLE }, POSITIONAL_ERROR_MESSAGE],
      ['no record at all', { err_name: NON_ERROR_THROWABLE }, POSITIONAL_ERROR_MESSAGE],
      ['a trailing argument', { err_name: NON_ERROR_THROWABLE }, POSITIONAL_ERROR_MESSAGE],
    ]);
  });
});

describe("a child's options are read the way pino reads them, or they are not checked at all", () => {
  it('F-279: a child whose options carry `redact` on their prototype keeps a named field on the line', () => {
    // `childOptionsChecked` tests all three refused options with `Object.hasOwn`, and pino does
    // not read all three the same way. `redact` is read at `proto.js:161` as
    // `typeof options.redact === 'object'` — an ORDINARY PROPERTY READ, which walks the
    // prototype chain — so a `redact` the check cannot see is installed anyway.
    //
    // MEASURED: the child is accepted and pino installs `{ paths: ['request_id'],
    // remove: true }`, and the resulting line carries no `request_id` at all, from the binding
    // or from the record. That is contract invariant 8 — "the key stays on the line" — false
    // for that subtree, under a censoring policy with the opposite polarity to this module's
    // that the module documents as refused. Round 5 predicted this would self-resolve when
    // ADR-0028 deleted the root's `redact`; it did not, because pino's read never consulted the
    // root's.
    //
    // ASSERTED UNCONDITIONALLY, AND IT COSTS NOTHING TO DO SO: refusing the options is the
    // likely answer and the emitter's catch arm logs the same `request_id`, so this line
    // carries the named field whichever way the module answers. It is red today only because
    // the third answer — accept and install — is the one that ships.
    expect(lines[LINE.childWithRedactOnItsOptionsPrototype].record.request_id).toBe(REQUEST_ID);
  });

  it('F-279: a child whose options lie about `hasOwnProperty` does not get the scan turned off', () => {
    // THE CONVERSE, AND THE HALF THAT LEAKS. pino calls `options.hasOwnProperty('formatters')`
    // AS A METHOD ON THE OPTIONS OBJECT (`proto.js:136`), so an options object that answers for
    // itself takes pino's replacing branch while `Object.hasOwn` correctly says no. The
    // child-supplied `formatters.log` then replaces the scan at every key and every depth.
    //
    // MEASURED: `"password":"X1…","ip":"203.0.113.33"`, both verbatim on the child's line.
    // ADR-0028 is what makes this a leak rather than a degradation — with `redact` gone there is
    // exactly ONE mechanism between an unnamed field and a line, and this is the call shape that
    // removes it. The same object shape with `serializers` brings F-244 back under `err`.
    //
    // The raw assertions hold whichever way the module answers, because a refused child logs
    // neither value. The censor equality is asserted only when the child ran, since a refusal
    // has no `password` key to read.
    const line = lines[LINE.childWithLyingHasOwnProperty];

    expect(line.raw).not.toContain(LYING_OPTIONS_PASSWORD);
    expect(line.raw).not.toContain(LYING_OPTIONS_IP);

    if (!String(line.record.msg).includes(CHILD_OPTIONS_REFUSED)) {
      expect(line.record.password).toBe(CENSOR);
      expect(line.record.ip).toBe(CENSOR);
    }
  });
});

describe('pino replaces a record it reads as an HTTP request or response, before anything here runs', () => {
  it('F-281: a request-shaped record becomes `req` alone, and its named fields go with the rest', () => {
    // CHARACTERISATION, NOT A DEFECT ASSERTION. `LOG` (`tools.js:47-56`) runs BEFORE `write`,
    // so `o.method && o.headers && o.socket` replaces the caller's whole record with
    // `mapHttpRequest(o)` — `{ req: … }` — before `formatters.log`, `serializers.err` or either
    // bindings wrapper exists on the path. Nothing in `logger.ts` can see the record that was
    // passed.
    //
    // THE SECURITY HALF IS INTACT AND IS ASSERTED FIRST: `req` is not a named field, so what
    // pino built is censored whole. MEASURED, and the measurement corrected what this comment
    // first claimed: appending `req` to `LOGGABLE_FIELDS` does NOT make this line leak, because
    // `reqSerializer` returns an object whose prototype is `pinoReqProto` rather than
    // `Object.prototype`, and `valueCensored` censors a container it declines to walk. Two
    // independent mechanisms hold this half, so the assertion below is not the guard against
    // that particular edit — `formatters.log` being removed or replaced is what reds it.
    const line = lines[LINE.requestShapedRecordWithNamedFields];

    for (const marker of [
      REQUEST_SNIFF_AUTHORIZATION,
      REQUEST_SNIFF_COOKIE,
      REQUEST_SNIFF_REMOTE_ADDRESS,
      REQUEST_SNIFF_URL,
    ]) {
      expect(line.raw).not.toContain(marker);
    }

    expect(line.record.req).toBe(CENSOR);

    // THE COST, WHICH IS THE REASON THIS TEST EXISTS. `request_id` and `route` are named fields
    // carrying values on the caller's record, and they are ABSENT — not `[redacted]`, absent —
    // because the replacement discarded them before the allowlist ran. Contract invariant 2 is
    // false for this record shape, the contract says so in place, and until now nothing pinned
    // it: the request-shaped record at ordinal 2 carries no `socket` and never trips the sniff.
    expect(line.record).not.toHaveProperty('request_id');
    expect(line.record).not.toHaveProperty('route');

    // Not bought by writing no line: the call site's own words survive the replacement.
    expect(line.record.msg).toBe(REQUEST_SNIFF_CONTEXT);
  });

  it('F-281: the same record with no `socket` keeps `request_id` and `route`, and is censored key by key', () => {
    // THE NEAR MISS, AND IT IS WHAT MAKES THE TEST ABOVE A STATEMENT ABOUT PINO'S SNIFF RATHER
    // THAN ABOUT THIS MODULE. One key removed, the same three payload-carrying keys present:
    // the record reaches `formatters.log` intact, both named fields keep their values, and
    // `method`, `headers` and `url` are censored one by one.
    //
    // So coverage does not depend on the replacement, which is the other half of "there is no
    // leak here" — the allowlist reaches the same payload without it. And a pino change that
    // WIDENED the sniff to fire without a `socket` reds here rather than passing silently.
    expect(
      fields(LINE.theSameRecordWithNoSocket, ['request_id', 'route', 'method', 'headers', 'url']),
    ).toEqual({
      request_id: REQUEST_ID,
      route: ROUTE_PATTERN,
      method: CENSOR,
      headers: CENSOR,
      url: CENSOR,
    });

    const line = lines[LINE.theSameRecordWithNoSocket];

    for (const marker of [REQUEST_SNIFF_AUTHORIZATION, REQUEST_SNIFF_COOKIE, REQUEST_SNIFF_URL]) {
      expect(line.raw).not.toContain(marker);
    }

    expect(line.record).not.toHaveProperty('req');
  });

  it('F-281: a record carrying a `setHeader` becomes `res` alone, which is the second door onto the same mechanism', () => {
    // DOOR TWO, found by `sdlc-reviewer`: `typeof o.setHeader === 'function'` (`tools.js:53`)
    // is a second, much cheaper trip-wire than the three-key request test — one function-valued
    // key on the record is enough. `resSerializer` then calls `getHeaders()`, so a `Set-Cookie`
    // the caller's record never held as a key is pulled INTO the replacement and censored with
    // it.
    //
    // Same shape of loss as door one, asserted separately because it fires on a different
    // predicate and a pino change could move one without the other. `status` is here as well as
    // `request_id` and `route`: it is a named field a response-logging call site would be
    // holding at exactly this moment.
    const line = lines[LINE.responseShapedRecordWithNamedFields];

    expect(line.raw).not.toContain(RESPONSE_SNIFF_SET_COOKIE);
    expect(line.record.res).toBe(CENSOR);

    expect(line.record).not.toHaveProperty('request_id');
    expect(line.record).not.toHaveProperty('route');
    expect(line.record).not.toHaveProperty('status');

    expect(line.record.msg).toBe(RESPONSE_SNIFF_CONTEXT);
  });
});
