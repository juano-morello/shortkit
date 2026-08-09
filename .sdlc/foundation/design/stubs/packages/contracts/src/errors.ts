/**
 * Contract: design/contracts/error-envelope.md
 * Produced by: TASK-007
 *
 * Codes are APPEND-ONLY. Never rename, never remove, never change a code's status.
 */
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
 * Normative status mapping. The API exception filter reads this; nothing else may
 * return a code with a different status.
 */
export const ERROR_CODE_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  confirmation_required: 400,
  verification_token_invalid: 400,
  workspace_id_required: 400,
  unauthenticated: 401,
  token_expired: 401,
  email_not_verified: 403,
  insufficient_workspace_role: 403,
  insufficient_tenant_role: 403,
  not_found: 404,
  slug_taken: 409,
  hostname_already_claimed: 409,
  last_owner_protected: 409,
  invitation_already_accepted: 409,
  invitation_tenant_conflict: 409,
  invitation_expired: 410,
  invitation_revoked: 410,
  rate_limited: 429,
  internal_error: 500,
  slug_generation_exhausted: 500,
};

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return errorEnvelopeContract.safeParse(value).success;
}

/**
 * ============================================================================
 * ZOD'S IDENTITY STAYS ON THIS SIDE OF THE BOUNDARY (ADR-0025).
 * ============================================================================
 *
 * Every zod schema in the system is declared in THIS package (ADR-0005), so this is
 * where a ZodError is recognised and flattened, next to the ValidationDetails shape the
 * flatten produces. The API filter calls these; it imports zod nowhere and does not
 * duck-type the error. A check on `issues` plus `name` stops matching the day zod
 * changes its internals, and the failure is silent: every malformed request body starts
 * answering 500 instead of 400.
 *
 * Declaration-only, so `sideEffects: false` still holds.
 */
export function isZodError(value: unknown): value is z.ZodError {
  return value instanceof z.ZodError;
}

/**
 * The key an issue with an empty path lands under, so a schema-level `.refine()`
 * failure reaches the user instead of vanishing.
 *
 * NO REQUEST CONTRACT MAY DECLARE A FIELD WITH THIS NAME. zod's own `flattenError`
 * drops root issues into a separate `formErrors` array that `ValidationDetails` has no
 * room for, and dropping them renders a form that reports nothing while refusing to
 * submit.
 */
export const FORM_ERROR_KEY = '_form';

/**
 * Caps on what one `ZodError` may turn into (F-095). zod reports one issue per failing
 * element, so an array body of 50k bad elements would otherwise build a multi-megabyte
 * body inside the exception filter from a 100 KB request.
 *
 * Issues past `MAX_VALIDATION_ISSUES` are not read. Messages past
 * `MAX_MESSAGES_PER_FIELD` for one key are dropped. If anything was dropped,
 * `VALIDATION_TRUNCATED_MESSAGE` is appended under `FORM_ERROR_KEY`, so a form shows
 * that there is more rather than silently showing less.
 */
export const MAX_VALIDATION_ISSUES = 100;
export const MAX_MESSAGES_PER_FIELD = 10;
export const VALIDATION_TRUNCATED_MESSAGE = 'Some errors were omitted.';

/**
 * ZodError -> the `details` of a `validation_failed` envelope.
 *
 * Keyed by the FIRST path segment, so `body.name` and `body.name.first` share the key
 * `name`. That matches zod's own flatten and the flat field map a form renders.
 * `issue.message` is zod's text; it names the field and the constraint and carries
 * nothing from the request value.
 *
 * ============================================================================
 * THE ACCUMULATOR IS A `Map`, NOT AN OBJECT LITERAL. THIS IS NOT STYLE (F-086, F-087).
 * ============================================================================
 *
 * `issue.path[0]` is caller-controlled the moment a request schema puts a user key in
 * the first segment: a top-level `z.record`, a `catchall`, or a `superRefine` setting
 * its own path. Accumulating into `{}` and reading `fieldErrors[key] ?? []` walks
 * `Object.prototype`, so a key of `constructor`, `toString`, `valueOf` or
 * `hasOwnProperty` reads an inherited value instead of `undefined` and the next line
 * throws `TypeError: messages.push is not a function` — reproduced against zod 4.4.3,
 * where `z.record(z.string(), z.string()).safeParse(JSON.parse('{"constructor": 2}'))`
 * yields an issue with `path: ["constructor"]`. The throw escapes the exception filter,
 * re-enters it as a TypeError and answers 500 with no field errors, on the shared
 * validation path every consuming TASK inherits.
 *
 * `Map` fixes it by construction rather than by discipline: no prototype to consult, so
 * no future edit has to remember an `Object.hasOwn` guard. `Object.fromEntries` then
 * returns an ORDINARY object, which matters twice: `validationDetailsContract` accepts
 * it, and a `__proto__` key lands as an own, JSON-visible property rather than setting a
 * prototype (verified on Node 24.19 — `Object.fromEntries` uses CreateDataProperty,
 * which ignores the `__proto__` setter). A null-prototype accumulator also fixes the
 * crash, and is rejected only because it hands every downstream reader an object whose
 * prototype is not the one they expect.
 *
 * Any other reducer keyed by caller-supplied strings — `details`-shaped or not — has
 * this defect unless it is written the same way.
 */
export function toValidationDetails(error: z.ZodError): ValidationDetails {
  const byKey = new Map<string, string[]>();
  let truncated = error.issues.length > MAX_VALIDATION_ISSUES;

  for (const issue of error.issues.slice(0, MAX_VALIDATION_ISSUES)) {
    const key = issue.path.length === 0 ? FORM_ERROR_KEY : String(issue.path[0]);
    const messages = byKey.get(key);

    if (messages === undefined) {
      byKey.set(key, [issue.message]);
    } else if (messages.length < MAX_MESSAGES_PER_FIELD) {
      messages.push(issue.message);
    } else {
      truncated = true;
    }
  }

  if (truncated) {
    const formMessages = byKey.get(FORM_ERROR_KEY);

    if (formMessages === undefined) {
      byKey.set(FORM_ERROR_KEY, [VALIDATION_TRUNCATED_MESSAGE]);
    } else {
      formMessages.push(VALIDATION_TRUNCATED_MESSAGE);
    }
  }

  return { fieldErrors: Object.fromEntries(byKey) };
}
