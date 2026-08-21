/**
 * TASK-1b-08: `parseOrThrow`, lifted from `workspaces.controller.ts`.
 *
 * Contract: docs/contracts/error-envelope.md (branch 2: `validation_failed`, the message
 * constant, `details.fieldErrors`).
 */
import { createInvitationRequestContract } from '@shortkit/contracts';
import { describe, expect, it } from 'vitest';

import { DomainError } from './domain-error';
import { parseOrThrow, VALIDATION_FAILED_MESSAGE } from './parse-or-throw';

describe('parseOrThrow', () => {
  it('returns the parsed value for a body the contract accepts', () => {
    const parsed = parseOrThrow(createInvitationRequestContract, {
      email: '  X@Example.com ',
      workspaces: [{ workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceRole: 'member' }],
    });

    expect(parsed.email).toBe('x@example.com');
  });

  it('turns a ZodError into 400 validation_failed with the filter’s message and the field errors under details', () => {
    let thrown: unknown;
    try {
      parseOrThrow(createInvitationRequestContract, { email: 'not-an-address', workspaces: [] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DomainError);
    const envelope = (thrown as DomainError).toEnvelope();
    expect({ code: envelope.code, message: envelope.message, status: (thrown as DomainError).status }).toEqual({
      code: 'validation_failed',
      message: VALIDATION_FAILED_MESSAGE,
      status: 400,
    });
    expect(Object.keys((envelope.details as { fieldErrors: Record<string, string[]> }).fieldErrors).sort()).toEqual(['email', 'workspaces']);
  });

  it('rethrows anything that is not a ZodError untouched', () => {
    const boom = new Error('boom');
    const contract = {
      parse(): never {
        throw boom;
      },
    };

    expect(() => parseOrThrow(contract, {})).toThrow(boom);
  });
});
