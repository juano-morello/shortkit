# Contract: error envelope and error code registry

- **Boundary:** every API response body that is not 2xx; every client that renders a failure; every `throw` in `apps/api` that expects a status other than 500.
- **Normative form:** `packages/contracts/src/errors.ts` (the wire shape and the code list) and `apps/api/src/common/errors/domain-error.ts` (how a throw carries a code). Stubs at the matching paths under `design/stubs/`.
- **Produced by:** TASK-007.
- **Consumed by:** TASK-008, 010, 011, 012, 014, 017, 018, 021, 024, 025, 040, 045, 049, 051, 052, 053, 054.
- **ADRs:** ADR-0005, ADR-0013, ADR-0024, ADR-0025, ADR-0026.

## Normative types

```ts
import { z } from 'zod';

export const ERROR_CODES = [
  // 400
  'validation_failed',
  'confirmation_required',
  'verification_token_invalid',
  'workspace_id_required',
  // 401
  'unauthenticated',
  'token_expired',
  // 403
  'email_not_verified',
  'insufficient_workspace_role',
  'insufficient_tenant_role',
  // 404
  'not_found',
  // 409
  'slug_taken',
  'hostname_already_claimed',
  'last_owner_protected',
  'invitation_already_accepted',
  'invitation_tenant_conflict',
  // 410
  'invitation_expired',
  'invitation_revoked',
  // 429
  'rate_limited',
  // 500
  'internal_error',
  'slug_generation_exhausted',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorEnvelopeContract = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string().min(1),
  details: z.unknown().optional(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeContract>;

/** `details` shape for `validation_failed`, and only for it. */
export const validationDetailsContract = z.object({
  fieldErrors: z.record(z.string(), z.array(z.string())),
});
export type ValidationDetails = z.infer<typeof validationDetailsContract>;

/**
 * Caps on one flatten (F-095). At most 100 issues are read, at most 10 issue messages
 * land under one key, and if anything was dropped `VALIDATION_TRUNCATED_MESSAGE` is
 * appended under `FORM_ERROR_KEY`. zod reports one issue per failing array element, so an
 * uncapped flatten turns a 100 KB body into a multi-megabyte response built inside the
 * exception filter.
 *
 * The notice sits OUTSIDE the per-key cap, so `_form` holds 11 entries when the dropped
 * issues were its own. Intended, and clarified 2026-08-05 because the wording read both
 * ways: the notice is a fixed string this package wrote, not an issue message derived
 * from the request, and dropping a real error to make room for a notice saying errors
 * were dropped serves nobody. The ceiling on one response is 101 messages for any input.
 */
export declare const MAX_VALIDATION_ISSUES = 100;
export declare const MAX_MESSAGES_PER_FIELD = 10;
export declare const VALIDATION_TRUNCATED_MESSAGE = 'Some errors were omitted.';

/**
 * The status table below, as data. The one source of a code's status: the filter reads
 * it, `DomainError.status` derives from it, and nothing chooses a status any other way.
 */
export declare const ERROR_CODE_STATUS: Record<ErrorCode, number>;

export declare function isErrorEnvelope(value: unknown): value is ErrorEnvelope;

/**
 * ADR-0025. Every schema in the system is declared in this package, so this package
 * recognises and flattens its own errors. The API filter calls these; it does not
 * import zod, and it does not hand-roll the flatten.
 *
 * `toValidationDetails` accumulates into a `Map` and drains it through
 * `Object.fromEntries`. That is required, not stylistic: `issue.path[0]` is
 * caller-controlled, and an object-literal accumulator read with `acc[key] ?? []` returns
 * an inherited `Object.prototype` member for a key of `constructor` or `toString` and
 * throws inside the filter (F-086, F-087; reasoning in ADR-0025). The body is normative
 * in `design/stubs/packages/contracts/src/errors.ts`.
 */
export declare function isZodError(value: unknown): value is z.ZodError;
export declare function toValidationDetails(error: z.ZodError): ValidationDetails;

/** Where an issue with an empty path lands. No request contract declares this field. */
export declare const FORM_ERROR_KEY = '_form';
```

## Status mapping

The API exception filter maps code to status. This table is normative; a code may not
be returned with a status other than its row.

| Code | Status | Emitted by |
|---|---|---|
| `validation_failed` | 400 | any endpoint with a zod body/query schema |
| `confirmation_required` | 400 | TASK-054 `POST /api/gdpr/delete` |
| `verification_token_invalid` | 400 | TASK-010 |
| `workspace_id_required` | 400 | TASK-017 guard, when no workspace id is resolvable |
| `unauthenticated` | 401 | TASK-011 |
| `token_expired` | 401 | TASK-011, when the JWT signature is valid and `exp` has passed |
| `email_not_verified` | 403 | TASK-011 |
| `insufficient_workspace_role` | 403 | TASK-017 |
| `insufficient_tenant_role` | 403 | TASK-017 |
| `not_found` | 404 | any resource route, including every cross-tenant access |
| `slug_taken` | 409 | TASK-025 |
| `hostname_already_claimed` | 409 | TASK-040 |
| `last_owner_protected` | 409 | TASK-018 |
| `invitation_already_accepted` | 409 | TASK-021 |
| `invitation_tenant_conflict` | 409 | TASK-021 |
| `invitation_expired` | 410 | TASK-021 |
| `invitation_revoked` | 410 | TASK-021 |
| `rate_limited` | 429 | TASK-051 |
| `internal_error` | 500 | exception filter, for anything unmapped |
| `slug_generation_exhausted` | 500 | TASK-024 |

## How an error carries its code to the filter

ADR-0024. Normative for every TASK that throws. Stub:
`design/stubs/apps/api/src/common/errors/domain-error.ts`.

```ts
// apps/api/src/common/errors/domain-error.ts
export const DOMAIN_ERROR_MARKER: unique symbol = Symbol.for('shortkit.domainError');

export interface DomainErrorOptions {
  readonly details?: unknown;                              // reaches the body
  readonly headers?: Readonly<Record<string, string>>;     // written before the body
  readonly cause?: unknown;                                // reaches the log only
}

export declare class DomainError extends Error {
  readonly [DOMAIN_ERROR_MARKER]: true;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(code: ErrorCode, message: string, options?: DomainErrorOptions);

  /** ERROR_CODE_STATUS[this.code]. Derived, never a constructor argument. */
  get status(): number;
  toEnvelope(): ErrorEnvelope;
}

export declare function isDomainError(value: unknown): value is DomainError;
export declare const INTERNAL_ERROR_MESSAGE = 'The request could not be completed.';
```

**Throw a `DomainError` and the filter answers with its code.** Throw anything else and
the filter answers 500 `internal_error`. Nothing in between, and no other mechanism:
no registry, no `code` property on a plain object, no metadata.

**A named subclass lives in the throwing feature's own directory**, never in a shared
catalogue. TASK-025 declares `SlugTakenError extends DomainError` in
`apps/api/src/links/`. Subclass when the error is thrown from more than one place or
carries data a caller inspects; otherwise `throw new DomainError('not_found', '...')`
at the throw site is the whole of it.

**Constructing a `DomainError` asserts its message is safe to show a stranger.** No
connection string, no token, no other tenant's id, no internal identifier (GC-9). The
filter passes that message to the body verbatim and replaces every other error's. A
message that fails the test belongs in the log, which means the error is not a
`DomainError`.

**Nothing wraps.** The filter does not walk `cause`, so a `DomainError` re-thrown inside
a plain `Error` answers 500. Let it propagate: no interceptor or repository catches it,
and `withTenantTransaction` rolls back and rethrows the original (AC-11,
`tenant-context.md`). A wrapper that is genuinely needed is itself a `DomainError`
carrying the original in `cause`.

### The filter's four branches, in order

Normative. TASK-007 implements exactly this.

| Order | Test | Status | Body |
|---|---|---|---|
| 1 | `isDomainError(err)` | `err.status` | `err.toEnvelope()`, and `err.headers` written to the response first |
| 2 | `isZodError(err)` | 400 | `{ code: 'validation_failed', message, details: toValidationDetails(err) }` |
| 3 | `err instanceof HttpException` | see below | by status |
| 4 | anything else | 500 | `{ code: 'internal_error', message: INTERNAL_ERROR_MESSAGE }`, no `details` |

Branch 4 puts nothing from the original error in the body. That default is the safe one
on purpose: a Postgres error naming a connection string, a Redis timeout naming an
internal host and an assertion quoting a row all land here.

The log gets `err_name` and `err_stack`, at `error` level, on a child logger carrying
`request_id`. `err_message` only for a `DomainError`. Amended 2026-08-05 (F-093, F-106)
and again 2026-08-08 (TASK-003): this paragraph first required "name, message and stack",
then name and message with no stack. Read "What the 500 log line carries, and who owns
changing it" below, which is the decided version, before you touch that call.

`isZodError` and `toValidationDetails` come from `@shortkit/contracts` (ADR-0025). The
filter imports zod nowhere, value or type, so TASK-007 needs no entry in
`apps/api/package.json` for this path.

### Branch 3: framework exceptions

`HttpException` is what the framework raises on its own. Application code throws a
`DomainError` instead, and TASK-056 greps for an `HttpException` subclass thrown under
`src/` outside `common/errors`.

| Status | Code | Body detail |
|---|---|---|
| 404 | `not_found` | no route matched; message `NOT_FOUND_MESSAGE` |
| 400 | `validation_failed` | message `VALIDATION_FAILED_MESSAGE`; `details.fieldErrors` = `{ _form: [FRAMEWORK_BAD_REQUEST_FORM_MESSAGE] }` |
| any other | `internal_error` | 500, and the original status is logged |

**Amended 2026-08-05 (F-094, ADR-0026). The `HttpException`'s own message never reaches
the body.** The previous version of this row put it under `_form`. Nest maps a
body-parser `SyntaxError` to `new BadRequestException(err.message)`, and that message
quotes the input: `JSON.parse('{"password":"hunter2","token":"eyJhbGciOi","x":}')` gives
`Unexpected token '}', ..."ciOi","x":}" is not valid JSON` on Node 24.19. The same arm
receives express's `URIError`, whose message router 2.2.0 rewrites to
`Failed to decode param '<value>'`. Both put raw request bytes in an error body, against
invariant 8, from an unauthenticated request. The arm now answers with a fixed string,
the same treatment the 404 arm gets and for the same reason. The original message goes to
the log through the same helper branch 4 uses.

### What the 500 log line carries, and who owns changing it

Amended 2026-08-05 (F-093, F-106). **Decided and landed 2026-08-08** by TASK-003 under the
F-090 ruling, with F-108, F-111 and F-242 answered here. Read this before writing anything
into the filter's log call. This section is normative for what an error contributes to a
log line; `logging-and-headers.md` is normative for the logger that carries it.

**The policy.** Every error goes through `errorLogFields(thrown, { includeMessage })` in
`apps/api/src/observability/logger.ts`, which builds three fields and no fourth:

```ts
export interface ErrorLogFields {
  readonly err_name: string;
  readonly err_message?: string;
  readonly err_stack?: string;
}
```

- **`err_stack` carries frames only.** The `${name}: ${message}` header is stripped by
  prefix and then by shape, so a message containing a literal newline leaves no remnant
  behind. F-108's framework-400 message quotes raw request bytes, which is the input that
  needs both halves of the strip: a filter keeping only frame-shaped lines would keep a
  message line beginning `    at `. The frames name files and functions in our own source
  and in `node_modules`, and carry no request data, no PII and no credential.
- **`err_message` is withheld by default.** It carries a URL-style Postgres DSN on a
  connection failure, an internal host on a Redis timeout, and a fragment of an
  unauthenticated request body on the framework-400 arm.
- **`includeMessage` is opt-in at two call sites, each with a stated reason.** The
  exception filter passes `isDomainError(exception)`: constructing a `DomainError` asserts
  its message is safe to show a stranger, so it is a fortiori safe to log. `main.ts` passes
  `true` on boot failures, which run before any request exists and where the message is the
  diagnosis, as in `GIT_COMMIT_SHA is not set`. Accepted cost: a `pg` connect failure at
  boot puts the database host and port on the line. That is infrastructure rather than a
  click stream, and the operator needs it.
- **Truncation was rejected as F-108's remedy.** A cap does not remove a credential sitting
  at the start of the quoted slice, so it buys a shorter line and no less exposure.

This reverses F-093's interim rather than undoing it. F-093 removed the frames because the
stack's first line repeats `${name}: ${message}`, verified on Node 24.19. The frames come
back only because that header is now stripped at construction. `exception.stack` still
never reaches a log line raw.

**Correction, 2026-08-08 (F-242).** Both contracts said `REDACT_PATHS` "cannot help either
way" with a message or a stack, and the reason was wrong. Once a serialiser turns an error
into an object, `err.message` and `err.stack` are ordinary paths and pino censors them.
Verified on pino 10.3.1 with `redact: { paths: ['err.message', 'err.stack'] }`, which emits
`{"err":{"type":"SyntaxError","message":"[redacted]","stack":"[redacted]",…}}`. What
redaction cannot do is reach **inside** a string, so a path censors a field whole or leaves
it whole. That is why the answer is which fields `errorLogFields` builds rather than which
paths to censor. The rule was right; the justification would not survive an implementer
checking it, and this is the third time on this initiative that has happened (F-220, F-229).

**Two things a later TASK must not do.** Do not pass an `Error` to a log call expecting the
message to appear: `logging-and-headers.md` states the four logger mechanisms that strip it
under every key. Do not interpolate `error.message` into a log message string either, which
puts it in `msg` where nothing reaches it.

### Message constants

Normative values (F-098). Pinning them stops a second implementer inventing a third
string; it is not a compatibility promise, and invariant 3 still forbids a caller
branching on any of them.

```ts
// apps/api/src/common/errors/exception-filter.ts
const VALIDATION_FAILED_MESSAGE = 'The request could not be validated.';
const NOT_FOUND_MESSAGE = 'The requested resource was not found.';
const FRAMEWORK_BAD_REQUEST_FORM_MESSAGE = 'The request could not be parsed.';

// apps/api/src/common/errors/domain-error.ts
export const INTERNAL_ERROR_MESSAGE = 'The request could not be completed.';
```

`NOT_FOUND_MESSAGE` replaces the framework's `Cannot ${method} ${url}`, which reflects
the request URL into a JSON body on every unmatched route.
`FRAMEWORK_BAD_REQUEST_FORM_MESSAGE` covers both producers on the 400 arm, a malformed
JSON body and a bad percent-encoding in a path segment, which is why it says "request"
rather than "body". A `DomainError` supplies its own message and none of these apply.

**A 413 answers 500 today.** `ERROR_CODES` has no code for a body over Express's default
limit, and `ERROR_CODE_STATUS` allows a code exactly one status, so there is nothing to
map it to. No `/api` route in launch-core documents a body size limit, and the 32 KiB cap
in `rate-limit.md` is on `/api/auth/*`, which is outside this envelope by invariant 1.
When a route needs to reject on size, append `payload_too_large` to `ERROR_CODES` with a
413 row, in the same commit as the route.

### `details` is narrowed before the body is written

Added 2026-08-05 (F-096, ADR-0026). This reverses ADR-0024's accepted cost, which had the
filter forwarding `details` verbatim for every code.

```ts
// apps/api/src/common/errors/error-envelope.ts
export function narrowEnvelope(envelope: ErrorEnvelope): ErrorEnvelope;
```

Reference body. This exact text was typechecked against a program configured like
`apps/api` (bundler resolution, `paths` to the contracts source, no `zod` in
`apps/api/package.json`), so importing the schema does not breach ADR-0025: the filter
imports a schema object from `@shortkit/contracts`, not zod.

```ts
export function narrowEnvelope(envelope: ErrorEnvelope): ErrorEnvelope {
  const { code, message, details } = envelope;

  if (details === undefined) return { code, message };

  if (code === 'validation_failed') {
    const parsed = validationDetailsContract.safeParse(details);

    if (parsed.success) return { code, message, details: parsed.data };
  }

  return { code, message };
}
```

| `code` | `details` | Result |
|---|---|---|
| any | absent | `{ code, message }`, rebuilt; any other top-level key is dropped |
| `validation_failed` | passes `validationDetailsContract` | `details` replaced by the **parse output**, not the input |
| `validation_failed` | fails `validationDetailsContract` | `details` dropped |
| any other code | present | `details` dropped |

Using the parse output rather than the input is the point of the rule: `z.object` strips
unknown keys, so a sibling attached beside `fieldErrors` does not survive (verified
against zod 4.4.3). Forwarding the input on a successful parse would let
`{ fieldErrors: {...}, conflictingRow: {...} }` through.

**Every row rebuilds the envelope from `code` and `message`, the first row included.**
Amended 2026-08-05 (F-107): the `details === undefined` row returned the caller's object
by reference, so a top-level sibling key reached the wire unnarrowed, which is the leak
this rule closes for `details` one level down. TypeScript does not stop the producer.
`override toEnvelope(): ErrorEnvelope { return { ...conflictingRow, code, message }; }`
compiles clean under `--strict`, because excess property checking does not apply to
properties arriving from a spread; the same object written as a direct literal errors
TS2353 (verified on TypeScript 5.9.3). The rebuild costs one object allocation on the
path every non-validation error takes, and it makes the function's guarantee whole: what
comes out has three keys at most, whatever went in.

The filter applies `narrowEnvelope` **once, to the body it is about to write**, so branch
1's `toEnvelope()` output passes through it along with branches 2 to 4. When `details` was
present and the returned envelope has none, the filter logs at `warn` with the `code`, and
**never the dropped value** — that value is the one suspected of carrying another tenant's
data, and a log is not a safe place for it (GC-9).

A code that needs a `details` shape amends this contract and `narrowEnvelope` in the same
commit as its throw site. Attaching an unnamed shape and hoping now produces a body
without `details`.

### Two more cases the filter has to answer

- **A code with no status.** `ERROR_CODE_STATUS[code]` returning `undefined` is
  unreachable by type and reachable through a cast. Answer 500 `internal_error` and log
  the code. Never answer with `undefined` as a status.
- **A response already started.** The redirect surface streams a 302 outside `/api`. If
  the headers are sent, the filter logs and ends the response. It does not write a body
  over a started one.

## How a TASK tests its own error mapping

Two levels, and neither one imports the filter. Only TASK-007's own spec constructs it.

**Level 1, on the constructed error.** The mapping is a property of the error, so assert
it there:

```ts
const error = new InvitationExpiredError();

expect(error.code).toBe('invitation_expired');
expect(error.status).toBe(410);
expect(errorEnvelopeContract.safeParse(error.toEnvelope()).success).toBe(true);
```

**Level 2, one HTTP round trip through the TASK's own route.** Assert the status and
`body.code` against the same pair. That proves the error reaches the filter through the
guards, interceptors and transaction between the throw and the response.

Calling `filter.catch(error, host)` directly asserts the filter's arguments rather than
the client's experience, and it passes just as well when the filter is never registered.
TASK-007's spec covers the four branches; nobody else re-covers them.

## Invariants a caller may rely on

1. Every non-2xx response from a route under the `/api` prefix has a body validating
   against `errorEnvelopeContract`. **Exception:** Better Auth's own routes at
   `/api/auth/*` are mounted outside Nest (ADR-0013) and return Better Auth's native
   error shape. TASK-008 maps them at the client boundary; nothing else may rely on the
   envelope there.
2. `code` is stable across releases. Codes are appended to `ERROR_CODES`, never
   renamed and never removed. A code's status never changes.
3. `message` is human-readable English intended for display, and may change at any
   time. **Callers must never branch on `message`.**
4. `details` is present only where this contract names a shape for it. When `code` is
   `validation_failed`, `details` is present and validates against
   `validationDetailsContract`. A key of `_form` (`FORM_ERROR_KEY`) holds the issues
   that belong to the request as a whole rather than to one field, so a client
   rendering only per-field errors drops nothing.
5. Cross-tenant access always returns 404 `not_found`, never 403. Existence is not
   disclosed. This holds for TASK-014, 018, 021, 025, 040, 045, 049 (AC-24, AC-27,
   AC-41, AC-69, AC-81).
6. `insufficient_workspace_role` and `insufficient_tenant_role` are only returned when
   the caller **is** a member and the role is too low. Absence of membership is
   `not_found`.
7. A 429 always carries a `Retry-After` header in delta-seconds.
8. No error body contains a raw IP address, a password, a token, or a `tenant_id`
   other than the caller's own (GC-9).
9. A 500 the caller did not cause carries `INTERNAL_ERROR_MESSAGE` and no `details`.
   Nothing of the underlying failure reaches the body. Debugging one means finding its
   `request_id` in the logs.
10. **A 409 on a uniqueness conflict discloses one bit and nothing else.** Added
    2026-08-05 (F-097). The bit is "this value is taken". Never which tenant holds it,
    never which workspace, never when it was claimed, never any part of the conflicting
    row. The message is fixed per code and `details` is absent, which the narrowing above
    now enforces at the filter rather than at the throw site.

    A uniqueness code may only be returned where **that bit is already observable without
    the endpoint**. Each of the two in `ERROR_CODES` today:

    - `hostname_already_claimed` is returned only when the conflicting row is in
      `verified`, `provisioning` or `active`, which is exactly the predicate of
      `domains_hostname_owned_unique`. Every one of those states requires a public
      `CNAME` to `<FLY_APP_NAME>.fly.dev` in the hostname's own zone
      (`domain-provisioning.md`), and `active` additionally puts the hostname in a
      Certificate Transparency log. A DNS query answers the same question, cheaper and
      unauthenticated. Returning 409 for a row in `pending_verification` or
      `verification_failed` **is** a disclosure, because nothing about those rows is
      public, and it is forbidden. See `domain-provisioning.md`.
    - `slug_taken` is scoped `(domain_id, slug)` (GC-6). On a shared system domain the
      namespace is already enumerable by requesting the short URL, so the 409 adds
      nothing for a link that resolves. Residual, accepted: a slug held by an expired or
      disabled link answers 404 at the redirect surface and 409 here, so the pair
      discloses that some tenant holds a non-serving link on a shared domain. One bit, no
      identity, no way to attribute it.

    Any new uniqueness code justifies itself against this invariant in the ADR that adds
    it. "It is only a 409" is not the justification.

## What the implementer must guarantee

- The exception filter is registered as `APP_FILTER` in `AppModule` and catches every
  thrown error, including non-`HttpException` throwables, which become 500
  `internal_error` carrying `INTERNAL_ERROR_MESSAGE` and nothing of the original error.
  The original goes to the log through `errorLogFields`, as `err_name` and an `err_stack`
  of frames, with `err_message` only for a `DomainError`. Amended 2026-08-05 (F-106) and
  2026-08-08 (TASK-003, F-242): this bullet first asked for the stack, then forbade it.
  See "What the 500 log line carries, and who owns changing it" above, which is the only
  place this contract states that policy.
- The four branches run in the order above, and `DomainError` is tested first.
- A `ZodError` becomes 400 `validation_failed` with `details` from
  `toValidationDetails(err)`. Do not call `err.flatten()`: it drops every issue with an
  empty path into a `formErrors` array that `ValidationDetails` has nowhere to put, so a
  schema-level `.refine()` failure would answer 400 with an empty `fieldErrors`.
- `err.headers` is written to the response before the body. That is how a 429 gets its
  `Retry-After` (invariant 7) without the guard reaching for the response object.
- Every body the filter writes goes through `narrowEnvelope` first, and no message from
  an `HttpException` reaches a body. The filter emits only strings declared in its own
  source and shapes validated against a schema in `packages/contracts` (ADR-0026).
- A code's status comes from `ERROR_CODE_STATUS` at every point. No call site, decorator
  or filter branch picks one.
- Adding a code means appending to `ERROR_CODES`, adding a row to `ERROR_CODE_STATUS`,
  and adding a row to the status table above, in the same commit.

## Versioning

Additive only. `ErrorCode` is a closed union at compile time, so `apps/web` must handle
an unknown code defensively at runtime even though the type says it cannot occur:
`<ErrorMessage />` falls back to a generic message for any code it has no copy for.
No URL versioning (ADR-0006).

`DomainError` is API-internal and carries no compatibility promise. It never crosses the
wire and `apps/web` never imports it; the envelope is what both sides share. Changing
its constructor is a refactor across `apps/api`, not a breaking change for any client.
