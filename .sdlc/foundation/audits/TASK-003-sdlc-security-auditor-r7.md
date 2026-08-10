# TASK-003 — sdlc-security-auditor, round 7, `reaudit: raised-only`

Scope: the four findings raised for verdict (F-277, F-279, F-280, F-265) plus F-281, against the
r5 fix delta `.sdlc/foundation/work/TASK-003-review-r7.diff` (`917c601..HEAD`, 5 files, `':!.sdlc'`).
The diff was read in full and cross-checked against `git diff --name-only 917c601..HEAD -- ':!.sdlc'`
— the 5 files match, nothing is missing.

HEAD = `87119a5`. Node v24.19.0, pino 10.3.1, pino-std-serializers 7.1.0, @nestjs/core 11.1.28,
helmet 8.3.0, on this repository's own `node_modules`. `apps/api/src/observability/logger.ts`
md5 `cb23a71dcfa2837a3c867a54cd3a82a5`, `apps/api/src/main.ts` md5 `9eab831c8dfbeff3920951ab7714b7ec`,
`eslint.config.mjs` md5 `0ea17dc0ccb65e775f82490ed491a386` — all unmodified, `git status --short`
empty at start and at end.

**Every verdict below is measured against the shipped singleton or against real HTTP response
bytes from `node dist/main.js` on loopback.** Nothing is reasoned from a docblock, an ADR or a
previous report. Where a claim is inference rather than emission it says so.

---

## Verdict table

| finding | severity as filed | verdict | evidence |
|---|---|---|---|
| **F-277** door seven, message position | blocker | **RESOLVED** | 9/9 shapes emit `err_name` only; 420-shape argument-list sweep leaks no container; regression comparison strictly stronger than the deleted denylist on all 8 wildcards and on 2 shapes the denylist missed |
| **F-279** `childOptionsChecked` predicates | minor | **RESOLVED** | both measured directions now refused; the accept-set re-measured and confirmed inert against pino 10.3.1 |
| **F-280** CSP `frame-ancestors` | minor | **RESOLVED** | `frame-ancestors 'none'` on real bytes on the routed 200, the branded 404, the unrouted `/` 404 and the framework-400 arm; other ten directives intact |
| **F-265** the `toJSON` class | minor | **SURVIVES, narrowed** | message position closed (2 routes); 9 of 13 measured routes still emit `toJSON`'s return value verbatim. The contract still asserts this class closed |
| **F-281** `mapHttpRequest` pre-emption | raised for confirmation | **CONFIRMED — no leak** | `"req":"[redacted]"` / `"res":"[redacted]"` on every sniffed shape; the censoring is ours, not the replacement's, and it does not depend on the replacement |

```yaml
verdict: clear
findings: []
```

**No NEW blocker or major finding.** The one blocker this round existed to close is measurably
closed, and it is closed in the strong direction: the message position is now stricter than it
was at any point in this module's history, including before ADR-0028.

**TASK-003 is safe to mark `done` on security grounds.** AC-6's deployed clause is blocked on
infrastructure and is not mine to call. What survives is F-265, minor, already disclosed in
ADR-0028's residual list, with an attacker who must hand this logger an object carrying a hidden
`toJSON` — and no library in this tree does. It does not block. Its documentation half does need
an edit and is named in §4.

---

## 1. F-277 — RESOLVED

### 1.1 The nine shapes, re-run

Emitted from the shipped singleton, `NODE_ENV=test`, `LOG_LEVEL=info`, stdout captured. Markers
are `SEKRIT-*`; `grep -o 'SEKRIT-[A-Z0-9-]*'` over the whole capture returns **zero hits**.

| # | call | emitted | r6 | r7 |
|---|---|---|---|---|
| A1 | `error({request_id}, {password})` | `"request_id":"r-probe","err":{"err_name":"non-error throwable (object)"},"msg":"an error was logged with no context string"` | LEAK | covered |
| A2 | `error(undefined, {password})` | the same, no `request_id` | LEAK | covered |
| A3 | `error(null, {password})` | the same, no `request_id` | LEAK | covered |
| A4 | `error({request_id}, {password}, 'tail')` | the same | LEAK | covered |
| A5 | class instance in the message position | the same | LEAK | covered |
| A6 | array in the message position | the same | LEAK | covered |
| E1 | `catch (e)` non-`Error` with a library-assigned `body` | the same | LEAK | covered |
| E3 | whole request in the message position (`url` with query token, `headers.authorization`, `headers.cookie`, `socket.remoteAddress`, `body`) | the same | LEAK | covered |
| G | the eight `REDACT_PATHS` wildcards in one container | the same | LEAK | covered |

`err_name: 'non-error throwable (object)'` is a constant. Not one key name, not one value, not
the container's type beyond `object` reaches the line.

### 1.2 Not bought by logging nothing

| call | emitted |
|---|---|
| `error({request_id}, null)` | `"request_id":"r-probe","msg":null` — unchanged |
| `error({request_id}, 42)` | `"request_id":"r-probe","msg":42` — unchanged |
| `error({request_id}, 'a plain string message')` | `"msg":"a plain string message"` — unchanged |
| `error({request_id}, function)` | `"request_id":"r-probe"`, no `msg` key — unchanged |
| `error({request_id}, new SyntaxError(…))` | `"err":{"err_name":"SyntaxError","err_stack":"    at …"}` + the fixed `msg` — the `Error` path is intact |

Every covered shape keeps its record (`request_id` present wherever one was passed) and keeps a
`msg`. `logger.spec.ts` 28/28 and `framework-400-request-body.spec.ts` 9/9 confirm the
non-object message positions did not move.

### 1.3 The REGRESSION comparison, run head to head

Same process shape, two singletons: `git show 45cf578^:apps/api/src/observability/logger.ts`
(the 25-path denylist, extracted to the scratchpad, md5 `589a2e493a54143c8f3313d268586824`) and
HEAD. The eight wildcards `*.password`, `*.token`, `*.secret`, `*.rawToken`, `*.tokenDigest`,
`*.verificationToken`, `*.ip`, `*.ipHash`.

| shape | `45cf578^` (denylist) | HEAD |
|---|---|---|
| `error({request_id}, {…eight})` | `"msg":{"password":"[redacted]","token":"[redacted]", … all 8 censored}` | `"err":{"err_name":"non-error throwable (object)"}`, nothing else |
| `error(undefined, {…eight})` | all 8 `[redacted]` | the same |
| `error(null, {…eight})` | all 8 `[redacted]` | the same |
| `error({request_id}, {…eight}, 'tail')` | `"msg":"{\"password\":\"[redacted]\", … }"` | the same |
| class instance carrying the eight | all 8 `[redacted]` | the same |
| `error({request_id}, ['first', {…eight}])` | **`"msg":["first",{"password":"W1","token":"W2","secret":"W3","rawToken":"W4","tokenDigest":"W5","verificationToken":"W6","ip":"203.0.113.32","ipHash":"W8"}]`** — all eight VERBATIM | the same, nothing emitted |
| `error({request_id}, {outer:{…eight}})` | **all eight VERBATIM** — the wildcard matched one level only | the same, nothing emitted |

**Answer to the question as put: yes, and strictly.** On the eight wildcards the message position
at HEAD is at least as strong as the denylist was on every shape, and it is stronger on two —
the array element and the one-level-deeper container, where the wildcard stringifier never
reached and HEAD emits nothing at all. The direction the regression ran in is reversed: HEAD
discards the container whole rather than censoring the names someone thought of.

### 1.4 The argument list swept rather than sampled

Because a fix to one position is exactly the shape of defect that moves a hole to the next
position, I swept the list instead of re-running the reproduction. 14 leading-argument kinds
(record, `undefined`, `null`, a bare string, `%o`/`%j`/`%s`/`%O`/`%d` format strings, a number, an
empty record, a record carrying its own `msg`, a record carrying a real `Error` under `err`, a
null-prototype record) × 10 payload kinds (plain container, nested container, array, class
instance, null-prototype object, decorated `Error`, `Map`, `Proxy`, raw string, hidden-`toJSON`
container) × 3 argument slots = **420 calls, 420 lines, 0 throws**.

`grep MK` over the capture returns 14 lines, and every one of them is one of exactly two
already-known classes:

- **11 lines: the raw STRING payload** (`"msg":"password=MK"`, `"msg":"ctx 'password=MK'"`,
  `"msg":"ctx password=MK"`). Free text in the message position or through `%s`/`%o`. Inherent
  and documented — no censoring scheme reaches inside a string.
- **3 lines: the hidden-`toJSON` container through `%o`/`%j`**. That is F-265, §4, not F-277.

Targeted confirmation that a plain container in a format-parameter position is still scanned:

```
logger.error('T1 %o', {password:'MK'})  -> "msg":"T1 {\"password\":\"[redacted]\"}"
logger.error('T2 %j', {password:'MK'})  -> "msg":"T2 {\"password\":\"[redacted]\"}"
logger.error('T4 %O', {password:'MK'})  -> "msg":"T4 {\"password\":\"[redacted]\"}"
logger.error({request_id}, 'T9 %o', {password:'MK'}) -> "msg":"T9 {\"password\":\"[redacted]\"}"
```

**No argument position emits a container's contents.** The `instanceof Error` test is gone rather
than widened, and the hook's two earlier branches (`thrown instanceof Error`,
`messageWouldBeTakenFromTheError`) do not reopen it: both hand pino the fixed string and drop the
message argument entirely.

### 1.5 The fix's own new surface, checked

The fix makes `errorMovedOntoTheRecord`'s `{ ...record }` spread run on every non-null object in
the message position, not only on an `Error`. That is a new re-read of the caller's record, so I
measured the availability parity against the pre-fix singleton (`917c601`):

| call | `917c601` | HEAD |
|---|---|---|
| record with a throwing enumerable getter + string message | THREW | THREW |
| record with a throwing enumerable getter + container message | THREW | THREW |
| record whose keys are all named, one a throwing getter, + container message | THREW | THREW |

Identical. The fix adds no throw site an operator would notice; F-253/F-259 is unchanged.

### 1.6 GC-1

Re-measured independently, same method as the implementer's (5 runs × 200 000 calls, median,
20 000 warm-up, stdout to `/dev/null`, both singletons in the same session), `917c601` against
HEAD:

| shape | `917c601` | HEAD | delta |
|---|---|---|---|
| flat request-log record + string | 2396 ns | 2361 ns | −35 ns (noise) |
| **record + container in the message position** | 2695 ns | 2785 ns | **+90 ns** |
| record holding an error | 6530 ns | 6614 ns | +84 ns (noise) |
| `'ctx %o'` + container | 2856 ns | 2885 ns | +29 ns (noise) |

Same direction and same order as the implementer's +180 ns on the one shape the fix covers; the
session-to-session spread is larger than the delta. One such line is ~0.011% of GC-1's 25 ms
ceiling. `pinoWouldReplace` is off the log path entirely — it runs on child construction only.

---

## 2. F-279 — RESOLVED

Both directions I measured at round 6, re-run against the shipped singleton.

| options object | pino would | r6 | r7 |
|---|---|---|---|
| `Object.create({ redact: { paths:['request_id'], remove:true } })` — prototypic `redact` | **install it** (`proto.js:161` is a plain property read) | accepted; the child's line lost `request_id` from binding and record | **REFUSED**, `TypeError` naming `redact` |
| `Object.create({ formatters:{log} })` + own `hasOwnProperty` answering `true` for `formatters` | take the replacing branch (`proto.js:136` calls the method on the object) | accepted; scan disabled at every key and depth — `password` and a raw `ip` verbatim | **REFUSED**, `TypeError` naming `formatters` |

The `serializers` variant of the lying object — which r6 named as an untested exploit of the same
defect — is refused by the same branch: `TypeError` naming `serializers`. Predicate fixed, not
the two cases.

**Presence-not-truthiness survived the change**, which is what `Object.hasOwn` is unioned in for:
`{serializers: undefined}`, `{redact: undefined}` and `{formatters: undefined}` are all still
refused, and an `Object.create(null)` options object carrying an own `serializers` is refused too.

**The accept-set re-measured, because a wrong accept is the half that leaks.** The two shapes
`pinoWouldReplace` still accepts are prototypic `serializers` and prototypic `formatters` with an
honest `hasOwnProperty` — pino's own-property check says no for both, so pino ignores them. Not
taken on faith; emitted:

```
child({request_id}, Object.create({serializers:{err:(x)=>x}}))
  .error({request_id, err: Error+body}, '…')
  -> "err":{"err_name":"Error","err_stack":"    at …"}          root serialiser still ran, no body

child({request_id}, Object.create({formatters:{log:(r)=>r}}))
  .info({request_id, password:'ACC-FMT-PW', ip:'203.0.113.55'}, '…')
  -> "password":"[redacted]","ip":"[redacted]"                  root scan still ran
```

A grandchild of the accepted child also censors. So the accept-set is inert on pino 10.3.1 and
accepting it costs nothing.

Two edges worth naming, neither a defect in this module: an options object with **no**
`hasOwnProperty` at all (`Object.create(null)`, benign contents) and one whose `hasOwnProperty`
**throws** are both guarded here — `suppliedClaimsOwnProperty` returns `false` — and then throw
from **pino's own read** (`options.hasOwnProperty is not a function`, and the caller's own
`nope`). That is pino's behaviour with or without this module, on an options object a call site
had to construct deliberately. Availability only, caller-supplied.

---

## 3. F-280 — RESOLVED

Measured on real response bytes, `node dist/main.js` on loopback, `NODE_ENV=production`, rebuilt
from HEAD.

| response | status | `frame-ancestors` | `X-Frame-Options` |
|---|---|---|---|
| `GET /health` — the routed 200 | 200 | `'none'` | `DENY` |
| `GET /api/no-such-route` — the branded 404 (`ApiExceptionFilter`) | 404 | `'none'` | `DENY` |
| `GET /` — the unrouted 404 | 404 | `'none'` | `DENY` |
| malformed-JSON POST — the framework-400 arm | 400 | `'none'` | `DENY` |

Full policy on every one of the four, byte-identical:

```
Content-Security-Policy: default-src 'self';base-uri 'self';font-src 'self' https: data:;
  form-action 'self';frame-ancestors 'none';img-src 'self' data:;object-src 'none';
  script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';
  upgrade-insecure-requests
```

Eleven directives: the ten helmet ships plus the overridden `frame-ancestors`. `useDefaults: true`
did what it says — nothing else moved. HSTS still `max-age=31536000; includeSubDomains` with **no**
`preload`, `nosniff` and `no-referrer` present on all four, `X-Powered-By` absent, and CORS still
absent on both a `GET` and an `OPTIONS` preflight carrying `Origin: https://evil.example`. The
two headers now agree, so the contract's table and the deployed bytes state the same policy.

The framework-400 line itself was re-checked end to end from a real socket with an
`Authorization: Bearer LEAKME-AUTH` header and `{"password":"LEAKME-BODY"` as the body: the
emitted line carries `request_id`, `err_name`, `err_stack` frames and the fixed `msg`, and
`grep -c LEAKME` over the whole process output is **0**.

Noted, not filed: the eighth integration test iterates `probes`, which is `/health` and the
branded 404. The framework-400 arm and the unrouted `/` are correct on the bytes and unasserted
by the suite — the same scope the pre-existing header tests already had, and helmet is app-level
middleware so all four arms come from one registration.

---

## 4. F-265, the `toJSON` class — SURVIVES, narrowed

Door seven's fix removes one route to a stringifier, and that is exactly what it removes: one
route. The leaking shape is a plain object whose own enumerable keys are **all named or absent**
— nothing changes, `fieldsCensored` returns it by reference, and pino's stringifier then honours
an own non-enumerable `toJSON` the scan never saw. Thirteen routes measured, `toJSON` returning
`{password: <marker>}`:

| route | emitted | verdict |
|---|---|---|
| under a named key at depth 2 | `"route":{"password":"TJ-A-NAMEDKEY-D2"}` | **LEAK** |
| under a named key at depth 3 | `"route":{"route":{"password":"TJ-B-NAMEDKEY-D3"}}` | **LEAK** |
| child bindings | `"route":{"password":"TJ-C-BINDINGS"}` | **LEAK** |
| grandchild bindings | `"route":{"password":"TJ-L-GRANDCHILD"}` | **LEAK** |
| `setBindings` | `"route":{"password":"TJ-M-SETBINDINGS"}` | **LEAK** |
| format argument `%o` | `"msg":"fmt {\"password\":\"TJ-D-FORMATARG\"}"` | **LEAK** |
| format argument `%j` | `"msg":"fmt {\"password\":\"TJ-E-FORMATARG-J\"}"` | **LEAK** |
| format argument `%O` | `{"password":"MK"}` in `msg` | **LEAK** |
| array element under a named key | `"route":[{"password":"TJ-I-ARRAY-ELEMENT"}]` | **LEAK** |
| **message position, with a record** | `"err":{"err_name":"non-error throwable (object)"}` | **closed by F-277's fix** |
| **message position, no record** | the same | **closed by F-277's fix** |
| as the whole record | `"request_id":"ok"` only — `_asJson` walks own keys, so a record-level `toJSON` never fires | covered |
| under the top-level `err` key | `"err":{"err_name":"non-error throwable (object)"}` | covered |

So: **narrowed by two routes, nine still open.** Severity stays **minor** for r6's reason — the
attacker must supply an object carrying a hidden `toJSON`, and no library in this tree does; no
shipped call site reaches it.

**The documentation half is only half corrected, and this is the part worth an edit.** ADR-0028
now carries an honest residual entry (`adr-0028-log-field-allowlist.md:919-924`: "returned by
reference … the Consequences table says the `toJSON` shape is `[redacted]`, which holds for the
shape it names, whose key is unnamed, and not for the mechanism"). The **contract** does not:

- `contracts/logging-and-headers.md:74-76` — "The three residuals closed as a class. A container
  the scan cannot inspect — past the depth bound, a class instance, **anything carrying `toJSON`
  (F-265)** — is censored rather than passed through."
- `contracts/logging-and-headers.md:858-872`, "The residuals closed" — the same claim with a
  table whose `toJSON` row (`{ ctx: { toJSON: … } }`) is censored by the **key** rule, since
  `ctx` is unnamed, not by anything that reaches `toJSON`.

And `logger.ts` itself asserts it twice, at `MAX_SCAN_DEPTH`'s docblock (`:610-612`) and at
`valueCensored`'s (`:733-738`) — the latter in a sentence that states the class is closed and
then describes the leak in the next clause.

The contract is the document every later TASK is told it may rely on. A reader who takes that
paragraph at face value will hand this logger a container from a library and believe a hidden
`toJSON` cannot fire. **Recommended, not blocking:** copy ADR-0028's residual wording into the
contract's "The residuals closed" section and into the two `logger.ts` docblocks. Same finding,
same owner slot, no new severity.

---

## 5. F-281, `mapHttpRequest` — CONFIRMED, no leak

**The mechanism, read rather than assumed.** `LOG` (`tools.js:47-56`) sniffs
`o.method && o.headers && o.socket` and replaces the whole record with `mapHttpRequest(o)`; a
`typeof o.setHeader === 'function'` record becomes `mapHttpResponse(o)`. Reading
pino-std-serializers 7.1.0 `lib/req.js`: `reqSerializer` builds `Object.create(pinoReqProto)` and
assigns `id`, `method`, `url`, `query`, `params`, `headers`, `remoteAddress`, `remotePort` as own
enumerable properties, plus a non-enumerable `raw` holding **the original request object**. It
censors nothing — it is a re-shaper, and it carries the credential-bearing `headers` and the raw
`remoteAddress` straight through. `lib/res.js` is the same shape and carries `getHeaders()`,
which is where a `Set-Cookie` lives.

**So the architect's "no leak, because the replacement censors" is right in the conclusion and
wrong in the reason, and the distinction matters.** The replacement censors nothing. What censors
is our own key rule: the replaced record is `{ req: … }` or `{ res: … }`, `formatters.log` runs on
it inside `_asJson`, and neither `req` nor `res` is on `LOGGABLE_FIELDS`. Measured:

| call | emitted |
|---|---|
| `info({request_id, route, method, headers:{authorization, cookie}, socket:{remoteAddress}}, '…')` | `"req":"[redacted]","msg":"…"` — no `request_id`, no `route` |
| `info({request_id, route, method}, '…')` — no `headers`/`socket`, sniff does not fire | `"request_id":"r-probe","route":"/api/x","method":"[redacted]"` |
| `info({request_id, setHeader, statusCode, getHeaders:()=>({'set-cookie':…})}, '…')` | `"res":"[redacted]"` |
| full request record with a query token in `url`, `x-forwarded-for`, `authorization`, `remoteAddress` and an extra `password` key | `"req":"[redacted]"` — `grep` for all five markers: 0 hits |
| the same request shape in **child bindings** | `"method":"[redacted]","url":"[redacted]","headers":"[redacted]","socket":"[redacted]"` — `asChindings` does **not** sniff, and the key rule covers every key anyway |
| the same request shape in the **message position** | `"err":{"err_name":"non-error throwable (object)"}` |

**No leak, on any of the six routes, and the coverage does not depend on the replacement.** Had
pino not replaced the record, the individual keys `method`, `url`, `headers`, `socket` would each
have been censored by the same rule — which is precisely what the bindings row demonstrates,
since that path skips the sniff. The property that holds is "an unnamed key does not carry a
value", and it holds before and after the replacement.

**What is true is that contract invariant 2 is false for that shape**, exactly as filed: a
request-shaped record loses `request_id`, `route` and `tenant_id` from the line. That is an
observability defect, not a leak — a correlation id vanishing from an audit line. It is already
recorded in both places it belongs (`logging-and-headers.md:643-657` under "Door six" and as the
named exception under invariant 2 at `:1232-1236`) and the remedy is stated: log named fields,
never a request object. No call site in `apps/api/src` logs a request-shaped record today —
swept, six call sites, all `(record, string)` or `(string)`.

Reachability, stated plainly so it is not read as wider than it is: an attacker cannot make a
record request-shaped from outside the process. The keys the sniff reads are top-level keys of an
object our own code builds. The one way a client could reach it is a future call site that
spreads request-controlled data into a log record (`logger.info({...req.body, request_id}, …)`),
which is a mass-assignment pattern nothing in this tree uses and which the contract forbids twice
over. **No finding filed.**

---

## Notes

**What else in the r7 delta was checked.** F-278's lint half (`eslint.config.mjs`) is not on my
verdict list but is a GC-9 bypass control, so it was measured rather than read — probed through
`eslint --stdin --stdin-filename`, so no file was modified:

| file | `Logger` from `@nestjs/common` | `pino` value import | `console.log` |
|---|---|---|---|
| any ordinary `apps/api/src/**` file | error | error | error |
| `apps/api/src/db/client.ts` (named exemption) | allowed | **error** | **error** |
| `apps/api/src/tenancy/tenant-context.ts` (named exemption) | allowed | **error** | **error** |
| `apps/api/src/observability/logger.ts` | allowed | allowed | allowed |
| `apps/api/test/**` | allowed | allowed | allowed |

The hazard the implementer flagged — a second config object silently replacing the first block's
rule options and switching the `pino` restriction off — did not happen: the two exempted files
keep both controls. `test/**` is uncovered, which is the pre-existing scope r6 already noted and
is not a runtime surface.

**Suite state, as I measured it.** `apps/api` observability, 4 files: `logger-contract-drift`
6/6, `logger-field-allowlist` 16/16, `logger.spec` 28/28, `framework-400-request-body` 9/9 —
**59 of 59**. The drift spec passing means the contract's fence and the shipped file agree; I read
the fence report's account of the three code changes it carried and the drift spec is what
verifies it. The new allowlist spec is not vacuous: it asserts `emitted.length ===
EXPECTED_LINE_COUNT` (19) before any test reads a line, so a dropped or extra line fails loudly
rather than silently reindexing, and its door-seven assertions discriminate — every one of those
shapes emits its marker verbatim on the `45cf578^` singleton and none on HEAD.

**Read-only compliance.** No file in the repository was created, modified or deleted except this
report. `git status --short` is empty; `logger.ts`, `main.ts` and `eslint.config.mjs` carry the
same md5s at the end as at the start (§ header). Both extracted singletons (`45cf578^` and
`917c601`) and all nine probe scripts live in the session scratchpad, outside the repository.
`apps/api/dist/` was rebuilt to boot the real server; it is gitignored and was already a build
artifact. The API server on port 53997 was stopped and the port is closed. Postgres was left
running, as instructed. I did not touch `findings.yaml` and I set no owner.

**What I could not verify.**

- **The deployed image.** Every header measurement is against `node dist/main.js` on loopback,
  not the Fly image. HSTS is only meaningful over TLS and loopback is not TLS: what is proved is
  that the header is emitted, not that a browser acts on it. No Docker build, no Fly credentials.
- **A real browser honouring `frame-ancestors 'none'` over `X-Frame-Options`.** Verified as
  response bytes and as a reading of CSP Level 2 § 4, not observed in a user agent.
- **The branded 404's own per-response CSP**, which `redirect-resolution.md` specifies and which
  must carry its own `frame-ancestors 'none'` because the directive does not fall back to
  `default-src`. No redirect route exists yet, so there is nothing to measure. The requirement is
  recorded in `main.ts`'s comment and in the contract; it lands with the TASK that builds that
  route, and if it is missed the framing protection F-280 just added is dropped on the one
  response slated to render tenant-controlled markup (F-006).
- **`err_name: 'non-error throwable (object)'` across exotic containers.** I emitted plain
  objects, arrays, class instances, null-prototype objects, `Map`, `Proxy`, decorated `Error`s and
  hidden-`toJSON` objects — 420 calls, no other `err_name` observed. Not `Buffer` and not a
  cross-realm object.
- **The `headersSent` arm of the exception filter.** Still unreachable without a streaming
  response, still read rather than measured. Unchanged from r6.

**Carried, not new, not re-raised here.** r6's finding 4 (`undefined` under an unnamed key with a
stateful getter), finding 6 (`NestFactory.create` leaving Nest's own logger enabled — still
observed on this session's boot, five ANSI-coloured non-JSON lines) and finding 7 (Node's
parser-level 400/431 carrying no headers) were out of this round's `raised-only` scope and were
not re-measured. Each is disclosed in ADR-0028 or the contract, and the mechanism that would
close 6 as a class — `app.useLogger` over the shared singleton — is named there as deliberately
deferred.

## Dependencies reviewed

**None.** `git diff --stat 917c601..HEAD -- '*package.json' 'pnpm-lock.yaml'` is empty: the r5
delta adds no dependency, bumps none, and removes no lockfile entry. The five files it touches
are `apps/api/src/main.ts`, `apps/api/src/observability/logger.ts`,
`apps/api/src/observability/logger-field-allowlist.spec.ts`,
`apps/api/test/security/security-headers.int-spec.ts` and `eslint.config.mjs`.

r6's dependency assessment stands unchanged: `helmet@8.3.0` exact-pinned, zero transitives, MIT,
no advisory; `pino@10.3.1` unchanged; the one accepted advisory (GHSA-67mh-4wv8-2f99 via
`better-auth`, itself an unimported runtime dependency) is argued in
`docs/security/known-advisories.md:35` and is not TASK-003's to retire.
