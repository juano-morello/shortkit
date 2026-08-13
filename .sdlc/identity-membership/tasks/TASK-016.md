---
id: TASK-016
story: STORY-006
epic: EPIC-001
title: Request logging for the first request path, and the SC-5 assertion
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-012]
paths: ["apps/api/src/observability/**", "apps/api/src/app.module.ts", "apps/api/test/observability/**"]
contracts: [design/contracts/logging-and-headers.md]
test_files: ["apps/api/src/observability/request-log.interceptor.spec.ts (unit)", "apps/api/src/observability/logger-field-allowlist.spec.ts (unit, existing file — extended)", "apps/api/test/observability/no-credentials-in-logs.int-spec.ts (integration)"]
acceptance: [AC-33, AC-34, AC-35]
rework_count: 0
---

## Intent

Make the first request path shortkit ever serves emit the log line its contract requires, and
prove by scanning real bytes that no credential, session token or email address is in it.

## Approach

**Nothing in `apps/api/src` writes a per-request log line today.** `LOGGABLE_FIELDS`
(`logger.ts:52-66`) already names `request_id`, `route`, `status`, `tenant_id` and
`duration_ms` as "logging-and-headers.md, Required fields", and no code emits any of them.
Asserting SC-5 over an empty set of lines is vacuously true, which is the shape F-295 refuses
and the exact reason `foundation`'s SC-1 closed untestable. **So this TASK ships the request
log line as well as the assertion**, and AC-33's test asserts a **non-zero** line count
before asserting the absences. That non-vacuity clause is load-bearing.

**`route` is the PATTERN, never a concrete path.** The allowlist comment says so. A concrete
path carries ids; a workspace id in a log line is not a credential but it is a tenant's data,
and the pattern is what an operator actually aggregates on.

**Logging is an allowlist, and a field is invisible until it is named** (ADR-0028). Any field
name the new path emits that is not in `LOGGABLE_FIELDS` renders as `[redacted]` — name and
value both survive verbatim, only the polarity changed. Add exactly the names the new lines
carry and no speculative ones. **`email` is the field to watch and it must not be added**;
if a call site wants to identify the caller, `tenant_id` is already allowlisted and a user
identifier, if one is wanted, is a **Design decision** listed for the architect — a user id is
not an email address, and the two must not be conflated in the name of a field.

**There is exactly one mechanism between an unnamed field and the line.** ADR-0028 deleted
the `redact` path list deliberately: 25 of its paths named keys that are not on the
allowlist, so the list was subsumed by the scan, and keeping two censoring mechanisms with
opposite polarity is a comprehension hazard that already misled a reader once. That is why
`childOptionsChecked` is load-bearing rather than hardening — **a child logger created with
unchecked options is the one way around the scan**, and any child logger this TASK creates
goes through it.

**Three defences already exist in `logger.ts` and every one was a real leak.** Do not weaken
any of them, and know why they are there before writing a log call:

- the `err` serialiser is overridden because pino's default copies **every own enumerable
  property** of an error onto the record, and body-parser attaches the verbatim request body
  to `err.body` — so one idiomatic `log.error({ err }, '…')` wrote an unauthenticated POST's
  credentials in the clear (F-244, reproduced on this repository's pino 10.3.1);
- `formatters.log` closes the same hole under **every** key, because `serializers` is keyed
  by field name and `{ error: e }` or `{ ctx: { err: e } }` reached pino's ordinary object
  path where `body` survives (F-248);
- the `logMethod` hook rewrites the two call shapes that put `err.message` into `msg`, which
  is a top-level key no censoring path can reach (F-251, F-252).

AC-35 is that first defence measured against **this initiative's** auth surface rather than
against the one that found it.

**The auth mount sits outside the Nest module graph** (ADR-0013), so a Nest interceptor does
**not** see `/api/auth/*` requests. AC-33's scan must therefore cover the whole process's
output during a signup — including anything Better Auth or Express writes on that path — and
not only the lines a Nest interceptor produced. If nothing logs on that path, the scan still
passes; what it must not do is scan only the surface it can see and report a clean result for
the surface it cannot.

**A password, a session token and a JWT are not fields — they are substrings.** The scan is
byte-level over the full line, including inside `err_message` and `err_stack`, because a
stack is the one field a path-based redaction could never reach. That is F-064's objection
and the reason `errorLogFields` strips the `name: message` header out of frames.

`app.module.ts` gains the request-log interceptor as an `APP_INTERCEPTOR` provider. Its
ordering relative to the tenant transaction interceptor (TASK-006) decides whether
`tenant_id` and `duration_ms` are available on the line — that ordering is a **Design
decision** and is listed for the architect.

## Out of scope for this TASK

Metrics and counters — `trusted_client_ip_unresolved_total`,
`auth_revocation_degraded_total` and `bff_proxy_auth_mismatch_total` are named in ADR-0013
and ADR-0040 and are **not** built here. Any web-side logging. Retiring the logger design
stub or widening the stub-drift gate's enforced prefixes (F-403, F-404 — TASK-010 states why
not). The three follow-up cards ADR-0041, ADR-0042 and F-369 owe (dependency-manifest logger
gating, moving the import restriction to follow the package, closing the lint fence's three
doors) — all three are recorded on `roadmap.md` and none is scheduled here. Adding `email` to
the allowlist under any name.

## Interfaces

**Consumes**

From `apps/api/src/observability/logger.ts` (shipped, same directory this TASK edits):
- `logger` — the one pino instance; its destination is fd 1 and the write is **synchronous**
- `LOGGABLE_FIELDS: ReadonlySet<string>` — currently `attempt`, `boot_precondition`, `code`,
  `duration_ms`, `err_message`, `err_name`, `err_stack`, `msg`, `request_id`, `retry_in_ms`,
  `route`, `status`, `tenant_id`
- `REDACT_CENSOR = '[redacted]'`
- `errorLogFields(thrown: unknown, options?: { includeMessage?: boolean }): ErrorLogFields` —
  builds `err_name`, `err_message`, `err_stack` and nothing else

From TASK-005: `RequestContext` populated on the request — `userId`, `tenantId`, `emailVerified`.
From TASK-006: `TenantTransactionInterceptor`, already registered as `APP_INTERCEPTOR`.
From TASK-012: the four authenticated workspace routes, and their route **patterns**.
From TASK-003 / TASK-004: the auth surface, whose lines the scan must also cover.

From `apps/api/test/support/auth-fixture.ts` (**test-architect's; consumed, never edited**):
`signUp`, `signIn`, `mintToken`, `POLICY_COMPLIANT_PASSWORD`, `SIGNUP_NAME`, `clearAuthTables`.

**Produces**

- `apps/api/src/observability/request-log.interceptor.ts` exporting
  `RequestLogInterceptor implements NestInterceptor` — one line per request carrying
  `request_id`, `route` (the pattern), `status`, `tenant_id` and `duration_ms`, and no field
  absent from the allowlist
- `apps/api/src/observability/logger.ts` — `LOGGABLE_FIELDS` extended with exactly the new
  names the new lines carry; **no `email` entry under any spelling**
- `apps/api/src/app.module.ts` — `RequestLogInterceptor` registered as `APP_INTERCEPTOR`
- `apps/api/test/observability/no-credentials-in-logs.int-spec.ts` — the SC-5 assertion: a
  full signup, sign-in and workspace-create run with the logger's output captured, a
  **non-zero line count**, and zero occurrences of the email address, the password, the
  session token and the JWT anywhere in the captured bytes
