/**
 * TASK-1b-12 (STORY-1b-02, AC-1b-12: "distinct copy renders for 404, 409 already-accepted,
 * 409 tenant-conflict, 410 expired, 410 revoked and 429"). One message per
 * `InvitationFailure` kind, none of them a channel for a server string or the token.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InvitationStateMessage, messageForInvitationFailure } from './invitation-state-message';
import type { InvitationFailure } from './invitations-api';

const RENDERED_KINDS: InvitationFailure[] = [
  { kind: 'not_found' },
  { kind: 'already_accepted' },
  { kind: 'tenant_conflict' },
  { kind: 'expired' },
  { kind: 'revoked' },
  { kind: 'rate_limited', retryAfterSeconds: undefined },
  { kind: 'unauthenticated' },
  { kind: 'validation', fieldErrors: {} },
  { kind: 'unknown' },
];

describe('InvitationStateMessage: one message per kind (AC-1b-12)', () => {
  it('renders a distinct alert per kind, and every kind renders one', () => {
    const seen = new Set<string>();

    for (const failure of RENDERED_KINDS) {
      const { unmount } = render(<InvitationStateMessage failure={failure} />);
      const alert = screen.getByRole('alert');
      const text = alert.textContent ?? '';

      expect(text.length, failure.kind).toBeGreaterThan(0);
      expect(seen.has(text), `${failure.kind} repeats another kind's copy`).toBe(false);
      seen.add(text);
      unmount();
    }
  });

  it('renders nothing for a caller-initiated abort', () => {
    const { container } = render(<InvitationStateMessage failure={{ kind: 'aborted' }} />);

    expect(container.innerHTML).toBe('');
    expect(messageForInvitationFailure({ kind: 'aborted' })).toBeNull();
  });

  it('the 429 copy says to retry shortly, and names the seconds when the client normalised them', () => {
    const shortly = messageForInvitationFailure({ kind: 'rate_limited', retryAfterSeconds: undefined });
    const timed = messageForInvitationFailure({ kind: 'rate_limited', retryAfterSeconds: 30 });
    const one = messageForInvitationFailure({ kind: 'rate_limited', retryAfterSeconds: 1 });

    expect(shortly).toMatch(/shortly/i);
    expect(shortly).not.toMatch(/\d/);
    expect(timed).toContain('30 seconds');
    expect(one).toContain('1 second.');
  });

  it('the already-accepted copy says to sign in', () => {
    expect(messageForInvitationFailure({ kind: 'already_accepted' })).toMatch(/sign in/i);
  });

  it("the tenant-conflict copy repeats ADR-0015's sentence: a different email address, or an account in that agency", () => {
    const message = messageForInvitationFailure({ kind: 'tenant_conflict' }) ?? '';

    expect(message).toMatch(/different email address/i);
    expect(message).toMatch(/account in that agency/i);
  });

  it('the expired and revoked copies are distinct and each says to ask for a new invitation', () => {
    const expired = messageForInvitationFailure({ kind: 'expired' });
    const revoked = messageForInvitationFailure({ kind: 'revoked' });

    expect(expired).toMatch(/expired/i);
    expect(revoked).toMatch(/withdrawn|revoked/i);
    expect(expired).not.toBe(revoked);
    expect(expired).toMatch(/new/i);
    expect(revoked).toMatch(/new/i);
  });

  it('the not-found copy does not disclose whether an invitation exists (one body for malformed, unknown, wrong-tenant)', () => {
    const message = messageForInvitationFailure({ kind: 'not_found' }) ?? '';

    expect(message).toMatch(/link/i);
    expect(message).not.toMatch(/another (agency|tenant)|does not exist|no such/i);
  });

  it('the validation copy is a fixed sentence and never echoes a field error verbatim', () => {
    const message = messageForInvitationFailure({
      kind: 'validation',
      fieldErrors: { email: ['op@agency.test is not allowed'] },
    });

    expect(message).toMatch(/check/i);
    expect(message).not.toContain('op@agency.test');
  });
});
