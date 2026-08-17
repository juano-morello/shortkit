'use client';

/**
 * TASK-008. The sign-in screen's client half: the shared form in `sign-in` mode, and the
 * navigation on success. `successPath` is decided by the SERVER page from `?returnTo=` under
 * the refresh route's same-origin rule (or `/workspaces` by default); this component only
 * follows it, and never reads the URL itself.
 *
 * `router.replace`, not `push`: the sign-in form holds a password and must not sit one Back
 * press away from the workspace list.
 */
import { useRouter } from 'next/navigation';
import type { ReactElement } from 'react';

import { CredentialForm } from './credential-form';

export interface SignInFormProps {
  /** A same-origin relative path, already vetted by the page. */
  successPath: string;
}

export function SignInForm({ successPath }: SignInFormProps): ReactElement {
  const router = useRouter();

  return (
    <CredentialForm
      mode="sign-in"
      onSuccess={() => {
        router.replace(successPath);
      }}
    />
  );
}
