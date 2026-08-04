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
