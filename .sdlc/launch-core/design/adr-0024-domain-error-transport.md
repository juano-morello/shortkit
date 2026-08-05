---
id: ADR-0024
slug: launch-core
title: A domain error carries its own ErrorCode, and everything else is a 500
status: accepted
supersedes: null
date: 2026-08-05
---

## Context

`error-envelope.md` fixes the wire shape, the code list and the status per code. It
never says how an error picks up its code on the way to the filter. The filter has to
answer one question for every throwable in the process, and nothing tells it how.

Fourteen TASKs throw a coded error: TASK-010 rejects a verification token, TASK-017
refuses a role, TASK-021 answers on an expired invitation, TASK-024 gives up generating
a slug, TASK-051 rate-limits. They all assume the filter maps them. TASK-007 writes the
filter first, in wave 1, so whatever its implementer picks becomes the mechanism for all
fourteen. Correcting it later touches every throw site in the API.

Three things constrain the answer.

`apps/api` is one tsup bundle at build time and one vitest module graph in test, so a
class identity check works today. It will not always be the only graph: the isolation
suite (TASK-056) and the integration config load the same sources under a second vitest
project.

`packages/contracts` is isomorphic and reaches the browser (ADR-0005). Anything a server
handler throws has no business shipping to a client component.

Guards throw before the handler runs, and one of them has to set `Retry-After` on the
way out (rate-limit.md). The mechanism has to carry a header, not only a code.

## Decision

**A `DomainError` class in `apps/api/src/common/errors/domain-error.ts`, holding the
code, and a filter that recognises it by a registered symbol.**

```ts
export const DOMAIN_ERROR_MARKER: unique symbol = Symbol.for('shortkit.domainError');

export class DomainError extends Error {
  readonly [DOMAIN_ERROR_MARKER]: true = true;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(code: ErrorCode, message: string, options?: DomainErrorOptions);

  get status(): number;          // ERROR_CODE_STATUS[this.code], never an argument
  toEnvelope(): ErrorEnvelope;
}

export function isDomainError(value: unknown): value is DomainError;
export const INTERNAL_ERROR_MESSAGE = 'The request could not be completed.';
```

Full stub: `design/stubs/apps/api/src/common/errors/domain-error.ts`. The filter
algorithm and its four branches are normative in `error-envelope.md`.

**The status is derived, never passed.** `ERROR_CODE_STATUS[code]` is the only source.
A constructor taking a status is how a call site would return `slug_taken` as a 400 and
break invariant 2 for every client already branching on the pair.

**Subclasses live in the throwing feature's own directory**, not in a catalogue.
`SlugTakenError` belongs to TASK-025 in `apps/api/src/links/`. No TASK edits a shared
file to add an error, so no wave conflicts here and no import cycle from `common` back
into features.

**An error with no code is a 500 with a fixed body.** Any throwable that is not a
`DomainError`, a `ZodError` or an `HttpException` becomes `internal_error` carrying
`INTERNAL_ERROR_MESSAGE` and no `details`. Its name, message and stack go to the log
with the `request_id`. Nothing of the original reaches the client, so a Postgres driver
error naming a connection string, a Redis timeout naming an internal host, and an
assertion quoting a row cannot leak (GC-9, invariant 8).

**Constructing a `DomainError` promises the message is safe to show a stranger.** No
connection string, no token, no other tenant's id, no internal identifier. That promise
is what lets the filter pass a `DomainError`'s own message straight to the body while
replacing every other error's. A message that cannot be shown to a stranger belongs in
the log, which means the error is not a `DomainError`.

**The filter does not walk `cause`.** Wrapping a `DomainError` in a plain `Error` turns
its 409 into a 500. Let errors propagate: nothing between the throw and the filter
catches them, and `withTenantTransaction` rolls back and rethrows the original (AC-11).
A wrapper that is genuinely needed is itself a `DomainError` with the original in
`cause`, which reaches the log and not the body.

**Tests assert the mapping without touching the filter.** Two levels, both in
`error-envelope.md`. A TASK owning an error asserts `new InvitationExpiredError().code`
and `.status` on the constructed object, then asserts one HTTP round trip through its
own route. Only TASK-007's own spec may construct the filter.

### Why a registered symbol rather than `instanceof`

`Symbol.for('shortkit.domainError')` resolves to the same symbol in every module graph
in the process, so the check survives a second copy of `domain-error.ts` under a vitest
workspace or a bundle loaded beside source. Plain `instanceof` would probably have held
for launch-core. Its failure mode is what decided it: every domain error in the
duplicated graph turns into a 500 with a generic message, the tests that construct
errors directly keep passing, and the only signal is a test asserting a status three
files away. Four lines buy that away. zod solves the same problem the same way, through
a trait check behind `Symbol.hasInstance`.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| `DomainError extends HttpException` | Nest-native. Nest's own default handler already returns the right status if the filter is ever missing, and every interceptor treats it as an expected error | Drags `@nestjs/common` into `src/db`, `src/tenancy` and every service that throws. `getResponse()` becomes a second serialisation path beside `toEnvelope()`, and the two drift. `HttpException` takes a status at construction, so the call site can pick one that contradicts `ERROR_CODE_STATUS` | The filter must handle framework `HttpException`s anyway, so inheriting from it buys a fallback we already have and pays with coupling and a second body shape |
| A `code` property on a plain object, checked structurally: `typeof e.code === 'string' && e.code in ERROR_CODE_STATUS` | No base class. Works on an error from any library that happens to carry a `code` | Postgres errors carry `code` (`23505`), Node system errors carry `code` (`ECONNREFUSED`), Redis errors carry `code`. Any of them landing on a matching string would be answered as a domain error, and `pg` codes are numeric strings that will not match today and are not guaranteed to stay that way. No compiler check that the code is in the union, so `'not_fuond'` ships | Structural checks on `code` collide with three libraries already in the dependency tree |
| A registry: `registerErrorCode(SlugTakenError, 'slug_taken')` in a shared module | Errors stay plain. The mapping is readable in one place | Every one of the fourteen TASKs edits the same file to add an error, which is the wave conflict the contracts barrel already fights. The registration is a side effect at import time, so an error class in a module nobody imported yet maps to 500 | Turns fourteen independent additions into one contended file, and fails open when a module is lazily loaded |
| Return a `Result<T, ErrorCode>` from every service instead of throwing | The code is in the type. No filter mapping at all, and the compiler finds unhandled cases | Rewrites every service signature and every guard, which cannot return a value. Nest guards and interceptors communicate by throwing, so the throwing path has to exist regardless | The framework's control flow is exceptions. A second convention beside it doubles the work rather than replacing it |

## Consequences

### Positive

- The filter has one question and four answers, and its behaviour is decided before the
  first feature TASK writes a throw.
- A code and its status cannot disagree. `status` is a getter over the contract's table.
- Adding an error touches one file in one TASK's own directory.
- `Retry-After` has a sanctioned path to the response, so TASK-051's guard does not
  invent one on the way past.
- The unsafe default is the loud one. An error nobody classified answers 500 with a
  fixed message rather than leaking its own text.

### Negative / accepted cost

- Every coded throw site writes `new DomainError('not_found', 'message')` rather than
  `throw new NotFoundException()`, which reviewers coming from Nest expect. The
  framework's exception classes are still legal and still map, so both spellings appear
  in the codebase and the difference matters only for which code lands.
- `INTERNAL_ERROR_MESSAGE` is deliberately useless to whoever hits it. Debugging a 500
  means finding the `request_id` in the logs. That is the price of invariant 8.
- The symbol marker is defensive code against a duplication that has not happened. It
  costs four lines and a reader's second glance.
- Error messages become user-facing copy written by backend implementers, with no
  reviewer between the throw site and the browser. The web app renders per code
  (`<ErrorMessage />`), so the copy that ships is often not this message, and there is
  no mechanism keeping the two in step.
- `details` is typed `unknown` on the class, so nothing stops a TASK attaching a shape
  the contract never named. The filter forwards it verbatim. Only review catches that.

  **Reversed 2026-08-05 by ADR-0026 (F-096).** The forwarding half no longer holds: the
  filter validates `details` against `validationDetailsContract` for `validation_failed`
  and drops it for every other code. The first sentence still holds. `details` is still
  typed `unknown` on the class and a throw site can still attach anything, so the mistake
  is still possible to make. It now costs the caller a missing `details` and the log a
  warn line, instead of shipping another tenant's fields.

### Follow-ups this creates

- TASK-007 materialises `domain-error.ts`, writes the filter, registers it as
  `APP_FILTER` in `AppModule`, and adds the filter branches to its spec.
- Each of TASK-010, 011, 014, 017, 018, 021, 024, 025, 040, 045, 049, 051, 053, 054
  throws `DomainError` or a subclass. None of them defines a code mapping.
- TASK-003's logger gets the 500 branch's log line: `request_id`, error name, message,
  stack. The redaction paths in `logging-and-headers.md` already cover the fields.
- TASK-056 has a grep worth adding: an `HttpException` subclass thrown from application
  code under `src/` outside `common/errors` means a status was picked without a code.
- Nothing owns a `ZodValidationPipe` yet, and it is the producer of every
  `validation_failed`. See ADR-0025.
