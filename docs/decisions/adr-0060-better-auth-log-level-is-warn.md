---
id: ADR-0060
slug: identity-membership
title: Better Auth's log level is warn, not error, because error discards the line that reports the misconfiguration
status: accepted
supersedes: null
amends: ADR-0052
date: 2026-08-16
---

> **This ADR amends ADR-0052 on one key: `logger.level` moves from `'error'` to `'warn'`.**
> Everything else in ADR-0052 stands unchanged: the `log` hook, `disableColors: true`,
> dropping positional `args`, the `msg` residual and the `origin-check.mjs:110` cost.
> ADR-0052 is an accepted ADR of this initiative, so it is amended by this one rather than
> edited in place; the `amended_by` pointer in its front matter is Juano's to add.

## Context

ADR-0052 fixed `level: 'error'` and gave one reason: `dist/api/routes/sign-up.mjs:168` logs
`Sign-up attempt for existing email: ${email}`, and GC-G names `email` as the field that must
never be loggable. It wrote that `'error'` "keeps `sign-up.mjs:168`'s email line suppressed at
the source rather than relying on a downstream filter", and made raising the level to `'info'`
a change the ADR forbids without an amendment.

The wave-2 security pass measured what `'error'` costs, and re-read the line the decision was
built on.

**The email line is `info`, not `warn`.** Read at the source: the call is
`ctx.context.logger.info(...)`. `shouldPublishLog` suppresses `info` at level `'warn'` exactly
as completely as it does at `'error'`. So the stated goal is met at `'warn'` and the ADR's
reason does not distinguish the two values.

**`'error'` discards the one line that reports ADR-0059's defect.**
`dist/context/create-context.mjs:64` emits, verbatim:

> `[better-auth] Base URL is not set. Set the baseURL option or BETTER_AUTH_URL env, or use a
> dynamic baseURL with allowedHosts for multi-host setups. Without it the origin is derived
> from the incoming request, and callbacks and redirects may not work correctly.`

Composed with exactly the logger ADR-0052 mandates, the bound `log` hook received **zero**
lines. The warning was filtered at the source. So the library reported the misconfiguration
that let an attacker choose a token's issuer, and our own configuration threw the report
away.

Three more `warn` sites go with it: `secret-utils.mjs:40-41` (a short or low-entropy secret,
which is ADR-0051's subject), `rate-limiter/index.mjs:284` (cannot determine a client IP,
which is the control TASK-004 depends on), and `internal-adapter.mjs:698`.

**No `warn` call site in 1.6.26 carries a value.** The auditor read every one of them: none
interpolates an email, a token, a password or a user id into the message. ADR-0052's hook
drops positional `args`, so the structured second arguments never reach the line either.

## Decision

**`logger.level` is `'warn'`. Everything else in ADR-0052 is unchanged, and
`auth.config.spec.ts` keeps asserting the level, at the new value.**

The audited basis is part of the decision and is stated in `auth.config.ts`'s comment beside
the key, because it is what a later reader needs in order to know whether raising it further
is safe:

> **THE BASIS WAS SCOPED TO `warn` AND THE LEVEL ADMITS `error` TOO: 2026-08-16, F-209.**
> Found by the implement-phase security audit. Every claim below is about `warn` call sites,
> which is what the design round audited; `'warn'` also admits every `error` site, and **two of
> those put an unbounded request-controlled string on the pino line**: reaching `msg`, the one
> field the allowlist does not censor. `origin-check.mjs:110` and `:55,77` are named in
> `auth.config.ts`'s comment.
>
> **The defect is the shape of the evidence, not the level.** An audit of one severity was used
> to justify a threshold that admits two, and nothing in the reasoning made that visible: the
> paragraph reads as exhaustive because it enumerates exhaustively within a scope it never
> states. The decision stands; the basis now says what it covers.
>
> The implementer **disputed the other half of F-209 and I accepted the dispute**: the finding
> also asked for truncation, and ADR-0052's alternatives table refuses truncation by name with a
> stated trigger that has not fired. A byte cap admits a cap's worth per request and does not
> touch line volume, which is the cost that would matter. Parked with that reasoning rather than
> implemented.

- the PII line at `sign-up.mjs:168` is `info` and is suppressed at `'warn'`;
- no `warn` call site in 1.6.26 interpolates a value into its message;
- `args` are dropped by the hook, so a structured second argument cannot reach the line.

**`'info'` remains forbidden without an amendment**, which is ADR-0052's rule unchanged and
is now the rule that actually carries the PII argument rather than the one between `warn` and
`error`.

**The basis is version-bound.** It was read against 1.6.26 and `better-auth` is pinned to an
exact version (ADR-0013, F-016). An upgrade re-reads the `warn` call sites, on the same
obligation ADR-0051 already puts on `create-context.mjs`.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Keep `'error'` and set `baseURL` (ADR-0059), so the warning has nothing to report | The specific line goes away because the misconfiguration goes away. No change to a decided ADR | It fixes one warning and keeps the channel closed for the other three, including the short-secret warning and the client-IP one TASK-004 depends on. It also makes the config self-confirming: the level is safe only while nothing is misconfigured, and the whole value of a warning is the case where something is | Closes the report rather than the reporting. The next misconfiguration is silent again |
| `'warn'`, but truncate `message` in the hook to bound the bytes | Bounds `origin-check.mjs:110`'s attacker-controlled header, which stays uncapped | ADR-0052 already weighed and refused truncation: F-108 established it is not this repository's answer to caller-controlled bytes, and the truncation length is a number nobody can justify. `origin-check` logs at `error` and is live at both levels, so this changes nothing about that residual | Settled by ADR-0052 and unrelated to the level |
| `'info'` | Every diagnostic the library produces reaches the log | Puts `sign-up.mjs:168`'s email line on the stream, which is the one field GC-G names and the reason ADR-0052 fixed a level at all | The original decision was right about this and is unchanged |
| Filter by message content in the hook rather than by level | Keeps every level and drops known-bad lines | A denylist of message substrings against a dependency's free text, kept current by nobody, breaking on any upstream rewording. It is the shape ADR-0028 exists to avoid: censoring by value rather than by key | Worse than the level control it would replace |

## Consequences

### Positive

- The library's own report of an unresolved `baseURL` reaches the log, which is the line that
  would have found ADR-0059's finding without an auditor.
- Three other `warn` sites become visible, including a short-secret warning that is a second
  signal for ADR-0051's rule and a client-IP warning TASK-004's limiter depends on.
- The reason recorded beside the key is now the measured one, so a later reader weighing
  `'info'` finds the argument that actually applies.

### Negative / accepted cost

- **More lines from a dependency reach `msg`, which is the uncensored field.** ADR-0052's
  central residual widens by three call sites. None of them carries a value today, and
  "today" is a version-bound claim.
- **The basis is a read of every `warn` call site at one version, and nothing re-checks it.**
  An upgrade that adds a `warn` interpolating an email defeats this with no test failing. The
  pin bounds it and the obligation is manual, exactly as ADR-0051 records for its own
  by-value rejection.
- **A second ADR now has to be read to know what ADR-0052 decided.** The level is in this one
  and everything else is in that one. Amending rather than superseding is what keeps that to
  one key, and it is still a split.
- Warning volume on a healthy stack is not zero: `rate-limiter/index.mjs:284` fires whenever
  a client IP cannot be determined, and ADR-0040 records that in every environment that
  exists today no trusted-address header is declared. Wave 2 does not mount the limiter, so
  this arrives with TASK-004 and may be noisy.

### Follow-ups this creates

- ~~Escalated to Juano: ADR-0052's front matter needs `amended_by: ADR-0060`, its Decision
  block's `level: 'error'` needs a struck-in-place correction, and its Follow-ups list says
  `auth.config.spec.ts` asserts `level === 'error'`.~~ **Applied by Juano, 2026-08-16.**
  ADR-0052 carries `amended_by`, a banner, `level: 'warn'` in its code block with the struck
  note, and its follow-up now reads `level === 'warn'`; that last one is the line the test
  architect reads and is the one that would have carried the old value into the spec.
- ~~TASK-003's card reproduces ADR-0052's `logger` block and says `level: 'error'`.~~
  **Applied by Juano, 2026-08-16.** No occurrence of `'error'` remains in the card.
- The upgrade procedure for `better-auth` now re-reads every `logger.warn` call site as well
  as `create-context.mjs`'s secret chain. That obligation lives with the version pin.
