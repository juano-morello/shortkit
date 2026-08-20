import { describe, expect, it, vi } from 'vitest';

import { DomainError, isDomainError } from './domain-error';
import type * as domainErrorModule from './domain-error';

/**
 * AC-13: a rejected API request answers with the shared envelope and a stable
 * machine-readable `code`. ADR-0024 makes `DomainError` the one way application code
 * says which code that is, so the mapping is a property of the constructed error
 * before it is a property of any response.
 *
 * These are `error-envelope.md`'s "level 1" assertions, the ones the contract tells
 * every consuming TASK (010, 011, 014, 017, 018, 021, 024, 025, 040, 045, 049, 051,
 * 053, 054) to write against its own subclass. Nothing here imports or constructs the
 * exception filter; the round trip through it lives in `exception-filter.spec.ts`.
 *
 * A `status` getter and a `toEnvelope()` that the filter happened to bypass would still
 * answer every client correctly, and every one of those fourteen TASKs would still be
 * asserting on a broken pair. That is why these are separate from the round trip rather
 * than folded into it.
 */

/** Safe to show a stranger, which is what constructing a `DomainError` promises. */
const SAFE_MESSAGE = 'The short code launch is already in use.';

/** Stands in for the class of value invariant 8 forbids in a body: a credential. */
const LEAKED_SECRET = 'postgres://shortkit:hunter2@db.internal:5432';

/**
 * Hand-read off `error-envelope.md`'s status table, not computed from
 * `ERROR_CODE_STATUS`: an expectation the code under test derives would hold whatever
 * that code did. Four codes with four different statuses, so a `status` that returns a
 * constant, or reads a table other than the contract's, cannot satisfy all of them.
 */
const CODE_STATUS_CASES = [
  { code: 'slug_taken', status: 409 },
  { code: 'invitation_expired', status: 410 },
  { code: 'rate_limited', status: 429 },
  { code: 'internal_error', status: 500 },
] as const;

/**
 * How a feature declares a named error (ADR-0024: in its own directory, never in a
 * shared catalogue). TASK-025's `SlugTakenError` is this, in `apps/api/src/links/`.
 */
class SlugTakenError extends DomainError {
  constructor(slug: string) {
    super('slug_taken', `The short code ${slug} is already in use.`);
  }
}

describe('DomainError', () => {
  it.each(CODE_STATUS_CASES)(
    'AC-13: derives status $status for code $code, the row error-envelope.md gives it',
    ({ code, status }) => {
      const error = new DomainError(code, SAFE_MESSAGE);

      expect(error.status).toBe(status);
    },
  );

  it('AC-13: a subclass derives the status of the code it passed up', () => {
    const error = new SlugTakenError('launch');

    expect(error.status).toBe(409);
  });

  it('AC-13: toEnvelope carries the code and the message, and nothing of the cause', () => {
    const error = new DomainError('slug_taken', SAFE_MESSAGE, {
      cause: new Error(`connection to ${LEAKED_SECRET} refused`),
    });

    expect(error.toEnvelope()).toEqual({ code: 'slug_taken', message: SAFE_MESSAGE });
  });

  it('AC-13: toEnvelope carries the details the error was constructed with', () => {
    const error = new DomainError('validation_failed', 'That short code cannot be used.', {
      details: { fieldErrors: { slug: ['is reserved'] } },
    });

    expect(error.toEnvelope().details).toEqual({ fieldErrors: { slug: ['is reserved'] } });
  });
});

describe('isDomainError', () => {
  it('AC-13: recognises a DomainError', () => {
    expect(isDomainError(new DomainError('not_found', 'No such link.'))).toBe(true);
  });

  it('AC-13: recognises a subclass declared in a feature directory', () => {
    expect(isDomainError(new SlugTakenError('launch'))).toBe(true);
  });

  it('AC-13: rejects an error carrying no code, which the filter answers 500 for', () => {
    expect(isDomainError(new Error(`connection to ${LEAKED_SECRET} refused`))).toBe(false);
  });

  it('AC-13: rejects null rather than throwing on it', () => {
    // `throw null` is legal, and the filter has to answer for every throwable in the
    // process. A check spelled `(value as DomainError)[MARKER] === true` throws here.
    expect(isDomainError(null)).toBe(false);
  });

  it('AC-13: recognises a DomainError built by a second copy of this module', async () => {
    const secondGraph = await loadSecondCopyOfThisModule();
    const error = new secondGraph.DomainError('slug_taken', SAFE_MESSAGE);

    expect(isDomainError(error)).toBe(true);
  });
});

/**
 * A second evaluation of `domain-error.ts` in this process: a distinct class object
 * that `instanceof DomainError` rejects, carrying the same `Symbol.for` marker.
 *
 * That duplication is what ADR-0024 chose a registered symbol for: TASK-056's
 * isolation suite and the integration config load these same sources under a second
 * vitest project. `instanceof` passes every test in this file except this one, and its
 * failure mode in production is every domain error in the duplicated graph silently
 * becoming a 500.
 *
 * The guard below is the honesty check: if the runner ever starts handing back the
 * cached module, the fixture stops being a second copy and this test would pass against
 * an `instanceof` implementation. It says so loudly instead.
 */
async function loadSecondCopyOfThisModule(): Promise<typeof domainErrorModule> {
  vi.resetModules();
  const secondGraph = await import('./domain-error');

  if (secondGraph.DomainError === DomainError) {
    throw new Error(
      'fixture is stale: the dynamic import returned the same class object, so this is not a second module graph and the test would pass against an instanceof check',
    );
  }

  if (new secondGraph.DomainError('not_found', 'x') instanceof DomainError) {
    throw new Error(
      'fixture is stale: an error from the second copy still satisfies instanceof, so this test no longer distinguishes the two implementations',
    );
  }

  return secondGraph;
}
