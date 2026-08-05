# Contract: error envelope and error code registry

- **Boundary:** every API response body that is not 2xx; every client that renders a failure; every `throw` in `apps/api` that expects a status other than 500.
- **Normative form:** `packages/contracts/src/errors.ts` (the wire shape and the code list) and `apps/api/src/common/errors/domain-error.ts` (how a throw carries a code). Stubs at the matching paths under `design/stubs/`.
- **Produced by:** TASK-007.
- **Consumed by:** TASK-008, 010, 011, 012, 014, 017, 018, 021, 024, 025, 040, 045, 049, 051, 052, 053, 054.
- **ADRs:** ADR-0005, ADR-0013, ADR-0024, ADR-0025.

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
 * The status table below, as data. The one source of a code's status: the filter reads
 * it, `DomainError.status` derives from it, and nothing chooses a status any other way.
 */
export declare const ERROR_CODE_STATUS: Record<ErrorCode, number>;

export declare function isErrorEnvelope(value: unknown): value is ErrorEnvelope;

/**
 * ADR-0025. Every schema in the system is declared in this package, so this package
 * recognises and flattens its own errors. The API filter calls these; it does not
 * import zod, and it does not hand-roll the flatten.
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

Branch 4 puts nothing from the original error in the body. Its name, message and stack
go to the log at `error` with the `request_id` (`logging-and-headers.md`). That default
is the safe one on purpose: a Postgres error naming a connection string, a Redis timeout
naming an internal host and an assertion quoting a row all land here.

`isZodError` and `toValidationDetails` come from `@shortkit/contracts` (ADR-0025). The
filter imports zod nowhere, value or type, so TASK-007 needs no entry in
`apps/api/package.json` for this path.

### Branch 3: framework exceptions

`HttpException` is what the framework raises on its own. Application code throws a
`DomainError` instead, and TASK-056 greps for an `HttpException` subclass thrown under
`src/` outside `common/errors`.

| Status | Code | Body detail |
|---|---|---|
| 404 | `not_found` | no route matched |
| 400 | `validation_failed` | `details.fieldErrors` = `{ _form: [<the exception's message>] }`, from a malformed JSON body |
| any other | `internal_error` | 500, and the original status is logged |

The message for a 400 comes from the `HttpException`'s own response, which the framework
or an implementer wrote. Never from an arbitrary `Error.message`.

**A 413 answers 500 today.** `ERROR_CODES` has no code for a body over Express's default
limit, and `ERROR_CODE_STATUS` allows a code exactly one status, so there is nothing to
map it to. No `/api` route in launch-core documents a body size limit, and the 32 KiB cap
in `rate-limit.md` is on `/api/auth/*`, which is outside this envelope by invariant 1.
When a route needs to reject on size, append `payload_too_large` to `ERROR_CODES` with a
413 row, in the same commit as the route.

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

## What the implementer must guarantee

- The exception filter is registered as `APP_FILTER` in `AppModule` and catches every
  thrown error, including non-`HttpException` throwables, which become 500
  `internal_error` with `INTERNAL_ERROR_MESSAGE` and the stack in the log only.
- The four branches run in the order above, and `DomainError` is tested first.
- A `ZodError` becomes 400 `validation_failed` with `details` from
  `toValidationDetails(err)`. Do not call `err.flatten()`: it drops every issue with an
  empty path into a `formErrors` array that `ValidationDetails` has nowhere to put, so a
  schema-level `.refine()` failure would answer 400 with an empty `fieldErrors`.
- `err.headers` is written to the response before the body. That is how a 429 gets its
  `Retry-After` (invariant 7) without the guard reaching for the response object.
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
