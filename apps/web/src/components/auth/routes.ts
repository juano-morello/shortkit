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
