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
 * ZodError -> the `details` of a `validation_failed` envelope.
 *
 * Keyed by the FIRST path segment, so `body.name` and `body.name.first` share the key
 * `name`. That matches zod's own flatten and the flat field map a form renders.
 * `issue.message` is zod's text; it names the field and the constraint and carries
 * nothing from the request value.
 */
export function toValidationDetails(error: z.ZodError): ValidationDetails {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? FORM_ERROR_KEY : String(issue.path[0]);
    const messages = fieldErrors[key] ?? [];

    messages.push(issue.message);
    fieldErrors[key] = messages;
  }

  return { fieldErrors };
}
