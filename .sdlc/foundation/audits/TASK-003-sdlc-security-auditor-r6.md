# TASK-003 — sdlc-security-auditor, final whole-TASK audit, round 6

Scope: FRESH whole-TASK audit, not `raised-only`. Package
`.sdlc/foundation/work/TASK-003-review-final.diff` (`af4e5bb..HEAD`, 26 files, `':!.sdlc'`),
read in full and cross-checked against `git diff --stat af4e5bb..HEAD -- ':!.sdlc'` — the
26 files match, nothing is missing this time, and `eslint.config.mjs` (F-268's rule) is
present at hunk 24.

HEAD = `917c601`. Node v24.19.0, pino 10.3.1, @nestjs/core 11.1.28, helmet 8.3.0, on this
repository's own `node_modules`. **Every runtime claim below is measured against the shipped
singleton or against real HTTP response bytes from `node dist/main.js` on loopback.** No
claim is reasoned from a docblock, an ADR, or a previous report.

---

## Verdict

**changes-requested. TASK-003 is NOT safe to mark `done`.**

One blocker. The allowlist inversion is real and it works — on the two paths ADR-0028 named.
`REDACT_PATHS` is gone, `LOGGABLE_FIELDS` is enforced at `formatters.log` and at both
bindings wrappers, and F-261, F-262 and F-266 are measurably closed on the record path, on the
bindings path, in a child and in a grandchild. F-243 clause 2 is discharged: helmet is
registered and invariant 4 holds on real response bytes including the branded 404.

**But the inversion is not complete. It moved the hole to the one argument position nothing
scans: the message.** `interpolationCovered` covers every format *parameter* and the message
argument only when it `instanceof Error`. A non-`Error` object in the message position reaches
`msg` **verbatim** — a whole request with its `authorization` header, its `cookie` and its
`remoteAddress`; a caught non-`Error` throwable with a library-assigned `body`. Measured, six
shapes. This is F-261's payload class returning through a door ADR-0028 did not consider, and
it is **a regression**: the deleted `redact` list's wildcard stringifier used to censor
`password`, `token`, `secret`, `ip` and `ipHash` inside `msg`, and now nothing does. Measured
on both singletons side by side.

What blocks `done`: finding 1. It is a hole in the mechanism this TASK exists to ship, and
`logging-and-headers.md` invariant 1 — which every later TASK is told it may rely on — is
measurably false as written.

Findings 2–7 are minor and nit; several are documentation claims that measure false rather
than leaks. They do not block on their own.

---

## Findings

```yaml
verdict: changes-requested
findings:
  - severity: blocker
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 239
    summary: >-
      Door seven. A non-Error value in pino's MESSAGE argument position reaches `msg`
      verbatim, past `formatters.log`, `serializers.err`, both bindings wrappers and
      `LOGGABLE_FIELDS`. `interpolationCovered` reduces the message argument only when it
      `instanceof Error`, and its loop starts one index past it.
    failure_scenario: >-
      An unauthenticated client sends a request. Any later TASK writes
      `logger.error({ request_id }, e)` — the shape `logger.ts:199` itself names as covered —
      where `e` is a NON-Error throwable, which is what `catch (e)` binds and what
      `serializers.err` and `messageWouldBeTakenFromTheError` already exist to handle. The
      whole object goes into `msg`. Measured: the line carries
      `"msg":{"message":"boom","body":"{...password: SEKRIT-MARKER-E1...}"}` — F-244's exact
      payload class. `logger.error({ request_id }, req)` is worse: the line carries the
      concrete url with its query token, `headers.authorization`, `headers.cookie` and
      `socket.remoteAddress`, all verbatim — a credential, a cookie and a raw client IP on one
      line, which is GC-9's first three prohibitions and contract invariant 1 verbatim.
    required_change: >-
      Cover the message argument for every value, not only for `Error`. `errorMovedOntoTheRecord`
      is the right shape for an `Error`; a non-Error container needs the same treatment
      (`valueCensored` at the format depth, or moved onto the record under a censored key) so
      that no unscanned object reaches `format()`. Then correct invariant 1, which currently
      promises coverage this module does not have, and add the message-position shapes to
      `logger-field-allowlist.spec.ts` — it emits eleven shapes and not one of them puts a
      value in the message position.

  - severity: minor
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 649
    summary: >-
      A plain object carrying an OWN NON-ENUMERABLE `toJSON` is emitted whole. F-265 did not
      close as a class. `fieldsCensored` returns the container by reference when nothing in it
      changed, and pino's stringifier then honours the `toJSON` the scan could not see.
    failure_scenario: >-
      A container whose own enumerable keys are all named (or all absent) triggers no copy, so
      the caller's object reaches `stringify` intact. Measured under a named key at depth 2,
      at depth 3, in child bindings, and — with NO named key needed at all — through a format
      argument: `logger.error('fmt %o', obj)` puts the whole `toJSON` return value into `msg`.
      An INHERITED `toJSON` is safe (the prototype check censors it) and an ENUMERABLE own
      `toJSON` is safe (it is an unnamed key, so it triggers the copy). Only the own
      non-enumerable form leaks. Downgraded to minor because the attacker must supply an object
      with a hidden `toJSON` and no library in this tree does.
    required_change: >-
      Either copy unconditionally in `fieldsCensored`/`elementsCensored`, or test for a
      function-valued `toJSON` in `valueCensored` and censor. Whichever is chosen, correct the
      two documents that assert this closed: `logging-and-headers.md` "The residuals closed"
      and ADR-0028's Consequences table both cite the `toJSON` shape as now `[redacted]` —
      true only because that shape's key is unnamed, not because the mechanism reaches
      `toJSON`.

  - severity: minor
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 438
    summary: >-
      `childOptionsChecked` does not refuse a `redact` supplied on the OPTIONS PROTOTYPE, and
      pino installs it. The round-5 prediction that deleting `redact` from the root would make
      `Object.hasOwn` "exactly right" is refuted: pino reads `options.redact` prototypically at
      `proto.js:161` regardless of what the root holds.
    failure_scenario: >-
      A child built with an options object whose `redact` lives on its prototype is accepted,
      and pino installs the redact. Measured with `{ paths: ['request_id'], remove: true }`:
      the child's line carries neither the binding's `request_id` nor the record's, so contract
      invariant 8 ("the key stays on the line") is false for that subtree and a censoring
      policy the module documents as refused is in force. Not a leak — `redact` only censors or
      removes, and the root no longer holds one to displace. The second half IS a leak but
      needs a call site that lies: an options object with an own `hasOwnProperty` returning
      true for `formatters`, with the formatters on its prototype, disables the scan entirely
      (measured: an unnamed `password` and a raw `ip` both verbatim), and the `serializers`
      variant brings F-244 back under `err`. That is the same class as the already-disclosed
      unwrapped-prototype residual.
    required_change: >-
      Test the three options the way pino reads each of them: an own-property check for
      `serializers` and `formatters`, and a plain property read for `redact`. Then correct
      r5's Note 1 in the record — it predicted self-resolution and the prediction did not hold
      — and add the spoofed-`hasOwnProperty` shape to the contract's list of what the
      descriptors do and do not buy.

  - severity: minor
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 636
    summary: >-
      ADR-0028 rule 5 ("`undefined` is left alone") is a hole for a stateful getter. The key is
      skipped, no copy is triggered, the record is returned by reference, and pino re-reads
      every key in `_asJson` (`tools.js:167`).
    failure_scenario: >-
      A record property whose getter answers `undefined` on the first read and a credential on
      the second puts it on the line under an unnamed key. Measured. The benign-then-secret
      variant is safe because censoring triggers the copy, and the throw-then-secret variant is
      safe for the same reason — so `undefined` is the only value that leaves the key
      unguarded. Minor: no library in this tree hands the logger a stateful getter, and the
      attacker must control an object's property descriptors.
    required_change: >-
      Either censor an `undefined` under an unnamed key and accept the added key, or state the
      double-read as a bounded residual next to rule 5 rather than leaving rule 5 reading as
      unconditional. Do not leave it undocumented: rule 4 was rewritten for exactly this
      second-read hazard and rule 5 reintroduces it.

  - severity: minor
    kind: behavior
    file: apps/api/src/main.ts
    line: 259
    summary: >-
      helmet's default `Content-Security-Policy` carries `frame-ancestors 'self'`, which every
      CSP-aware browser honours IN PREFERENCE TO `X-Frame-Options`. The contract's table says
      `DENY` and `frameguard: { action: 'deny' }` sends it, but the effective policy a browser
      enforces is `'self'`.
    failure_scenario: >-
      Measured on `GET /health` and on the branded 404, both responses carry
      `X-Frame-Options: DENY` AND a CSP containing `frame-ancestors 'self'`. CSP Level 2
      requires a user agent that supports `frame-ancestors` to ignore `X-Frame-Options`, so the
      one option the implementer deliberately overrode is the one the browser discards.
      Same-origin framing of a JSON API is close to harmless today; it stops being harmless
      when the branded 404 renders tenant-controlled markup (F-006) on the same origin.
    required_change: >-
      Set the CSP `frame-ancestors` directive to `'none'` so the two headers agree, or record
      in the contract's table that `frame-ancestors 'self'` is the operative framing policy and
      `X-Frame-Options: DENY` is the legacy fallback. Right now the table states an intent the
      deployed bytes do not deliver.

  - severity: nit
    kind: behavior
    file: apps/api/src/main.ts
    line: 236
    summary: >-
      `NestFactory.create(AppModule)` leaves Nest's own logger enabled, so the shipped process
      writes unstructured, ANSI-coloured, uncensored lines to stdout beside pino's JSON. The
      contract says "Nothing may opt out" and GC-9 says structured logs via pino.
    failure_scenario: >-
      Measured on a real boot: five `[Nest] ... LOG [RoutesResolver] ...` lines with escape
      codes, none of them JSON, none carrying `service`, `env` or a pino timestamp, none
      through `LOGGABLE_FIELDS`. Today they are boot-time only and carry route names.
      `no-console` cannot reach them — the writes are inside `@nestjs/core` — and F-268's lint
      rule is scoped to `apps/api/src/**`, so nothing in the build sees this second surface.
      Filed as a nit because nothing request-derived reaches those lines today; the reason to
      close it is that the next Nest component to log an exception through them (a pipe, a
      guard, an interceptor mounted by a later TASK) writes past every mechanism in this
      module.
    required_change: >-
      `NestFactory.create(AppModule, { logger: false })`, or a `LoggerService` adapter over the
      shared pino singleton. Then say so in "One mechanism between an unnamed field and the
      line", which currently lists a second pino instance as the hole and does not mention the
      non-pino one that is already running.

  - severity: nit
    kind: behavior
    file: .sdlc/foundation/design/contracts/logging-and-headers.md
    line: 1005
    summary: >-
      Invariant 4 says "every API response including errors". Node's HTTP parser answers before
      Express and therefore before helmet, and those responses carry none of the five headers.
    failure_scenario: >-
      Measured against `node dist/main.js`: a header with a raw control byte answers
      `400 Bad Request` plus `Connection: close` and nothing else; a 20 KB header answers
      `431 Request Header Fields Too Large` plus `Connection: close` and nothing else. No
      HSTS, no `nosniff`, no `X-Frame-Options`. These responses have no body and no content
      type, so four of the five headers would buy nothing; HSTS is the only one with any value
      and no Express middleware can reach these responses at all.
    required_change: >-
      Narrow invariant 4 to "every response Express writes" and name the parser-level 400/431
      as the stated exception, so the next auditor measures the same thing the invariant
      claims.
```

---

## Measured evidence

All bytes below are emitted by the **shipped singleton** at
`apps/api/src/observability/logger.ts` (md5 `88cf0c238633777e375ec5d75cfeed1f`, unmodified),
imported into a Node process, stdout captured. Markers are `SEKRIT-MARKER-*`.

### 1. Attacking the allowlist — what an unnamed key does under every call shape

| # | shape | emitted | verdict |
|---|---|---|---|
| A1 | `logger.error({request_id}, {password})` | `"msg":{"password":"SEKRIT-MARKER-A1"}` | **LEAK** |
| A2 | `logger.error(undefined, {password})` | `"msg":{"password":"SEKRIT-MARKER-A2"}` | **LEAK** |
| A3 | `logger.error(null, {password})` | `"msg":{"password":"SEKRIT-MARKER-A3"}` | **LEAK** |
| A4 | `logger.error({request_id}, {password}, 'tail')` | `"msg":"{\"password\":\"SEKRIT-MARKER-A4\"} "` | **LEAK** |
| A5 | class instance in the message position | `"msg":{"password":"SEKRIT-MARKER-A5"}` | **LEAK** |
| A6 | array in the message position | `"msg":[{"password":"SEKRIT-MARKER-A6"}]` | **LEAK** |
| E1 | `catch (e)` non-Error, `logger.error({request_id}, e)` | `"msg":{"message":"boom","body":"{...SEKRIT-MARKER-E1...}"}` | **LEAK** |
| E2 | same shape, real `Error` | `"err":{"err_name":"SyntaxError","err_stack":"    at ..."}` + fixed `msg` | covered |
| E3 | whole request in the message position | `url` with its query token, `headers.authorization`, `headers.cookie`, `socket.remoteAddress`, all verbatim | **LEAK** |
| E4 | whole request in the RECORD position | `"req":"[redacted]"` | covered |
| B1 | Symbol key on the record | absent from the line | covered |
| B2 | prototype-chain enumerable key | absent from the line | covered |
| B3 | getter `undefined` then secret, unnamed key | `"evil":"SEKRIT-MARKER-B3"` | **LEAK** (finding 4) |
| B4 | getter benign then secret, unnamed key | `"evil":"[redacted]"` | covered |
| B5 | own non-enumerable `toJSON` under a named key | `"route":{"password":"SEKRIT-MARKER-B5"}` | **LEAK** (finding 2) |
| B6 | enumerable `toJSON` under a named key | `"route":{"toJSON":"[redacted]"}` | covered |
| B7 | `toJSON` on the whole record | `"request_id":"r-b7"`, nothing else | covered |
| B8 | named chain `route.route.route.route` | `{"route":{"route":{"route":"[redacted]"}}}` | covered (`MAX_SCAN_DEPTH`) |
| B9 | array under a named key | `"route":["a",{"password":"[redacted]"}]` | covered |
| B10 | unnamed key whose value IS the censor string | `"evil":"[redacted]"` | covered |
| C1/C3 | `%o` / `%j` with an unnamed key | `"msg":"fmt {\"password\":\"[redacted]\"}"` | covered |
| C2 | `%s` with a raw string | verbatim | inherent, documented (free text) |
| C4 | `%o` with `{err: e}` | `err_name` + frames only | covered |
| C5 | `%o` with a 4-deep container | `"msg":"fmt {\"a\":\"[redacted]\"}"` | covered |
| D1 | `logger.child({request_id, password})` | `"password":"[redacted]"` | covered |
| D2 | grandchild bindings | `"password":"[redacted]"` | covered |
| D5 | `child(b, { formatters: ... })`, own property | `TypeError`, refused | covered |
| E7 | `child.setBindings({password})` | `"password":"[redacted]"` | covered |
| E8 | `Object.create(null)` record | `"password":"[redacted]"` | covered |
| E9 | Proxy hiding a key from `ownKeys` | absent | covered |
| E10 | `msg` supplied as an object on the record | `"msg":{"password":"[redacted]"}` | covered |
| F1 | throwing getter alone | log call throws, no line | documented (F-253) |
| F2 | getter throws once then returns a secret | `"evil":"[redacted]"` | covered (rule 4 works) |
| F3 | INHERITED `toJSON` under a named key | `"route":"[redacted]"` | covered |
| F5 | own non-enumerable `toJSON` as a FORMAT ARGUMENT | `"msg":"fmt {\"password\":\"SEKRIT-MARKER-F5\"}"` | **LEAK** (finding 2) |
| F7 | `BigInt` under a named key | `"status":1`, no throw | fine |
| F8 | circular under a named key | `"route":{"request_id":"ok","self":"[redacted]"}` | covered |
| G1 | hostile `x-request-id`, 128 chars, quote + newline + escape byte | one line, valid JSON, every control byte escaped | no log forging |

**The inversion is complete on the record path and on the bindings path, and it is not complete
on the argument list.** Every door round 4 and round 5 opened is shut. The one that is open is
the one nobody has attacked, because F-260's fix was measured on `%o`, `%j`, `%s` and an
`Error` in the message position, and stopped there.

### 2. The regression `redact`'s removal caused

Same call, two singletons, same process shape. `git show 45cf578^:apps/api/src/observability/logger.ts`
is the one that shipped before ADR-0028.

| call | before ADR-0028 | shipped |
|---|---|---|
| `logger.error({request_id}, {password:'X'})` | `"msg":{"password":"[redacted]"}` | `"msg":{"password":"SEKRIT-MARKER-A1"}` |
| `logger.error({request_id}, {clientIp, apiKey})` | both verbatim | both verbatim |
| `logger.error({request_id}, req)` | headers, IP, url verbatim | headers, IP, url verbatim |

The 25-path list built a **wildcard stringifier** (`*.password`, `*.token`, `*.secret`,
`*.ipHash`, `*.rawToken`, `*.tokenDigest`, `*.verificationToken`), and pino applies the
wildcard stringifier to the `msg` value too (`tools.js:205`,
`stringifiers[messageKey] || wildcardStringifier`). So for the seven names the denylist
happened to cover, `msg` was censored by accident and is now not. This is the ADR's own
accepted cost — "after this change there is exactly one mechanism between an unnamed field and
the line" — landing on a path the ADR did not enumerate.

### 3. The single-mechanism concern, and the `Object.hasOwn` question re-examined

**The bypass did not self-resolve. It changed shape.** pino 10.3.1 `proto.js`:

- `:115` `options.hasOwnProperty('serializers')` — an own check, which `Object.hasOwn` matches.
- `:136` `options.hasOwnProperty('formatters')` — same.
- `:161` `typeof options.redact === 'object' && options.redact !== null` — an **ordinary
  property read**, which walks the prototype chain. Deleting the root's `redact` did nothing to
  this line.

Measured: a child built with `redact` on its options prototype is accepted by
`childOptionsChecked` and the redact is installed — with `remove: true` on `request_id`, the
child's line carries no `request_id` at all, from the binding or from the record. No leak,
because `redact` only censors. But the contract's mechanism table lists `childOptionsChecked`
as covering "a child that tries to replace `redact`, `serializers` or `formatters`" and it
covers two of the three.

The converse also measures: because pino calls `options.hasOwnProperty(...)` as a **method on
the options object**, an options object that lies about it takes pino's replacing branch while
`Object.hasOwn` correctly says no. Measured, scan fully disabled — an unnamed `password` and a
raw `ip` both verbatim on the child's line. The `serializers` variant restores F-244 under
`err`. Both need a call site that means it, so they sit with the disclosed
unwrapped-prototype residual rather than above it — but that residual is disclosed and this
one is not.

**`childOptionsChecked` is load-bearing and it is one predicate away from being right.** It is
worth the ten minutes.

### 4. The two accepted deviations, judged independently

**Deviation 1, the `Array.isArray` ternary in `fieldsCensored`'s copy.** No security
consequence found. An array passed as the whole record has its indices decided by the key rule
(`'0'` is not in `LOGGABLE_FIELDS`), the `Error` branch runs first and keeps invariant 5's
`[e, e]` working, and both copy forms write the same own enumerable keys. One behaviour
difference neither document names: an array carrying an extra own string property loses it in
the array-spread copy, because array spread copies indices only. That drops a field rather than
adding one, so it is safe by this module's own polarity. **I did not re-measure the ADR's "both
forms emit identical bytes" claim** — nothing in my findings turns on it.

**Deviation 2, `interpolationSafe` becoming `valueCensored(value, 1)`.** The reasoning is right
and the constant is right. A format argument has no key, so the key rule genuinely cannot apply;
routing it through the value half is the only coherent answer; and the `+ 1` inside
`valueCensored` really is what keeps `logger.error('ctx %o', { err: e })` shut — measured, the
interpolated `err` comes out as `err_name` plus frames, so the top-level exemption does not fire
at depth 2.

**But the deviation is about format PARAMETERS, and door six's other half is the MESSAGE
argument.** `interpolationCovered` treats those two roles differently on purpose — the docblock
at `logger.ts:212` says so — and the message role is handled by exactly one ternary that tests
`instanceof Error` (`:239`). Every non-`Error` value in that position walks past both the loop
(which starts at `message + 1`) and the ternary. That is finding 1, and the architect's
acceptance of deviation 2 did not touch it, because deviation 2 is about the loop and the gap is
in the line above it.

### 5. helmet, and F-243 clause 2

**Confirmed. F-243 clause 2 is discharged.** Registered at `main.ts:259`, on the app, after
`NestFactory.create` and before `setGlobalPrefix`, exactly as the contract states. Measured
against `node dist/main.js` on loopback, all five headers on every Express-written response —
`GET /health` 200, `GET /api/no-such-route` branded 404, `GET /` 404, `GET /api/%` 404, and the
malformed-JSON POST that takes the framework-400 arm:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains     (no preload — correct)
X-Content-Type-Options:    nosniff
X-Frame-Options:           DENY
Referrer-Policy:           no-referrer
Content-Security-Policy:   default-src 'self';base-uri 'self';...;frame-ancestors 'self';...
X-Powered-By:              absent
```

Invariant 4 holds on the routed 200, on the exception filter's branded 404 (which is the half
module-level middleware misses, and putting helmet on the app is what covers it), and on the
framework-400 arm. Two carve-outs are findings 5 and 7: CSP's `frame-ancestors 'self'` outranks
the `DENY`, and Node's parser-level 400/431 carry nothing.

CORS: measured absent. `OPTIONS` and `GET` with `Origin: https://evil.example` return no
`Access-Control-Allow-Origin`. Invariant 3 holds.

The framework-400 arm end to end, from a real socket, with a real `Authorization` header and a
credential in a malformed body: the emitted line carries `err_name`, frames, `request_id` and
nothing else. `grep -c LEAKME` over the captured process output = **0**. F-108 and F-244 are
closed on the live path.

---

## Notes

**What is genuinely closed, measured rather than taken from the log.** F-261, F-262 and F-266
are closed on the record path and the bindings path. `logger.info(req, '...')` emits
`"req":"[redacted]"`. The six spellings in the allowlist spec's shape 0 — `principalKey`,
`subjectIp`, `bearer`, `authToken`, `x_api_key`, `attemptCount` — are all censored, which is
the class test ADR-0028 set itself and it passes. `ipHash` and `ip_hash` are both censored, so
the casing residual is gone. The depth bound inverted correctly: past 4 a container is
`[redacted]`, not passed through. The two wrappers hold on a child, a grandchild and
`setBindings`. F-268's lint rule exists and fires — probe-verified with a temporary file that
imported `pino` and called `console.log`, both flagged, file deleted, tree confirmed clean.

**`LOGGABLE_FIELDS`, read as an attacker would.** Thirteen names, and none of them is on the
never-allowlist. The two that carry the most risk are `msg` (free text by construction, and
finding 1 is about the one shape that puts a caller's object into it) and `route`, which the
contract says must be the PATTERN and which will hold a concrete path the first time a
request-log middleware gets it wrong — measured, a `route` holding a concrete path with a query
token is emitted verbatim, correctly, because the mechanism cannot know a pattern from a path.
That is policy, and step 3 of "What a TASK does to log a new field" is what has to catch it.
`request_id` is caller-controlled through `x-request-id` (trimmed, capped at 128 at
`exception-filter.ts:340`) — measured non-injectable: one JSON line, quote, newline and escape
byte all escaped.

**`tenancy/tenant-context.ts:247` is still the one live instance** of an error message
interpolated into `msg`. Filed as F-274, disclosed in the contract as "reported and not fixed",
outside TASK-003's paths. Not re-raised. It is now the *second* uncensored surface, next to
finding 1.

**Outside this TASK, flagged not filed: `better-auth@1.6.26` is a runtime dependency of
`apps/api` with no importer.** `grep -rn better-auth apps packages --include=*.ts` returns only
`test/support/auth-fixture.ts` docblocks. It was pinned by TASK-009 (`2a150e8`), TASK-009 was
deferred by the 2026-08-09 re-scope, its integration spec was deleted, and the dependency
stayed. It ships in the Fly image (`Dockerfile:63`,
`pnpm install --frozen-lockfile --prod --filter @shortkit/api...`) and it is the sole reason
GHSA-67mh-4wv8-2f99 is in `apps/api`'s production graph — `docs/security/known-advisories.md:35`
says exactly that. Removing it would take an unused auth library out of the runtime image and
retire an accepted-advisory row. Not TASK-003's to do.

**The deleted `apps/api/test/auth/credential-auth.int-spec.ts` is not a coverage regression.**
It was TASK-009's red step for deferred EPIC-002; `apps/api/src/auth` does not exist and nothing
in `src` imports `better-auth`, so the test covered no shipped code. Removed by the re-scope
commit `6189c5b`, with recovery documented on the card.

**Deploy surface.** Re-read rather than assumed: `Dockerfile`, `.dockerignore`, `fly.toml`,
`infra/deploy.sh`, `docs/security/ci-secrets.md`. No secret literal, no `eval`, no piped
download. `--build-arg` carries `GIT_COMMIT_SHA` only, which AC-6 publishes unauthenticated
anyway. `.dockerignore` excludes `.env*`, `*.pem`, `*.key`, `.git` and `.sdlc`. `.env.local` is
gitignored and untracked, confirmed with `git check-ignore`. The only diffs in
`ci-secrets.md` and `provision-test-database.sql` are `launch-core` to `foundation` path
renames. `test/support/response-object-probe.controller.ts` is test-only and is not in the
built bundle (`grep -c ROSECRET apps/api/dist/main.js` = 0).

**Suite state, as I measured it.** `apps/api` observability: 4 files, 54 tests, all green —
`logger.spec.ts` 28, `logger-field-allowlist.spec.ts` 11, `logger-contract-drift.spec.ts` 6,
`framework-400-request-body.spec.ts` 9. The drift test passing means the contract's fence and
the shipped file agree; I read both and they do. The allowlist spec is a good suite — eleven
shapes, each one a finding's reproduction — and its blind spot is precisely finding 1: every
shape puts its payload in the RECORD, none in the message position.

**Read-only compliance.** No source file was modified. One temporary file
(`apps/api/src/__audit_probe.ts`) was created to prove F-268's lint rule fires, and deleted;
`git status --short` was empty afterwards and `apps/api/src/observability/logger.ts` is md5
`88cf0c238633777e375ec5d75cfeed1f`, byte-identical to HEAD. Probe scripts and the extracted
pre-ADR-0028 logger live in the scratchpad, outside the repository. `apps/api/dist/` was rebuilt
to boot the real server; it is gitignored and was already a build artifact. The API server I
started on ports 53991 and 53992 was stopped; Postgres was left running, as instructed. I did
not touch `findings.yaml` and I set no owner.

**What I could not verify.**

- **The deployed image.** Every header measurement is against `node dist/main.js` on loopback,
  not against the Fly image. HSTS is only meaningful over TLS and loopback is not TLS, so what I
  proved is that the header is emitted, not that a browser will act on it. No Docker build was
  run and no Fly credentials were used.
- **The `headersSent` arm of the exception filter.** It needs a response that has already
  started streaming, which only the redirect surface produces, and no redirect route exists. Its
  log call is read and reasoned about, not measured.
- **The ADR's claim that both `fieldsCensored` copy forms emit identical bytes** (deviation 1).
  Not re-measured; no finding depends on it.
- **The performance table.** The ADR's re-measured figures are `sdlc-implementer-backend`'s and
  I did not re-run them. Against GC-1 I checked the shape of the argument rather than the
  numbers: the redirect cache-hit path imports nothing from this module and writes no line
  today, so the scan is not on the 25 ms path at all yet. If finding 1's fix adds work, it adds
  it to one argument of a log call, the same order as what `interpolationCovered` already does
  per argument.
- **Whether any shipped call site reaches finding 1 today. It does not.** I swept
  `apps/api/src` and found six log call sites — `main.ts:199`, `main.ts:293`,
  `exception-filter.ts:181`, `:195`, `:288` (through `logError`), plus `db/client.ts:93` and
  `tenancy/tenant-context.ts:247` — and every one is `(record, string)` or `(string)`. The
  finding is against the mechanism and against invariant 1's promise, not against a live call
  site. Stated plainly so it is not read as wider than it is.

## Dependencies reviewed

One dependency added in this package.

| package | version | assessment |
|---|---|---|
| `helmet` | `8.3.0` | **Clean.** Exact-pinned in `apps/api/package.json` per ADR-0018, no caret. `pnpm-lock.yaml` carries the importer entry (`:50`), the resolution with integrity `sha512-Qgpiaws3Sm30Av8Eah6sjMCZZwjlBu+E68rhpCWBshY1lb09HtLwj5GviX0OyQIn+ulUS0iX0AxN5n3tLZzz1w==` (`:2376`) and the dependency block `helmet@8.3.0: {}` (`:5145`) — **zero transitive dependencies**, which is the whole reason this is a low-risk add. MIT, `engines: >=18.0.0`, maintained by the helmetjs org, current major, no advisory in `pnpm audit --prod`. Behaviour verified against real bytes rather than docs: `frameguard: { action: 'deny' }` is the only override and it lands, HSTS carries no `preload` as the contract requires, and `X-Powered-By` is removed. |

`pino@10.3.1` also appears as an addition in this package's `package.json` diff — it is the same
pin r5 reviewed, unchanged, and its transitives are unchanged. `@pinojs/redact@0.4.0` remains in
the lockfile because **pino depends on it directly**, not because this module uses the `redact`
option; `redact` is gone from the singleton and the drift test pins that.

`pnpm audit --prod --audit-level moderate`: **1 moderate**, GHSA-67mh-4wv8-2f99
(`esbuild <= 0.24.2`) via
`apps__api > better-auth > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils`.
Accepted and argued in `docs/security/known-advisories.md:35`; the argument still holds — no
listening socket, `drizzle-kit` is a CLI-only optional peer, and the image's `--prod` install
does not pull it. See the `better-auth` note above for why this row could be retired outright.

No dependency was bumped and no lockfile entry was removed.
