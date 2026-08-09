# TASK-003 — scoped security pass, fix round 3 (r4 audit)

- **Auditor slot:** `sdlc-security-auditor`
- **Scope:** `.superpowers/sdd/TASK-003/review-0a52185..015bba2.diff` (8 commits), plus a
  deliberate widening: *enumerate the ways an `Error`, or the raw body it carries, reaches an
  emitted line* — rather than re-checking the five doors already closed.
- **Date:** 2026-08-08
- **Verdict:** **changes-requested**
- **Findings:** 5 major, 3 minor, 2 nit. No blocker.
- **Prior findings re-judged:** F-244 **STILL ADDRESSED under the keys it named**. F-248, F-251,
  F-252, F-258 **ADDRESSED** — each verified by execution, not by reading the report.
- **Gates not re-run** (the orchestrator's run stands). Everything below was executed against
  the shipped singleton `apps/api/src/observability/logger.ts` through `npx tsx`, `NODE_ENV=test`,
  pino 10.3.1 / Node 24.19, and against the installed `node_modules` sources.

---

## 1. Door six, and how I went looking for it

Four doors onto one payload were found one at a time, each by reading the next artifact along.
So I did not read the artifacts for door six. I enumerated the code paths in pino 10.3.1 by
which any part of a log call reaches the output line, and asked which of them the module's five
mechanisms stand in front of:

| pino path | what builds the bytes | covered by |
|---|---|---|
| the log record | `_asJson` → `formatters.log` → `serializers[key]` → redact stringifier | `formatters.log` + `serializers.err` |
| child bindings | `child()` → `asChindings` → bindings formatter → `serializers[key]` | the `child` wrapper |
| instance bindings | `setBindings()` → `asChindings` | the `setBindings` wrapper |
| `msg` derived from the record | `write()`, `proto.js:223` | `hooks.logMethod`, both branches |
| **`msg` built from the call's arguments** | **`genLog`'s `LOG` → `format(msg, params, formatOpts)` — `quick-format-unescaped`** | **nothing** |
| the record pino *builds for you* | `genLog`'s `LOG`: `if (o.method && o.headers && o.socket) o = mapHttpRequest(o)` | `REDACT_PATHS`, **partially** |

The last two rows are open. They are findings 1 and 2, and both carry F-244's exact payload.

### 1.1 Door six — `msg` is also built from the *arguments*, and the hook never sees them

`genLog` (`lib/tools.js`) calls `format(msg, formatParams, this[formatOptsSym])` before `write`
ever runs. `quick-format-unescaped` expands `%o`, `%O` and `%j` through `formatOpts.stringify`
and `%s` through `String()`. `hooks.logMethod` inspects `args[0]` and `args[1]` only, and by the
time a placeholder matters `args[1]` is a *string* — so every branch of the hook declines and
the call passes through untouched.

Reproduced against the shipped singleton, error shaped as body-parser shapes it
(`err.body` = the verbatim request body, `err.message` = the F-108 arm's quoted request bytes):

```
logger.error('parse failed: %o', e)
  {"level":"error",…,"msg":"parse failed: {\"body\":\"{\\\"email\\\":\\\"a@b.test\\\",\\\"password\\\":\\\"MARKER-BODY\\\"}\",\"status\":400,…}"}

logger.error({ request_id: 'r1' }, 'parse failed: %o', e)      → same, with request_id alongside
logger.error('parse failed: %j', e)                            → same
logger.error('ctx %o', { err: e })                             → same, nested under err

logger.error('parse failed: %s', e)
  {"level":"error",…,"msg":"parse failed: SyntaxError: Unexpected token h in JSON at position 12: {\"password\":\"MARKER-MSG\"}"}

logger.error({ request_id: 'r2' }, e)          // the Error as the MESSAGE argument
  {"level":"error",…,"request_id":"r2","msg":{"body":"{\"email\":\"a@b.test\",\"password\":\"MARKER-BODY\"}","status":400,…}}
```

Three things make this the same finding as F-244 rather than a new class:

1. **The payload is identical** — every own enumerable property a library hung off the throwable,
   `err.body` among them. Not a message; the whole decorated object.
2. **`msg` is the field the module already treats as uncensorable.** `hooks.logMethod` exists for
   exactly this reason on two other call shapes.
3. **Redaction is not a fallback, and I checked rather than assumed.** `formatOpts.stringify` *is*
   the redacting stringifier, so an interpolated object does get the path list applied —
   `logger.error('creds %o', { password: 'x', nested: { token: 'y' } })` emits
   `"creds {\"password\":\"[redacted]\",\"nested\":{\"token\":\"[redacted]\"}}"`. It does not help
   here for F-244's original reason: `err.body` is a *string*, and a path list cannot reach inside
   one. `%s` bypasses `stringify` altogether.

The contract's invariant 6 does carve out interpolation — but only *"a message a call site
interpolated into the context string itself, which no mechanism here can reach"*, i.e. the
`` `failed: ${e.message}` `` shape (F-247). That is not this. Here the call site did **not**
interpolate: it handed the error to the logger, which is precisely the act this module promises
to make safe, and pino did the interpolation. The leaked value is not the message but the body.
A reader of invariant 6 who avoids template literals has no reason to think `%o` is different —
and `logger.error('parse failed: %o', err)` is the console-shaped idiom pino's own README
teaches (`logger.info('hello %s', 'world')`).

**This is door six.** It is not introduced by this diff; it has been open since the module
existed, and none of the five reviews of it looked at `genLog`.

### 1.2 Door seven — pino builds a record for you out of an HTTP request

`genLog`'s `LOG` intercepts a first argument that looks like a request
(`o.method && o.headers && o.socket`) and replaces it with
`pino-std-serializers`' `mapHttpRequest`. That serialiser emits `method`, `url`, `headers`,
**`remoteAddress`** and **`remotePort`**. Reproduced:

```
logger.info(req, 'incoming request')
  {"level":"info",…,"req":{"method":"GET","url":"/r/MARKER-SLUG?utm=1",
   "headers":{"host":"x.test","authorization":"[redacted]","cookie":"[redacted]",
              "x-shortkit-client-ip":"[redacted]","user-agent":"ua"},
   "remoteAddress":"203.0.113.7","remotePort":54321},"msg":"incoming request"}
```

The headers *are* censored — which is what makes this dangerous rather than obvious. The redact
list carries six `req.headers.*` paths, so the list itself tells a reader that logging a whole
request is an anticipated, covered act. Contract invariant 1 says so outright: *"Logging a whole
request or response object never emits a credential, an IP, or a cookie. The redaction is at the
logger, so no call site has to remember."* **Measured false.** `req.remoteAddress` is the raw
client IP — GC-9's first prohibition, in any field, from any header — and `req.url` is the
concrete path, which the same contract forbids two sections earlier (*"`route` is the pattern,
never the concrete path … the redirect path's concrete paths are the entire click stream in plain
text"*). Neither `remoteAddress`, `remotePort` nor `url` is in `REDACT_PATHS`.

This is the same failure shape as F-253: a brand-new invariant that a later TASK will trust,
measured false. It differs in that the payload is live PII rather than an availability edge.

---

## 2. The two `Object.defineProperty` wrappers, judged

**Coverage, verified by execution rather than by the implementer's report.** All of the following
came out with `err_name`/`err_stack` and no `MARKER-BODY`:

- `logger.child({ request_id }).child({ error: e })` — grandchild, nested key.
- `logger.child({ request_id }).setBindings({ error: e })` — child's `setBindings`.
- `logger.child({ error: e }, { level: 'debug' })` — a child created *with* an options argument.
- `logger.child({ request_id }, { msgPrefix: 'pfx ' })`.
- `logger.child({ err: e })` and `setBindings({ err: e })` still report the policy fields, not
  `non-error throwable (object)` — the depth-1 seam holds on both bindings paths.

**Mechanically, all of that rests on one unpinned fact.** The wrappers are *own* properties of
the root singleton and nothing else:

```
Object.getOwnPropertyNames(logger)            → ['child', 'setBindings', …]
Object.getOwnPropertyNames(logger.child({a:1})) → []          // no own child, no own setBindings
```

A child is covered only because `child()` returns `Object.create(this)`, which makes the root's
own properties *inherited* properties of every descendant. That is a pino implementation detail
(`proto.js`), it is not part of pino's public contract, no test in the suite builds a grandchild,
and the drift test compares text and cannot see it. Finding 5.

**Bypasses I found.**

- **`child(bindings, options)` is a supported opt-out of the entire configuration, and the wrapper
  passes `options` through unexamined** (`proto.js:115-165`). Reproduced, all three:

  ```
  logger.child({request_id:'r4'}, { serializers: { err: pino.stdSerializers.err } })
        .error({ err: e }, '…')
    → "err":{"type":"SyntaxError","message":"boom MARKER-MSG","stack":"SyntaxError: boom MARKER-MSG\n…",
              "body":"{\"password\":\"MARKER-BODY\"}","status":400}     ← F-244, verbatim, restored

  logger.child({request_id:'r5'}, { formatters: { log: (o) => o } }).error({ error: e }, '…')
    → "error":{"body":"{\"password\":\"MARKER-BODY\"}","status":400}    ← F-248, verbatim, restored

  logger.child({request_id:'r6'}, { redact: ['nothing'] })
        .error({ password:'MARKER-PW', req:{headers:{authorization:'Bearer MARKER-AUTH'}} }, '…')
    → "password":"MARKER-PW","req":{"headers":{"authorization":"Bearer MARKER-AUTH"}}
  ```

  The `redact` one is the plausible accident rather than the exotic one: a TASK that wants **one**
  extra path for its own subtree writes `logger.child(b, { redact: ['*.myField'] })` and silently
  drops all twenty-five. pino *replaces*, it does not merge (`proto.js:158-160`, comment: *"replace
  redact directly"*). Finding 4.
- **The prototype is still reachable.** `Object.getPrototypeOf(logger).child.call(logger, { error: e })`
  emits the raw body. So does reassigning `logger.child`, since the descriptor is `writable: true,
  configurable: true`. Neither is an idiomatic mistake — a later TASK does not reach for
  `getPrototypeOf` — so this is hardening, not a door. Finding 8.
- **No initialisation-order window.** The wrappers are installed at module scope after `pino()`;
  `logger.ts` imports nothing from the app, so no importer can call `child` mid-evaluation.
- **Nothing inside pino calls `.child(`** (re-grepped `lib/*.js` and `pino.js`: zero hits), so the
  wrapper displaces no internal behaviour.

**Is `setBindings` coming off the residual list justified? Yes.** I re-derived the claim rather
than taking it: both wrappers route through the single `bindingsScanned`, both are covered on the
root and on descendants, and `setBindings` appends to the singleton's chindings permanently — so
it was the higher-consequence of the two doors, not the lower. The residual list is right to say
*both* entries to `asChindings` are covered and that a third entry would belong on the list.

---

## 3. The depth-4 bound and the stated residuals, judged

**The bound is fine and the reasoning is honest.** Every call site in `apps/api/src` builds a flat
record; the deepest named shape is `req.headers.authorization` at 3; the residual is recorded in
the source, the contract and the versioning rules; and the cost figures are stated with the one
number nobody could reproduce flagged as such. I re-confirmed depth 4 replaced and depth 5 not.
No finding.

**The residual list is incomplete by one mechanism: `toJSON`.** The scan inspects *properties*;
`JSON.stringify` consults `toJSON` and never looks at them. Reproduced both ways:

```
logger.error({ ctx: { toJSON: () => e } }, 'toJSON')            // PLAIN object — isWalkable WALKS it
  → "ctx":{"body":"{\"password\":\"MARKER-BODY\"}","status":400}

class Ctx { constructor(err) { this.err = err } toJSON() { return { inner: this.err } } }
logger.error({ ctx: new Ctx(e) }, 'class with toJSON')
  → "ctx":{"inner":{"body":"{\"password\":\"MARKER-BODY\"}","status":400}}
```

The first line is *not* residual 2. `isWalkable` returns true for it — the prototype is
`Object.prototype` — the scan walks it, finds one key whose value is a function, replaces nothing,
and the error reappears at stringify time. So the residual list's two entries do not span it, and
residual 2's stated remedies (*"log the fields it wants rather than the instance, or widen
`isWalkable`"*) do not describe this mechanism: widening `isWalkable` is irrelevant here, and for
the class form it would fix the leak only by *dropping `toJSON` from the copy*, silently changing
what the line looks like. Finding 6.

**Two shapes I checked that are NOT residuals**, worth recording so nobody re-files them:
a getter that *returns* an error is read, replaced, and the copy's re-invocation of the getter is
overwritten by the assignment (`"boom":{"err_name":"SyntaxError",…}`); and symbol-keyed and
non-enumerable properties are invisible to `Object.keys` and to `JSON.stringify` alike.

---

## 4. `REDACT_PATHS` at 25 entries, judged: not closed over this system's own fields

The camelCase/snake_case section is careful, states its residual, and is right that the wildcard
matches exactly one level. The gap is not casing — it is **which names**. Reproduced on one line:

```
logger.info({ clientIp:'203.0.113.7', trustedClientIp:'203.0.113.7',
              remoteAddress:'203.0.113.7', ipAddress:'203.0.113.7' }, 'ip names')
  → "clientIp":"203.0.113.7","trustedClientIp":"203.0.113.7",
    "remoteAddress":"203.0.113.7","ipAddress":"203.0.113.7"     ← none censored
```

`*.ip` and `ip` cover a key spelled exactly `ip` and nothing else. This system does not spell it
`ip`. Its header is `x-shortkit-client-ip`; the accessor named in the design stubs is
`trustedClientIp()` (`design/stubs/apps/api/src/auth/resolve-rate-limit-principal.ts:28`); pino's
own request serialiser spells it `remoteAddress` (§1.2). The natural binding for any of those is
`clientIp` or `remoteAddress`, and neither is on the list. GC-9's first prohibition is *a raw IP
address, in any field, from any header* — the mechanism that is supposed to enforce it does not
cover the spelling the enforcing code will hold. Finding 3.

The same probe on credential names: `sessionToken`, `accessToken`, `refreshToken`, `apiKey`,
`api_key`, `passwordHash`, and bare `authorization` / `cookie` outside `req.headers` are all
emitted verbatim. `token` and `*.token` do not match `sessionToken`. Finding 7, minor: unlike the
IP case these are not names the system holds *today*, and the append-only escalation rule is a
reasonable answer for names that do not exist yet. The IP case is different because the name
already exists in a design stub.

Also on the list, and *not* a finding: `ip_hash` in snake_case is documented as a residual with the
right escalation rule, and I confirmed the measurement (`{ ipHash, ip_hash }` →
`"ipHash":"[redacted]","ip_hash":"SNAKE"`). The contract's argument that TypeScript only ever holds
`ipHash` is sound as far as the ORM goes.

---

## 5. F-253's residual ruling, judged: correctly weighted, and safer than the ruling claims

I was asked whether a documented residual is the right weight for something that can convert a
logged failure into an unhandled one (GC-8). **It is, and the argument for it is stronger than the
one the architect made.**

The architect's case is the four-throw-site table: a sentinel in `readIndexedProperty` would cover
two rows and not the other two (fast-redact's `cloneSelectively`, `asChindings`), so it would buy a
guarantee bounded at depth 4 that the two call sites cannot check before calling. That holds.

What the ruling does not say, and what I verified in the source, is that **neither named call site
can build a hostile record in the first place.** Both go through
`exception-filter.ts:265-275`'s `logError`, which emits
`{ ...fields, ...errorLogFields(exception, …) }` — `fields` is a call-site literal (`{ status }`),
and `errorLogFields` returns strings built behind `readStringProperty`'s guard. The child logger's
bindings are `{ request_id: string }` (`:125`, `requestId()` returns a `string`, capped at 128).
`main.ts:269` is the same shape. There is no caller-controlled property in either record, so the
throw sites are not reachable from the two places where GC-8 would bite. The residual bites only a
*future* call site that spreads caller-controlled data into a log record — which is exactly what
the contract's "Wrap the log call where there is nowhere left to escape to" bullet tells that call
site to handle locally.

So: no finding, and I would resist escalating this one in a later round. The remaining defect on
this path is F-259 (open, correctly filed): `readIndexedProperty`'s docblock still claims the scan
"must not throw out of the log call" while the `{ ...container }` spread at `logger.ts:398`
re-invokes the getter outside the guard. That claim is still in the shipped source at
`logger.ts:409-413`. Not re-filed.

---

## 6. Findings

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 139
    summary: >-
      DOOR SIX. pino builds `msg` from the log call's ARGUMENTS through quick-format-unescaped
      before write() runs, and hooks.logMethod inspects only args[0] and args[1]. A `%o`, `%j` or
      `%s` placeholder, or an Error passed as the message argument, puts F-244's payload — every
      own enumerable property of the throwable, err.body included — into the one field no redact
      path can censor.
    failure_scenario: >-
      A later TASK writes the console-shaped idiom pino's own README teaches. REPRODUCED against
      the shipped singleton with a body-parser-shaped SyntaxError. `logger.error('parse failed:
      %o', e)`, `logger.error({request_id:'r1'}, 'parse failed: %o', e)`, `logger.error('parse
      failed: %j', e)` and `logger.error('ctx %o', { err: e })` each emit
      "msg":"parse failed: {\"body\":\"{\\\"email\\\":\\\"a@b.test\\\",\\\"password\\\":\\\"MARKER-BODY\\\"}\",\"status\":400,…}".
      `logger.error('parse failed: %s', e)` emits the message verbatim, which on the F-108
      framework-400 arm quotes raw request bytes. `logger.error({request_id:'r2'}, e)` — the Error
      in the message position, a one-token transposition of the covered `logger.error(e, 'ctx')` —
      emits "msg":{"body":"{…password…}","status":400}. genLog (lib/tools.js) calls
      format(msg, formatParams, formatOpts) before write(); by then args[1] is a string, so every
      branch of the hook declines. formatOpts.stringify IS the redacting stringifier and does
      censor interpolated objects (`'creds %o'` with a top-level password emits `[redacted]`), but
      err.body is a STRING and a path list cannot reach inside one — F-244's original reason — and
      %s bypasses stringify entirely. Contract invariant 6 carves out only "a message a call site
      interpolated into the context string itself"; here the call site interpolated nothing, it
      handed the error to the logger, and the leaked value is the body rather than the message.
      Not introduced by this diff; open since the module existed and not looked at in five reviews.
    required_change: >-
      Cover the format path or state it as loudly as the depth-5 residual, in the source docblock,
      in the contract's partition section and in invariant 6. The mechanism available is
      hooks.logMethod, which already owns `msg`: it receives the whole args array, so it can
      replace any Error among args[2..] with errorLogFields(...) — or reject a format-carrying
      call shape outright — before pino formats. A test on emitted bytes for `%o`, `%s` and the
      Error-as-message shape either way; the suite has none, and every other door onto `msg` has
      one.

  - severity: major
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 35
    summary: >-
      pino replaces a request-shaped first argument with pino-std-serializers' mapHttpRequest,
      which emits `remoteAddress`, `remotePort` and the concrete `url`. None is in REDACT_PATHS,
      so logging a whole request writes the raw client IP. Contract invariant 1 states the
      opposite.
    failure_scenario: >-
      genLog's LOG does `if (o.method && o.headers && o.socket) o = mapHttpRequest(o)`. REPRODUCED
      against the shipped singleton: logger.info(req, 'incoming request') emits
      "req":{"method":"GET","url":"/r/MARKER-SLUG?utm=1","headers":{…"authorization":"[redacted]",
      "cookie":"[redacted]","x-shortkit-client-ip":"[redacted]"…},"remoteAddress":"203.0.113.7",
      "remotePort":54321}. The headers ARE censored, which is what makes this dangerous rather
      than obvious — six req.headers.* paths on the list tell a reader that logging a request is
      an anticipated, covered act, and contract invariant 1 says it outright: "Logging a whole
      request or response object never emits a credential, an IP, or a cookie. The redaction is
      at the logger, so no call site has to remember." A raw IP in any field is GC-9's first
      prohibition and the reason ip_hash exists; the concrete `url` is what the same contract
      forbids under "route is the pattern, never the concrete path — the redirect path's concrete
      paths are the entire click stream in plain text". The reachable call site is the request-log
      middleware a later TASK owes for the `request_id`/`route`/`status`/`duration_ms` line, where
      `log.info({ req, res }, 'request completed')` is the pino-documented shape.
    required_change: >-
      Append `req.remoteAddress`, `req.remotePort`, `*.remoteAddress` and bare `remoteAddress` to
      REDACT_PATHS (append-only, so this is additive), and decide `req.url` explicitly — either a
      redact path or a stated prohibition, since a concrete path is not a secret a censor value
      helps with. Invariant 1 must then say what it actually guarantees, or be reduced to the
      headers it does cover. A test on emitted bytes for logger.info(req, …), which is the
      invariant's own wording and has no test today.

  - severity: major
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 49
    summary: >-
      REDACT_PATHS covers a raw IP only under the exact key `ip`. This system spells it `clientIp`
      / `trustedClientIp` / `remoteAddress`, none of which the list matches, against GC-9's
      first prohibition.
    failure_scenario: >-
      REPRODUCED: logger.info({ clientIp:'203.0.113.7', trustedClientIp:'203.0.113.7',
      remoteAddress:'203.0.113.7', ipAddress:'203.0.113.7' }, 'ip names') emits all four verbatim;
      only a key spelled exactly `ip` (or `x.ip`) is censored. The header this system reads is
      `x-shortkit-client-ip` and the accessor already named in the design stubs is
      `trustedClientIp()` (design/stubs/apps/api/src/auth/resolve-rate-limit-principal.ts:28), so
      the binding a rate-limit or click TASK holds is `clientIp` or `trustedClientIp`, not `ip`.
      GC-9 says a raw IP may not appear in a log line in any field from any header, and this list
      is the mechanism named for it — the ip_hash casing residual is documented, this one is not
      mentioned anywhere. Unlike the credential names below, the spelling exists in the repository
      today.
    required_change: >-
      Append `clientIp`, `*.clientIp`, `trustedClientIp`, `*.trustedClientIp`, `remoteAddress`,
      `*.remoteAddress` (shared with the finding above) and `ipAddress`, `*.ipAddress`. Append-only,
      so additive. If the answer is instead that the escalation rule covers it, then the rule has
      to be stated against a named-today spelling rather than a hypothetical one, and "What may
      never appear in a log line" should carry the list of spellings a raw IP arrives under.

  - severity: major
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 216
    summary: >-
      The child wrapper scans `bindings` and passes `options` through unexamined, and pino's child
      options REPLACE the instance's redact list, serializers and log formatter. One documented
      pino call opts a subtree out of every control this module installs.
    failure_scenario: >-
      proto.js:115-165. REPRODUCED against the shipped singleton, all three:
      child(b,{serializers:{err:pino.stdSerializers.err}}).error({err:e}) restores F-244 verbatim
      ("body":"{\"password\":\"MARKER-BODY\"}" plus message and unstripped stack);
      child(b,{formatters:{log:(o)=>o}}).error({error:e}) restores F-248 verbatim;
      child(b,{redact:['nothing']}).error({password:'MARKER-PW',req:{headers:{authorization:
      'Bearer MARKER-AUTH'}}}) emits both verbatim. The redact case is the plausible accident: a
      TASK adding ONE path for its own subtree writes child(b,{redact:['*.myField']}) and silently
      drops all twenty-five, because pino replaces rather than merges ("replace redact directly",
      proto.js:158). exception-filter.ts:125 already creates a child per request, so the call shape
      is present; only the options argument is missing. Nothing in the source docblock, the
      contract or the versioning rules mentions that child options are an opt-out, while the
      module header says "Consumed by: every API TASK. Nothing may opt out."
    required_change: >-
      The wrapper is the seam and already intercepts the call: reject or merge the three dangerous
      option keys there — throw on `serializers.err`, `formatters.log` and `redact` in child
      options, or merge redact paths onto REDACT_PATHS rather than replacing. Whichever, the
      contract's "The two wrappers" section must state that child options replace, and a test on
      emitted bytes must pin it.

  - severity: major
    kind: implementation
    file: apps/api/src/observability/logger.ts
    line: 241
    summary: >-
      Every child and grandchild is covered only because pino's child() returns
      Object.create(this). That is an unpinned internal of an exact-pinned dependency: no test
      builds a grandchild, and a grouped Dependabot minor bump that changed child construction
      would reopen F-251 and F-258 at exception-filter.ts:125 with every gate green.
    failure_scenario: >-
      MEASURED: Object.getOwnPropertyNames(logger) is ['child','setBindings',…] and
      Object.getOwnPropertyNames(logger.child({a:1})) is [] — a child has NO own wrapper and
      resolves both methods through the prototype chain to the root singleton. Coverage of
      logger.child(x).child({error:e}) and logger.child(x).setBindings({error:e}) therefore rests
      entirely on that one line of pino's proto.js, which is not part of pino's public contract.
      The suite's four bindings tests all call the ROOT (logger.spec.ts:488-537, :592-618); the
      implementer's own report §8 says "no test builds a grandchild… that is the one place I would
      want a test I cannot write". The drift spec compares text and cannot see it. .github/
      dependabot.yml groups every minor and patch into one pull request, so pino 10.4.0 arrives
      alongside unrelated bumps with a green suite and no reason for a human to re-read proto.js.
      The same class of exposure applies to the other three internals this module now depends on:
      _asJson running formatters.log BEFORE serializers (tools.js:160-169), asChindings applying
      the bindings formatter at :247 before serializers[key] at :258, and child() swapping in
      resetChildingsFormatter at proto.js:98-104. The suite pins the consequences of the first
      two; nothing pins the third or the Object.create.
    required_change: >-
      A test that emits bytes from a GRANDCHILD — logger.child({request_id}).child({error:e}) and
      the same for setBindings — which is the guard the implementer asked for and the only one
      that fails when pino changes child construction. Cheap alternative for the rest: a single
      test asserting the four internals still hold (formatter-before-serializer ordering on both
      paths), so a bump that moves them is red rather than silent. Neither needs a version change.

  - severity: minor
    kind: implementation
    file: apps/api/src/observability/logger.ts
    line: 325
    summary: >-
      The residual list has two entries and needs three. A `toJSON` method reintroduces an error
      the scan already passed over, and neither residual spans it — including on a PLAIN object,
      which isWalkable walks.
    failure_scenario: >-
      REPRODUCED both ways. logger.error({ ctx: { toJSON: () => e } }, 'toJSON') emits
      "ctx":{"body":"{\"password\":\"MARKER-BODY\"}","status":400}: the container is a plain object,
      isWalkable returns true, the scan walks it, finds one key holding a FUNCTION, replaces
      nothing, and JSON.stringify then calls toJSON and serialises the error's own enumerable
      properties. So this is not residual 2 — the scan did not decline to walk it. The class form
      (class Ctx { toJSON() { return { inner: this.err } } }) leaks too, and residual 2's stated
      remedies do not describe it: widening isWalkable is irrelevant to the plain-object case, and
      for the class case it would "fix" the leak only by dropping toJSON from the copy and
      silently changing what the line looks like. The scan inspects properties; stringify consults
      toJSON; the two never meet.
    required_change: >-
      State it as residual 3 in MAX_ERROR_SCAN_DEPTH's list and in the contract, under the same
      escalation rule, with the mechanism named (a toJSON is consulted by stringify and is
      invisible to a property scan) — not folded into the class-instance entry, because the plain-
      object form is outside it. No behaviour change required if the trade-off is deliberate.

  - severity: minor
    kind: implementation
    file: apps/api/src/observability/logger.ts
    line: 44
    summary: >-
      `token` and `*.token` match a key spelled exactly `token`. sessionToken, accessToken,
      refreshToken, apiKey, api_key, passwordHash and a bare `authorization` or `cookie` outside
      req.headers all reach the line verbatim.
    failure_scenario: >-
      REPRODUCED: logger.info({ proxySecret:'S', BFF_PROXY_SECRET:'S', apiKey:'S', api_key:'S',
      passwordHash:'S', sessionToken:'S', authorization:'Bearer S', cookie:'sid=S' }, '…') emits
      every one uncensored. GC-9 and the contract's "What may never appear in a log line" name a
      session token, a capability token and any digest of one; the list covers rawToken,
      tokenDigest and verificationToken by exact spelling and stops there. Weaker than the IP
      finding above because none of these spellings exists in apps/api/src today — Better Auth's
      session field is `token`, which IS covered — so the append-only escalation rule is a
      defensible answer.
    required_change: >-
      Either append the spellings a credential plausibly arrives under (sessionToken, accessToken,
      refreshToken, apiKey, api_key, passwordHash, authorization, cookie, plus their `*.` halves),
      or state explicitly in the REDACT_PATHS docblock that the list matches EXACT key names and
      that a TASK introducing any *-suffixed credential name adds it in the same commit. The
      docblock currently warns about depth and says nothing about spelling.

  - severity: minor
    kind: implementation
    file: apps/api/src/observability/logger.ts
    line: 241
    summary: >-
      Both wrappers are installed writable and configurable, and pino's originals stay reachable
      through the prototype, so a control the versioning rules call "not removable by a TASK" is
      removable by one assignment and bypassable by one call.
    failure_scenario: >-
      REPRODUCED: Object.getPrototypeOf(logger).child.call(logger, { error: e }).error('…') emits
      "error":{"body":"{\"password\":\"MARKER-BODY\"}","status":400}. `logger.child = pinoChild`
      does the same permanently, on the singleton every later TASK imports, and nothing in the
      suite or the drift test detects it. This is hardening rather than a door — a later TASK does
      not reach for getPrototypeOf, and the descriptor comment explains that defineProperty was a
      typing decision rather than a security one — but the versioning rules claim these two are
      not removable, and today they are the two least protected things in the file.
    required_change: >-
      writable: false on both descriptors, which makes an assignment a TypeError in this module
      graph (ES modules are strict) instead of a silent replacement. Keep configurable: false too
      unless a test needs to restore them. If the descriptors stay as they are, the versioning
      rules should stop implying the runtime protects them.

  - severity: nit
    kind: implementation
    file: eslint.config.mjs
    line: 21
    summary: >-
      The contract's "Never introduce a second pino instance" and the module header's "Nothing may
      opt out" are enforced by nothing. There is no no-restricted-imports rule on `pino` and no
      no-console rule.
    failure_scenario: >-
      A later TASK writes `import pino from 'pino'; const log = pino();` in its own module and gets
      a logger with no redact list, pino's default err serialiser and none of the four mechanisms —
      F-244 restored in full, with typecheck, lint, the suite and the drift test all green, because
      every one of them looks only at apps/api/src/observability/logger.ts. Same for a console.log
      of a caught error, which writes an unstructured line straight past GC-9. Only one pino
      instantiation exists today (grepped: logger.ts:130 is the only pino() call, exception-filter
      imports the TYPE only), so this is a guard on the rule rather than a live defect.
    required_change: >-
      no-restricted-imports on 'pino' with an override for apps/api/src/observability/logger.ts,
      and no-console for apps/api/src. Five lines in eslint.config.mjs. Out of TASK-003's paths;
      routing is the orchestrator's.

  - severity: nit
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 139
    summary: >-
      A trailing argument with no format placeholder is silently dropped, so the safe-looking
      neighbour of door six loses the error entirely rather than leaking it.
    failure_scenario: >-
      REPRODUCED: logger.error('parse failed', e) emits {"level":"error",…,"msg":"parse failed"} —
      no err_name, no frames, nothing. quick-format-unescaped returns the format string unchanged
      when it contains no `%`, and pino discards the remaining arguments. A call site debugging a
      production failure gets a line that names the failure and carries none of it. Recording it
      here because it sits one character away from the leaking shapes above: `'parse failed'` is
      silent, `'parse failed %o'` leaks the request body, and nothing tells a reader which is which.
    required_change: >-
      Nothing on its own. If door six is closed in the hook, cover this in the same edit — an
      Error among args[2..] with no placeholder to consume it should become errorLogFields on the
      record rather than being dropped.
```

---

## 7. Per-finding verdicts on the round's own work

- **F-251 — ADDRESSED.** Verified by execution on the shipped module, including grandchildren,
  a child created with an options argument, and the depth-1 `err` seam on the bindings path. The
  mechanism note (`formatters.bindings` cannot reach child bindings on pino 10.3.1) is correct and
  is now in the contract, which is what stops the plausible "simplification" from reopening it.
- **F-252 — ADDRESSED, and the widening was the right call.** Keying the hook on the presence of
  the error key rather than `value instanceof Error` is what makes it cover a decorated plain
  object, which is what `catch (err)` actually binds. Narrowing it to `instanceof` would have been
  the enumeration-shaped fix F-244 rejected. It does not reach the format path (finding 1), which
  is a different door rather than an incomplete fix of this one.
- **F-258 — ADDRESSED.** Both entries to `asChindings` covered, one shared `bindingsScanned`, and
  the depth-1 seam verified on the `setBindings` path specifically rather than inferred from
  `child`. Taking it off the residual list is justified.
- **F-255 — ADDRESSED as documentation**, with one gap: the `toJSON` mechanism is outside it
  (finding 6).
- **F-244 — still ADDRESSED under the keys it named**, and re-opened under two paths it did not
  (findings 1 and 2).
- **F-253 — the residual ruling is correct**, and stronger than argued: neither named call site can
  build a hostile record. §5.
- **F-259 — still open and still accurate.** `readIndexedProperty`'s docblock at `logger.ts:409-413`
  still claims the scan must not throw out of the log call while `logger.ts:398`'s spread
  re-invokes the getter outside the guard. Not re-filed.

---

## 8. Dependencies reviewed

No dependency was added or bumped in this diff. Reviewed because the code now depends on
internals:

| package | version | how pinned | exposure |
|---|---|---|---|
| `pino` | 10.3.1 | exact in `apps/api/package.json`, `pnpm-lock.yaml`, `--frozen-lockfile` in CI | four load-bearing internals: `_asJson` running `formatters.log` before `serializers[key]` (`tools.js:160-169`); `asChindings` applying the bindings formatter at `:247` before `serializers[key]` at `:258`; `child()` swapping in `resetChildingsFormatter` (`proto.js:98-104`); `child()` returning `Object.create(this)`. The suite pins the consequences of the first two. The third is documented and would fail loudly. The fourth is pinned by nothing — finding 5. |
| `@pinojs/redact` | 0.4.0 (transitive) | `pnpm-lock.yaml:4141` | one-level wildcard semantics, and `cloneSelectively`'s behaviour on a throwing getter (F-253's third throw site). A minor bump changing wildcard depth would widen or narrow every path silently; no test asserts that `*.x` matches exactly one level. |
| `pino-std-serializers` | 7.x (transitive) | lockfile | `mapHttpRequest`'s field set — finding 2. A bump that adds a field to the request serialiser adds it to the log line with no code change here. |
| `quick-format-unescaped` | 4.x (transitive) | lockfile | the `%o`/`%j`/`%s` expansion in finding 1. |

Everything is exact-pinned and `.github/dependabot.yml` is the only thing that raises a version;
the weekly `dependencies` workflow audits the whole tree. The residual risk is not an unpinned
version, it is that minor and patch bumps are **grouped into one pull request**, so a pino minor
that moves any of the four internals arrives among unrelated bumps with a green suite. No CVE
applies to any version in the tree here; I did not run a fresh advisory query, since the weekly
job owns that and the orchestrator's gates are the record.

---

## 9. What I could not do, stated rather than implied

- **I did not run the test suite, typecheck, lint or build.** The dispatch said not to; the
  orchestrator's run is the record. Every measurement above is my own probe against the shipped
  module.
- **I did not run body-parser itself.** Like everyone in this chain, I built the error by hand
  with `Object.assign(new SyntaxError(...), { body, status, statusCode, type })`. The claim that
  body-parser 2.3.0 assigns the verbatim body to `err.body` is still unverified end-to-end by
  anybody, and it is the premise the whole chain rests on. An integration test that POSTs
  malformed JSON and asserts the emitted bytes would close it; that is the one thing nobody has
  done.
- **I could not test a pino version other than 10.3.1**, so finding 5's failure mode is reasoned
  from pino's source and from the measured absence of own properties on a child, not observed.
- **I did not review the `helmet`/HSTS half of the contract** (invariant 4, F-243 clause 2). It is
  outside this diff and still unowned; the marking is present and nothing has changed.
- **I set no `owner_slot` on any finding.** Routing is the orchestrator's.
