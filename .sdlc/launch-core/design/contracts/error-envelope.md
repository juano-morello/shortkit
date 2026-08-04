# Contract: error envelope and error code registry

- **Boundary:** every API response body that is not 2xx; every client that renders a failure.
- **Normative form:** `packages/contracts/src/errors.ts` (stub: `design/stubs/packages/contracts/src/errors.ts`).
- **Produced by:** TASK-007.
- **Consumed by:** TASK-008, 011, 012, 014, 017, 018, 021, 025, 040, 045, 049, 051, 052, 053, 054.
- **ADRs:** ADR-0005, ADR-0013.

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
   `validation_failed`, `details` validates against `validationDetailsContract`.
5. Cross-tenant access always returns 404 `not_found`, never 403. Existence is not
   disclosed. This holds for TASK-014, 018, 021, 025, 040, 045, 049 (AC-24, AC-27,
   AC-41, AC-69, AC-81).
6. `insufficient_workspace_role` and `insufficient_tenant_role` are only returned when
   the caller **is** a member and the role is too low. Absence of membership is
   `not_found`.
7. A 429 always carries a `Retry-After` header in delta-seconds.
8. No error body contains a raw IP address, a password, a token, or a `tenant_id`
   other than the caller's own (GC-9).

## What the implementer must guarantee

- The exception filter is registered as `APP_FILTER` in `AppModule` and catches every
  thrown error, including non-`HttpException` throwables, which become 500
  `internal_error` with a fixed message and the stack in the log only.
- A `ZodError` from a validation pipe becomes 400 `validation_failed` with
  `details.fieldErrors` from `error.flatten().fieldErrors`.
- Adding a code means appending to `ERROR_CODES` and adding a row above in the same
  commit.

## Versioning

Additive only. `ErrorCode` is a closed union at compile time, so `apps/web` must handle
an unknown code defensively at runtime even though the type says it cannot occur:
`<ErrorMessage />` falls back to a generic message for any code it has no copy for.
No URL versioning (ADR-0006).
