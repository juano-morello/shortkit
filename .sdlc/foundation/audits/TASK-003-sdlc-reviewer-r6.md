# TASK-003 — sdlc-reviewer, round 6 (FINAL, whole-TASK, post-ADR-0028)

Reviewed: `.sdlc/foundation/work/TASK-003-review-final.diff` (`af4e5bb..917c601`, 26 files,
pathspec `':!.sdlc'`), read against the whole files, `.sdlc/foundation/tasks/TASK-003.md`,
`adr-0028-log-field-allowlist.md`, `adr-0022-…`, `adr-0026-…`,
`contracts/logging-and-headers.md`, `contracts/error-envelope.md`, and the shipped
`node_modules/.pnpm/pino@10.3.1` source. Every claim below was measured against the shipped
singleton or the booted bundle, not read off a commit message.

```yaml
verdict: changes-requested
```

## What blocks `done`

**One blocker.** A non-`Error` container in a log call's *message position* is serialised
whole into `msg`, bypassing `LOGGABLE_FIELDS`, `formatters.log`, `serializers.err` and both
bindings wrappers. The call shape typechecks and lints clean. Measured on the shipped module:
a bearer token, a raw client IP and a password on one line.

Everything else is major and below.

---

## Findings

```yaml
findings:
  - severity: blocker
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 239
    summary: >-
      interpolationCovered only rewrites the MESSAGE position when args[1] is an Error, so a
      non-Error container in that position is JSON-serialised whole into `msg` with no
      mechanism on the path at all.
    failure_scenario: >-
      `p.catch((e) => logger.error({ request_id }, e))` — `e` is `any` in a `.catch`
      callback, so this typechecks (`tsc --noEmit` clean) and lints clean (`no-explicit-any`
      bans the annotation, not the inferred type; `no-unsafe-argument` is not enabled because
      eslint.config.mjs uses the non-type-checked `tseslint.configs.recommended`).
      MEASURED against the shipped singleton, 2026-08-10:
        Promise.reject({ statusCode: 401, clientIp: '203.0.113.9',
                         headers: { authorization: 'Bearer LEAKED-TOKEN' },
                         body: '{"password":"LEAKED-PASSWORD"}' })
          .catch((e) => logger.error({ request_id }, e));
      emits
        {"level":"error",…,"request_id":"r-9","msg":{"statusCode":401,
         "clientIp":"203.0.113.9","headers":{"authorization":"Bearer LEAKED-TOKEN"},
         "body":"{\"password\":\"LEAKED-PASSWORD\"}"}}
      Path traced: `hooks.logMethod` branch 1 needs `thrown instanceof Error` (the record is
      not); branch 2 needs the record to carry an `err` key (it does not); `interpolationCovered`
      computes `messageArgumentIndex(args) === 1` and then tests `args[1] instanceof Error`,
      which is false, so `covered = args`; the interpolation loop starts at `message + 1 === 2`
      and never touches `args[1]`. pino's `LOG` then does `msg = n.shift()`, quick-format's
      `format(f, [], …)` returns the object unchanged for `len === 1`, and `_asJson`'s `msg`
      arm hits its `default:` branch and calls `stringify(value)`.
      Four of the five leaked names — `clientIp`, `authorization`, `body`, `password` — are on
      the contract's own never-allowlist. This violates GC-9, contract invariant 8 ("A field
      that is not named in LOGGABLE_FIELDS does not reach the line"), and the source's own
      claim at logger.ts:221-222 that "A CONTAINER in either position is scanned".
      Nothing in the suite covers it: logger.spec.ts ordinal 21
      (`LINE.errorInTheMessagePosition`) uses `parseFailure`, an `Error`, which takes the
      branch that exists. No emitter line passes a non-Error in the message position.
    required_change: >-
      A container in the message position must reach a line under the same policy as one in a
      format-argument position. After the fix, `logger.error({ request_id }, { password: 'P' })`
      must not put `P` on the line, and `logger.error({ request_id }, plainObjectWithErrKey)`
      must keep behaving as it does now. The existing `errorMovedOntoTheRecord` seam is the
      obvious place, but the shape of the answer is Design's: moving an arbitrary container
      onto the record under `err` would hand it to `serializers.err`, which reduces a non-Error
      to `err_name: 'non-error throwable (object)'` and discards it — that may be the right
      answer, but it is a behaviour change to invariant 6's table and needs stating. Whatever
      lands, logger.ts:221-222's "either position" claim must become true or be corrected, and
      a red test must exist for a non-Error container in the message position.

  - severity: major
    kind: contract
    file: .sdlc/foundation/design/adr-0028-log-field-allowlist.md
    line: 455
    summary: >-
      Migration step 3's call-site sweep — the ADR's own stated safety net, marked "Run, and
      re-verified against the shipped list on 2026-08-10. Nothing degrades." — misidentifies
      two of the eight sites it enumerates. `db/client.ts:93` and `tenant-context.ts:247` are
      not on the shared logger at all.
    failure_scenario: >-
      `apps/api/src/db/client.ts:55` and `apps/api/src/tenancy/tenant-context.ts:136` each
      declare `const logger = new Logger('…')` imported from `@nestjs/common` — verified: neither
      file imports `observability/logger`, and `grep -rn "new Logger(" apps packages` returns
      exactly those two. The ADR says of them "pass a string and no record, so the key rule does
      not reach them. `msg` covers what they emit", which reads as "they are shared-logger call
      sites whose fields are safe". They are a second log surface with none of the six
      mechanisms, no JSON, no `service`/`env`/`request_id`, and ANSI colour codes.
      `tenant-context.ts:247` writes `error.message` of an arbitrary afterCommit failure to
      stdout through it. The contract's own boundary sentence — "Consumed by: every API TASK.
      Nothing may opt out" — is therefore measured false, and nothing in the build catches it:
      F-268's lint rule in eslint.config.mjs restricts importing `pino`, not `@nestjs/common`'s
      `Logger`. F-274 exists but is filed on a false premise — its failure_scenario reasons
      about `msg` being "built by the call site, before pino", which presumes the line goes
      through pino at all.
    required_change: >-
      The ADR's completed-sweep claim must be corrected to say what those two sites actually
      are, and F-274 must be re-scoped to "two modules log through Nest's Logger, outside every
      mechanism" rather than "one call site interpolates a message". If "Nothing may opt out" is
      to stay in the contract, something must enforce it — the natural extension is F-268's lint
      block, adding `@nestjs/common`'s `Logger` to the restricted imports for
      `apps/api/src/**/*.ts`. The code change itself is TASK-005's and outside this TASK's
      paths; the false claim in an `accepted` ADR whose Migration says COMPLETE is this TASK's.

  - severity: minor
    kind: implementation
    file: apps/api/test/security/security-headers.int-spec.ts
    line: 213
    summary: >-
      The invariant-3 CORS guard probes with no `Origin` request header, so it cannot see a
      reflective CORS configuration.
    failure_scenario: >-
      Invariant 3 reads "The API sends no `Access-Control-Allow-Origin` header, for any origin,
      on any route", and the probes are bare `fetch(baseUrl + path)` with no `Origin`. The
      `cors` package Nest's `enableCors` uses only emits the header for `origin: true` (reflect)
      when the request carries an `Origin`: `configureOrigin` sets the value to
      `req.header('Origin')`, and `applyHeaders` skips a falsy value. So a later TASK adding
      `app.enableCors({ origin: true, credentials: true })` to `main.ts` — the shape someone
      reaches for when a browser complains — ships a reflecting API with this test green.
      `enableCors()` and `enableCors({ origin: 'https://x' })` are caught, because those set the
      header unconditionally.
    required_change: >-
      One of the two probes sends an `Origin` header (any value) and the assertion covers that
      response too, so the invariant's "for any origin" clause is exercised rather than assumed.

  - severity: minor
    kind: contract
    file: apps/api/src/observability/logger.ts
    line: 618
    summary: >-
      `fieldsCensored`'s docblock still argues the `Array.isArray` ternary on the rationale
      F-275 measured false, and now directly contradicts the corrected inline comment thirty
      lines below it inside the same function.
    failure_scenario: >-
      logger.ts:618-623 says the bare spread "would turn an ARRAY handed in as the whole record
      into an object keyed `"0"`, `"1"`. Contract invariant 5 names `[e, e]` as a covered shape,
      so the copy keeps the array branch" — a behavioural claim. logger.ts:409-411 (and the
      contract fence, and ADR-0028's "Deviations" ruling) says the opposite: "It changes no
      emitted byte — measured, both forms — so it is a type guarantee, not a behavioural one."
      A reader who resolves the contradiction by testing measures identical bytes, concludes the
      docblock is the current one and the inline comment wrong, and deletes the ternary —
      losing the `<T extends object>(record: T): T` soundness that is the real reason. F-275 was
      filed as a `nit` against a stale claim; it is now a self-contradiction inside one function,
      which is worse than the finding as filed.
    required_change: >-
      The docblock carries the type-soundness rationale only, and does not re-argue bytes.
      Comments are stripped by the drift comparison, so this costs no contract edit.

  - severity: minor
    kind: contract
    file: .sdlc/foundation/design/contracts/logging-and-headers.md
    line: 30
    summary: >-
      The mechanism table and two comments inside the normative fence send the reader to a
      section "Door six" that this contract does not contain.
    failure_scenario: >-
      `grep -n "Door six"` on the contract returns exactly three hits: the `hooks.logMethod`
      table row's Section column (:30) and the fence's own comments (:222-223, :232). There is
      no `### Door six` heading. So the rationale the fence defers to — "The two argument roles
      get two different answers; see 'Door six' for why" — exists nowhere in the normative
      artifact, and it is precisely the rationale the blocker above turns on. The drift test
      cannot catch this: comments are stripped before comparison.
    required_change: >-
      Either the section is written (and it should state, correctly, which argument positions
      are scanned and which are not) or the three references are re-pointed at a section that
      exists.

  - severity: minor
    kind: behavior
    file: apps/api/src/main.ts
    line: 236
    summary: >-
      Nest's own framework logger is left at its default, so the deployed process interleaves
      ANSI-coloured non-JSON lines with pino JSON on stdout.
    failure_scenario: >-
      MEASURED against `node dist/main.js` on loopback, 2026-08-10: stdout carries
      `\x1b[32m[Nest] 1341083  - \x1b[39m08/10/2026, 2:17:54 PM …[NestFactory] Starting Nest
      application...` and five more like it, then pino JSON. The contract's Boundary is "every
      log line the API emits" and its Consumed-by is "Nothing may opt out". A log shipper
      parsing NDJSON drops those lines or files them as parse errors; a Nest internal error at
      init writes a stack the same way, outside `errorLogFields`. `main.ts` is this TASK's file
      and `NestFactory.create(AppModule, { logger: … })` is the one seam.
    required_change: >-
      Either the framework logger is routed through the shared pino instance (a `LoggerService`
      adapter) or disabled, or the contract's Boundary sentence is narrowed to say framework
      bootstrap lines are outside it and why. Not both silent.

  - severity: nit
    kind: contract
    file: apps/api/src/observability/logger-contract-drift.spec.ts
    line: 33
    summary: >-
      The spec's docblock still defines the normative region as ending "through the end of
      `isWalkable`", a declaration ADR-0028 deleted.
    failure_scenario: >-
      The code is right — REGION_END is `export interface RequestLogFields` — and the contract
      already corrected itself on this point ("`isWalkable` used to be the last declaration in
      the region. ADR-0028 removed it"). Only the spec's prose is stale. Same class as F-276,
      which fixed the two anchors that execute and left the one that does not.
    required_change: The docblock names the region the constants actually cut.

  - severity: nit
    kind: contract
    file: apps/api/src/common/errors/exception-filter.ts
    line: 235
    summary: >-
      The framework-400 arm's comment reasons about `REDACT_PATHS`, a mechanism ADR-0028
      removed, to justify a live decision.
    failure_scenario: >-
      "…and `REDACT_PATHS` is a path list that cannot reach inside a string." The conclusion
      survives ADR-0028 (no censoring scheme reaches inside a string, as the contract now says
      in general terms) but the premise names a deleted declaration, so a reader checking it
      finds nothing and cannot tell whether the decision still holds.
    required_change: The comment cites the surviving general statement rather than the removed list.

  - severity: nit
    kind: contract
    file: .sdlc/foundation/design/adr-0028-log-field-allowlist.md
    line: 476
    summary: "`code` is named with no emitter today" is false; two call sites emit it.
    failure_scenario: >-
      `exception-filter.ts:181` (`log.warn({ code: body.code }, …)`) and `:195`
      (`log.error({ code: exception.code }, …)`) both emit `code`. The same sweep lists those
      two line numbers as call sites without saying what they emit. Harmless to the mechanism —
      `code` is on the list — but it is a wrong statement inside the artifact this TASK offers
      as evidence that the sweep was done.
    required_change: The sweep names `code`'s two emitters.
```

---

## Focus items, answered

### 1. The allowlist itself

**Sound at both enforcement points, with one gap that is not in either of them** (the blocker
above is on the `hooks.logMethod`/format path, not on `formatters.log` or the wrappers).
Checked against pino 10.3.1's actual `_asJson` and `asChindings` rather than the docblocks:

- `_asJson` iterates `for (const key in obj)` **guarded by `Object.prototype.hasOwnProperty.call(obj, key)`** (`tools.js:165-167`), so `Object.keys` in `fieldsCensored` and pino's own emission agree on exactly the same key set. Verified by probe: `logger.info(Object.create({ password: 'PROTO-SECRET' }), '…')` emits no `password` key at all. An inherited-property bypass does not exist.
- `asChindings` uses the same `hasOwnProperty` guard (`tools.js:249-256`).
- `base` (`service`, `env`) is serialised in the pino constructor, before the two
  `Object.defineProperty` installations, so it is **not** censored. Verified:
  `{"service":"shortkit-api","env":"production",…}`.
- Circular records terminate: `{ route: obj }` with `obj.route = obj` reaches `MAX_SCAN_DEPTH` and censors.
- `__proto__` as an own enumerable key (JSON-parsed input) is censored correctly — the spread
  creates an own data property, so the assignment writes to it rather than to the prototype setter.
- A cross-realm `Error` fails `instanceof` and falls to the key rule, which censors it. Safe direction.
- Load-bearing degradation: **none.** I re-ran the sweep against source rather than trusting it.
  `main.ts:199` (`boot_precondition`, `attempt`, `retry_in_ms`, + `errorLogFields`),
  `main.ts:293` (`boot_precondition` + `errorLogFields`), `exception-filter.ts:125`
  (`request_id`), `:181`/`:195` (`code`), `logError`'s one caller with fields (`{ status }`).
  All thirteen names cover it. `logger-field-allowlist.spec.ts`'s
  `fieldsTheCallSitesEmit` asserts all ten of the reachable ones with their values, which is
  what stops "censor everything" passing.
- `code` **does** have emitters today, contrary to the ADR (nit above).

Two residuals I could not turn into a realistic failure, recorded rather than filed:
- A plain object (prototype `Object.prototype`) with **zero own enumerable keys and a
  non-enumerable `toJSON`**, sitting under a *named* key, is returned unchanged by
  `fieldsCensored` and then serialised from `toJSON`'s return value. Measured:
  `logger.info({ route: sneaky }, …)` emits `"route":{"password":"TOJSON-SECRET"}`. It needs a
  named key (thirteen of them, all expected to hold primitives) plus a deliberately
  non-enumerable `toJSON`. No library shape I can name produces it. Suspicion, not a finding.
- `MAX_SCAN_DEPTH` is pinned by no test now, and `logger-field-allowlist.spec.ts` says so in
  place. The reasoning holds: past the bound a container is censored, so both directions are
  additive to leak-safety. What a mutation would remove is termination on a self-referential
  record, and the versioning rule in the contract covers that. Not a finding.

### 2. helmet, and invariant 4

**Invariant 4 holds, and holds wider than the seven tests assert.** Registered at
`main.ts:259` on the app, after `NestFactory.create` and before `setGlobalPrefix`, which is
correct: `app.use` pushes onto the Express router stack immediately, while Nest's own parser
and router middleware are registered during `init()`, which `listen()` triggers eight lines
later. So helmet is first in the stack.

Measured independently, `node dist/main.js` on loopback:
- routed `/health` 200 and the branded 404 — the two the int-spec probes — carry
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` (no `preload`),
  `X-Content-Type-Options: nosniff`, **`X-Frame-Options: DENY`** (not helmet's `SAMEORIGIN`),
  `Referrer-Policy: no-referrer`, and a CSP with `default-src`.
- **A body-parser 400 also carries them all**, which the int-spec does not cover and which is
  the response class registered-inside-a-module middleware would have missed. Confirmed with a
  malformed-JSON POST to `/api/nope`.
- `X-Powered-By` is gone, as documented.

One class of response carries no helmet headers and cannot: a request Node's own HTTP parser
rejects before any JS runs (`Content-Length: 999999999999999999999` → `400 Bad Request`,
`Connection: close`, no other headers). No middleware can reach it. Recorded so a later
auditor does not file it as a defect; the contract may want to say so.

### 3. The five rewritten guards

**All five still bite. None is a tautology.** I traced the mutation each one is supposed to
catch rather than accepting the report's claim:

| guard | asserts | mutation it still catches |
|---|---|---|
| `F-244: a secret at the top level…` (ordinal 3) | `password`/`token`/`ip`/`req` each `=== '[redacted]'` | drop the `LOGGABLE_FIELDS.has(key)` arm → each key emits its marker; both the raw-contains and the equality fail |
| `F-248: …one level down` (ordinal 8) | `record.ctx === '[redacted]'` | drop the key arm → `ctx` becomes `{err:{err_name,…}}`, not the censor string |
| `F-251: …nested in child bindings` (ordinal 11) | `record.ctx === '[redacted]'` + no marker in raw | drop `bindingsScanned` from `childWithFieldsCensored` → `ctx` carries body-parser's assigned `body`; the raw-contains assertion fails first |
| `F-257: …four levels in` (ordinal 16) | `record.a === '[redacted]'` | drop the key arm → `a` becomes `{b:{c:{d:'[redacted]'}}}`, not the censor string |
| `F-258: …bound by setBindings` (ordinal 29) | `record.ctx === '[redacted]'` **and** `record.error.err_name === 'SyntaxError'` with no unpolicied keys | drop the `setBindings` wrapper → `error` carries `body`; the raw-contains assertion fails |

Three of the five (F-248, F-251, F-257) now assert only "the container is `[redacted]`", which
a hypothetical "censor every object-valued key" implementation would also satisfy. That is not
a hole, because `logger-field-allowlist.spec.ts`'s three
"what the allowlist may not censor" tests and ordinal 29's `err_name` assertion are what stand
against a scan that censors too much. The pairing is sound.

One thing the rewrite genuinely lost and disclosed: F-257's original required_change was
"assert the POSITIVE half — an error at depth 4 IS replaced". That assertion is now
unwritable, because `a` is censored at depth 1 before the walk reaches depth 4. F-257 should be
ruled **superseded by ADR-0028**, not **resolved** — the guarantee it asked for no longer
exists in a form a test can address, and the spec says so in place.

### The two accepted deviations, judged independently

- **`Array.isArray(record) ? [...record] : { ...record }`.** The architect's measurement is
  correct — I re-derived it from `_asJson`, which writes own enumerable keys either way, so an
  array record emits `"0":…,"1":…` under both forms. The ternary should be kept, for the
  `<T extends object>(record: T): T` reason and no other. The docblock that still argues bytes
  is the minor finding above.
- **`interpolationSafe` → `valueCensored(value, 1)`.** Correct, and the `+ 1` inside
  `valueCensored` is doing exactly what the comment claims. Traced: a format-argument container
  is walked by `fieldsCensored` at depth 2, where `depth === 1 && key === ERROR_KEY` cannot
  fire, so `logger.error('ctx %o', { err: e })` stays closed. Routing it through
  `fieldsCensored(value, 1)` instead would reopen it. Accept.

### `childOptionsChecked`, since it is load-bearing now

**Sound.** Verified against `proto.js:114-165` rather than the docblock, and by probe:
- pino gates `serializers` and `formatters` on `options.hasOwnProperty(…)`, which is exactly
  what `Object.hasOwn` tests. An **inherited** `formatters` is not honoured by pino — probed:
  `logger.child(b, Object.create({ formatters: { log: (o) => o } }))` still censored
  `password`. So the check's polarity matches pino's.
- pino gates `redact` on `typeof options.redact === 'object'`, a plain read, so an inherited
  `redact` **is** honoured and `Object.hasOwn` does not see it. Probed: it applied. This cannot
  weaken anything — a child-supplied `redact` only adds censoring on a root that has none —
  but the docblock's "pino tests `hasOwnProperty` for `serializers` and `formatters`" is
  accurate precisely because it does not claim `redact`. No finding.
- `typeof supplied !== 'object'` lets a *function* through unchecked. Not reachable from any
  typed call site and not worth a branch.

---

## Ruling on the seven unjudged minors

- **F-119** — discharged. `fly.toml` has no `release_command`, the reasoning and the three
  accepted costs are written beside its absence, and `infra/deploy.sh` sequences the migration
  before the deploy with the image proved buildable first. Ledger status is still `open`.
- **F-217** — discharged. `HealthModule` is in `AppModule`, `GET /health` answers 200 at the
  root (measured on the booted bundle: `Mapped {/health, GET} route`).
- **F-225** — materially mitigated, doc clause NOT written. The residue it names is now
  structurally impossible: `build-commit.ts` has no fallback and throws, the Dockerfile's
  runtime stage greps the ARG against the same regex, and `main.ts` refuses at boot. But its
  actual required_change was a sentence in `test-strategy.md`'s AC-6 entry and in the product
  auditor's brief — "verifying the exempt half means COMPARING the deployed `/health` commit
  against the SHA that was deployed". `test-strategy.md:169` still says only
  "`sdlc-product-auditor` verifies this half against the deployed URL." Stays **minor**; it is
  the product auditor's brief that carries the risk now, not the code.
- **F-243** — clause 1 discharged (paths corrected in the card), clause 2 discharged (helmet,
  verified above), **clause 3 not discharged**. `db/client.ts:54` and
  `tenant-context.ts:135` still read "TASK-003 replaces this with the pino logger." and the
  line under each still constructs `new Logger(…)` from `@nestjs/common`. That is the major
  finding above; the comments are the visible half of it.
- **F-250** — discharged. ADR-0022 carries zero fenced blocks and zero occurrences of
  `serializers`; the contract is the single normative source and says so.
- **F-257** — should be ruled **superseded**, not resolved. See above.
- **F-259** — discharged. `readIndexedProperty`'s docblock now states plainly that the guard
  "DOES NOT MAKE THE SCAN THROW-FREE" and names the spread as the remaining throw site; the
  contract's "A log call can still throw" section carries the four-row measurement. Option 1
  of the two the finding offered, taken honestly.

---

## Cannot verify from diff

- **AC-6's exempt half.** Whether the deployed Fly URL answers `/health` over HTTPS with a
  `commit` equal to the SHA that was deployed. No deploy has happened from this tree; it is
  `sdlc-product-auditor`'s by the test-strategy ruling.
- **`infra/deploy.sh` end to end.** Guards 1-4 are readable and correct on inspection; guard 5
  (`docker build`) and the `fly deploy` handoff were not executed. The DSN parse is
  best-effort by design and guard 4 prints what it parsed, so a misparse is visible.
- **The Dockerfile builds.** Not run. The `ARG`-inside-stage claim and the grep guard are
  correct as written.
- **Whether `apps/api/test/support/**` and `apps/api/test/auth/**` are ratified into this
  TASK's `paths`.** The diff touches four files under `test/support/` and one under
  `test/auth/`, and the corrected front-matter lists neither — it lists
  `apps/api/test/security/**` only. Three of those files carry a
  "⚠ THIS FILE IS sdlc-test-architect'S" banner, so this may be deliberate cross-slot work
  rather than an omission. The orchestrator holds that context.
- **Whether F-274's re-scope and the ADR-0028 sweep correction are gating `done` or are
  follow-up.** The major finding says what is false; who fixes it and when is routing.

## Notes

- Gates re-run here and matching the reported state: `apps/api` observability suite 54/54
  (`logger.spec.ts` 28, `logger-field-allowlist.spec.ts` 11, `logger-contract-drift.spec.ts` 6,
  `framework-400-request-body.spec.ts` 9); root unit 122 passed / 6 failed of 128, the six being
  TASK-008's `not implemented` throws from `apps/web/src/lib/api/client.ts:77`;
  `security-headers.int-spec.ts` 7/7; `tsc --noEmit -p apps/api/tsconfig.json` clean.
- The drift test is doing real work. `FENCE_MARKER` is `export const LOGGABLE_FIELDS` and the
  quote guard is re-anchored on the child-options refusal message, which does carry the hazard
  it claims (`logger's` and `an error's` inside template literals joined by a ` + ` that is
  code). The added hand-written case genuinely separates a quote-blind stripper from a real
  one. F-276's two executing anchors are fixed.
- `eslint.config.mjs` **is** in this package (the round-5 pathspec dropped it) and does carry
  F-268's rule: `no-console: error` and a `no-restricted-imports` block on `pino` for
  `apps/api/src/**` excluding the logger module itself. It is what makes the second-pino-instance
  prohibition a mechanism. It does not reach `@nestjs/common`'s `Logger` — see the major finding.
- `exception-filter.ts`'s `requestId()` truncates a caller-supplied `x-request-id` at 128
  characters and JSON-encodes it, so the header cannot split a record. `request_id` is a named
  field, so an attacker-chosen 128-byte string does reach the log verbatim; that is the
  contract's stated design, not a defect.
- `logError`'s `includeMessage: isDomainError(exception)` is correct against
  `error-envelope.md`, and the framework-400 arm was measured clean end to end on the booted
  bundle: a POST of `{"password":"SEKRIT-KEY-MARKER"` emits `err_name: "BadRequestException"`,
  frames only, no `err_message`, and the marker appears nowhere on the line.
