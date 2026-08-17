/**
 * STORY-001 — AC-8. TASK-001.
 *
 * Contract: docs/contracts/auth-contracts.md
 * ADR: adr-0047-password-policy.md, adr-0013-better-auth-in-nestjs.md
 *
 * AC-8: "Given the auth and membership contracts in `packages/contracts`, when a signup
 * request body with no `password` field is parsed by the request contract, then the parse
 * fails and `toValidationDetails` keys at least one issue under `password`; and when
 * `pnpm typecheck` is run at the repository root with `apps/web` importing those contracts,
 * it exits 0."
 *
 * The second clause is discharged by the `pnpm typecheck` gate, not by an assertion here:
 * a test cannot run the root typecheck without importing `node:child_process`, which this
 * package's lint bans (ADR-0005). It is stated so a reader does not assume this file covers
 * it.
 *
 * ============================================================================
 * THE BOUNDS ARE ASSERTED THROUGH THE PARSE, NOT AS EQUALITY ON THE CONSTANT.
 * ============================================================================
 *
 * `expect(PASSWORD_MIN_LENGTH).toBe(8)` fires on a deliberate policy change and sleeps
 * through a contract that ignores the constant. The pair below covers both halves: literal
 * 7/8 and 128/129 passwords pin ADR-0047's numbers, and the constant-derived lengths pin
 * that `signUpRequestContract` is built from the exported values rather than from its own
 * inline literals.
 */
import { describe, expect, it } from 'vitest';

import { isZodError, toValidationDetails } from '../errors';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  authSessionContract,
  shortkitJwtClaimsContract,
  signInRequestContract,
  signUpRequestContract,
} from './index';

/** A password well inside both bounds, so a test about another field fails for that field. */
const VALID_PASSWORD = 'correct-horse-battery-staple';

function passwordOfLength(length: number): string {
  return 'a'.repeat(length);
}

describe('signUpRequestContract', () => {
  it('AC-8: a sign-up body with no password fails the parse and keys an issue under password', () => {
    const outcome = signUpRequestContract.safeParse({
      email: 'operator@example.com',
      name: 'An Operator',
    });

    expect(outcome.success).toBe(false);

    if (outcome.success) {
      return;
    }

    expect(isZodError(outcome.error)).toBe(true);
    expect(toValidationDetails(outcome.error).fieldErrors.password?.length ?? 0).toBeGreaterThan(
      0,
    );
  });

  it('AC-8 (ADR-0047): a seven-character password is refused', () => {
    const outcome = signUpRequestContract.safeParse({
      email: 'operator@example.com',
      password: passwordOfLength(7),
      name: 'An Operator',
    });

    expect(outcome.success).toBe(false);
  });

  it('AC-8 (ADR-0047): an eight-character password is accepted', () => {
    const outcome = signUpRequestContract.safeParse({
      email: 'operator@example.com',
      password: passwordOfLength(8),
      name: 'An Operator',
    });

    expect(outcome.success).toBe(true);
  });

  it('AC-8 (ADR-0047): a 129-character password is refused', () => {
    const outcome = signUpRequestContract.safeParse({
      email: 'operator@example.com',
      password: passwordOfLength(129),
      name: 'An Operator',
    });

    expect(outcome.success).toBe(false);
  });

  it('AC-8 (ADR-0047): a 128-character password is accepted', () => {
    const outcome = signUpRequestContract.safeParse({
      email: 'operator@example.com',
      password: passwordOfLength(128),
      name: 'An Operator',
    });

    expect(outcome.success).toBe(true);
  });

  it('AC-8 (ADR-0047): the exported bounds are the bounds the contract enforces', () => {
    const below = signUpRequestContract.safeParse({
      email: 'operator@example.com',
      password: passwordOfLength(PASSWORD_MIN_LENGTH - 1),
      name: 'An Operator',
    });
    const above = signUpRequestContract.safeParse({
      email: 'operator@example.com',
      password: passwordOfLength(PASSWORD_MAX_LENGTH + 1),
      name: 'An Operator',
    });

    // TASK-003 feeds `emailAndPassword.minPasswordLength` from the same two constants
    // (ADR-0047). A contract carrying its own inline 8 and 128 would pass the four literal
    // tests above and let the two enforcement points drift the day a bound moves.
    expect([below.success, above.success]).toEqual([false, false]);
  });

  it('AC-8: a sign-up body with no name is refused, because better-auth 1.6.26 answers 400 to one', () => {
    const outcome = signUpRequestContract.safeParse({
      email: 'operator@example.com',
      password: VALID_PASSWORD,
    });

    expect(outcome.success).toBe(false);
  });

  it('AC-8: a sign-up body whose email is not an address is refused', () => {
    const outcome = signUpRequestContract.safeParse({
      email: 'operator-at-example.com',
      password: VALID_PASSWORD,
      name: 'An Operator',
    });

    expect(outcome.success).toBe(false);
  });
});

describe('signInRequestContract', () => {
  it('AC-8 (ADR-0047): sign-in applies no length floor, so an account created under an older one still parses', () => {
    const outcome = signInRequestContract.safeParse({
      email: 'operator@example.com',
      password: 'short',
    });

    // Deliberate: a floor raised later would otherwise reject a correct password with a
    // validation error rather than an authentication one, locking out every existing
    // account. A `.min(PASSWORD_MIN_LENGTH)` copied onto this schema fails here.
    expect(outcome.success).toBe(true);
  });

  it('AC-8: sign-in still refuses an empty password', () => {
    const outcome = signInRequestContract.safeParse({
      email: 'operator@example.com',
      password: '',
    });

    expect(outcome.success).toBe(false);
  });
});

describe('authSessionContract', () => {
  const user = {
    id: 'nZ8kQpR2xLmT4vB6',
    name: 'An Operator',
    email: 'operator@example.com',
    emailVerified: false,
    createdAt: '2026-08-13T09:00:00.000Z',
    updatedAt: '2026-08-13T09:00:00.000Z',
  };

  it('AC-8: a sign-up response carrying a null token parses', () => {
    const parsed = authSessionContract.parse({ token: null, user });

    // Sign-up returns `token: null` when auto sign-in is disabled. A non-nullable `token`
    // makes every sign-up response unparseable.
    expect(parsed.token).toBeNull();
  });

  it("AC-8: the user id is not required to be a uuid, because Better Auth generates its own", () => {
    const parsed = authSessionContract.parse({ token: 'session-token', user });

    expect(parsed.user.id).toBe('nZ8kQpR2xLmT4vB6');
  });

  it('AC-8: a sign-in response carrying the extra redirect and url fields parses, and drops them', () => {
    const parsed = authSessionContract.parse({
      token: 'session-token',
      user,
      redirect: false,
      url: 'https://app.example.com/dashboard',
    });

    // NOT `.strict()`, deliberately: sign-in returns two fields this repository does not
    // use, and a strict schema would fail every sign-in the day Better Auth adds a third.
    expect(parsed).toEqual({ token: 'session-token', user });
  });
});

describe('shortkitJwtClaimsContract', () => {
  const claims = {
    sub: 'nZ8kQpR2xLmT4vB6',
    tid: '11111111-1111-4111-8111-111111111111',
    email: 'operator@example.com',
    ev: false,
    jti: 'session-id-not-token-id',
    exp: 1_786_000_300,
    iat: 1_786_000_000,
    iss: 'https://api.example.com',
    aud: 'https://app.example.com',
  };

  it('AC-8 (ADR-0013): the nine claims ADR-0013 fixes all survive a parse', () => {
    // Field-by-field equality rather than `success`: a schema missing `ev` still parses
    // this body and silently drops the claim `AuthGuard` reads.
    expect(shortkitJwtClaimsContract.parse(claims)).toEqual(claims);
  });

  it('AC-8 (ADR-0013): a tid that is not a uuid is refused', () => {
    expect(shortkitJwtClaimsContract.safeParse({ ...claims, tid: 'tenant-a' }).success).toBe(
      false,
    );
  });

  it('AC-8 (ADR-0013): aud is a single string, so an array of audiences is refused', () => {
    expect(
      shortkitJwtClaimsContract.safeParse({ ...claims, aud: ['https://app.example.com'] })
        .success,
    ).toBe(false);
  });

  it('AC-8 (ADR-0013): a claim set with no tid is refused', () => {
    const withoutTid: Record<string, unknown> = { ...claims };
    delete withoutTid.tid;

    // GC-D: `tid` is in every token. An optional `tid` would let a token with no tenant
    // claim past the guard's claim-shape check.
    expect(shortkitJwtClaimsContract.safeParse(withoutTid).success).toBe(false);
  });
});
