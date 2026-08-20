/**
 * The routes and query parameters the auth screens fix (TASK-008). TASK-013 (workspace
 * list) and TASK-017 (compose check) depend on these exact strings, so they live here as
 * constants rather than as literals spread over three files.
 *
 * `SIGN_IN_ROUTE` repeats `session.ts`'s constant of the same name deliberately: that module
 * imports `next/headers`, which cannot enter a client bundle, and these constants are read
 * by `'use client'` components. `sign-in.spec.tsx` asserts the two stay equal.
 */
export const SIGN_IN_ROUTE = '/sign-in';
export const SIGN_UP_ROUTE = '/signup';
/** Where a successful sign-in lands by default (TASK-013 builds the route). */
export const WORKSPACES_ROUTE = '/workspaces';

/** `?created=1` on the sign-in screen: signup succeeded and the account is ready. */
export const SIGNUP_CREATED_PARAM = 'created';
export const SIGNUP_CREATED_VALUE = '1';
/** `?returnTo=<same-origin relative path>` on the sign-in screen (the refresh route's rule). */
export const RETURN_TO_PARAM = 'returnTo';

/** The sign-in URL signup navigates to on success. Carries no credential and no address. */
export const SIGN_IN_AFTER_SIGNUP_URL = `${SIGN_IN_ROUTE}?${SIGNUP_CREATED_PARAM}=${SIGNUP_CREATED_VALUE}`;

/**
 * TASK-1b-12 (item 1b). The accept page (TASK-1b-13, `app/(auth)/invitations/accept`). The
 * email link is `<origin>/invitations/accept#token=<raw>`: the token is in the FRAGMENT, so
 * this route string never carries it and neither does any `returnTo` built from it (D-03).
 * One home; `components/invitations/invitations-api.ts` re-exports it.
 */
export const INVITATION_ACCEPT_ROUTE = '/invitations/accept';

/**
 * Where an INVITED signup lands (AC-1b-12, amended 2026-08-18 by the coordinator's ruling
 * on TASK-1b-13): the sign-in screen with `?created=1` and NO `returnTo`. The API's signup
 * hook has already accepted the invitation when the account was created (D-18), so there
 * is nothing left for the accept page to do; sign-in's default landing, `/workspaces`, is
 * where the new member belongs. Kept as its own constant so the accept page and its spec
 * name the journey in one place; today equal to `SIGN_IN_AFTER_SIGNUP_URL`. Carries no
 * credential, no address and no token.
 */
export const SIGN_IN_AFTER_INVITED_SIGNUP_URL = SIGN_IN_AFTER_SIGNUP_URL;
