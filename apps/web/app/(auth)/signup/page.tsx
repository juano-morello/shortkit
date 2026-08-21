/**
 * TASK-008 (STORY-003, AC-16). The signup screen, at `/signup`.
 *
 * A server component that renders the heading, the client form and the way to sign-in.
 * On success the form navigates to `/sign-in?created=1` (ADR-0061: signup does not
 * auto-sign-in, so there is no session to land on the workspace list with; the sign-in
 * screen shows the confirmation instead; Juano's ruling, TASK-008 card).
 *
 * TASK-013's "create your first workspace" path returns here, and TASK-017's compose check
 * drives this route; the path is fixed in `src/components/auth/routes.ts`.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';

import { SIGN_IN_ROUTE } from '../../../src/components/auth/routes';
import { SignupForm } from '../../../src/components/auth/signup-form';

export const metadata: Metadata = {
  title: 'Create your account · Shortkit',
  description: 'Create a Shortkit account to manage branded short links for your clients.',
};

export default function SignupPage(): ReactElement {
  return (
    <main className="auth-page">
      <h1>Create your account</h1>
      <p className="auth-lede">One account, then a workspace per client.</p>
      <SignupForm />
      <p className="auth-switch">
        Already have an account? <Link href={SIGN_IN_ROUTE}>Sign in</Link>
      </p>
    </main>
  );
}
