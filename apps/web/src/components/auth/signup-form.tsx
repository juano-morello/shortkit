'use client';

/**
 * TASK-008. The signup screen's client half: the shared form in `signup` mode, and the one
 * navigation the card fixes for success — the sign-in screen with `?created=1` (ADR-0061:
 * no session was established, so the workspace list would only bounce back here).
 *
 * TASK-1b-12 (item 1b) adds two optional props for the accept page (TASK-1b-13): the
 * invitation token to attach to the signup body (D-03; `CredentialForm.invitationToken`)
 * and the landing path, which that page sets to `SIGN_IN_AFTER_INVITED_SIGNUP_URL` so a
 * sign-in comes back to `/invitations/accept` (AC-1b-12). Both default to the plain signup
 * behaviour, so the `/signup` page is unchanged.
 *
 * `router.replace`, not `push`: the signup form holds a password and must not sit one
 * Back press away. The target carries no address, no credential and no token.
 */
import { useRouter } from 'next/navigation';
import type { ReactElement } from 'react';

import { CredentialForm } from './credential-form';
import { SIGN_IN_AFTER_SIGNUP_URL } from './routes';

export interface SignupFormProps {
  /** Attached to the signup body as `invitationToken` (D-03). Absent for a plain signup. */
  invitationToken?: string;
  /** A same-origin relative path; defaults to the sign-in screen with `?created=1`. */
  successPath?: string;
}

export function SignupForm({ invitationToken, successPath = SIGN_IN_AFTER_SIGNUP_URL }: SignupFormProps = {}): ReactElement {
  const router = useRouter();

  return (
    <CredentialForm
      mode="signup"
      invitationToken={invitationToken}
      onSuccess={() => {
        router.replace(successPath);
      }}
    />
  );
}
