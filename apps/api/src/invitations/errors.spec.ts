/**
 * TASK-1b-04 — the five invitation errors, level 1 per error-envelope.md ("How a TASK tests
 * its own error mapping"): code, derived status, envelope validity, and a fixed message that
 * names no id, token, address or tenant. GC-M: every code already exists.
 */
import { ERROR_CODES, errorEnvelopeContract } from '@shortkit/contracts';
import { describe, expect, it } from 'vitest';

import { isDomainError } from '../common/errors/domain-error';

import {
  InvitationAlreadyAcceptedError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationRevokedError,
  InvitationTenantConflictError,
} from './errors';

const CASES: ReadonlyArray<[string, () => Error, string, number]> = [
  ['InvitationNotFoundError', () => new InvitationNotFoundError(), 'not_found', 404],
  [
    'InvitationAlreadyAcceptedError',
    () => new InvitationAlreadyAcceptedError(),
    'invitation_already_accepted',
    409,
  ],
  ['InvitationExpiredError', () => new InvitationExpiredError(), 'invitation_expired', 410],
  ['InvitationRevokedError', () => new InvitationRevokedError(), 'invitation_revoked', 410],
  [
    'InvitationTenantConflictError',
    () => new InvitationTenantConflictError(),
    'invitation_tenant_conflict',
    409,
  ],
];

describe('invitation errors (level 1)', () => {
  it.each(CASES)('%s carries %s / %i and a valid envelope', (_name, make, code, status) => {
    const error = make();

    expect(isDomainError(error)).toBe(true);
    if (!isDomainError(error)) {
      return;
    }

    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect((ERROR_CODES as readonly string[]).includes(error.code)).toBe(true);
    expect(errorEnvelopeContract.safeParse(error.toEnvelope()).success).toBe(true);
    expect(error.name).toBe(_name);
  });

  it('every message is fixed and carries no uuid, no token-shaped run, no address', () => {
    for (const [, make] of CASES) {
      const first = make().message;
      const second = make().message;

      expect(first).toBe(second);
      expect(first).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      expect(first).not.toMatch(/[A-Za-z0-9_-]{43}/);
      expect(first).not.toMatch(/@/);
    }
  });

  it('constructors take no arguments, so nothing can be interpolated into a message', () => {
    for (const [, make] of CASES) {
      expect(make().constructor.length).toBe(0);
    }
  });
});
