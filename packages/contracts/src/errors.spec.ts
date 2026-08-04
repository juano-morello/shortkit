import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  ERROR_CODE_STATUS,
  errorEnvelopeContract,
  isErrorEnvelope,
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
