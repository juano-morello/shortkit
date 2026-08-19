/**
 * TASK-008. Where a sign-in from `/sign-in` lands, decided on the SERVER from `?returnTo=`.
 *
 * `returnTo` is an open-redirect surface. It is vetted by `safeReturnTo`, imported from the
 * refresh route handler (TASK-007) so the two screens that read a `returnTo` share ONE rule:
 * only a same-origin relative path survives WHATWG normalisation against a fixed `.invalid`
 * base; anything else falls back. The refresh route's fallback is `/`; this page's is the
 * workspace list, so that fallback and an absent parameter both resolve to `WORKSPACES_ROUTE`.
 *
 * Kept out of `page.tsx` because a Next page module may export only Next's own fields.
 */
import { WORKSPACES_ROUTE } from '../../../src/components/auth/routes';
import { DEFAULT_RETURN_TO, safeReturnTo } from '../../api/bff/session/refresh/route';

export function successPathFrom(candidate: string | string[] | undefined): string {
  const value = Array.isArray(candidate) ? candidate[0] : candidate;

  if (value === undefined || value === '') {
    return WORKSPACES_ROUTE;
  }

  const safe = safeReturnTo(value);

  return safe === DEFAULT_RETURN_TO ? WORKSPACES_ROUTE : safe;
}
