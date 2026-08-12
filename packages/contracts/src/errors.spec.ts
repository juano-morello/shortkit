import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ERROR_CODES,
  ERROR_CODE_STATUS,
  errorEnvelopeContract,
  isErrorEnvelope,
  isZodError,
  toValidationDetails,
  validationDetailsContract,
} from './errors';

describe('ERROR_CODE_STATUS', () => {
  it('maps every declared code to a status', () => {
    expect(Object.keys(ERROR_CODE_STATUS).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('only maps to statuses the envelope is allowed to carry', () => {
    for (const status of Object.values(ERROR_CODE_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

describe('errorEnvelopeContract', () => {
  it('accepts a code, a message and optional details', () => {
    const parsed = errorEnvelopeContract.parse({
      code: 'slug_taken',
      message: 'that slug is already in use',
    });

    expect(parsed.code).toBe('slug_taken');
    expect(parsed.details).toBeUndefined();
  });

  it('rejects a code outside the append-only list', () => {
    expect(errorEnvelopeContract.safeParse({ code: 'teapot', message: 'no' }).success).toBe(false);
  });

  it('rejects an empty message', () => {
    expect(errorEnvelopeContract.safeParse({ code: 'not_found', message: '' }).success).toBe(false);
  });
});

describe('isErrorEnvelope', () => {
  it('narrows a valid envelope', () => {
    expect(isErrorEnvelope({ code: 'rate_limited', message: 'slow down' })).toBe(true);
  });

  it('rejects a value that is not an envelope', () => {
    expect(isErrorEnvelope({ error: 'boom' })).toBe(false);
    expect(isErrorEnvelope(null)).toBe(false);
  });
});

describe('validationDetailsContract', () => {
  it('accepts field errors keyed by field name', () => {
    const parsed = validationDetailsContract.parse({
      fieldErrors: { slug: ['is required', 'is reserved'] },
    });

    expect(parsed.fieldErrors.slug).toEqual(['is required', 'is reserved']);
  });

  it('rejects a bare string where a list of messages belongs', () => {
    expect(
      validationDetailsContract.safeParse({ fieldErrors: { slug: 'is required' } }).success,
    ).toBe(false);
  });
});

/**
 * ADR-0025 puts the recognition and the flatten in this package because the shape they
 * produce is declared eight lines above them. The two rules that placement exists to
 * keep together — an empty path lands under `_form`, and a path collapses to its first
 * segment — are asserted here, over real `ZodError`s.
 *
 * Every error below comes out of a real schema. An issue array written by hand would
 * assert this file's idea of zod rather than the zod 4.4.3 ADR-0025 was verified
 * against, and the day zod changes an issue's shape the hand-rolled fixture would keep
 * passing while the filter answered 500.
 */
function zodErrorFrom(schema: z.ZodType, value: unknown): z.ZodError {
  const result = schema.safeParse(value);

  if (result.success) {
    throw new Error('fixture is stale: the schema accepted the value it was built to reject');
  }

  return result.error;
}

describe('isZodError', () => {
  it('narrows an error a schema in this package actually threw', () => {
    const error = zodErrorFrom(errorEnvelopeContract, { code: 'not_found', message: '' });

    expect(isZodError(error)).toBe(true);
  });

  it('rejects a plain object wearing a ZodError name and an issue list', () => {
    expect(isZodError({ name: 'ZodError', issues: [] })).toBe(false);
  });
});

describe('toValidationDetails', () => {
  /** A root `.refine()`: the failure zod's own `flattenError` drops (ADR-0025). */
  const matchingPasswords = z
    .object({ password: z.string(), confirm: z.string() })
    .refine((value) => value.password === value.confirm, {
      message: 'the passwords must match',
    });

  /** Two failing leaves under one parent, so the collapse has something to collapse. */
  const profileContract = z.object({
    profile: z.object({
      first: z.string().min(1, 'first name is required'),
      last: z.string().min(1, 'last name is required'),
    }),
  });

  /**
   * A record over caller-supplied keys — the shape that makes a prototype-named key
   * reachable, per F-086. `JSON.parse` rather than a literal because that is how the key
   * arrives in production: off the wire, from a request body.
   */
  const tagsContract = z.record(z.string(), z.string({ error: 'must be text' }));

  it('lands an issue with an empty path under the _form key', () => {
    const error = zodErrorFrom(matchingPasswords, { password: 'a', confirm: 'b' });

    expect(toValidationDetails(error).fieldErrors).toEqual({
      _form: ['the passwords must match'],
    });
  });

  it('collapses two issues under one parent to a single first-segment key', () => {
    const error = zodErrorFrom(profileContract, { profile: { first: '', last: '' } });

    expect(Object.keys(toValidationDetails(error).fieldErrors)).toEqual(['profile']);
  });

  it('keeps both messages for a collapsed key, in issue order', () => {
    const error = zodErrorFrom(profileContract, { profile: { first: '', last: '' } });

    expect(toValidationDetails(error).fieldErrors.profile).toEqual([
      'first name is required',
      'last name is required',
    ]);
  });

  it('keeps an issue whose first path segment names an Object.prototype member', () => {
    const error = zodErrorFrom(tagsContract, JSON.parse('{"constructor": 2}') as unknown);

    expect(toValidationDetails(error).fieldErrors).toEqual({ constructor: ['must be text'] });
  });
});

/**
 * The caps `error-envelope.md` added on 2026-08-05 (F-095): at most 100 issues read, at
 * most 10 messages under one key, and `VALIDATION_TRUNCATED_MESSAGE` appended under
 * `FORM_ERROR_KEY` when anything was dropped.
 *
 * zod reports one issue per failing array element, so an uncapped flatten turns a 100 KB
 * body of bad elements into a multi-megabyte response assembled inside the exception
 * filter. The numbers below are written as literals rather than imported from
 * `./errors`: the exports do not exist yet, and a named import of a missing export would
 * fail the whole file at load instead of failing these four tests on their assertions.
 */
describe('toValidationDetails caps', () => {
  /** One issue per failing element, all collapsing to the same first path segment. */
  const tagListContract = z.object({ tags: z.array(z.string({ error: 'must be text' })) });

  /** One issue per key, so the issue cap is what binds rather than the per-key cap. */
  const lookupContract = z.record(z.string(), z.string({ error: 'must be text' }));

  function badTags(count: number): unknown {
    return { tags: Array.from({ length: count }, (_, index) => index) };
  }

  function badLookup(count: number): unknown {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, index]));
  }

  it('keeps at most ten messages under one key', () => {
    const error = zodErrorFrom(tagListContract, badTags(15));

    expect(toValidationDetails(error).fieldErrors.tags).toHaveLength(10);
  });

  it('appends the truncation notice under _form when it dropped messages', () => {
    const error = zodErrorFrom(tagListContract, badTags(15));

    expect(toValidationDetails(error).fieldErrors._form).toEqual(['Some errors were omitted.']);
  });

  it('leaves no truncation notice when it dropped nothing', () => {
    const error = zodErrorFrom(tagListContract, badTags(10));

    expect(Object.keys(toValidationDetails(error).fieldErrors)).toEqual(['tags']);
  });

  it('reads at most a hundred issues', () => {
    const error = zodErrorFrom(lookupContract, badLookup(150));
    const keyed = Object.keys(toValidationDetails(error).fieldErrors).filter(
      (key) => key !== '_form',
    );

    expect(keyed).toHaveLength(100);
  });
});
