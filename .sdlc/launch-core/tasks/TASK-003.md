---
id: TASK-003
story: STORY-002
epic: EPIC-001
title: API deployable on Fly.io with a health endpoint
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: ["fly.toml", "Dockerfile", "infra/**", "apps/api/src/health/**", "apps/api/src/app.module.ts", "apps/api/src/main.ts", "apps/api/src/common/errors/**"]
contracts: []
test_files: []
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

Concretely: `main.ts`'s `bootstrap().catch()` currently logs through `console.error`, with
a comment saying you will swap it for pino. Do that. Until you do, the API's boot-failure
log line carries no `level`, no `service`, no `env`, no timestamp and no redaction, which
is exactly the pipeline the contract says nothing may opt out of.

You share `main.ts` with TASK-009, which owns `assertBffProxySecretConfigured()` there.
You are in wave 2 and it is in wave 3, so you land first.

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
