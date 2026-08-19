/**
 * Contract: docs/contracts/error-envelope.md (shared primitives)
 *
 * The cursor bound had no test because it had no bound. Item 2 gave the cursor its first
 * consumer (link listing), a security review found that `limit` was bounded and `cursor`
 * was not, and this file is what stops that returning quietly.
 */
import { describe, expect, it } from 'vitest';

import { CURSOR_MAX_LENGTH, paginationQueryContract } from './pagination';

describe('paginationQueryContract', () => {
  it('admits a cursor of the shape this repository issues', () => {
    // base64url of `<ISO timestamp>|<uuid>`, which is what the links service encodes.
    const cursor = Buffer.from(
      '2026-08-19T12:00:00.000Z|00000000-0000-4000-8000-000000000001',
      'utf8',
    ).toString('base64url');

    expect(cursor.length).toBeLessThan(CURSOR_MAX_LENGTH);
    expect(paginationQueryContract.parse({ cursor }).cursor).toBe(cursor);
  });

  it('admits a cursor at exactly the bound and refuses one character more', () => {
    const atBound = 'a'.repeat(CURSOR_MAX_LENGTH);

    expect(paginationQueryContract.safeParse({ cursor: atBound }).success).toBe(true);
    expect(paginationQueryContract.safeParse({ cursor: `${atBound}a` }).success).toBe(false);
  });

  it('keys the refusal under cursor, so a screen can put it where the value came from', () => {
    const result = paginationQueryContract.safeParse({ cursor: 'a'.repeat(CURSOR_MAX_LENGTH + 1) });

    expect(result.success).toBe(false);
    expect(result.error?.issues.at(0)?.path).toEqual(['cursor']);
  });

  it('leaves the cursor optional, because the first page names none', () => {
    expect(paginationQueryContract.parse({})).toEqual({ limit: 25 });
  });

  it('still bounds limit, which is the bound the cursor was missing', () => {
    expect(paginationQueryContract.safeParse({ limit: 101 }).success).toBe(false);
    expect(paginationQueryContract.safeParse({ limit: 0 }).success).toBe(false);
    expect(paginationQueryContract.parse({ limit: 100 }).limit).toBe(100);
  });
});
