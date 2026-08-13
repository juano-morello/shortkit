---
id: STORY-006
epic: EPIC-001
title: No credential, session token or email address reaches a log line
status: planned
tasks: [TASK-016]
depends_on: [STORY-004]
---

## User story

As Juano, I need the first request path shortkit ever serves to leave no email address,
password, session token or JWT in its logs, so that the allowlist ADR-0028 installed is
proved against real traffic rather than against the fields that existed when it was written.

## Acceptance criteria

- [ ] AC-33: Given a complete run of signup, then sign-in, then workspace creation against the API with the logger writing to a capturable destination, when every byte of every line the process wrote is scanned, then the signup email address, the password, the session token and the minted JWT each appear zero times — in any field, in `msg`, and inside `err_message` and `err_stack`.
- [ ] AC-34: Given the log lines the new request path emits, when each field name on them is compared against `LOGGABLE_FIELDS`, then every field name present on a line is a member of the allowlist, and a field deliberately added to a line under a name absent from the allowlist renders as `[redacted]` rather than as its value.
- [ ] AC-35: Given an error raised on the auth surface that carries the request body as an own enumerable property, when that error is logged through the API's logger under any key, then the emitted line carries only the fields `errorLogFields` builds and the body content appears zero times.

## Definition of Ready

**PASS with one concern.**

- [x] ACs are testable and unambiguous
- [x] Dependencies identified — needs a request path that logs, which STORY-004 completes
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run; `logging-and-headers.md` is named by TASK-016
- [x] No blocking open questions

**Concern — the new request path may emit no log lines at all, which would make AC-33
vacuous.** Nothing in `apps/api/src` writes a per-request log line today: `logger.ts`
allowlists `request_id`, `route`, `status`, `tenant_id` and `duration_ms` as
"logging-and-headers.md, Required fields" and no code emits them. If this initiative ships
no request logging, AC-33 passes over an empty set — the exact shape F-295 refuses and the
exact reason `foundation`'s SC-1 closed untestable. TASK-016 therefore ships the request log
line as well as the assertion, and AC-33's test asserts a **non-zero** line count before
asserting the absences. That non-vacuity clause is load-bearing, not decoration.

## Definition of Done

- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids
