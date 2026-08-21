/**
 * TASK-1b-12 (STORY-1b-02, AC-1b-12: distinct copy for 404, 409 already-accepted, 409
 * tenant-conflict, 410 expired, 410 revoked and 429). The one place the invitation
 * failure copy lives, so the accept page (TASK-1b-13) and the invitations screen
 * (TASK-1b-14) render the same sentence for the same code.
 *
 * Contract: docs/contracts/error-envelope.md (copy is keyed by `code`, through
 *   `classifyInvitationError`), docs/contracts/rate-limit.md ("the copy for that 429 says
 *   to retry shortly"), docs/contracts/invitation-tokens.md (one body for malformed,
 *   unknown and wrong-tenant; so one sentence too).
 * ADR: adr-0015 (the tenant-conflict sentence: accept from a different email address, or
 *   from an account in that agency), adr-0029 (no server string is echoed).
 * Produced by: TASK-1b-12
 *
 * No message echoes a server `message`, a field error, an address or the token. The
 * not-found copy does not say whether an invitation exists: the API answers one 404 body
 * for malformed, unknown and wrong-tenant tokens (GC-L), and this copy keeps that.
 */
import type { ReactElement } from 'react';

import type { InvitationFailure } from './invitations-api';

export const INVITATION_MESSAGES = {
  notFound: 'This invitation link is not valid. Check the link in your email, or ask the person who invited you to send a new one.',
  alreadyAccepted: 'This invitation has already been used. If that was you, sign in to reach your workspaces.',
  tenantConflict:
    'Your account belongs to a different agency. Accept this invitation from a different email address, or from an account in that agency.',
  expired: 'This invitation has expired. Ask the person who invited you to send a new one.',
  revoked: 'This invitation was withdrawn. Ask the person who invited you for a new one if you still need access.',
  rateLimited: (seconds: number | undefined): string =>
    seconds === undefined
      ? 'Too many attempts. Try again shortly.'
      : `Too many attempts. Try again in ${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}.`,
  unauthenticated: 'Your session has ended. Sign in again to continue.',
  validationFailed: 'Some of the details were not accepted. Check them and try again.',
  generic: 'Something went wrong on our side. Try again in a moment.',
} as const;

/**
 * The sentence for a failure, or `null` for a caller-initiated abort (nothing to show).
 * Exported so a screen that renders the copy inside its own layout (under a field, in a
 * toast) reads the same string the component renders.
 */
export function messageForInvitationFailure(failure: InvitationFailure): string | null {
  switch (failure.kind) {
    case 'not_found':
      return INVITATION_MESSAGES.notFound;
    case 'already_accepted':
      return INVITATION_MESSAGES.alreadyAccepted;
    case 'tenant_conflict':
      return INVITATION_MESSAGES.tenantConflict;
    case 'expired':
      return INVITATION_MESSAGES.expired;
    case 'revoked':
      return INVITATION_MESSAGES.revoked;
    case 'rate_limited':
      return INVITATION_MESSAGES.rateLimited(failure.retryAfterSeconds);
    case 'unauthenticated':
      return INVITATION_MESSAGES.unauthenticated;
    case 'validation':
      // The field errors are the FORM's to place under its inputs; at this level one fixed
      // sentence, so no server-produced string is rendered here.
      return INVITATION_MESSAGES.validationFailed;
    case 'aborted':
      return null;
    case 'unknown':
      return INVITATION_MESSAGES.generic;
  }
}

export interface InvitationStateMessageProps {
  failure: InvitationFailure;
}

/**
 * `role="alert"` so a screen reader announces the state when it appears; the accept page
 * swaps the preview for this, so it is the page's one message. Renders nothing for an
 * abort.
 */
export function InvitationStateMessage({ failure }: InvitationStateMessageProps): ReactElement | null {
  const message = messageForInvitationFailure(failure);

  if (message === null) {
    return null;
  }

  return (
    <p role="alert" className="form-error" data-invitation-state={failure.kind}>
      {message}
    </p>
  );
}
