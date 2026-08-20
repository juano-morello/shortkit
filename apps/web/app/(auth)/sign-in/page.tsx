/**
 * TASK-008 (STORY-003, AC-17; AC-16's landing). The sign-in screen, at `/sign-in`: the
 * route `requireAuth()` (TASK-007) sends an unauthenticated visitor to.
 *
 * An async server component. Before rendering the form it reads `sk_at` the way
 * `requireAuth` does (`sessionUserFromJwt`, decode only): a visitor who already holds a
 * decodable session has nothing to do here and is redirected to the workspace list, or to
 * a vetted `?returnTo=`. Then it reads two query parameters:
 *
 *   - `?created=1`: signup just landed here (ADR-0061: no auto-sign-in). Shows the
 *     confirmation "Your account is ready. Sign in to continue".
 *   - `?returnTo=<path>`: where a successful sign-in should land. Accepted ONLY as a
 *     same-origin relative path under the SAME rule the refresh route applies
 *     (`safeReturnTo`, imported from it rather than re-implemented); anything else, and the
 *     default, is `/workspaces` (TASK-013 builds it).
 *
 * The page never reads or renders a credential; the form posts to the BFF and the BFF sets
 * the cookies on its own response.
 */
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactElement } from 'react';

import {
  RETURN_TO_PARAM,
  SIGNUP_CREATED_PARAM,
  SIGNUP_CREATED_VALUE,
  SIGN_UP_ROUTE,
} from '../../../src/components/auth/routes';
import { SignInForm } from '../../../src/components/auth/sign-in-form';
import { ACCESS_COOKIE, sessionUserFromJwt } from '../../../src/lib/session/session';
import { successPathFrom } from './success-path';

export const metadata: Metadata = {
  title: 'Sign in · Shortkit',
  description: 'Sign in to your Shortkit workspaces.',
};

type SearchParams = Record<string, string | string[] | undefined>;

interface SignInPageProps {
  searchParams: Promise<SearchParams>;
}

/** Shown once, when signup lands here (ADR-0061). A page file may export only Next's fields. */
const ACCOUNT_READY_MESSAGE = 'Your account is ready. Sign in to continue.';

/** The first value of a query parameter, or `undefined`. */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SignInPage({ searchParams }: SignInPageProps): Promise<ReactElement> {
  const query = await searchParams;
  const successPath = successPathFrom(query[RETURN_TO_PARAM]);

  // The same light check `requireAuth` performs, without its redirect target: a decodable
  // `sk_at` means the visitor is signed in and the workspace list is where they belong.
  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;

  if (accessToken !== undefined && accessToken !== '' && sessionUserFromJwt(accessToken) !== null) {
    redirect(successPath);
  }

  const created = firstParam(query[SIGNUP_CREATED_PARAM]) === SIGNUP_CREATED_VALUE;

  return (
    <main className="auth-page">
      <h1>Sign in</h1>
      {created ? (
        <p role="status" className="notice">
          {ACCOUNT_READY_MESSAGE}
        </p>
      ) : null}
      <SignInForm successPath={successPath} />
      <p className="auth-switch">
        New to Shortkit? <Link href={SIGN_UP_ROUTE}>Create an account</Link>
      </p>
    </main>
  );
}
