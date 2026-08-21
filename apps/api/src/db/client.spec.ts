import { describe, expect, it } from 'vitest';

import { postgresErrorCode, postgresErrorConstraint } from './client';

/**
 * F-120: the sanctioned way a caught database error is classified.
 *
 * `databaseTransaction` unwraps drizzle's `DrizzleQueryError` at the TRANSACTION
 * boundary, but drizzle wraps at the STATEMENT boundary, so a `catch` inside `fn`
 * still holds the wrapper and reads `error.code` as `undefined`. The downstream
 * caller this protects is TASK-025's collision loop (`docs/contracts/slug.md`
 * "Uniqueness and collision"): insert inside `SAVEPOINT slug_try`, catch `23505`,
 * roll back, redraw. That catch is inside `fn`.
 *
 * `tenant-context.md` "Driver errors inside `fn`" makes `postgresErrorCode` and
 * `postgresErrorConstraint` the only sanctioned way to read a caught database error
 * anywhere in `apps/api`, and `slug.md` shows the collision loop branching on both.
 *
 * The real `23505` round trip needs a live Postgres and lives in
 * `test/tenancy/tenant-context.int-spec.ts`. What is asserted here is the half that
 * needs no database: a `catch` block receives whatever was thrown, so the accessors
 * have to answer for values that are not driver errors at all without throwing a
 * second error out of the caller's catch.
 */
describe('the database error accessors', () => {
  it('F-120: an error that did not come from the driver has no Postgres error code and no constraint', () => {
    const notFromTheDriver = new Error('the tenant was not found');

    expect(postgresErrorCode(notFromTheDriver)).toBeUndefined();
    expect(postgresErrorConstraint(notFromTheDriver)).toBeUndefined();
  });

  it('F-120: a thrown value that is not an Error is answered rather than thrown on', () => {
    // A catch block binds whatever was thrown. The collision loop calls both accessors
    // first thing inside its catch, so a TypeError raised in here replaces a
    // recoverable slug collision with a 500 that names the wrong failure.
    for (const thrown of [undefined, null, 'duplicate key value violates unique constraint']) {
      expect(postgresErrorCode(thrown)).toBeUndefined();
      expect(postgresErrorConstraint(thrown)).toBeUndefined();
    }
  });
});
