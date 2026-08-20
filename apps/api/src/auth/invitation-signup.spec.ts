import { APIError } from 'better-auth/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as CapabilityLookup from '../invitations/capability-lookup';
import type { AcceptGrant, VerifiedInvitation } from '../invitations/capability-lookup';
import {
  InvitationAlreadyAcceptedError,
  InvitationExpiredError,
  InvitationRevokedError,
} from '../invitations/errors';
import { logger } from '../observability/logger';
import type { AuthBeforeHookContext } from './before-hook';
import {
  INVITATION_ALREADY_ACCEPTED_MESSAGE,
  INVITATION_EXPIRED_MESSAGE,
  INVITATION_HOOK_CODES,
  INVITATION_LOOKUP_FAILED_MESSAGE,
  INVITATION_NOT_FOUND_MESSAGE,
  INVITATION_REVOKED_MESSAGE,
  INVITATION_TOKEN_BODY_KEY,
  SIGN_UP_EMAIL_PATH,
  invitationTokenFrom,
  invitationValidationHook,
  provisionForNewUser,
} from './invitation-signup';
import * as OnUserCreated from './on-user-created';

/**
 * STORY-1b-02 — AC-1b-8, AC-1b-9, AC-1b-10 at the hook level. TASK-1b-09 (item 1b, wave 3).
 *
 * Contract: `docs/contracts/invitation-tokens.md` ("The invited-signup branch uses the same
 * entry point"), `docs/contracts/auth-config-surface.md` (invariants 4, 5; the error-cases
 * table). ADR-0013 (F-228), ADR-0015, ADR-0021, ADR-0055, F-216, D-01, D-18.
 *
 * WHAT IS HERE: the one predicate both hooks share, the path predicate, the mapping from
 * the lookup's answers to the five `APIError`s (status, code, fixed message), the F-228 rule
 * (nothing but an `APIError` leaves the hook — an unexpected throw becomes a 500 WITH a
 * body, logged once with no message), and `provisionForNewUser`'s branch. WHAT IS NOT: the
 * lookup and the accept themselves — those open real tenant transactions and are
 * `capability-lookup.spec.ts`'s and `test/invitations/capability-token.int-spec.ts`'s —
 * and whether Better Auth really hands the after hook the request body, which
 * `test/auth/signup-invited.int-spec.ts` proves against the child.
 *
 * The two sanctioned functions are mocked at the module boundary (the idiom
 * `capability-lookup.spec.ts` uses on `tenant-context`): the hook's contract is what it does
 * with each answer, and a real database here would prove the wrong thing twice.
 */

vi.mock('../invitations/capability-lookup', () => ({
  findInvitationByCapabilityToken: vi.fn(),
  acceptInvitationByCapabilityToken: vi.fn(),
}));

vi.mock('./on-user-created', () => ({
  createTenantForNewUser: vi.fn(),
}));

const find = vi.mocked(CapabilityLookup.findInvitationByCapabilityToken);
const accept = vi.mocked(CapabilityLookup.acceptInvitationByCapabilityToken);
const createTenant = vi.mocked(OnUserCreated.createTenantForNewUser);

/** A well-formed token shape (D-13): 36-char tenant id, `.`, 43 base64url chars. */
const TOKEN = '11111111-1111-4111-8111-111111111111.' + 'a'.repeat(43);
const ADDRESS = 'invitee-8f3c@example.com';
const USER = { id: 'nZ8kQpR2xLmT4vB6', name: 'Invitee' };

function ctx(path: string, body: unknown): AuthBeforeHookContext {
  return { path, body } as unknown as AuthBeforeHookContext;
}

async function thrownBy(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }

  return { resolved: true };
}

function verified(): VerifiedInvitation {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenantId: '11111111-1111-4111-8111-111111111111',
    email: 'someone-else@example.com',
    state: 'pending',
    expiresAt: new Date('2026-08-25T10:00:00.000Z'),
    workspaces: [],
    invitedByUserId: 'inviter01',
    inviterEmail: 'inviter@example.com',
    tenantName: 'Tenant A',
  };
}

beforeEach(() => {
  find.mockReset();
  accept.mockReset();
  createTenant.mockReset();
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invitationTokenFrom — the one predicate both hooks share (D-18)', () => {
  it('a non-empty string under invitationToken is the token, verbatim', () => {
    expect(invitationTokenFrom({ [INVITATION_TOKEN_BODY_KEY]: TOKEN })).toBe(TOKEN);
    expect(INVITATION_TOKEN_BODY_KEY).toBe('invitationToken');
    // Not trimmed, not repaired: a bearer credential is compared by digest as sent.
    expect(invitationTokenFrom({ invitationToken: ` ${TOKEN}` })).toBe(` ${TOKEN}`);
  });

  it.each([
    ['no body', undefined],
    ['a null body', null],
    ['a string body', 'invitationToken=abc'],
    ['a number body', 42],
    ['an array body', [TOKEN]],
    ['a body without the key', { email: ADDRESS, password: 'x', name: 'n' }],
    ['an object-typed token', { invitationToken: { ne: null } }],
    ['a number-typed token', { invitationToken: 12345 }],
    ['an array-typed token', { invitationToken: [TOKEN] }],
    ['a null token', { invitationToken: null }],
    ['an empty-string token', { invitationToken: '' }],
    ['a boolean token', { invitationToken: true }],
  ])('AC-1b-10: %s is "not invited" and never throws', (_label, body) => {
    expect(invitationTokenFrom(body)).toBeUndefined();
  });
});

describe('invitationValidationHook', () => {
  it("applies to '/sign-up/email' only: every other path returns without a lookup", async () => {
    for (const path of ['/sign-in/email', '/sign-out', '/get-session', '/token']) {
      await expect(invitationValidationHook(ctx(path, { invitationToken: TOKEN }))).resolves.toBeUndefined();
    }

    expect(find).not.toHaveBeenCalled();
    expect(SIGN_UP_EMAIL_PATH).toBe('/sign-up/email');
  });

  it('a signup WITHOUT a string token is untouched: no lookup, no refusal (AC-1b-10)', async () => {
    for (const body of [
      undefined,
      { email: ADDRESS, password: 'x', name: 'n' },
      { email: ADDRESS, password: 'x', name: 'n', invitationToken: '' },
      { email: ADDRESS, password: 'x', name: 'n', invitationToken: { ne: null } },
      { email: ADDRESS, password: 'x', name: 'n', invitationToken: 7 },
    ]) {
      await expect(invitationValidationHook(ctx(SIGN_UP_EMAIL_PATH, body))).resolves.toBeUndefined();
    }

    expect(find).not.toHaveBeenCalled();
  });

  it('a valid pending token passes: the lookup ran with the token, nothing was thrown, nothing accepted', async () => {
    find.mockResolvedValueOnce(verified());

    await expect(
      invitationValidationHook(ctx(SIGN_UP_EMAIL_PATH, { email: ADDRESS, password: 'x', name: 'n', invitationToken: TOKEN })),
    ).resolves.toBeUndefined();

    expect(find).toHaveBeenCalledWith(TOKEN);
    expect(accept).not.toHaveBeenCalled();
  });

  it('D-01: the row’s email is not compared with the signup address (the link is the capability)', async () => {
    find.mockResolvedValueOnce({ ...verified(), email: 'the-invited-one@example.com' });

    await expect(
      invitationValidationHook(ctx(SIGN_UP_EMAIL_PATH, { email: 'anyone-else@example.com', password: 'x', name: 'n', invitationToken: TOKEN })),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['null (malformed / unknown / wrong-tenant — one answer, ADR-0021)', null, 404, INVITATION_HOOK_CODES.notFound, INVITATION_NOT_FOUND_MESSAGE],
    ['InvitationExpiredError', new InvitationExpiredError(), 410, INVITATION_HOOK_CODES.expired, INVITATION_EXPIRED_MESSAGE],
    ['InvitationRevokedError', new InvitationRevokedError(), 410, INVITATION_HOOK_CODES.revoked, INVITATION_REVOKED_MESSAGE],
    ['InvitationAlreadyAcceptedError', new InvitationAlreadyAcceptedError(), 409, INVITATION_HOOK_CODES.alreadyAccepted, INVITATION_ALREADY_ACCEPTED_MESSAGE],
  ])('AC-1b-8/9: the lookup answering %s → APIError %i with the code and the fixed message', async (_label, answer, status, code, message) => {
    if (answer instanceof Error) {
      find.mockRejectedValueOnce(answer);
    } else {
      find.mockResolvedValueOnce(answer);
    }

    const thrown = await thrownBy(
      invitationValidationHook(ctx(SIGN_UP_EMAIL_PATH, { email: ADDRESS, password: 'x', name: 'n', invitationToken: TOKEN })),
    );

    expect(thrown).toBeInstanceOf(APIError);
    const apiError = thrown as APIError;
    expect({ status: apiError.statusCode, body: apiError.body }).toEqual({ status, body: { code, message } });
    expect(apiError.message).toBe(message);
  });

  it('F-228 / ADR-0055: an unexpected throw from the lookup becomes a 500 APIError WITH a body, logged once with no message on the line', async () => {
    find.mockRejectedValueOnce(new Error(`connect ECONNREFUSED for token ${TOKEN} of ${ADDRESS}`));

    const thrown = await thrownBy(
      invitationValidationHook(ctx(SIGN_UP_EMAIL_PATH, { email: ADDRESS, password: 'x', name: 'n', invitationToken: TOKEN })),
    );

    expect(thrown).toBeInstanceOf(APIError);
    const apiError = thrown as APIError;
    expect({ status: apiError.statusCode, body: apiError.body }).toEqual({
      status: 500,
      body: { code: INVITATION_HOOK_CODES.lookupFailed, message: INVITATION_LOOKUP_FAILED_MESSAGE },
    });

    const error = vi.mocked(logger.error);
    expect(error).toHaveBeenCalledTimes(1);
    const [fields, message] = error.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ code: 'invitation_lookup_failed', err_name: 'Error' });
    expect(fields).not.toHaveProperty('err_message');
    expect(typeof message).toBe('string');
    expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(error.mock.calls)).not.toContain(ADDRESS);
  });

  it('F-216 / GC-K: every message is a fixed constant that names no token, address, id or "@"', () => {
    const messages = [
      INVITATION_NOT_FOUND_MESSAGE,
      INVITATION_EXPIRED_MESSAGE,
      INVITATION_REVOKED_MESSAGE,
      INVITATION_ALREADY_ACCEPTED_MESSAGE,
      INVITATION_LOOKUP_FAILED_MESSAGE,
    ];

    for (const message of messages) {
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(ADDRESS);
      expect(message).not.toContain('@');
      expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
      expect(message).not.toMatch(/\$\{|%s/);
    }

    expect(INVITATION_HOOK_CODES).toEqual({
      notFound: 'INVITATION_NOT_FOUND',
      expired: 'INVITATION_EXPIRED',
      revoked: 'INVITATION_REVOKED',
      alreadyAccepted: 'INVITATION_ALREADY_ACCEPTED',
      lookupFailed: 'INVITATION_LOOKUP_FAILED',
    });
  });

  it('never throws anything but an APIError, whatever the body is (F-228)', async () => {
    const hostile = [
      undefined,
      null,
      0,
      'a string',
      [],
      { invitationToken: Symbol('x') },
      { invitationToken: () => TOKEN },
      Object.create(null) as unknown,
    ];

    for (const body of hostile) {
      await expect(invitationValidationHook(ctx(SIGN_UP_EMAIL_PATH, body))).resolves.toBeUndefined();
    }

    expect(find).not.toHaveBeenCalled();
  });
});

describe('provisionForNewUser — the after hook’s branch (ADR-0015, D-18)', () => {
  it('a token → acceptInvitationByCapabilityToken(token, { userId, tenantMembership: "create" }) and NO tenant is created', async () => {
    accept.mockResolvedValueOnce({ tenantId: '11111111-1111-4111-8111-111111111111', workspaces: [] });

    await expect(
      provisionForNewUser(USER, { body: { email: ADDRESS, password: 'x', name: 'n', invitationToken: TOKEN } }),
    ).resolves.toBeUndefined();

    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(TOKEN, { userId: USER.id, tenantMembership: 'create' } satisfies AcceptGrant);
    expect(createTenant).not.toHaveBeenCalled();
  });

  it.each([
    ['no context at all', null],
    ['an undefined context', undefined],
    ['a context with no body', {}],
    ['a body without a token', { body: { email: ADDRESS, password: 'x', name: 'n' } }],
    ['an object-typed token', { body: { invitationToken: { ne: null } } }],
    ['a number-typed token', { body: { invitationToken: 12345 } }],
    ['an empty-string token', { body: { invitationToken: '' } }],
  ])('AC-1b-10: %s → createTenantForNewUser and no accept', async (_label, context) => {
    createTenant.mockResolvedValueOnce({ tenantId: 't', membershipId: 'm' });

    await expect(provisionForNewUser(USER, context)).resolves.toBeUndefined();

    expect(createTenant).toHaveBeenCalledWith({ id: USER.id, name: USER.name });
    expect(accept).not.toHaveBeenCalled();
  });

  it('ADR-0054 part 2: a failing accept propagates verbatim — nothing is swallowed and no tenant is created instead', async () => {
    const failure = new Error('the accept transaction failed');
    accept.mockRejectedValueOnce(failure);

    await expect(provisionForNewUser(USER, { body: { invitationToken: TOKEN } })).rejects.toBe(failure);
    expect(createTenant).not.toHaveBeenCalled();
  });
});
