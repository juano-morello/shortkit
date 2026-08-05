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
`request_id`, with the message and stack passed through ADR-0022's serialisation rather than
concatenated into a string. Path-based redaction cannot reach inside a message string, which
is the point `sdlc-security-auditor` made when it noted a URL-style DSN in a connection error
puts credentials in `message` where `REDACT_PATHS` will never find them.

**Related, and yours to settle in the same edit:** F-093 records that `main.ts:59-62`
deliberately does *not* log a stack, on the reasoning that no redact path reaches inside one,
while `exception-filter.ts` logs `exception.stack` in full. Two files in one repo currently
state opposite policies. TASK-007's implementer is making the filter match `main.ts` in the
interim; when you land the error serialiser, decide the policy once and make both files agree
under it.

**Ownership note.** TASK-003 and TASK-007 now both hold `apps/api/src/common/errors/**`.
TASK-007 is wave 1 and closes before TASK-003 runs in wave 2, so they never execute
concurrently — but merge deliberately rather than assuming, the same care `plan.md`'s wave
table asks for at `app.module.ts`, which these two TASKs already share.
