# TASK-003 — sdlc-security-auditor, re-audit round 5

Scope: `reaudit: raised-only`. The 12 findings this auditor raised (F-108, F-111, F-260,
F-261, F-262, F-263, F-264, F-265, F-266, F-267, F-268, F-269).

Judged against CURRENT SOURCE at HEAD = `e34e542`, working tree, not against any report,
commit message or `findings.yaml` status field. Every runtime claim below was MEASURED
against the shipped singleton on this repository's own `node_modules` — pino 10.3.1,
@nestjs/core 11.1.28, Node v24.19.0 — not reasoned from docs.

Review package `.sdlc/foundation/work/TASK-003-review-r5.diff` was read in both its
incomplete (18-file) and regenerated (24-file) forms. No verdict below depended on the
diff: all twelve were judged by reading the working-tree files. The six restored files
(`Dockerfile`, `.dockerignore`, `eslint.config.mjs`, `fly.toml`, `infra/deploy.sh`,
`pnpm-lock.yaml`) were read directly and are covered under Notes and Dependencies.

## Verdict table

| id | verdict | one-line reason |
|---|---|---|
| F-108 | RESOLVED | the framework-400 arm no longer logs the quoted slice; `includeMessage` is `isDomainError(...)`, false for a `BadRequestException`, and the stack header is double-stripped. Measured end to end |
| F-111 | RESOLVED | the CHECK ran before the serialiser was chosen and its result is recorded (`logger.ts:688-702`); the offending contract sentence is gone; the module never uses `pino.stdSerializers.err` |
| F-260 | RESOLVED | `interpolationCovered` covers every argument position pino formats (`logger.ts:159`, `:217-236`). 14 call shapes measured, no leak in any |
| F-261 | **SURVIVES** | `REDACT_PATHS` is unchanged. `logger.info(req, '…')` still emits `remoteAddress`, `remotePort`, the concrete `url` — and, measured this round, a bare `authorization` and `cookie` too |
| F-262 | **SURVIVES** | `clientIp`, `trustedClientIp`, `remoteAddress`, `ipAddress` all emitted verbatim beside `"ip":"[redacted]"`. ADR-0028 is accepted but NOT implemented |
| F-263 | RESOLVED | `childOptionsChecked` throws on `redact`, `serializers`, `formatters` (`logger.ts:391-421`). Measured on child, grandchild and great-grandchild |
| F-264 | RESOLVED | ordinal 27 builds a real grandchild (`logger.spec.ts:357-360`); the test (`:893-916`) reds under the `.call(logger, …)` mutation — verified by mutating and restoring |
| F-265 | RESOLVED | stated as the third residual, with its distinct mechanism, at `logger.ts:516-526`. "State it or handle it" — it is stated; behaviour is unchanged and still measured leaking, which the finding permitted |
| F-266 | **SURVIVES** | `sessionToken`, `accessToken`, `refreshToken`, `apiKey`, `api_key`, `passwordHash`, bare `authorization`, bare `cookie` all emitted verbatim |
| F-267 | RESOLVED | both wrappers `writable:false, configurable:false` (`logger.ts:438-450`); assignment, `delete` and `defineProperty` all `TypeError`. The prototype residual is disclosed rather than claimed away |
| F-268 | RESOLVED | the lint rule exists (`eslint.config.mjs:26-58`) and fires — probe-verified, including the `logger.ts` exemption and the type-import carve-out |
| F-269 | RESOLVED | rides on F-260's fix as the source states: measured, the trailing argument is still dropped, and the interpolated form now carries `err_name` + frames, not a credential |

RESOLVED: 9. SURVIVES: 3 (F-261, F-262, F-266). WITHDRAWN: 0.

New findings raised at blocker or major: **none**. Four sub-threshold observations are in
Notes and are deliberately NOT filed.

**The log's claim, confirmed and refuted.** F-260 and F-263 are genuinely closed — the log
is right about those two. F-261, F-262 and F-266 are NOT closed. They were routed to
ADR-0028, ADR-0028 was accepted, and only its two PRECONDITIONS (F-260, F-263) were
implemented. The allowlist itself has not shipped: `REDACT_PATHS` is still the mechanism at
`logger.ts:35-64` and `redact:` is still on the pino literal at `:136`. The contract says so
itself at `logging-and-headers.md:38-52` ("PENDING … not yet implemented") and the in-flight
frontmatter correction on ADR-0028 says "partly implemented". Anything in the ledger reading
those three as resolved-by-ADR-0028 is reading the DECISION as the IMPLEMENTATION.

## Detail

### F-108 — RESOLVED

`apps/api/src/common/errors/exception-filter.ts:257` — the 400 arm now calls
`logError(log, 'framework exception with a 400 status', exception)` instead of writing the
exception's own message. `logError` (`:282-292`) passes
`includeMessage: isDomainError(exception)`, which is `false` for the `BadRequestException`
Nest builds, so `errorLogFields` (`apps/api/src/observability/logger.ts:740-757`) omits
`err_message` entirely.

Measured, this round, with the real V8 message for a body whose first bytes are a credential:

```
V8 message:              "Unexpected token 'S', \"SEKRIT-KEY\"... is not valid JSON"
nest.stack first line:   "BadRequestException: Unexpected token 'S', \"SEKRIT-KEY\"... is not valid JSON"
errorLogFields(nest,{includeMessage:false}) -> {"err_name":"BadRequestException","err_stack":"    at …"}
```

The newline property the finding named is also gone. Body `\n    at FAKEFRAME-SEKRIT\n{"a":1`
produces message `Unexpected token 'a', "\n    at FAKEFRA"... is not valid JSON`; the emitted
fields contain `FAKEFRAME-SEKRIT` = **false**. Both halves of the strip are load-bearing and
both are present (`stackFrames`, `logger.ts:793-809`): prefix removal, then the `/^\s+at /`
shape filter.

The chosen remedy is the one this finding recommended — stop logging the slice — not
truncation, which is explicitly rejected at `logger.ts:714-716` for the reason the finding
gave (a credential at offset zero survives a cap).

`apps/api/src/observability/framework-400-request-body.spec.ts` pins this against a real Nest
application over a real socket (9 tests, green), and F-273's second copy — the same fragment
inside `exception.getResponse()` — is pinned as well. The filter never calls `getResponse()`;
grepped and confirmed.

### F-111 — RESOLVED

The finding asked for a CHECK, not an answer, and the check ran before the serialiser was
chosen. `logger.ts:688-702` records the measurement: `pino.stdSerializers.err(e)` emits the
RAW `e.stack`, whose first line is `${name}: ${message}` — exactly the reinstatement F-111
predicted — and the module therefore never uses that serialiser. Its own
`serializers.err` (`:142`) routes through `errorLogFields`, which builds three fields and no
fourth.

The contract half is closed too. The sentence F-111 was filed against is gone from
`error-envelope.md`; `:237-291` now carries the measured answer plus the correction that
`REDACT_PATHS` *does* reach `err.message`/`err.stack` once serialised, with the true
constraint stated narrowly (redaction cannot reach INSIDE a string). `TASK-003.md:123-129`
carries the check itself. `grep -n "named field\|truncat\|stdSerializers"` over both contracts
returns no occurrence of the original claim.

### F-260 — RESOLVED

`logger.ts:159` — the hook's terminal line is now
`method.apply(this, interpolationCovered(args) …)`, and `interpolationCovered` (`:217-236`)
walks from `messageArgumentIndex(args) + 1` to the end of the argument list, so every
position pino interpolates is covered, not `args[0]` and `args[1]`.

Measured against the shipped singleton, 14 shapes, marker `DOOR6-MARKER` on `err.body` and
`DSNMARK` in the message. **Not one line carried either marker.**

| call | `msg` |
|---|---|
| `logger.error('parse failed: %o', e)` | `parse failed: {"err_name":"SyntaxError","err_stack":"    at …"}` |
| `%j` | same shape |
| `%O` | same shape |
| `%s` | `parse failed: [object Object]` |
| `logger.error({request_id}, 'parse failed: %o', e)` | same shape, `request_id` preserved |
| `logger.error({request_id}, e)` (Error in message position) | `an error was logged with no context string`, error moved to `err` |
| `logger.error('ctx %o', {err: e})` | reduced — the auditor's own reproduction |
| `logger.error('ctx %o %o', {err:e}, e)` | both positions reduced |
| `logger.error(null, 'null-first %o', e)` / `undefined`-first | reduced |
| `logger.error(e, 'ctx %o', e2)` | `err` reduced AND the format arg reduced |
| `logger.error([e], 'array-first %o', e2)` | reduced |
| `logger.error('%d %o', 5, e)` | reduced |
| `logger.error(Object.assign(Object.create(null), {err:e}), '…')` | reduced |

The accepted CORRECTION is judged, not re-litigated: the stated attacker path
(body-parser's `err.body` reaching the filter) does not occur — `mapExternalException` replaces
the `SyntaxError` first — but the remedy was the right one and it is what shipped. The leak
shapes above involve no body-parser at all, and the real framework-400 exposure was the
message, which is F-108, now also closed.

### F-261 — SURVIVES  [major]

`apps/api/src/observability/logger.ts:35-64` is byte-for-byte the 25-path list the finding was
raised against, and `:136` still carries `redact: { paths: [...REDACT_PATHS], censor: … }`.
No allowlist exists in the file.

Measured this round:

```
logger.info(req, 'a request-shaped first argument')
{"level":"info","service":"shortkit-api","env":"test","id":1,"method":"GET",
 "url":"/l/abc?token=SEKRIT",
 "headers":{"host":"x","authorization":"Bearer AAA","cookie":"sk_at=BBB"},
 "remoteAddress":"203.0.113.7","remotePort":44321,"msg":"…"}
```

**Wider than filed.** When the request object is the RECORD ITSELF rather than the value of a
`req` key, the six `req.headers.*` paths do not apply either, so a bare `authorization` header
and a `Cookie` go on the line in the clear alongside the IP. The finding named
`remoteAddress`, `remotePort` and `url`; add `headers.authorization` and `headers.cookie` at
top level. `logger.info({ req }, '…')` — the same object one key down — censors the two
headers and still emits `remoteAddress`, `remotePort` and `url`.

Reachability today: no shipped call site logs a request object. The eight log call sites in
`apps/api/src` are `main.ts:198`, `:269`, `exception-filter.ts:125`, `:181`, `:195`, `:288`,
`db/client.ts:93`, `tenancy/tenant-context.ts:247`, and none passes one. So this is a latent
control gap, not a live leak — which is why the severity stays major rather than blocker. The
attacker becomes real at the first request-logging middleware: an unauthenticated visitor's
raw IP reaches the log store on every request, which is GC-9's first prohibition, and the
redirect path's concrete `url` is the entire click stream in plain text.

`logging-and-headers.md:804-812` disclaims invariant 1 in place and forbids call sites from
relying on it. That is honest and it is the right interim, but it is a prohibition, not a
mechanism, and the contract's own text says so.

### F-262 — SURVIVES  [major]

Measured, one line, this round:

```
{"clientIp":"203.0.113.9","trustedClientIp":"203.0.113.10","remoteAddress":"203.0.113.11",
 "ipAddress":"203.0.113.12","ip":"[redacted]","ip_hash":"SNAKE","ipHash":"[redacted]", …}
```

Four raw IPv4 literals in the clear beside two censored keys. `ip_hash` in the Postgres
spelling is also verbatim, which is the residual the contract names at `:660-664`.

`trustedClientIp` is still the accessor named in
`design/stubs/apps/api/src/auth/resolve-rate-limit-principal.ts:28`, so the spelling this
system will actually hold remains one of the uncensored ones. The next TASK to materialise
that stub and log its principal writes a raw client IP to the log store on an unauthenticated
path.

Nothing in the source has changed. ADR-0028 is the accepted answer; step 2 of its Migration
("add `LOGGABLE_FIELDS` … delete `REDACT_PATHS`") has not been performed.

### F-263 — RESOLVED

`logger.ts:391-421`. `OPTIONS_A_CHILD_MAY_NOT_REPLACE = ['redact','serializers','formatters']`,
and `childOptionsChecked` throws a `TypeError` naming the option and the reason. Refusal, which
the finding accepted as one of two acceptable answers and which the source argues for at
`:376-389` (a merge is undefinable for two of the three).

Measured:

| call | outcome |
|---|---|
| `logger.child({s:1},{redact:{…}})` | TypeError |
| `logger.child({s:1},{serializers:{err:…}})` | TypeError |
| `logger.child({s:1},{formatters:{log:…}})` | TypeError |
| `logger.child({s:1},{serializers:undefined})` | TypeError (presence, not truthiness — matches pino's `hasOwnProperty` test) |
| `logger.child({s:1},{level:'warn'})`, `{msgPrefix:'p'}`, no options | permitted |
| **grandchild** `parent.child({s:1},{redact:{…}})` | TypeError |
| **great-grandchild** | TypeError |

The refusal is inherited down the whole chain, which the finding did not ask for and which
matters because ADR-0028 makes this the last mechanism standing. Three emitted-byte tests
cover it (`logger.spec.ts` ordinals 23-26).

### F-264 — RESOLVED

`logger.spec.ts:357-360` builds
`logger.child({request_id: MARKER}).child({error: parseFailure}).error(…)` — a real
grandchild, ordinal 27 — and the test at `:893-916` asserts both halves on that one line.

Verified by mutation rather than by reading. I changed `logger.ts:339`
`inheritedChild.call(this, …)` → `.call(logger, …)` and ran the suite:

```
Tests  1 failed | 27 passed (28)
× F-264: a grandchild keeps its parent's bindings and still covers an error in its own
AssertionError: expected undefined to be 'grandchild-parent-binding-marker'
```

Exactly the mutation the finding named, killed by exactly one test. **The file was restored
with `git checkout --` and verified byte-identical: md5 `589a2e493a54143c8f3313d268586824`
before and after, `diff -q` against a pre-mutation copy clean, `git status --porcelain` shows
no modification to any source file.**

I reach the same verdict as `sdlc-reviewer` independently and by a different method (it read
the test; I killed the mutant). No disagreement.

### F-265 — RESOLVED

The required change was "state it as a third residual, or handle it. No behaviour change if
deliberate." It is stated, at `logger.ts:516-526`, as residual 3, with the mechanism spelled
out correctly and distinguished from residual 2 — "THIS SCAN INSPECTS PROPERTIES;
`JSON.stringify` CONSULTS `toJSON` AND THEN NEVER LOOKS AT THEM" — which is precisely the
distinction the finding was making.

Behaviour is unchanged, as permitted. Confirmed still leaking, measured:

```
logger.info({ ctx: { toJSON: () => e } }, '…')  ->  "ctx":{"body":"{\"password\":\"TOJSON-MARKER\"}"}
logger.info({ ctx: new Ctx(e) }, '…')           ->  "ctx":{"err":{"body":"…TOJSON-MARKER…"}}
logger.info('fmt %o', { ctx: { toJSON: () => e } })  ->  same payload inside msg
```

The format path leaks it too, which the source's residual text does not mention. Noted below,
not filed.

### F-266 — SURVIVES  [minor, as filed]

Measured:

```
{"sessionToken":"S1","accessToken":"S2","refreshToken":"S3","apiKey":"S4","api_key":"S5",
 "passwordHash":"S6","authorization":"Bearer AAA","cookie":"sk_at=BBB",
 "token":"[redacted]","password":"[redacted]", …}
```

Eight credential-shaped spellings in the clear, two censored. Unchanged from the round-4
measurement. Same cause as F-261 and F-262: ADR-0028 accepted, not implemented.

`logging-and-headers.md:699-708` records all of these as emitted verbatim and forbids logging
them until the allowlist lands. Documented, not mechanised.

### F-267 — RESOLVED

`logger.ts:438-450`. Both wrappers installed with `writable: false, enumerable: false,
configurable: false`. Measured:

```
Object.getOwnPropertyDescriptor(logger,'child')
  -> {"value":"[fn]","writable":false,"enumerable":false,"configurable":false}
Object.getOwnPropertyDescriptor(logger,'setBindings')  -> identical
logger.child = fn          -> TypeError: Cannot assign to read only property 'child'
delete logger.child        -> TypeError: Cannot delete property 'child'
Object.defineProperty(...)  -> TypeError: Cannot redefine property: child
```

The finding's second clause — "note the originals stay reachable via the prototype either
way" — is honoured rather than papered over. `Object.getPrototypeOf(logger).child` is still a
function (measured `true`), and `logger.ts:434-437` says so in the source
("WHAT THIS DOES NOT DO … That is hardening against the accident, not a boundary against a
call site that means it"), as does the contract fence at `logging-and-headers.md:290-292`. A
claim the artifact makes that the code does not enforce is the shape this finding objected to,
and that shape is gone.

The `defineProperty` calls sit inside the drift test's normative region (before
`export interface RequestLogFields`), so `logger-contract-drift.spec.ts` — 5 tests, green —
now fails if they are removed.

### F-268 — RESOLVED

`eslint.config.mjs:26-58`. A config block scoped to `apps/api/src/**/*.ts`, ignoring
`observability/logger.ts`, with `no-console: error` and
`@typescript-eslint/no-restricted-imports` banning the `pino` VALUE import while permitting
the type import.

Probe-verified rather than read (the rule's own scoping is the thing that fails silently):

```
apps/api/src/zz-probe.ts   -> 'pino' import is restricted …  @typescript-eslint/no-restricted-imports
                              Unexpected console statement    no-console
apps/api/src/observability/logger.ts (exempt)  -> no pino/console error
apps/api/src/zz2.ts, `import type { Logger } from 'pino'`  -> clean
```

All three arms behave as claimed. The finding was a nit, its required change was "write the
rule, or stop claiming enforcement", and the rule is written and works.

Scope note, not a defect: the rule covers `apps/api/src/**` only. `apps/api/test/**`,
`packages/**` and `apps/web/**` are outside it, and `require('pino')` is outside
`no-restricted-imports` by construction. Neither is a hole worth a finding today — no such
call site exists — but "never a second pino instance" is now enforced in the one tree that
matters rather than everywhere the sentence claims.

### F-269 — RESOLVED

The finding said "covered by F-260's fix if the hook scans every argument position", and it
is, in the way `logger.ts:206-211` states: the trailing argument is still dropped by
`quick-format`, which is pino's documented behaviour and not this module's to change, but
the dropped value and the interpolated value are now the same reduced value.

Measured:

```
logger.error('parse failed', e)                 -> {"msg":"parse failed"}                (dropped)
logger.error({request_id}, 'no placeholder', e) -> {"request_id":"r1","msg":"no placeholder"}
logger.error('parse failed: %o', e)             -> msg carries err_name + frames, no marker
```

The difference between the two forms is now a silent line versus a line naming the error, not
silence versus a credential. That is what the finding asked for.

## Notes

**1. `childOptionsChecked` uses `Object.hasOwn`; pino reads `options.redact` through the
prototype chain. Measured bypass. NOT filed — no attacker, no reachable path, and it
disappears under ADR-0028.**

`apps/api/node_modules/pino/lib/proto.js:115` and `:136` test
`options.hasOwnProperty('serializers')` / `('formatters')`, which `Object.hasOwn` matches
exactly. `:161` does not: it tests `typeof options.redact === 'object' && options.redact !==
null`, an ordinary property read that walks the prototype chain. So:

```
const opts = Object.create({ redact: { paths: ['nothing.here'], censor: 'x' } });
logger.child({ s: 1 }, opts)                 -> NOT refused
child.error({ password: 'PROTO-BYPASS-MARKER' }, '…')
  -> {"s":1,"password":"PROTO-BYPASS-MARKER","msg":"…"}      (root emits "[redacted]")
```

The scan still ran (the inherited `formatters` was correctly ignored by pino too), so only
`redact` was replaced. Why this is not a finding: no external attacker constructs a child
logger's options object; no call site in `apps/api` passes options at all; and ADR-0028 step 2
deletes the `redact` option, after which the only key pino reads prototypically is gone and
`Object.hasOwn` is exactly right for the two that remain. Worth one line in the
`childOptionsChecked` docblock; not worth a fix.

**2. The format-argument scan reaches one level shallower than the record scan, and the
residual list does not say so. NOT filed — documentation precision.**

`FORMAT_ARGUMENT_SCAN_DEPTH = 2` (`logger.ts:272`) versus `errorsReplaced(record, 1)` on the
record path, against the same `MAX_ERROR_SCAN_DEPTH = 4`. Measured:

```
logger.error('%o', { a:{ b:{ c:{ err: e } } } })
  -> "msg":"{\"a\":{\"b\":{\"c\":{\"err\":{\"body\":\"{\\\"password\\\":\\\"EDGE-MARKER\\\"}\"}}}}}"
```

That is an error at nesting level **4** leaking through a format argument, while residual 1 —
`logger.ts:508` and `logging-and-headers.md:558-567` — says "depth 5 or deeper" without
qualifying which path. The trade itself is deliberate and documented ("the price is one level
of reach", `logger.ts:264-271`); the residual list is what understates it. Same class as
F-265: the residual should name the path it applies to.

**3. The contract's "The residuals" section still says "Two shapes" while the source states
three.** `logging-and-headers.md:553` opens "**Two shapes reach a line with a library's
assigned properties still on them**" and lists depth-5 and the class instance;
`logger.ts:503-526` lists three, adding F-265's `toJSON`. The contract acknowledges F-265 only
inside the PENDING ADR-0028 block at `:61-63`. The drift test cannot see this — the fenced
region ends at `isWalkable` and this is prose — so it will not self-correct. F-265 is
RESOLVED against the file it was filed against (`logger.ts`); this is the contract half.

**4. `apps/api/src/tenancy/tenant-context.ts:247` interpolates `error.message` into `msg`.**
Already disclosed at `logging-and-headers.md:880-884` ("reported but not fixed") and outside
TASK-003's paths. Not mine, not re-raised, but it is the one live instance of the one shape no
mechanism in this module can reach, and it currently has no owner.

**5. `helmet` is still not registered.** `grep -rn helmet apps/api/src apps/api/package.json`
returns nothing. Contract invariant 4 — HSTS, `nosniff`, `DENY` on every API response — is
false in the shipped `main.ts`, and the contract says so at `:816-819`. That is F-243 clause 2,
explicitly escalated and unowned, and it is not one of my twelve. Flagged because TASK-003
cannot honestly be certified against `logging-and-headers.md` while an invariant that contract
assigns to it is false with no finding tracking it.

**6. Deploy surface, read after the package was regenerated — nothing changes above.**
`Dockerfile` sets `ENV NODE_ENV=production` and no `LOG_LEVEL`, so the shipped logger runs at
`info` in production: the F-261/F-262/F-266 shapes are all `logger.info`-reachable on the
deployed image, which is the level at which a request-logging middleware would write. No
secret is baked into the image (`GIT_COMMIT_SHA` only, and AC-6 publishes it unauthenticated
anyway); `.dockerignore` excludes `.env*`, `.npmrc`, `*.pem`, `*.key`, `.git` and `.sdlc`.
`infra/deploy.sh` prints host, database and role from the migration DSN and never the
password, and refuses a loopback target, a dirty tree and a non-TTY stdin. `fly.toml` sets no
`[env]` and no `[build.args]`. Nothing in these six files touches the logger's configuration,
and no verdict above leaned on their absence — in particular F-268 was judged by reading
`eslint.config.mjs` in the working tree and probing the rule, never from the diff.

**Suite state.** `pnpm test` — 110 passed / 6 failed (116). The 6 are TASK-008's
`not implemented` throws in `apps/web/src/lib/api/client.ts:77`, as briefed. `apps/api` alone:
10 files, 89 tests, all green, including `logger.spec.ts` (28), `logger-contract-drift.spec.ts`
(5) and `framework-400-request-body.spec.ts` (9).

**Read-only compliance.** One source mutation was performed to kill the F-264 mutant
(`logger.ts:339`), restored immediately and verified byte-identical by md5 and `diff -q`.
Probe scripts were written to the scratchpad; two had to be run from `apps/api/` to resolve
`pino` and `@nestjs/common`, so they were copied in, executed and deleted, and
`git status --porcelain` was checked after each. The only modified path in the working tree is
`.sdlc/foundation/design/adr-0028-log-field-allowlist.md`, which was already modified before
this audit began (the `proposed` → `accepted` frontmatter correction) and which I did not
touch. I did not edit `findings.yaml`, and I set no owner.

**Could not verify.** Nothing in scope was unverifiable. Every claim above was either measured
or read from the working tree. The one thing I did NOT attempt is running the deployed image
or `infra/deploy.sh` end to end — no Fly credentials, no Docker daemon exercised — so the
deploy-surface observations in Note 6 are from reading those files, not from executing them.

## Dependencies reviewed

One dependency added in `af4e5bb..HEAD`.

| package | version | assessment |
|---|---|---|
| `pino` | `10.3.1` | Exact-pinned, no caret, no tilde, per ADR-0018. `pnpm-lock.yaml` regenerated and committed alongside `apps/api/package.json`. Transitives: `atomic-sleep`, `on-exit-leak-free`, `pino-abstract-transport@3.0.0`, `pino-std-serializers@7.1.0`, `process-warning@5.1.0`, `quick-format-unescaped@4.0.4`, `real-require`, `safe-stable-stringify@2.5.0`, `sonic-boom@4.2.1`, `thread-stream@4.2.0` — all first-party to the pino org or long-standing single-purpose modules, MIT. `pnpm audit --prod --no-optional --audit-level moderate`: **No known vulnerabilities found.** |

`quick-format-unescaped` is worth naming explicitly: it is the module that made door six
(F-260) possible, it remains in the tree, and F-260's fix works by reducing values BEFORE they
reach it rather than by removing it. `pino-std-serializers` is installed but its `err`
serialiser is deliberately never used (`logger.ts:688-702`); a later edit reaching for it
reopens F-111.

No dependency was bumped. `drizzle-kit` is deliberately kept OUT of the runtime image
(`Dockerfile`, `fly.toml`, F-119 settlement), which is what keeps GHSA-67mh-4wv8-2f99 out of
the production graph — that assessment in `docs/security/known-advisories.md` is still true of
the shipped Dockerfile, verified by reading the `pnpm install --frozen-lockfile --prod` line.
