/**
 * Contract: docs/contracts/error-envelope.md ("Message constants", branch 2)
 * ADR: adr-0024-domain-error-transport.md, adr-0025-zod-error-recognition-in-contracts.md
 * Produced by: TASK-1b-08 (lifted from `workspaces.controller.ts`, TASK-012, which keeps
 *              its own copy until its owner adopts this one)
 *
 * Request bodies and queries are parsed THROUGH THE CONTRACTS INSIDE THE HANDLER. No
 * `ZodValidationPipe` exists (ADR-0025, "Follow-ups") and `apps/api` declares no `zod`
 * dependency, so a route calls the schema by hand and turns the `ZodError` into a
 * `DomainError` carrying `validation_failed` and `toValidationDetails(error)`: the same shape
 * the filter's own branch 2 builds, produced where the route decides everything else.
 * `isZodError` and `toValidationDetails` come from `@shortkit/contracts`; zod is imported
 * nowhere in this file, value or type.
 */
import { isZodError, toValidationDetails } from '@shortkit/contracts';

import { DomainError } from './domain-error';

/**
 * The same text the filter's own validation branches carry (`error-envelope.md`, "Message
 * constants"): a client renders per code and never branches on a message, and the failing
 * fields are in `details`. Restated rather than imported because the filter keeps its
 * constants module-private, and F-098's point (no third string) holds as long as the value
 * is the same.
 */
export const VALIDATION_FAILED_MESSAGE = 'The request could not be validated.';

/** The one shape this file needs of a contract: something with `parse`. Not a zod type. */
export interface Contract<T> {
  parse(input: unknown): T;
}

/**
 * Parses `input` with `contract`; a `ZodError` becomes 400 `validation_failed` with the
 * flattened field errors as `details`, and anything else is rethrown untouched.
 */
export function parseOrThrow<T>(contract: Contract<T>, input: unknown): T {
  try {
    return contract.parse(input);
  } catch (error: unknown) {
    if (isZodError(error)) {
      throw new DomainError('validation_failed', VALIDATION_FAILED_MESSAGE, {
        details: toValidationDetails(error),
      });
    }

    throw error;
  }
}
