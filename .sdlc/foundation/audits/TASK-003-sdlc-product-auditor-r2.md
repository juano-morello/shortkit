# TASK-003 Product Audit — round 2 (AC-6, STORY-002)

`sdlc-product-auditor`, 2026-08-10. Read-only. Range audited: `af4e5bb..917c601`
(`.sdlc/foundation/work/TASK-003-review-final.diff`).

Everything below was measured in this environment. Where I read rather than ran, I say so.

---

```yaml
verdict: changes-requested
ac_verification:
  - id: AC-6
    status: partial
    evidence: >-
      in-process half: apps/api/src/health/health.spec.ts::"GET /health" (3/3 green);
      apps/api/test/security/security-headers.int-spec.ts::"both probed responses really were
      served" (real dist/main.js boot, /health -> 200); apps/api/src/health/build-commit.ts:38-51;
      image half: docker run of the shipped Dockerfile answered
      {"status":"ok","commit":"917c601a8068547752fa263cb765ecfe5535c8c9"} == git rev-parse HEAD.
      deployed half: NO EVIDENCE EXISTS. shortkit-api.fly.dev is NXDOMAIN from Fly's own
      authoritative nameservers.
    note: >-
      The clause "Given the API deployed to Fly.io ... requested over HTTPS" is not satisfied
      and cannot be satisfied by anything in this diff. Nothing has been deployed.
findings:
  - severity: blocker
    kind: behavior
    file: fly.toml
    line: 8
    summary: >-
      AC-6's deployed half is unmet: there is no Fly.io deployment. `shortkit-api.fly.dev`
      returns NXDOMAIN from ns1.flydns.net, so the app has never had a public IP allocated.
    failure_scenario: >-
      STORY-002 promises "both deployables reachable on the internet". The web half is live and
      verified (Vercel, 200 + HTML). The API half is not on the internet at all. Marking TASK-003
      `done` records a deployed API that does not exist, and TASK-003 is one of two TASKs before
      the wave-2 gate that completes the initiative - so the initiative would close claiming a
      reachable API with no API reachable.
    required_change: >-
      Run `infra/deploy.sh` against a real Fly app and a real Neon database, then re-verify:
      `GET https://<host>/health` returns 200, `status == "ok"`, and `commit` equals the SHA that
      was deployed (F-225's comparison, not an existence check). Until then AC-6 stays `partial`
      and TASK-003 cannot reach `done` on its only acceptance criterion.
  - severity: major
    kind: behavior
    file: docs/architecture/migrations.md
    line: 120
    summary: >-
      F-142 was assigned to this TASK and is not discharged. "At deploy" still states the Fly
      release command runs `db:migrate` before the machine takes traffic. `fly.toml` deliberately
      has NO `release_command` and `infra/deploy.sh` runs the migration from the working copy.
    failure_scenario: >-
      The doc now contradicts the shipped deployment shape in the direction that breaks
      production. A reader who believes it runs `fly deploy` by hand, expecting the platform to
      migrate, and ships code against an unmigrated schema - the exact state `infra/deploy.sh`
      guard 3 exists to prevent and which `fly.toml` names as accepted cost 3, "Nothing but the
      script sequences the two". `/health` still answers 200 because it touches no database, so
      the Fly check stays green while every DB-backed request 500s.
    required_change: >-
      Rewrite "At deploy" to describe what ships: no release command, migration runs from the
      working copy through `infra/deploy.sh` as `shortkit_migrator` before `fly deploy`, five
      guards, and the three costs `fly.toml` records. The card names this TASK as the owner:
      "You own fly.toml and the Dockerfile, so you settle F-119 and correct this section in the
      same change."
  - severity: minor
    kind: behavior
    file: apps/api/src/main.ts
    line: 236
    summary: >-
      `NestFactory.create(AppModule)` is called with no `logger` option, so the framework's own
      ConsoleLogger writes ANSI-coloured plain text to stdout in production alongside pino's JSON.
    failure_scenario: >-
      MEASURED in the shipped image: `[Nest] 1  - 08/10/2026, 5:15:34 PM     LOG [RoutesResolver]
      HealthController {/api/health}: +2ms`. GC-9 is "structured logs via pino" and the contract
      this TASK produces says "Consumed by: every API TASK. Nothing may opt out" - the framework
      writing the first lines of every boot is the one opt-out nobody assigned. A JSON-parsing
      ingest drops or mangles them, and the same logger carries Nest's own shutdown and
      `app.close()` failures, which are exactly the lines an operator needs during an incident.
      This is the identical argument F-060 made about `bootstrap().catch()` - the file it applies
      to is in this TASK's paths.
    required_change: >-
      Either route Nest's logger through the shared pino instance (`NestFactory.create(AppModule,
      { logger })` or `app.useLogger`), or record in the contract that framework lines are outside
      the pipeline and why. Preceded by a red assertion on the bytes, per the contract's own
      "assert the bytes, not the configuration".
  - severity: minor
    kind: contract
    file: .sdlc/foundation/design/contracts/logging-and-headers.md
    line: 44
    summary: >-
      Invariant 2's `tenant_id` half is false today and carries no "not true today" annotation,
      the way invariant 4 correctly did before helmet landed.
    failure_scenario: >-
      "Every line inside a tenant transaction carries `tenant_id`." The only module that logs
      inside a tenant transaction is `apps/api/src/tenancy/tenant-context.ts`, which logs through
      Nest's `Logger` (`:136`), emits no `tenant_id`, and is not JSON. `tenant_id` is in
      `LOGGABLE_FIELDS` with zero producers anywhere in `apps/api/src`. A later TASK reads the
      invariant as a property it may rely on. It is a plan.
    required_change: >-
      Annotate invariant 2 in place the way invariant 4 was, naming the two Nest-`Logger` call
      sites and F-243 clause 3, or discharge it. Same for the stale sentence at `:1076`, "F-268
      proposes a lint rule for this and is unowned" - the rule shipped in `eslint.config.mjs`.
  - severity: minor
    kind: scope
    file: apps/api/test/support/auth-fixture.ts
    line: 1
    summary: >-
      370-line Better Auth fixture with no consumer. Its only importer,
      `apps/api/test/auth/credential-auth.int-spec.ts`, was deleted by the 2026-08-09 re-scope
      when TASK-009 left with EPIC-002. TASK-003 edited this file two days earlier (3e4f42b).
    failure_scenario: >-
      Dead test infrastructure for a deferred initiative, carrying pinned claims about
      `better-auth@1.6.26` that nothing re-verifies. It typechecks and lints on every run, so it
      will be maintained by accident and trusted by the roadmap TASK that inherits it.
    required_change: >-
      Delete it, or move it to the roadmap entry that will need it. This is re-scope residue
      rather than a TASK-003 defect - flagged because it was in the audited range and because the
      brief asked what assumes departed work.
  - severity: minor
    kind: contract
    file: docs/architecture/rls.md
    line: 83
    summary: >-
      F-141's third instance is not discharged. The flag table still names
      `src/redirect/db/redirect-read.ts` and `src/gdpr/privileged-eraser.ts` as the files that set
      `app.redirect_context` and `app.privileged_erase`. Neither directory exists.
    failure_scenario: >-
      Both belong to work that left with the deferred EPICs (roadmap items 2 and 4). The table is
      headed "One file sets each flag" and two of its three rows name nothing. F-141's other two
      instances were closed - the boot row is now true (verified below) and `db:check-policies`
      does run in CI (`.github/workflows/ci.yml:259`) - so this is the one left.
    required_change: >-
      Mark both rows as unbuilt and name the roadmap item, the way `plan.md` handles the rest of
      the re-scope.
```

---

## 1. AC-6, verbatim, both halves

> **AC-6:** Given the API deployed to Fly.io, when `GET /health` is requested over HTTPS, then it
> returns 200 with a JSON body containing a `status` field equal to `"ok"` and a `commit` field
> matching the deployed git SHA.

The 2026-08-06 split (`design/test-strategy.md:153-170`) is on the record and I audited against it:
the in-process half is tested, the "deployed to Fly.io / over HTTPS" half is exempt from the suite
and is **mine to verify against a live URL**.

### 1a. In-process half — MET, and it is stronger than the r1 audit could show

- `apps/api/src/health/health.spec.ts` — 3/3 green, run by me. Real HTTP round trip against an app
  built from `AppModule`; asserts 200, `status === 'ok'`, and `commit === '3d1f7a…0c7b'`, a SHA
  nothing in the process can compute. That kills a hardcoded value, a placeholder, an empty string,
  a truncation and a read of the wrong variable.
- `apps/api/src/health/build-commit.ts:38-51` — no `??`, no `||`, no default parameter, no
  sentinel. Rejects `undefined` and anything failing `/^[0-9a-f]{40}$/`.
- `apps/api/test/security/security-headers.int-spec.ts` adds evidence the r1 audit did not have:
  it builds the bundle and runs `node dist/main.js` on a socket, and its first test asserts
  `['/health', 200]`. So `/health` resolves at the root **through the real composition root with
  the global prefix applied**, not only inside a testing module. F-217's failure mode is closed at
  the layer it actually occurs in.

### 1b. Image half — MET, and nobody had checked it before

F-225's residue is that the in-process test always sets `GIT_COMMIT_SHA`, so it cannot catch a
build that never supplies it. I closed that gap for the image, which is as far as it can be closed
without Fly. All four measured in this environment:

| Layer | Command | Result |
|---|---|---|
| Dockerfile guard, malformed SHA | `docker build --build-arg GIT_COMMIT_SHA=not-a-sha` | build **fails** at `Dockerfile:53` |
| Full image | `docker build --build-arg GIT_COMMIT_SHA=$(git rev-parse HEAD)` | succeeds |
| The deployable answering | `curl http://127.0.0.1:3999/health` against the container | `{"status":"ok","commit":"917c601a8068547752fa263cb765ecfe5535c8c9"}`, HTTP 200, `Content-Type: application/json`, and the value **equals `git rev-parse HEAD`** |
| Runtime refusal, tampered SHA | `docker run -e GIT_COMMIT_SHA=unknown` | exits non-zero, one pino JSON line, `msg: "the API failed to start"` |

The same run also verified two things TASK-003 carries but no AC covers:

- **F-116 / F-141 are true in the shipped image.** `docker run -e DATABASE_URL=postgres://postgres:…`
  (a superuser) exits **1** with
  `boot_precondition: "runtime_role_cannot_bypass_rls"` and the verdict
  `"DATABASE_URL connects as 'postgres', which is exempt from row-level security (superuser=true,
  bypassrls=true)"`. `docs/architecture/rls.md:160`'s "boot, before traffic" is now a true sentence.
- **Invariant 4 holds on the real deployable.** Every header on `/health` from the container:
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` (no `preload`),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a CSP,
  and **no `X-Powered-By`**. Seven integration tests assert the same against `dist/main.js`.

Docker artifacts I created were removed; `shortkit-postgres-1` left running as instructed. Working
tree clean.

### 1c. Deployed half — NOT MET. There is no deployment.

I am not passing this on the strength of the in-process half.

```
dns.google      shortkit-api.fly.dev  A  -> Status 3 (NXDOMAIN), authority ns1.flydns.net
cloudflare-dns  shortkit-api.fly.dev  A  -> Status 3 (NXDOMAIN), authority ns1.flydns.net
```

The methodology is controlled, so this is not a sandbox artifact:

- `debug.fly.dev` resolves through the same query path — `Status 0`, three A records. Fly publishes
  `*.fly.dev` for apps that exist; it published nothing for this one.
- TASK-004's live Vercel deployment answered me over HTTPS: `200`, `text/html`. My environment can
  reach and verify a live deployment when one exists.
- `shortkit.fly.dev` and `api-shortkit.fly.dev`: also NXDOMAIN. It is not a naming mismatch.

Corroborating, not load-bearing: no `flyctl` on PATH, no `~/.fly`, no deploy workflow under
`.github/workflows/`, and `infra/deploy.sh` cannot have completed here — it requires `flyctl`, a
TTY, and a non-loopback `DATABASE_MIGRATION_URL`. A local image `shortkit-api:a0b42624…` exists in
the docker cache, which is guard 5 having run at commit `a0b4262` on 2026-08-08 and stopped there.

**So the AC's opening clause — "Given the API deployed to Fly.io" — has never been true, and the
`commit`-versus-deployed-SHA comparison F-225 demands has no subject.** Everything TASK-003 built
makes that comparison correct *when* it happens. Nothing makes it have happened.

I am not calling this an implementation defect. It is a step nobody has taken, and it is the one
step AC-6 is actually about.

---

## 2. Scope — the honest read you asked for

### The measurement

Lines added by TASK-003 in this range, excluding `.sdlc/**` and the re-scope commit's three files:
**4,817**.

| Group | Added | Authorised by |
|---|---|---|
| Logger + its four spec files | **3,453** | GC-9, `logging-and-headers.md`, F-060/F-090 rulings — **no AC** |
| `main.ts` (boot preconditions, pino swap, helmet) | 251 | F-116, F-245, F-243 cl. 2 — **no AC** |
| Security-headers int-spec + its three support files | 398 | F-243 clause 2 — **no AC** |
| `exception-filter.ts` pino swap | 116 | F-090, F-108 — **no AC** |
| `infra/deploy.sh` | 145 | AC-6 + F-119/F-142 |
| `fly.toml` | 103 | AC-6 |
| `Dockerfile` + `.dockerignore` | 110 | AC-6, ADR-0027 |
| Health module (3 files) | 92 | **AC-6**, F-217 |
| `eslint.config.mjs` | 33 | F-268 — **no AC** |
| manifest + lockfile | 103 | F-075/F-085 |

**AC-6's own subject — a health endpoint and a deployable — is 450 lines, 9% of the TASK. The
logging subsystem is 72%.** Roughly 91% of what this TASK shipped is authorised by a finding, a
ruling or a Global Constraint, and by no acceptance criterion.

### Was it smuggled? No.

Every excursion has a written authorisation, and most were ruled by you on the card by name: F-060
(`main.ts`), F-090 (`common/errors/**`), F-116 (the RLS call site), F-075/F-085 (manifest and
lockfile), the 2026-08-10 helmet ruling, the 2026-08-10 ADR-0028 ruling. The implementer flagged its
own path excursion (F-243) rather than making it quietly. The `paths` front-matter was corrected —
late, and the card says so plainly. This is not a TASK that took territory. Nothing here was hidden.

### Was it one TASK? No, and I think that is the finding.

The mechanism is visible in the card itself. Every ⚠ section is a cross-cutting obligation arriving
because **this is the TASK that owns `main.ts`**: three earlier TASKs left `// TASK-003 replaces
this with the pino logger` comments in files they owned, the logging contract named a producer with
no path, and F-116's function had no call site. None of that was costed anywhere. The composition
root became the destination for everything nobody else could hold, and the routing was by file
ownership rather than by size.

Two blocks were TASK-sized work in their own right, on the project's own evidence:

**The logging and redaction subsystem.** 3,453 lines, five audit rounds, ~30 findings, six days,
*two* ADRs — and the second one, ADR-0028, needed a full red→green cycle that you had to rule
**outside the rework counter** because the fix-round cap did not fit it. A cap sized for TASK-sized
work does not fit because the work was not TASK-sized. GC-14 says size a TASK to one focused
sitting. Rounds 3, 4 and 5 were each larger than that on their own.

**Helmet and the security headers.** Assigned 2026-08-10, four days after this TASK first went to
audit, arriving with its own contract section, its own invariant, a new integration test file and
three new support files. `apps/api/test/security/**` had to be added to `paths` to receive it. That
is a TASK being appended to a TASK.

Had they been separated, each would have had its own card, its own ACs, its own sizing and its own
Design gate — and the observability findings would have routed by `paths` rather than by the `**`
fallback, which the card discloses routed correctly **by luck** for six days.

### What is under-specified because no AC describes it

You named this precisely: **no acceptance criterion anywhere describes the logging redaction
policy**, which is the largest thing this TASK built. Three consequences, and they are not
theoretical:

1. **Nothing states the acceptance bar, so the verification is circular.** GC-9's entire written
   requirement is "structured logs via pino; no PII in log bodies". Everything else — allowlist
   polarity, `MAX_SCAN_DEPTH = 4`, six doors, `[redacted]` naming its own key, the never-allowlist,
   `childOptionsChecked` — was decided inside Design and Implement. The tests assert the contract,
   the contract describes the code, and the code was written by the same TASK. There is a normative
   contract and a machine-checked drift test, and those are a good substitute for an AC — but a
   contract states what the code *does*. An AC states what the initiative *promised*. The second was
   never written, so "does this meet GC-9" has no non-circular answer.
2. **The verdict a green suite gives you is "the code does what the code does".** The one thing I
   could check independently was whether the four open majors are actually closed. They are: I
   emitted the F-261, F-262 and F-266 reproductions through the shipped singleton and got
   `"remoteAddress":"[redacted]"`, `"clientIp":"[redacted]"`, `"trustedClientIp":"[redacted]"`,
   `"sessionToken":"[redacted]"`, `"apiKey":"[redacted]"`, `"req":"[redacted]"`, with `request_id`,
   `tenant_id`, `route`, `status` and `duration_ms` passing through intact. **The ledger still lists
   F-261, F-262 and F-266 as `open` with a round-5 note saying they survive.** They do not. The
   ledger is stale as of commit `45cf578`. I do not own `findings.yaml`; flagging for whoever does.
3. **The largest hole in it is out of reach of the mechanism and of any AC.** Measured:
   `logger.error('boom %s', someString)` emits the string verbatim, by design — a format argument
   with no key must interpolate. The contract discloses this at `:1026` and `:1086-1093`, the one
   live instance is `tenancy/tenant-context.ts:247`, and it is filed as F-274 against the roadmap.
   That is honest disclosure. What is missing is that **the class is unenforced**: `eslint.config.mjs`
   bans `console.*` and a second `pino()`, not a call site building its own message. No AC would have
   caught it either — which is the point. Nobody ever wrote down what "no PII in log bodies" has to
   mean for it to be met.

**My read: legitimate accretion, illegitimately unbounded.** The composition root does genuinely own
`main.ts` and observability is genuinely cross-cutting — so most of these arrivals were correctly
addressed. What went wrong is that a TASK is the unit of sizing and of acceptance, and this one
absorbed two more without either being re-derived. That belongs in the retro as a workflow finding,
not as a defect against the implementer, who disclosed every excursion it made.

---

## 3. Shipped but not asked for

Nothing without a written authorisation. The list, so it is on the record rather than implied:

- **The entire logging and redaction subsystem** (`observability/**`, 3,453 lines). Authorised by
  GC-9 + the contract + the F-060/F-090 rulings. Covered by no AC.
- **The lint rule** (`eslint.config.mjs:26-58`). F-268 only; the contract text still calls F-268
  "unowned" (`:1076`).
- **Helmet and the seven header tests**, plus `test/support/api-server.ts`,
  `response-object-probe.controller.ts` and `typescript-module-hooks.mjs`. F-243 clause 2, ruled
  2026-08-10. No AC.
- **The boot-refusal sequence in `main.ts`** — commit-SHA check, RLS refusal, the 20 s reachability
  budget and its coupling to `fly.toml`'s 30 s `grace_period`. F-116, F-141, F-245. No AC. It is
  also the most consequential thing in the diff for GC-5, and I verified it works.
- **`USER node`** in the `Dockerfile` — carried over from the r1 audit, self-disclosed, still
  nothing behind it. Harmless.
- Re-scope residue inside the audited range, **not TASK-003's work**: the deletion of
  `credential-auth.int-spec.ts`, and the edits to `docs/security/ci-secrets.md` and
  `.github/scripts/provision-test-database.sql`, all from `6189c5b`. The review package attributes
  three files to this TASK that it did not touch.

## 4. Out-of-scope items that got built

None against `refinement.md`'s Out list. Nothing here touches password-protected links, bulk CSV
import, analytics, campaigns, MCP, smart routing, billing, SSO, i18n, mobile, Postgres-loss degraded
mode or multi-region. The card's own "Out of scope for this TASK" (custom hostname binding, database
connection, Redis, third-party secrets) holds with one deliberate exception: `main.ts` now opens a
**database connection at boot**, by your F-116 ruling. Correctly ruled, and the card was never
updated to reflect it.

## 5. Does anything assume work that left with the deferred EPICs?

Nothing that breaks. Five instances, all cosmetic-to-minor, listed because you asked:

1. `apps/api/test/support/auth-fixture.ts` — 370 orphan lines for TASK-009/TASK-058. Filed above.
2. `docs/architecture/rls.md:83-84` — two flag-table rows naming files in `src/redirect/` and
   `src/gdpr/`, both now roadmap items. Filed above; also F-141's undischarged third instance.
3. `apps/api/src/common/errors/exception-filter.ts:299` — "becomes end-to-end correlation the moment
   the BFF forwards one (TASK-012)". TASK-012 is deferred. A comment, not a dependency.
4. `LOGGABLE_FIELDS` names `route`, `status`, `duration_ms` and `tenant_id` as
   `logging-and-headers.md` "Required fields". **No code in `apps/api/src` produces any of them.**
   There is no request-completion log line and no request-logging middleware in EPIC-001; that work
   left. The allowlist is append-only so this costs nothing, but the contract's "Required fields"
   section describes a line that does not exist, the same way invariant 4 did before helmet.
5. `TASK-003.md:101-109` still instructs the implementer that it shares `main.ts` with TASK-009,
   is "concurrent, not sequenced", and must never merge lockfile hunks with it. TASK-009 left on
   2026-08-09. `plan.md:97` records the departure; the card does not.

The logger has exactly **two** production consumers today: `main.ts` and `exception-filter.ts`. Its
`child()` wrapper is used once (the filter's `request_id`); `setBindings`, `RequestLogFields` and
four of the thirteen allowlisted names have no production caller at all. That is not waste — the
mechanisms close measured leaks on the paths that do exist — but it is worth seeing plainly: a
912-line subsystem whose intended consumers are mostly on the roadmap.

## 6. What I could not verify

- **Anything requiring a Fly deployment.** No `flyctl`, no Fly credentials, and no app exists to
  probe. `fly deploy` semantics, Fly's health-check behaviour, `force_https` redirect behaviour,
  and the `commit`-versus-deployed-SHA comparison are all unverified and unverifiable here. Said
  plainly rather than implied.
- **`infra/deploy.sh` end to end.** Guards 1, 2 and 3 are readable and their logic is sound; guards
  4 and 5 and the `fly deploy` call were never executed. I did not run it — it applies DDL.
- **Neon behaviour behind the 20 s reachability budget.** F-149's cold-wake claim is measured
  against a local container in my run, not against a free-tier Neon instance scaling from zero. The
  budget is a reasoned number, not a measured one.
- **GC-3's $25/month.** One `shared-cpu-1x` / 512 MB always-on plus Neon and Vercel free tiers is
  plausibly inside it. Nobody has a bill.
- **F-144's mid-transaction listener test.** Still unwritten; `db/client.ts:54` still carries its
  "TASK-003 replaces this" comment, correctly left alone since `apps/api/src/db/**` is not in this
  TASK's paths.

## 7. Gates, re-run by me

| Gate | Result |
|---|---|
| `pnpm test` | 122 passed / 6 failed of 128. The 6 are `apps/web/src/lib/api/client.spec.ts`, AC-15, TASK-008's `not implemented` throws. Matches the brief. |
| `pnpm --filter @shortkit/api test` | 101/101, 11 files. `health.spec.ts` 3/3. |
| `pnpm test:integration` | 37/37, including 7 security-header tests booting the real bundle. |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | exit 0 / 0 / 0. |
| `docker build` + `docker run` | image builds, boots, `/health` 200 with the correct SHA; both refusal paths exit non-zero. |

---

## Verdict

**changes-requested**, on one clause and one document.

The engineering in this TASK is not the problem — the in-process half of AC-6 is met, the image half
is met and now measured rather than reasoned about, the four open logging majors are genuinely
closed, invariant 4 is true, and the RLS boot refusal works in the shipped artifact. Five audit
rounds produced code that does what its contract says.

What blocks `done` is that **AC-6 is an acceptance criterion about a deployed API, and no API is
deployed.** The API is deployable; it has not been deployed. Those are different claims and only one
of them is true. The second blocker, F-142, is small to fix and is the kind of stale sentence that
sends the next person to the wrong deployment procedure.

Fix the doc, run the deploy, re-verify `commit` against the deployed SHA, and AC-6 closes cleanly.
