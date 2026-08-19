'use client';

/**
 * TASK-008. The signup screen's client half: the shared form in `signup` mode, and the one
 * navigation the card fixes for success — the sign-in screen with `?created=1` (ADR-0061:
 * no session was established, so the workspace list would only bounce back here).
 *
 * `router.replace`, not `push`: the signup form holds a password and must not sit one
 * Back press away. The target carries no address and no credential.
 */
import { useRouter } from 'next/navigation';
import type { ReactElement } from 'react';

import { CredentialForm } from './credential-form';
import { SIGN_IN_AFTER_SIGNUP_URL } from './routes';

export function SignupForm(): ReactElement {
  const router = useRouter();

  return (
    <CredentialForm
      mode="signup"
      onSuccess={() => {
        router.replace(SIGN_IN_AFTER_SIGNUP_URL);
      }}
    />
  );
}
