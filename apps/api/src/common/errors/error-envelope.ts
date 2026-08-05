import { ERROR_CODE_STATUS } from '@shortkit/contracts';
import type { ErrorCode, ErrorEnvelope } from '@shortkit/contracts';

/**
 * Contract: design/contracts/error-envelope.md
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
