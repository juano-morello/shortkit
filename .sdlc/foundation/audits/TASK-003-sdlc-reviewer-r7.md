# TASK-003 — sdlc-reviewer, round 7 (scoped re-audit, `reaudit: raised-only`)

Reviewed: `.sdlc/foundation/work/TASK-003-review-r7.diff` (`917c601..87119a5`, 5 files,
pathspec `':!.sdlc'`), read against the whole of `apps/api/src/observability/logger.ts`,
`logger-field-allowlist.spec.ts`, `logger.spec.ts`, `eslint.config.mjs`, `main.ts`,
`design/contracts/logging-and-headers.md`, `adr-0028-log-field-allowlist.md`, the three
round-5 reports, and the shipped `node_modules/.pnpm/pino@10.3.1` /
`pino-std-serializers@7.1.0` / `quick-format-unescaped@4.0.4` sources. Nothing below is read
off a report: every behavioural claim was emitted from the shipped singleton in this session.

```yaml
verdict: clear
```

No new blocker. No new major. One new minor, and it is a guard gap rather than a byte defect.

## Verdict table

| finding | raised by | ruling | basis |
|---|---|---|---|
| **F-277** (blocker, door seven) | `sdlc-reviewer` + `sdlc-security-auditor`, r6 | **RESOLVED** | 19 shapes emitted from the shipped singleton; zero markers on any line; the argument is MOVED, not dropped |
| **F-275** (nit, `fieldsCensored` docblock) | `sdlc-reviewer` r6 | **RESOLVED** | `logger.ts:684-694` now argues type soundness and agrees with the fence's inline comment instead of contradicting it |
| **F-278, lint half** | `sdlc-architect` ruling, implementer deviation | **RESOLVED, deviation correct and necessary** | measured through `eslint --stdin --stdin-filename` on five file identities; the deviation is the only arrangement that keeps the `pino` ban alive |
| **F-281** (new, architect) | `sdlc-architect` r7 | **CONFIRMED**, and wider than filed (a second door) | `tools.js:48-52`; measured `"req":"[redacted]"` and `"res":"[redacted]"` with the named fields gone |
| **NEW-R7-1** (minor) | this audit | filed | the shipped answer is distinguishable from the cheapest wrong answer by no behavioural test; measured with a drop-mutant |

**TASK-003's code is ready for `done`.** The blocker this round existed to close is closed, on
every shape I could construct and not only on the two reproductions; nothing in the round-5
diff introduces a new leak, a new throw class, or a behaviour change at any call site that
exists today. AC-6's deployed clause is separately blocked on infrastructure and is not mine.

---

## F-277 — RESOLVED

### What shipped

`apps/api/src/observability/logger.ts:253-256`:

```ts
const covered =
  message === 1 && typeof args[1] === 'object' && args[1] !== null
    ? errorMovedOntoTheRecord(args)
    : args;
```

The `instanceof Error` test is gone, not widened with a second branch, which is what the
ruling required and what removes the enumeration shape F-244/F-262/F-266 each punished.
`errorMovedOntoTheRecord`'s body (`:295-299`) is unchanged.

### Measured, not read off the report

One process, `NODE_ENV=test LOG_LEVEL=info`, importing the shipped singleton by absolute path,
19 call shapes. **Not one of the 20 distinct leak markers appears on any line** (`grep -o
'LEAK-[A-Z]'` over the full output returns nothing). The shapes, beyond the six the emitter
already covers:

| shape in the message position | line |
|---|---|
| `Object.create(null)` carrying `password` | `"err":{"err_name":"non-error throwable (object)"}` |
| a plain object with an **own non-enumerable `toJSON`** returning `{password}` | same — the design's stated reason for choosing (a) over (b) holds when emitted |
| `{ name, message, stack }` (a container impersonating an error) | same |
| `Buffer.from('LEAK-N')` | same |
| a real `Error` | `"err":{"err_name":"Error","err_stack":"    at …"}` — frames only, no message |
| `null` / `42` / `'plain string'` / a function | `"msg":null` / `"msg":42` / `"msg":"plain string message"` / no `msg` key — all unchanged, as the ADR's table states |

**It moves, it does not drop.** Every one of those lines carries the caller's `request_id`
AND an `err` object AND `"msg":"an error was logged with no context string"`. The
cheapest-wrong-fix hazard the dispatch named is not what shipped.

### Judging the fix rather than the tests

- **The predicate's bound is right.** `messageArgumentIndex` (`:279-281`) returns 0 only when
  `args[0]` is neither an object nor `undefined`, so index 1 is the only index a
  message-position container can occupy. `logger.info(42, {password})` and
  `logger.info(undefined, undefined, {password})` take the format-argument path — I emitted
  both, both censored.
- **The widening cannot leak through `serializers.err`.** `errorLogFields` (`:901-918`)
  returns `{err_name}` alone for a non-`Error` and never touches the caller's object, so the
  moved container is never handed to pino's stringifier. That is precisely the property
  alternative (b) would have lost, and the `toJSON` probe above is the demonstration.
- **No new throw class.** `typeof` replaces `instanceof`, which is strictly fewer proxy traps
  on the module's side; the `instanceof` that remains runs inside `serializers.err`, where it
  ran before. `errorMovedOntoTheRecord`'s `{ ...record }` spread widens the pre-existing
  F-253/F-259 hostile-getter throw site to more call shapes — same class, already documented
  at `:801-818` and in the contract's "A log call can still throw".
- **No call site changes behaviour.** All seven live call sites pass `(record, string)`:
  `main.ts:199`, `:309`, `exception-filter.ts:181`, `:195`, `:288`, plus the two exempt Nest
  loggers. Nothing in `apps/api/src` puts an object in the message position.
- **The two disclosed costs are real and are as disclosed.** Measured:
  `logger.error({request_id, err: realError}, container)` emits the real error's `err_name`
  and `err_stack` and nothing of the container — `messageWouldBeTakenFromTheError` (`:571-580`)
  fires first, the container is dropped, no leak. And
  `logger.error({request_id, msg:'CALLER-MSG'}, container)` emits
  `…,"msg":"CALLER-MSG","err":{…},"msg":"an error was logged with no context string"` — a
  duplicate `msg` key, last-wins under `JSON.parse`, because `_asJson` writes `propStr` before
  `msgStr` (`tools.js:165-224`). Both are contrived, neither has a call site, both are priced
  in the contract's invariant 6. Note for a later round rather than a finding: the hook's own
  `messageWouldBeTakenFromTheError` docblock names the double-`msg` hazard and guards for it,
  while `errorMovedOntoTheRecord` does not — the module knows the hazard in one branch and not
  in the other.
- **The docblock's false claim is gone.** `logger.ts:209-232` no longer says "A CONTAINER in
  either position is scanned"; it states four rows in the ADR's order, and the contract's
  "Door six" says why "scanned" was the wrong word for two of them.

---

## F-275 — RESOLVED

`logger.ts:684-694` now reads the rationale as type soundness — `<T extends object>(record: T): T`,
`as T` would be a lie on an object keyed `"0"`,`"1"` — and states the byte question as the
corrected fact ("IDENTICAL EITHER WAY, MEASURED ON BOTH FORMS"), which agrees with the fence's
inline comment instead of contradicting it. The r6 finding was the self-contradiction, and it
is gone. The docblock does still mention bytes; that is not a re-argument, it is the true half.

---

## F-278, lint half — RESOLVED. The implementer's deviation is correct and the ruling's shape
would have been a regression.

The claim is that ESLint replaces rule options rather than merging them, so the ruling's
"second config object listing only `@nestjs/common`" would have switched the `pino` ban off for
every file it matched. I did not take that on trust. Measured with
`npx eslint --no-warn-ignored --stdin --stdin-filename <path>` against a probe importing
`Logger` from `@nestjs/common`, `pino` as a value, `pino` as a type, `* as nest`, and calling
`console.log`:

| file identity | `@nestjs/common` `Logger` | `pino` value | `pino` type | `import * as nest` | `console.log` |
|---|---|---|---|---|---|
| `apps/api/src/probe.ts` (any ordinary API file) | error | error | allowed | **error** | error |
| `apps/api/src/db/client.ts` | allowed (exemption) | error | — | allowed | error |
| `apps/api/src/tenancy/tenant-context.ts` | allowed (exemption) | error | — | allowed | error |
| `apps/api/src/observability/logger.ts` | allowed | allowed | allowed | allowed | allowed |
| `apps/web/src/probe.ts`, `apps/api/test/probe.int-spec.ts` | allowed | allowed | — | allowed | allowed |

The arrangement holds: both blocks match `apps/api/src/**/*.ts`, the later one wins outright,
and because `noSecondPinoInstance` (`eslint.config.mjs:11-17`) is listed in both
(`:58` and `:94`) the `pino` ban survives the replacement. The two exempt files keep
`no-console` and the `pino` ban, which is what "more than the exemption is for" meant. A bonus
the ruling did not claim: the namespace bypass `import * as nest from '@nestjs/common'` is
reported too, so the rule is not a one-spelling defence.

Scope limits, recorded so nobody reads the mechanism as wider than it is, neither of them new
this round and neither a finding: `apps/api/test/**` is outside both blocks (an int-spec may
still construct a second pino), and `observability/logger.ts` is exempt from `no-console` as
well as from the `pino` ban, which is a consequence of F-268's original `ignores` and not of
this round's edit.

---

## F-281 — CONFIRMED, and there is a second door the finding did not name

The mechanism is in pino's `LOG`, `tools.js:48-52`, and it runs **inside** the function the
hook calls, so it is downstream of `interpolationCovered` and upstream of `formatters.log`:

```js
if (o.method && o.headers && o.socket) { o = mapHttpRequest(o) }
else if (typeof o.setHeader === 'function') { o = mapHttpResponse(o) }
```

Measured on the shipped singleton:

```
logger.info({request_id, route, method, headers:{authorization:'Bearer …'}, socket:{remoteAddress:'…'}}, 'a request-shaped record')
  → {"level":"info",…,"req":"[redacted]","msg":"a request-shaped record"}
logger.info({request_id, setHeader: () => undefined, statusCode: 500, password: '…'}, 'a response-shaped record')
  → {"level":"info",…,"res":"[redacted]","msg":"a response-shaped record"}
```

Both confirmed exactly as filed: `request_id` and `route` are **gone**, not censored, so
invariant 2 ("every line inside a request carries `request_id`") and invariant 8's "the key
stays on the line" are both false for that record shape — which is the whole mitigation
ADR-0028 offers for what the allowlist costs. The `mapHttpResponse` door has the same effect
for any record carrying a callable `setHeader`, and the architect's F-281 text names only the
request door; the contract's "Door six" paragraph does name both.

**It fails safe.** No credential, header or IP reaches the line in either case — `req` and
`res` are not on `LOGGABLE_FIELDS`, so the mapped object is censored whole, and I checked the
deeper direction too: even if `req` were ever added to `LOGGABLE_FIELDS`, `reqSerializer`'s
output has `pinoReqProto` as its prototype (`pino-std-serializers/lib/req.js:8-56`), so
`valueCensored` (`logger.ts:761-765`) declines the non-plain prototype and censors it anyway.

**Not a finding against the code**, because the contract at HEAD already states it in three
places — "Door six"'s "One thing pino does to the RECORD before any of this", invariant 1's
"What the invariant does not promise", and invariant 2's "One measured exception". The code
matches the contract. What is worth the orchestrator's attention: nothing pins it. The
allowlist spec's request-shaped record (ordinal 2, `logger-field-allowlist.spec.ts:371-384`)
carries `id, method, url, headers, remoteAddress, remotePort` and **no `socket`**, so it does
not trip the sniff and asserts the per-key censoring instead; no emitter line in the repository
produces a `"req":"[redacted]"` or `"res":"[redacted]"` record line. The behaviour the contract
now documents as an exception to an invariant is asserted nowhere, and the only thing standing
against a call site hitting it is the prose "Never log a request or response object".

---

## New finding

```yaml
findings:
  - severity: minor
    kind: behavior
    file: apps/api/src/observability/logger-field-allowlist.spec.ts
    line: 987
    summary: >-
      NEW. The shipped answer to F-277 (MOVE the container onto the record under `err`) is
      distinguishable from the cheapest wrong answer (DROP it) by no behavioural test in the
      repository, and the round-5 design report states the opposite.
    failure_scenario: >-
      MEASURED with a drop-mutant, 2026-08-10: `logger.ts` copied outside the repository with
      `errorMovedOntoTheRecord(args)` replaced by
      `[args[0] ?? {}, POSITIONAL_ERROR_MESSAGE, ...args.slice(2)]` — i.e. the caller's
      argument discarded rather than filed under `err`. The mutant emits
      `{"request_id":"r-probe","msg":"an error was logged with no context string"}` for a
      container AND for a real `Error`, so:
        - `F-277: a value in the message position reaches the line …` (:942) passes — no marker
          on any line.
        - `F-277: covering the message position does not cost the line its record or its
          message` (:987) passes — it asserts `record.request_id` (untouched by the mutant) and
          `toHaveProperty('msg')` (the fixed string is there). It catches dropping the RECORD
          and dropping the MESSAGE; it does not catch dropping the caller's ARGUMENT.
        - `F-277: … keeps the censoring the deleted redact list gave msg` (:1013) passes.
        - `logger.spec.ts`'s ordinal 21, `F-260: an Error in the message position never becomes
          the message` (:829-842), passes — it asserts no marker, `request_id` present, and
          `msg` is a string. It never reads `err_name` or `err_stack`.
      So a later edit that "simplifies" the hook by discarding the message argument ships a
      module that reports NOTHING for `logger.error({request_id}, err)` — strictly worse than
      the pre-round module, which at least reduced a real `Error` to its frames — with the
      whole behavioural suite green. Only `logger-contract-drift.spec.ts` fires, and it fires
      as a TEXT divergence ("the source diverged from the contract"), which a developer
      discharges by editing the fence.
      The claim this contradicts is `.sdlc/foundation/work/TASK-003-f277-design-report.md:75-77`:
      "A third alternative, dropping the message argument, lost to silence and is already
      redded by `F-277: covering the message position does not cost the line its record or its
      message` (mutation A)." It is not. The test's own docblock explains why — it deliberately
      declined to assert the SHAPE because Design had not ruled yet — but Design has now ruled,
      and the shape is normative in ADR-0028's position table and in the contract's invariant 6.
    required_change: >-
      One assertion, on the ordinals the emitter already writes: the message-position lines
      carry `err.err_name === 'non-error throwable (object)'`, and the `Error` case
      (`logger.spec.ts` ordinal 21) carries `err_name` plus an `err_stack` of frames. After it,
      the drop-mutant is red and the normative table has a byte-level guard. The design report's
      "already redded by mutation A" sentence is false and should not be carried forward as
      evidence of coverage.
```

Filed as `minor` rather than `major` deliberately, and the dispatch's "new blocker/major only"
is why the reasoning is spelled out: the shipped bytes are correct, and the fenced region
covers the mutated line, so `logger-contract-drift.spec.ts` does fire on the mutation — just as
a text gate, not a behaviour gate. It should not consume a rework round; it is a
`sdlc-test-architect` follow-up.

## Cannot verify from diff

- **AC-6's exempt half** — no deploy has happened from this tree. `sdlc-product-auditor`'s, by
  the test-strategy ruling. Unchanged from r6.
- **The CSP against a browser.** I verified `main.ts:249-254`'s two-override shape against
  helmet 8.3.0's `getDefaultDirectives` and against the new int-spec's assertion
  (`security-headers.int-spec.ts:235-256`, `cspDirective` parses correctly, including the
  absent-versus-wrong distinction it was written for). "The browser now agrees with
  `X-Frame-Options`" remains inference from CSP Level 2, as the implementer disclosed. I
  started no browser and did not re-run the integration suite.
- **`infra/deploy.sh`, the Dockerfile build, the deployed image.** Untouched by this diff and
  unchanged from r6.
- **Whether `F-274`, `F-257`'s "superseded" ruling and the seven r6 minors are gating `done` or
  are follow-up.** Routing, not review.

## Notes

- Gates: I did not re-run what the implementer and the orchestrator already ran on this tree.
  Everything above is an independent probe against the shipped singleton, plus five ESLint runs
  through stdin, plus one drop-mutant run outside the repository. The working tree was not
  modified: `git status --short` is empty at HEAD `87119a5`, and every probe file lives in the
  session scratchpad.
- `pinoWouldReplace` (`logger.ts:494-517`) was not in my verdict list but ships in this diff, so
  I checked it against `proto.js:114-165` rather than against its docblock. It matches pino
  option by option: `serializers` at `:114` (`hasOwnProperty(…) === true`), `formatters` at
  `:136` (truthy `hasOwnProperty`), `redact` at `:161`
  (`(typeof options.redact === 'object' && options.redact !== null) || Array.isArray(…)`, whose
  array arm is genuinely subsumed). The union with `Object.hasOwn` is safe in the refusing
  direction, which is the direction that costs nothing. One contrived residual, not filed
  because I cannot make it matter: a `redact` on the options PROTOTYPE behind a getter that
  throws once and succeeds on the second read is answered `false` here and installed by pino —
  effect is a child logger losing named fields, no leak, no call site.
- The `err` seam still holds after the widening: `formatters.log` skips `err` at depth 1
  (`logger.ts:701-703`) and `serializers.err` owns it, so the moved container is reduced by
  exactly one mechanism and the partition documented at `:651-663` is unchanged.
- `logger.error('ctx %o', { err: e })` still emits `"msg":"ctx {\"err\":\"[redacted]\"}"` —
  measured this session, so the format-parameter path did not regress while the message
  position was being closed.
