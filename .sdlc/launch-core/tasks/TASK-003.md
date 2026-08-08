---
id: TASK-003
story: STORY-002
epic: EPIC-001
title: API deployable on Fly.io with a health endpoint
status: tests-red
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: ["fly.toml", "Dockerfile", "infra/**", "apps/api/src/health/**", "apps/api/src/app.module.ts", "apps/api/src/main.ts", "apps/api/src/common/errors/**", "apps/api/package.json", "pnpm-lock.yaml"]
contracts: []
test_files: ["apps/api/src/health/health.spec.ts"]
acceptance: [AC-6]
rework_count: 0
---

## Intent

Get the NestJS deployable running on the internet before any feature depends on it.

## Approach

One backend deployable only (GC-7); stay inside the $25/month total (GC-3); structured logs via pino (GC-9); the health response must expose the deployed commit SHA.

## Out of scope for this TASK

Custom hostname binding (TASK-043), database connection, Redis, secrets for third-party services.

## Interfaces

**Consumes**

`apps/api` workspace and the composition root (TASK-001).

**Produces**

Deployed API base URL; `GET /health` → `{ status: "ok", commit: <sha> }`; the pino logger instance registered at the composition root, available to all later API TASKs.

## ⚠ main.ts added to paths 2026-08-04 (F-060, ruled by Juano)

`paths` gained `apps/api/src/main.ts`. `design/contracts/logging-and-headers.md` already
gives its Normative form as "`apps/api/src/observability/logger.ts` **and**
`apps/api/src/main.ts`", and its Consumed-by as "every API TASK. Nothing may opt out" —
so the contract always assigned you a file your paths excluded.

Concretely, and CORRECTED 2026-08-06: `main.ts`'s `bootstrap().catch()` no longer logs through
`console.error` — TASK-007 replaced it with the error envelope and Nest's `Logger`, and this line
described the pre-TASK-007 repo. What remains yours is the pino swap itself, on that line and on
`exception-filter.ts`. The original text follows for the reasoning it carries, with
a comment saying you will swap it for pino. Do that. Until you do, the API's boot-failure
log line carries no `level`, no `service`, no `env`, no timestamp and no redaction, which
is exactly the pipeline the contract says nothing may opt out of.

You share `main.ts` with TASK-009, which owns `assertBffProxySecretConfigured()` there.

**CORRECTED 2026-08-06: TASK-009 is in WAVE 2, not wave 3 — you are concurrent, not sequenced.**
`plan.md`'s wave table puts 003, 006, 008 and 009 together and prescribes worktree isolation for
exactly this reason. You do not "land first". The scout mapped the collision precisely: TASK-009
rewrites `main.ts:42-52` (bodyParser off, the auth mount, the global prefix moving last) while you
rewrite `:54-81` and insert a boot refusal into the region it restructures. In `app.module.ts` the
conflict is line `:16` alone. Merge deliberately rather than assuming one of you arrives to a clean
file.

## ⚠ common/errors/** added to paths 2026-08-05 (F-090, ruled by Juano)

`paths` gained `apps/api/src/common/errors/**`, and **the pino swap in
`apps/api/src/common/errors/exception-filter.ts` is now explicitly this TASK's**, not a
comment addressed to nobody.

**Why it had to move.** TASK-007's exception filter logs through Nest's `Logger` with a
comment saying "TASK-003 replaces this with the pino logger, which adds request_id to these
lines." Both `sdlc-reviewer` and `sdlc-security-auditor` found the same hole independently:
this TASK's paths did not reach that file, and TASK-007 closes at the end of wave 1, so no
TASK could perform the swap. A code comment is not an owner.

**Why it is not cosmetic.** `design/contracts/logging-and-headers.md` makes `REDACT_PATHS`
the sole mechanism enforcing GC-9, and this filter is the only place in the API that writes
an arbitrary error's message and stack. Until the swap lands, that line sits outside the
redaction pipeline entirely, and `error-envelope.md` invariant 9 — debugging a 500 means
finding its `request_id` in the logs — is false for every 500 the product returns.

**Add to Produces:** the `exception-filter.ts` log line moved onto the pino logger, carrying
`request_id`, **with the stack/message policy decided and recorded** — not a fixed field list.
Corrected 2026-08-05 (F-110): this clause used to require "the message and stack passed through
ADR-0022's serialisation", which prescribed an outcome the contract deliberately leaves to you and
named a remedy that does not work. Path-based redaction cannot reach inside a message string, which
is the point `sdlc-security-auditor` made when it noted a URL-style DSN in a connection error
puts credentials in `message` where `REDACT_PATHS` will never find them.

**Related, and yours to settle in the same edit:** F-093 recorded that `main.ts:59-62`
deliberately does *not* log a stack, while `exception-filter.ts` logged `exception.stack` in
full — two files in one repo stating opposite policies. **That is no longer the state**:
TASK-007's implementer made the filter match `main.ts`, so neither logs a stack today.
(Corrected 2026-08-05, F-110; this paragraph described the pre-F-093 repo.)

**Read `design/contracts/error-envelope.md`, section "What the 500 log line carries, and who
owns changing it", before you touch the log line.** It is normative, it states what ships
today and why, and it names you as the owner of the permanent answer. `design/contracts/
logging-and-headers.md` § "The exception filter's error line" points at it as well. This
TASK's `contracts:` front-matter is empty, so this sentence is the delivery path — do not
rely on the field.

## ⚠ F-108 — the framework-400 arm, and why ADR-0022 serialisation will not fix it

Added 2026-08-05. `sdlc-security-auditor` deferred this to you rather than reopening TASK-007,
and the ledger previously claimed it had been recorded here when it had not.

`exception-filter.ts`'s branch-3 400 arm logs the framework's own message. For a malformed
JSON body that message is Nest's `BadRequestException(err.message)` over Node's `JSON.parse`
text, **which quotes raw request bytes** — an unauthenticated POST containing a credential can
put a fragment of it in the log. Two properties follow:

- `REDACT_PATHS` cannot reach it. Redaction is path-based and a message string has no path, so
  "pass it through ADR-0022's serialisation" is not a remedy. This is why the Produces clause
  above was corrected.
- The quoted slice is raw input, so it can contain a literal newline. Verified on Node 24.19:
  Nest's text logger writes it as two physical lines, splitting a line-oriented log. JSON
  encoding by pino removes that property; it does not remove the credential fragment.

**The remedy the auditor recommends:** log `exception.name` plus the `SyntaxError`'s position,
or a hard-truncated message — not the quoted slice. The message has no diagnostic value the
client is allowed to see anyway.

**One check to run before you choose a serialiser (F-111).** `err.stack`'s first line *is*
`name: message`. A serialiser that emits the raw stack therefore reinstates the message inside
the `stack` field, which defeats redacting `message`. Verify what your chosen `err` serialiser
puts in `stack` **before** you redact anything. This is stated as a check rather than an answer
because `pino` is not installed in this workspace and nobody has been able to measure it —
`sdlc-architect` and `sdlc-security-auditor` both declined to write the shape as a claim, which
was the right call after ADR-0024 had to strike an unverified redaction claim as wrong-when-written.

**Ownership note.** TASK-003 and TASK-007 now both hold `apps/api/src/common/errors/**`.
TASK-007 is wave 1 and closes before TASK-003 runs in wave 2, so they never execute
concurrently — but merge deliberately rather than assuming, the same care `plan.md`'s wave
table asks for at `app.module.ts`, which these two TASKs already share.

## ⚠ F-116 — the RLS bypass guard's call site lands here (ruled by Juano 2026-08-05)

TASK-005 built `assertRuntimeRoleCannotBypassRls()` in `apps/api/src/db/rls.ts` because
`design/contracts/rls-policy-template.md` names it, and disclosed that **nothing calls it**.
Verified by the orchestrator: grep over `apps/api/src` finds exactly one occurrence, the export
itself. Both candidate call sites — `main.ts` and the `DbModule` composition root — are outside
TASK-005's paths, so the placement was Juano's call. It is yours.

**What it guards.** The function is the runtime proof that the application's database role cannot
see through row-level security. With no call site, a `DATABASE_URL` pointing at a superuser or any
`BYPASSRLS` role starts the API normally and **every tenant-scoped query silently returns every
tenant's rows** — the one condition GC-5 exists to make impossible. The integration suite cannot
catch this: `rls-fixture.ts` asserts the role's attributes before the tests run, so the suite
proves the *policies* work while nothing proves the *deployed process* refused the wrong role.

**The ruling: boot-time refusal in `main.ts`, not a module-init assertion and not a warning.**
Call it during bootstrap and **refuse to start** if it fails. A process that logs a warning and
serves traffic with RLS disabled is worse than one that never came up. This joins the `main.ts`
obligations you already carry from F-060, F-090, F-093 and F-108 — make it one coherent bootstrap
sequence rather than four bolted-on checks, and record the ordering you chose in your report.

**Related and still open: F-119.** `db:migrate` runs `drizzle-kit`, a devDependency, while
ADR-0004 has the Fly release command running migrations in the deployed image — where
devDependencies are not installed. A `--prod` build or any multi-stage build that prunes them has
no `drizzle-kit` binary, so the release command fails at deploy time rather than build time. You
own `fly.toml` and the `Dockerfile`, so you settle it: promote `drizzle-kit` to a dependency and
ship a migration toolchain into the runtime image, or have the release command run something else.
Record which way and why in your report — this is a deployment-shape decision, not a manifest typo.

## ⚠ Four deferred TASK-005 findings routed here 2026-08-05

These were raised against TASK-005 and deferred as minors rather than fixed. They land on
your card because **you are the TASK that makes them true or false**, and a ledger line
would not survive to you.

**F-144 — the F-137 listener has no regression test, and you are slated to edit those exact
lines. Satisfy this BEFORE you refactor `client.ts`'s logger.** Raised independently by
`sdlc-reviewer` and `sdlc-security-auditor`. Deleting the
`pool.on('connect', client => client.on('error', …))` block leaves all 65 unit and 21
integration tests green: the F-123 idle test kills a connection that is *already back in the
pool*, where pg-pool re-attaches its own `idleListener` on release, so the pool-level handler
alone satisfies it. The guarded path is the opposite state — `_acquireClient` removes
`idleListener` on checkout and drizzle's `NodePgSession.transaction` attaches none, so a
client killed **mid-transaction** has zero listeners and Node exits the process. The 5 s
`idle_in_transaction_session_timeout` added in the same round makes that routine rather than
exceptional. `client.ts:54` already announces "TASK-003 replaces this with the pino logger".
The test the auditors specify: kill a backend while it is checked out inside a transaction
(`pg_terminate_backend` from a second connection, or the idle bound itself) and assert the
call rejects with **no `uncaughtException`**. The existing F-123 test already installs the
capture the assertion needs. Test files are `sdlc-test-architect`'s — request it, do not
write it yourself.

**F-141 — `docs/architecture/rls.md:160` says `assertRuntimeRoleCannotBypassRls` runs at
"boot, before traffic". Nothing calls it.** Raised independently by `sdlc-reviewer` and
`sdlc-product-auditor`. The repository's only RLS architecture document tells a reader that a
`DATABASE_URL` pointing at a superuser, a `BYPASSRLS` role or a table-owning role cannot boot
the API. Today it boots normally and every policy is decoration. Of the three checks in that
table this is the one with no other detector. **You land F-116's boot call site, so you are
the TASK that makes the sentence true** — correct the row when you wire it. Two smaller
instances in the same file: `:161` says `db:check-policies` runs in CI (TASK-002's, unbuilt),
and the flag table at `:83` names `src/redirect/db/redirect-read.ts` and
`src/gdpr/privileged-eraser.ts`, neither of which exists.

**F-142 — `docs/architecture/migrations.md:102` states the Fly release command running
`db:migrate` as an existing procedure.** No `fly.toml`, `Dockerfile` or release command
exists, and **F-119 disputes whether `drizzle-kit` is even present in a production image**.
You own `fly.toml` and the `Dockerfile`, so you settle F-119 and correct this section in the
same change. A document that states an unresolved question as fact is how the answer stops
being asked.

**F-149 — `connectionTimeoutMillis: 2000` also caps connection ESTABLISHMENT, not just the
queue wait its docblock reasons about.** pg-pool applies the same value in `newClient`
(`pg-pool@3.14.0:250-263`): a new client that has not finished connecting within it has its
socket destroyed, and the caller gets "Connection terminated due to connection timeout". GC-3
pins Neon's free tier, which scales to zero — the first request after an idle period pays TCP
+ TLS + auth + compute wake, and if that exceeds 2 s it **fails rather than waits**. The pool
is empty at process start too, so the same cap hits the first request after every deploy.
This is the one of TASK-005's three unmeasured capacity numbers with a concrete stated
mechanism, and **you wire the real endpoint, so you are the only place it can be confirmed**.

## ⚠ F-217 — `/health` is excluded from the prefix but nothing serves it

`main.ts` already excludes `/health` from the global prefix — that shipped with TASK-001 — but no
controller answers it, so the route **404s today**. ADR-0006 has you verifying that `GET /health`
resolves at the root after the prefix is set; the exclusion is in place and the endpoint is yours.

Found by `sdlc-integrator` during wave 1's integration pass. It matters slightly more than an
unbuilt endpoint usually would: configuration for a route exists while the route does not, so a
platform health probe — which is what `fly.toml` will point at — reads a 404 as a broken service
rather than an unimplemented one.

## ⚠ apps/api/package.json and pnpm-lock.yaml added to paths (F-075/F-085, ruled by Juano 2026-08-06)

**You add `pino`, exact-pinned, no caret and no tilde per ADR-0018, and you commit the regenerated
lockfile in the same commit.** Verified 2026-08-06: `pino` appears in zero manifests and zero times
in the lockfile, so ADR-0022's whole logging story has no package behind it.

F-075 settled that the consuming TASK owns its own workspace manifest; F-085 extended that to
`pnpm-lock.yaml`, because every CI job installs with `--frozen-lockfile` and a manifest change
without its lockfile fails install for every later TASK.

**TASK-009 also holds these two files this wave** — it adds `better-auth`. That is what makes the
wave-table's worktree isolation load-bearing rather than precautionary. **Never merge lockfile
hunks. Re-run the install on the merged manifests and commit the result**, which is the policy
already written into TASK-005 under the same ruling. Say in your report which version of `pino` you
chose and why; F-069 is the record of what an unreviewed pin looks like.
