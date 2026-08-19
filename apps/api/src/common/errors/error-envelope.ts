import { ERROR_CODE_STATUS, validationDetailsContract } from '@shortkit/contracts';
import type { ErrorCode, ErrorEnvelope } from '@shortkit/contracts';

/**
 * Contract: docs/contracts/error-envelope.md
 *
 * The one error shape the API returns. `ERROR_CODE_STATUS` is normative, so the
 * status is never chosen at the call site — a code always carries the status the
 * contract gives it. TASK-007's exception filter serialises through this.
 */
export interface ErrorResponse {
  readonly status: number;
  readonly body: ErrorEnvelope;
}

export function errorResponse(code: ErrorCode, message: string, details?: unknown): ErrorResponse {
  return {
    status: ERROR_CODE_STATUS[code],
    body: details === undefined ? { code, message } : { code, message, details },
  };
}

/**
 * ADR-0026. The last checkpoint before the wire: the filter writes only strings it chose
 * itself and shapes validated against a schema in `packages/contracts`.
 *
 * `details` is typed `unknown` on `DomainError` (ADR-0024) and `z.unknown().optional()`
 * on the envelope, so a throw site can attach anything and no downstream assertion
 * notices. The tempting shape for a 409 is the row that conflicted, and that row belongs
 * to another tenant. This narrowing makes attaching an unnamed shape a drop rather than
 * a leak.
 *
 * - `details` absent: the envelope is rebuilt as `{ code, message }`. Corrected 2026-08-05
 *   (F-107); this row used to return the caller's envelope by reference, which shipped any
 *   top-level sibling key on it unnarrowed.
 * - `validation_failed`: kept only if it parses, and what is kept is the PARSE OUTPUT.
 *   `z.object` strips unknown keys, so a sibling attached beside `fieldErrors` does not
 *   survive — forwarding the input on a successful parse would let it through.
 * - Any other code: dropped. This contract names a `details` shape for exactly one code,
 *   and a code that wants a second one amends `error-envelope.md` and this function in
 *   the same commit as its throw site.
 *
 * This lives at the boundary rather than inside `DomainError.toEnvelope()` because a
 * subclass in a feature directory may override `toEnvelope()`, and branches 2 to 4 never
 * call it. The filter is the one place every body passes through.
 */
export function narrowEnvelope(envelope: ErrorEnvelope): ErrorEnvelope {
  const { code, message, details } = envelope;

  if (details === undefined) {
    return { code, message };
  }

  if (code === 'validation_failed') {
    const parsed = validationDetailsContract.safeParse(details);

    if (parsed.success) {
      return { code, message, details: parsed.data };
    }
  }

  return { code, message };
}
