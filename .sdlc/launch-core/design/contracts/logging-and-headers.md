# Contract: structured logging, redaction, CORS, and security headers

- **Boundary:** every log line the API emits; every response header it sets.
- **Normative form:** `apps/api/src/observability/logger.ts` and `apps/api/src/main.ts`. The wave-1 stub at `design/stubs/apps/api/src/observability/logger.ts` is **superseded** (F-249) and its config is unsafe to copy.
- **Produced by:** TASK-003.
- **Consumed by:** every API TASK. Nothing may opt out.
- **ADRs:** ADR-0022. Enforces GC-9.

## Logger

Amended 2026-08-08 (F-249, F-244, F-248, F-242). The block below now matches the shipped
`apps/api/src/observability/logger.ts` on pino 10.3.1. The version it replaced had 17
redact paths against the shipped 25, no `serializers`, no `hooks` and no `formatters.log`.
A TASK re-deriving the logger from that version would have reintroduced a credential leak
with every gate green, which is what F-249 was filed for.

**Four mechanisms, and every one of them is load-bearing.** `redact` covers named fields.
`serializers.err` covers the `err` key. `hooks.logMethod` covers the positional
`log.error(err)` call. `formatters.log` covers every other key at depth. Read "Why each
mechanism is here" below before editing any of them. Removing one reopens a leak that
already shipped once, and `apps/api/src/observability/logger.spec.ts` fails on each.

```ts
import pino from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["fly-client-ip"]',
  'req.headers["x-forwarded-for"]',
  'req.headers["x-shortkit-client-ip"]',
  'req.headers["x-shortkit-proxy-auth"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.rawToken',
  '*.tokenDigest',
  '*.verificationToken',
  '*.ip',
  '*.ipHash',
  'req.body.password',
  'req.body.confirmation',
  // The top-level halves of the wildcards above (F-244). A pino wildcard matches exactly
  // one level, so `*.password` does not reach a `password` key on the record itself, and
  // the record itself is where a call site that spreads a parsed body reaches first.
  'password',
  'token',
  'secret',
  'rawToken',
  'tokenDigest',
  'verificationToken',
  'ip',
  'ipHash',
] as const;

export const REDACT_CENSOR = '[redacted]';

/** What `msg` says when a call site logged an error and nothing else. */
const POSITIONAL_ERROR_MESSAGE = 'an error was logged with no context string';

/** How far into a log record the error scan looks. See "The residual" below. */
const MAX_ERROR_SCAN_DEPTH = 4;

/** The key pino files a positional `Error` under, and the one key `serializers.err` owns. */
const ERROR_KEY = 'err';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
  base: { service: 'shortkit-api', env: process.env.NODE_ENV },
  formatters: {
    level: (label) => ({ level: label }),
    log: (record) => errorsReplaced(record, 1),
  },
  serializers: { err: (thrown: unknown) => errorLogFields(thrown, { includeMessage: false }) },
  hooks: {
    logMethod(args, method) {
      const [thrown, context] = args as [unknown, unknown];

      if (thrown instanceof Error && typeof context !== 'string') {
        method.call(this, { err: thrown }, POSITIONAL_ERROR_MESSAGE);
        return;
      }

      method.apply(this, args);
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

function errorsReplaced<T extends object>(container: T, depth: number): T {
  let replacement: T | undefined;

  for (const key of Object.keys(container)) {
    // The seam with `serializers.err`. See "The ordering" below: this skip is required,
    // not stylistic.
    if (depth === 1 && key === ERROR_KEY) {
      continue;
    }

    const value = readIndexedProperty(container, key);

    if (value === UNREADABLE_PROPERTY) {
      continue;
    }

    const replaced =
      value instanceof Error
        ? errorLogFields(value, { includeMessage: false })
        : depth < MAX_ERROR_SCAN_DEPTH && isWalkable(value)
          ? errorsReplaced(value, depth + 1)
          : value;

    if (replaced !== value) {
      replacement ??= (Array.isArray(container) ? [...container] : { ...container }) as T;
      (replacement as Record<string, unknown>)[key] = replaced;
    }
  }

  return replacement ?? container;
}

/** A property whose getter threw. The scan leaves that key exactly as it found it. */
const UNREADABLE_PROPERTY = Symbol('unreadable property');

function readIndexedProperty(container: object, key: string): unknown {
  try {
    return (container as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE_PROPERTY;
  }
}

/** Plain records and arrays only. `Object.keys` on a `Buffer` is thousands of index strings. */
function isWalkable(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}
```

`errorLogFields` is specified in `error-envelope.md`, "What the 500 log line carries, and
who owns changing it". It returns `err_name`, an `err_stack` of frames with the
`${name}: ${message}` header stripped, and `err_message` only when the caller opts in.

**When this block and the shipped file disagree, the shipped file wins and the divergence
is a finding.** No test in the repository compares them, which is how F-249 survived two
fix rounds. A TASK that changes the logger updates this block in the same commit.

### Why each mechanism is here

**`redact` covers fields you can name.** It is a path allowlist and it reaches exactly the
paths listed. Nothing else.

**`serializers.err` stops an error's own properties reaching the line (F-244).** pino's
default `err` serialiser copies every own enumerable property of the error onto the record.
body-parser 2.3.0 assigns the verbatim request body to `err.body` on the 400 it raises for
malformed JSON, so one idiomatic `log.error({ err }, '…')` wrote an unauthenticated POST's
credentials in the clear. Reproduced on pino 10.3.1 and re-measured 2026-08-08: a bare pino
emits `"body":"{\"password\":\"BODYMARK\""` under `err`. `REDACT_PATHS` did not reach it,
because `err.body` is a string and no path reaches inside a string. Routing the key through
`errorLogFields` makes the record carry the three fields the policy builds and no fourth,
whatever the error hangs off itself. Appending `err.body` to `REDACT_PATHS` was the
alternative and it defends one property that has already been found by name; the next
library to decorate an error picks a different name.

`serializers.err` also owns the non-error case under that key. `logger.error({ err: { body:
'…' } })` emits `{"err":{"err_name":"non-error throwable (object)"}}`. `errorsReplaced`
deliberately does not do that, because it replaces `Error` instances only.

**`hooks.logMethod` closes the same hole by its other door (F-244).** `log.error(err)` with
no context string routes the error through the serialiser, and then pino copies
`err.message` into `msg`. `msg` is a top-level key, and no redact path can censor it without
censoring every log line's text. Measured on pino 10.3.1: `bare.error(err)` emits
`"msg":"boom DSNMARK"`. The message is the one field the policy withholds everywhere else,
so the hook rewrites that call shape into the one the serialiser fully covers.
`log.error(err, 'context')` and every non-Error first argument pass through untouched.

**`formatters.log` covers every other key, at depth (F-248).** A serialiser is keyed by
field name, so `serializers.err` covers exactly one key. That is the same enumeration
weakness F-244 rejected, one level up: `{ error: e }` is as idiomatic as `{ err: e }`,
`cause` is ES2022's own name for a chained error, and `{ ctx: { err: e } }` is the same key
one level down. All three reach pino's ordinary object path. `message` and `stack` are
non-enumerable and do not survive it, but body-parser **assigns** `body`, so it is own and
enumerable and travels under any key. All three leaked F-244's exact payload, reproduced
before the fix. Adding `serializers.error` and `serializers.cause` would be the enumeration
F-244 rejected and would not reach the nested shape at all.

Only `Error` instances are replaced. A plain object a call site chose to log is that call
site's decision; the hazard is what a library hangs off a throwable without the call site
knowing.

The scan descends into nothing it replaces, which is why `err.cause` stays shut. `cause` set
through the `Error` constructor is own but non-enumerable, so `Object.keys` never returns it
and nothing walked it before F-248's fix. `errorLogFields` is the boundary: it reads `name`,
`message` and `stack` and returns three fields, never a container to walk. A later edit that
"improves" the walk by following `cause` reopens the leak for chained errors, and
`logger.spec.ts` has a test that fails when it does.

### The ordering: `formatters.log` runs before the serialisers

`formatters.log` runs **before** the per-key serialisers, not after. Measured in the
installed pino 10.3.1, `lib/tools.js` `_asJson`: the `formatters.log(obj)` call sits at line
162 and the `serializers[key](value)` loop at 169. Both F-248 as filed and the test
architect's report said the opposite, and the correction is load-bearing.

That ordering is **why** `errorsReplaced` skips the top-level `err` key at depth 1. Had the
scan replaced that error too, `serializers.err` would receive a plain object and emit
`{"err":{"err_name":"non-error throwable (object)"}}`, losing the error's name and its
frames. Verified 2026-08-08 against the shipped logger by handing it a plain object under
`err`, which is that exact output.

So the two mechanisms **partition the record**:

| Owner | Covers |
|---|---|
| `serializers.err` | the top-level `err` key, including a non-error under it |
| `formatters.log` (`errorsReplaced`) | every other key, at every depth up to `MAX_ERROR_SCAN_DEPTH`, including `err` nested below the root |

There is no key between them. Drop the `depth === 1 && key === ERROR_KEY` skip and the
`err` key starts emitting `non-error throwable (object)`; drop `serializers.err` and the
non-error case under `err` stops being covered at all.

### The residual: depth 5

The scan is bounded at 4. Every log call site in `apps/api/src` builds a flat record today,
and the deepest shape named anywhere is `req.headers.authorization` at 3, so 4 is that plus
one level of slack. It was measured against the shipped instance's own formatter on pino
10.3.1 and Node 24.19, one million calls per figure: 40 ns on a flat record, 95 ns on one
carrying `req.headers`, 115 ns five deep, 500 ns when the record holds an error, where
`errorLogFields` rather than the walk is the cost. A whole log call is 5.8 µs to 9 µs, so
the scan costs under 2% of a line against GC-1's 25 ms budget. The bound also makes a
self-referential record terminate.

**An error at depth 5 or deeper is not replaced, and its assigned properties reach the
line.** Verified 2026-08-08 against the shipped logger:

```
{"…","a":{"b":{"c":{"d":{"err":{"body":"{\"password\":\"BODYMARK\"","status":400}}}}},"msg":"depth 5 - beyond the bound"}
```

This is the same limit `REDACT_PATHS` has for a nested secret, with the same answer: a TASK
that builds a record that deep raises `MAX_ERROR_SCAN_DEPTH` in the same commit and says so.

### Which casing `REDACT_PATHS` is keyed to

**The property names as they appear on the JavaScript record, which for domain values is
camelCase.** `ipHash` and `*.ipHash` are in the list because `ClickEventInput.ipHash` in
`click-events.md` is the TypeScript field a call site holds. `ip_hash` is the Postgres column
name in the same contract's DDL, and "What may never appear in a log line" below states the
prohibition in that snake_case form because that is the field's name in the database.

The two spellings are not interchangeable to fast-redact. Verified 2026-08-08 against the
shipped logger: `{ ipHash: 'CAMEL', ip_hash: 'SNAKE' }` emits
`"ipHash":"[redacted]","ip_hash":"SNAKE"`.

The logger's own structured fields are snake_case (`request_id`, `tenant_id`, `duration_ms`,
`err_name`), and that is not a contradiction. The logger builds those itself and never has to
censor them. The redact list only has to match names that arrive from elsewhere.

**The residual, named.** A record built from a raw driver row carries Postgres column names
verbatim, so a `db.execute` result logged whole would put `ip_hash` on the line uncensored.
No shipped code does that today; `ipHash` is the only spelling that exists in TypeScript. A
TASK that logs a raw row adds `ip_hash` and `*.ip_hash` in the same commit.

## Required fields

| Field | On | Source |
|---|---|---|
| `request_id` | every line inside a request | `x-request-id` header, or a generated uuid |
| `tenant_id` | every line inside a tenant transaction | `currentTenantId()` |
| `route` | request completion | the matched route pattern, not the raw path |
| `status`, `duration_ms` | request completion | |

`route` is the pattern (`/api/links/:id`), never the concrete path. A concrete path
carries a slug or an id, and the redirect path's concrete paths are the entire click
stream in plain text.

## What may never appear in a log line

Normative. GC-9.

- A raw IP address, in any field, from any header.
- A JWT, a session token, a capability token, an invitation token, a verification token,
  or any digest of one.
- A password, in any form.
- `ip_hash`. It is pseudonymous per tenant and a log aggregator is a weaker boundary than
  the database. The redact list carries this one as `ipHash` and `*.ipHash`, which is the
  TypeScript spelling a call site holds; see "Which casing `REDACT_PATHS` is keyed to".
- A request or response body, unless an explicit reviewed call logs named fields from it.
- A `tenant_id` other than the one the request is scoped to.
- An error's `message`, unless the call site opts in with a stated reason. Added
  2026-08-08 (F-090, F-108). The policy and its two opt-in call sites are in
  `error-envelope.md`, "What the 500 log line carries, and who owns changing it".
- Any property a library assigned to an error. `body-parser` puts the raw request body on
  `err.body`; `pg` puts colliding column values on `detail`.

The redact list is one of four mechanisms, and it is the one that only covers fields you
can name. **It is an allowlist of paths and it does not reach arbitrary nesting**:
`*.token` matches exactly one level, so it covers `req.token` and covers neither `token` at
the top level nor `payload.data.credentials.token` two levels down. That is why every
`*.x` entry is paired with a bare `x`. A TASK introducing a nested secret adds a path in
the same commit.

The other three mechanisms cover what a path list cannot: `serializers.err`,
`hooks.logMethod` and `formatters.log` keep an error's own properties and its message off
the line under every key, whatever they are named. See "Why each mechanism is here".

**The two `x-shortkit-*` entries are in the list now, ahead of the headers existing**
(F-032). `x-shortkit-client-ip` carries a raw client IP on every browser-originated API
request (GC-9 forbids a raw IP in any field from any header), and
`x-shortkit-proxy-auth` carries `BFF_PROXY_SECRET` verbatim — a leaked log line would
let anyone forge `X-Shortkit-Client-IP` against Fly directly and defeat every IP-keyed
auth bucket. The `'*.secret'` wildcard matches a property one level deep and **does not
reach a header key**. **TASK-003 owns these entries** and ships them in wave 1 with the
rest of the list, eight waves before TASK-009 introduces the headers; redacting a
not-yet-sent header is free, and appending later would have no owner. The
`BFF_PROXY_SECRET` value is never logged on the Vercel side either
(`web-api-client.md`).

### The exception filter's error line

Added 2026-08-05 (F-106). Resolved 2026-08-08 (F-242, TASK-003 fix round 1).
`apps/api/src/common/errors/exception-filter.ts` is the only place in the API that writes
an arbitrary error into a log line, and TASK-003 owns that file as of the F-090 ruling.

**The line is on pino now, and the stack-versus-message question is decided.**
`errorLogFields` builds `err_name` always, `err_stack` as frames only, and `err_message`
only where the call site opts in. `error-envelope.md`, "What the 500 log line carries, and
who owns changing it", is normative for that policy and names the two call sites that pass
`includeMessage: true`.

**One sentence that stood here was measured false and is removed.** It said `REDACT_PATHS`
"cannot help either way: it matches paths, and neither a message nor a stack has one." Once
a serialiser turns an error into an object, `err.message` and `err.stack` are ordinary
paths and pino censors them. Verified 2026-08-08 on pino 10.3.1: with
`redact: { paths: ['err.message', 'err.stack'] }`, a serialised error emits
`{"err":{"type":"SyntaxError","message":"[redacted]","stack":"[redacted]",…}}`.

The true constraint is narrower, and it is the one the policy rests on. **Redaction cannot
reach inside a string.** A path censors a field whole or leaves it whole, so a message that
carries a Postgres DSN goes to the log intact or not at all. That is why the answer is which
fields `errorLogFields` builds rather than which paths to censor, and it is also why the
stack is emitted as frames with the `${name}: ${message}` header stripped at construction:
`err.stack` opens with a `${name}: ${message}` line, and no path can remove the first line
of a string.

## CORS

**Disabled. `app.enableCors()` is never called.**

The browser never reaches the API cross-origin: ADR-0014 routes every browser request
through the Next.js BFF, same-origin with the page. The redirect path is reached by
navigation rather than by `fetch`, so it needs no CORS header either.

A future cross-origin consumer, such as the MCP server, gets its own ADR. It does not
inherit a permissive default set here. **A frontend TASK meeting a cross-origin error
escalates rather than enabling CORS**: the error means something is bypassing the BFF,
which is the actual defect.

## Security headers

`helmet()` with defaults, plus HSTS, registered in `main.ts` before the global prefix.

| Header | Value | Scope |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | every response |
| `X-Content-Type-Options` | `nosniff` | every response |
| `X-Frame-Options` | `DENY` | every response |
| `Referrer-Policy` | `no-referrer` | every response except the redirect 302 |
| `Content-Security-Policy` | helmet default | API responses |

`preload` is **not** set on HSTS: submission is close to irreversible and the apex domain
is unregistered.

### Two deliberate exceptions on the redirect path

Both already normative in `redirect-resolution.md`. They override the defaults above.

| Response | Header | Value | Why |
|---|---|---|---|
| redirect 302 | `Referrer-Policy` | `unsafe-url` | passing the short URL to the destination is the point of an attribution referrer, and the link is public |
| branded 404 | `Content-Security-Policy` | `default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'` | tighter than helmet's default; the page interpolates tenant-controlled branding (F-006) |

## Invariants a caller may rely on

1. Logging a whole request or response object never emits a credential, an IP, or a
   cookie. The redaction is at the logger, so no call site has to remember.
2. Every line inside a request carries `request_id`; every line inside a tenant
   transaction carries `tenant_id`.
3. The API sends no `Access-Control-Allow-Origin` header, for any origin, on any route.
4. HSTS, `nosniff` and `DENY` are present on every API response including errors.
   **Not true today.** `helmet` is not registered. F-243 clause 2 is open and escalated:
   this contract assigned helmet and HSTS to TASK-003 with no AC, no test and no finding
   tracking them. Nothing in launch-core owns it until that routes.
5. Logging an `Error` under any key, at any depth up to 4, emits `err_name`, an
   `err_stack` of frames, and nothing else. Not `message`, not `body`, not `detail`, not
   any property a library assigned. Holds for `{ err: e }`, `{ error: e }`, `{ cause: e }`,
   `{ ctx: { err: e } }`, `[e, e]`, `log.error(e)` and `log.error(e, 'context')`.
6. A hostile error does not take the process with it. An accessor that throws on `name`,
   `message` or `stack`, and a record property whose getter throws, are both survivable:
   the log call emits a line and does not rethrow. This matters at the exception filter's
   `headersSent` arm and in `main.ts`'s last-chance boot handler, which have nowhere left
   to escape to.

## What the implementer must guarantee

- **A test asserts redaction works**: build a log line from a request carrying
  `Authorization: Bearer x.y.z` and `Cookie: sk_at=...`, and assert the serialised output
  contains neither value and contains `[redacted]`.
- A test asserts no response carries `Access-Control-Allow-Origin`.
- Adding a field that could carry a secret means adding its path to `REDACT_PATHS` in the
  same commit.
- **Assert the bytes, not the configuration.** `apps/api/src/observability/logger.spec.ts`
  spawns a Node process, imports the shipped singleton, emits one line per call shape and
  reads stdout. A test that inspected `logger.options.serializers` passes against a config
  that emits the wrong bytes, which is how F-244 and F-248 both reached the branch. Eleven
  tests defend this today, each proven by a mutation that fails exactly it.
- **Never pass `includeMessage: true` without a reason at the call site.** Two call sites
  do, both named in `error-envelope.md`. A third needs the same treatment there.
- Never introduce a second pino instance. The redaction and the three error mechanisms are
  configuration on one logger, so a second instance built anywhere is a hole with none of
  them. Import `logger` from `apps/api/src/observability/logger.ts`.
- **Never interpolate an error's message into a log message string.**
  `` logger.error(`failed: ${e.message}`) `` puts the message into `msg`, which no
  serialiser, formatter or redact path reaches. Pass `{ err: e }` and a fixed context
  string instead. `apps/api/src/tenancy/tenant-context.ts:247` does the interpolated form
  today and is reported but not fixed.
- Never log `error.request` or `error.config` from an HTTP client. Both carry headers.
- **Never log a database error's `detail`, `hint`, `where`, `internalQuery` or `query`.**
  Added 2026-08-05 (F-120). A `pg.DatabaseError` populates `detail` on a unique violation
  with the colliding column values verbatim (`Key (slug)=(abc) already exists`), and
  `where` and `internalQuery` carry query text from a trigger or function body.
  `REDACT_PATHS` is a path list and cannot reach inside those strings, so redaction is
  not a fallback here. The readable fields on a caught database error are the SQLSTATE
  and the constraint name, both through the accessors in `tenant-context.md`, "Driver
  errors inside `fn`".

## Versioning

`REDACT_PATHS` is append-only. Removing a path needs a reason in the commit message.
Changing the header table requires amending ADR-0022.

`serializers.err`, `hooks.logMethod` and `formatters.log` are not removable by a TASK.
Each closes a leak that shipped once, each is defended by tests in `logger.spec.ts`, and
a change to any of them needs a finding and an ADR amendment before the code moves.
Raising `MAX_ERROR_SCAN_DEPTH` is additive and needs neither; lowering it is a removal.

`ErrorLogFields` grows by adding an optional field. Renaming `err_name`, `err_message` or
`err_stack` breaks every saved log query, so it needs the same amendment.

**ADR-0022's Decision block still shows the 17-path literal with no serialisers, no hook
and no formatter.** It has not been amended, and the code fenced there predates F-244 and
F-248. This contract is normative for the logger configuration; treat that block as the
2026-08-04 decision it records, not as something to copy.
