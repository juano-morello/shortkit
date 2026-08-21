/**
 * TASK-013 (STORY-003 AC-16's "a subsequent page load … still shows it"). Recognises the
 * refresh bounce `serverApiClient` throws on a 401 `token_expired`, so the page can re-issue
 * it WITH a `returnTo` and land back here after the refresh instead of on `/`.
 *
 * `serverApiClient` cannot set cookies during render (web-api-client.md invariant 5), so it
 * `redirect()`s to `SERVER_COMPONENT_REFRESH_PATH` with no `returnTo`: "a server component
 * has no reliable view of the URL being rendered … A protected page that wants to return to
 * itself can catch the redirect and re-issue it with `?returnTo=`" (its docblock). This page
 * knows its own URL, so it does. Without this, an operator whose `sk_at` aged past 300 s
 * reloads `/workspaces` and lands on the home page: signed in, list not shown.
 *
 * Next signals a redirect by throwing an error whose `digest` is
 * `NEXT_REDIRECT;<replace|push>;<destination>;<status>;` (`next/dist/client/components/
 * redirect-error.js`). Only that shape, with that exact destination, is intercepted;
 * anything else is left to whoever threw it, so a future change to the digest degrades to
 * the default bounce rather than to a swallowed error.
 *
 * Kept out of `page.tsx` because a Next page module may export only Next's own fields.
 */
import { SERVER_COMPONENT_REFRESH_PATH } from '../../../src/lib/api/client';
import { RETURN_TO_PARAM } from '../../../src/components/auth/routes';

const REDIRECT_ERROR_CODE = 'NEXT_REDIRECT';

/** `true` when `error` is Next's redirect signal to the refresh-and-bounce route, without a `returnTo`. */
export function isRefreshBounce(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('digest' in error) || typeof error.digest !== 'string') {
    return false;
  }

  const parts = error.digest.split(';');
  const [code, type] = parts;
  const destination = parts.slice(2, -2).join(';');

  return code === REDIRECT_ERROR_CODE && (type === 'replace' || type === 'push') && destination === SERVER_COMPONENT_REFRESH_PATH;
}

/** The refresh route with `returnTo` set to `path`, a same-origin relative path the route vets again. */
export function refreshBounceUrl(path: string): string {
  const query = new URLSearchParams({ [RETURN_TO_PARAM]: path });

  return `${SERVER_COMPONENT_REFRESH_PATH}?${query.toString()}`;
}
