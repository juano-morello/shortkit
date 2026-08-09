/**
 * Contract: design/contracts/error-envelope.md
 * ADR: adr-0024-domain-error-transport.md
 * Produced by: TASK-007
 * Consumed by: TASK-010, 011, 014, 017, 018, 021, 024, 025, 040, 045, 049, 051, 053, 054
 *
 * ============================================================================
 * THE ONLY WAY AN ERROR CARRIES AN ErrorCode TO THE EXCEPTION FILTER.
 * ============================================================================
 *
 * Throw a DomainError, or a subclass of one, and the filter answers with its code and
 * the status ERROR_CODE_STATUS gives that code. Throw anything else and the filter
 * answers 500 `internal_error` with INTERNAL_ERROR_MESSAGE and nothing of the original
 * error in the body. That default is the safe one on purpose: an error only reaches a
 * client because someone decided it should.
 *
 * THE MESSAGE IS PART OF THE PROMISE. Constructing a DomainError asserts that its
 * message is safe to show a stranger: no connection string, no token, no other tenant's
 * id, no internal identifier (GC-9). A message that fails that test belongs in the log,
 * which means the error is not a DomainError.
 *
 * NEVER WRAP. The filter does not walk `cause`, so re-throwing a DomainError inside a
 * plain `new Error(...)` turns a 409 into a 500. Let it propagate: nothing between the
 * throw and the filter catches it, and withTenantTransaction rolls back and rethrows the
 * original (AC-11). If a wrapper is genuinely needed, the wrapper is itself a
 * DomainError and the original goes in `cause`, which reaches the log and not the body.
 *
 * NO CENTRAL CATALOGUE. A feature that wants a named error declares the subclass in its
 * own directory. Nothing is registered anywhere, so no TASK edits a shared file to add
 * an error, and a wave conflict here is impossible.
 */
import { ERROR_CODE_STATUS } from '@shortkit/contracts';
import type { ErrorCode, ErrorEnvelope } from '@shortkit/contracts';

/**
 * Registered rather than local, so the check survives a second copy of this module in
 * one process: a vitest workspace running two projects, or a bundled build loaded beside
 * source. `instanceof` alone would silently stop matching there, and the symptom is
 * every domain error in the duplicated graph turning into a 500.
 */
export const DOMAIN_ERROR_MARKER: unique symbol = Symbol.for('shortkit.domainError');

export interface DomainErrorOptions {
  /** Only where error-envelope.md names a shape for the code. Reaches the body. */
  readonly details?: unknown;
  /** Written to the response before the body. `Retry-After` on `rate_limited`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Reaches the log, never the body. */
  readonly cause?: unknown;
}

export class DomainError extends Error {
  readonly [DOMAIN_ERROR_MARKER]: true = true;

  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly headers?: Readonly<Record<string, string>>;

  constructor(code: ErrorCode, message: string, options?: DomainErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    // `new.target`, so a subclass reports its own name in the log without restating it.
    this.name = new.target.name;
    this.code = code;
    this.details = options?.details;
    this.headers = options?.headers;
  }

  /**
   * DERIVED, never passed in. A code has exactly one status (error-envelope.md
   * invariant 2), and a status argument here is how a call site would break that.
   */
  get status(): number {
    return ERROR_CODE_STATUS[this.code];
  }

  toEnvelope(): ErrorEnvelope {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * What the filter calls. Tests call it too, so no test needs to reach into the filter
 * to assert that an error maps to a code.
 */
export function isDomainError(value: unknown): value is DomainError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[DOMAIN_ERROR_MARKER] === true
  );
}

/**
 * The whole body of every 500 the filter emits for an unmapped throwable. Fixed, so no
 * detail of the failure can reach a client through it, and so a test can assert on it.
 * Clients still never branch on a message (error-envelope.md invariant 3).
 */
export const INTERNAL_ERROR_MESSAGE = 'The request could not be completed.';

/**
 * A named subclass looks like this, IN THE FEATURE'S OWN DIRECTORY, not here:
 *
 *   // apps/api/src/links/slug-taken.error.ts   (TASK-025)
 *   export class SlugTakenError extends DomainError {
 *     constructor(slug: string) {
 *       super('slug_taken', `The short code ${slug} is already in use.`);
 *     }
 *   }
 *
 * Subclass when the error is thrown from more than one place or carries data a caller
 * inspects. Otherwise `throw new DomainError('not_found', '...')` at the throw site is
 * the whole of it.
 */
