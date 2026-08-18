/**
 * TASK-013 (STORY-004, AC-27; STORY-003 AC-19 and AC-16's reload clause). The workspace
 * list screen at `/workspaces` — the redirect target of a successful sign-in (TASK-008,
 * `WORKSPACES_ROUTE`) and the route AC-19's unauthenticated request must be bounced from.
 *
 * Contract: docs/contracts/workspaces.md ("Endpoints"), docs/contracts/web-api-client.md
 *   (Client: `serverApiClient` — the server leg, direct to the API with the `sk_at` cookie).
 * ADR: adr-0014 (server components skip the proxy; the browser goes through the BFF).
 *
 * ============================================================================
 * DESIGN RULINGS (the architect's), RECORDED HERE.
 * ============================================================================
 *
 * 1. PROTECTION IS SERVER-SIDE AND COMES FIRST. `await requireAuth()` is the first thing
 *    this page does: a visitor with no session is redirected to `/sign-in` before any
 *    workspace data is fetched. Never render-then-hide — a page that renders with
 *    workspace data and hides it has already put a tenant's data in a response body
 *    (AC-19; the TASK-013 card).
 *
 * 2. THE INITIAL LIST IS FETCHED ON THE SERVER through `serverApiClient` —
 *    `GET {API_BASE_URL}/workspaces`, plus `?includeArchived=true` when the page's own
 *    `?archived=1` search parameter is set — and handed to the client `<WorkspaceList>` as
 *    `initialItems`. The page is dynamic (it reads cookies), so every load sees the list
 *    the API holds; that is AC-16's "a subsequent page load … still shows it".
 *
 * 3. AC-27 IS A RE-FETCH, NOT AN OPTIMISTIC INSERT. After a successful create (and rename,
 *    and archive) the client component re-fetches through `apiClient`
 *    (`GET /api/bff/workspaces…`) and replaces its state. Simpler than optimistic UI, with
 *    no row to roll back on failure — a failed create shows its error under the name field
 *    and adds nothing — and what is rendered is by construction what the API holds. The
 *    full argument is in `workspace-list.tsx`'s docblock.
 *
 * 4. ARCHIVED VISIBILITY IS A LINK TO `?archived=1` (and back), i.e. a server re-render
 *    with the other list, so the server and the API agree on what "archived" means; the
 *    client list honours the same flag on its re-fetches. `<WorkspaceList>` is KEYED by the
 *    flag so the switch remounts it with the new `initialItems`.
 *
 * 5. THE EMPTY STATE says what a workspace is (one per client; a branded domain later) and
 *    shows the create form — it is the first thing most operators see, since signup
 *    creates a tenant with no workspaces.
 *
 * 6. RENAME IS INLINE PER ROW; ARCHIVE IS A PER-ROW BUTTON; an archived row shows an
 *    "Archived" badge and no controls (the API allows renaming an archived workspace; the
 *    screen keeps it read-only — `workspace-row.tsx`).
 *
 * 7. ERRORS BY `code`: `validation_failed` under the field; `not_found` refreshes and says
 *    "That workspace no longer exists."; `rate_limited`/`internal_error`/transport one
 *    generic retry line; `unauthenticated` mid-use → `router.replace('/sign-in?returnTo=/workspaces')`.
 *
 * 8. NOTHING HERE READS A COOKIE OR HOLDS A TOKEN. `requireAuth` and `serverApiClient` read
 *    `sk_at` inside `src/lib`; the client component uses `apiClient` through the BFF.
 *
 * Two failures of the initial fetch are handled here, the rest are not swallowed: an
 * `unauthenticated` from the API (a present-but-refused `sk_at`) redirects to sign-in with a
 * `returnTo` to this page, and the `token_expired` refresh bounce `serverApiClient` throws is
 * re-issued with a `returnTo` (see `refresh-bounce.ts`), so a reload after the JWT aged out
 * comes back HERE, not to `/`.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactElement } from 'react';

import type { Workspace } from '@shortkit/contracts';

import { WORKSPACES_ROUTE } from '../../../src/components/auth/routes';
import { WorkspaceList } from '../../../src/components/workspaces/workspace-list';
import {
  ARCHIVED_PARAM,
  ARCHIVED_VALUE,
  SIGN_IN_AFTER_EXPIRY_URL,
  WORKSPACES_WITH_ARCHIVED_URL,
  listWorkspacesRequest,
} from '../../../src/components/workspaces/workspaces-api';
import { ApiError, serverApiClient } from '../../../src/lib/api/client';
import { requireAuth } from '../../../src/lib/session/session';
import { isRefreshBounce, refreshBounceUrl } from './refresh-bounce';

export const metadata: Metadata = {
  title: 'Workspaces · Shortkit',
  description: 'Your client workspaces.',
};

/** Reads cookies on every request; never prerendered, never cached. */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

interface WorkspacesPageProps {
  searchParams: Promise<SearchParams>;
}

/** The first value of a query parameter, or `undefined`. */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function WorkspacesPage({ searchParams }: WorkspacesPageProps): Promise<ReactElement> {
  // Ruling 1: redirect before any data fetch. `redirect()` throws, so nothing below runs
  // for a visitor with no session.
  await requireAuth();

  const query = await searchParams;
  const includeArchived = firstParam(query[ARCHIVED_PARAM]) === ARCHIVED_VALUE;
  const ownPath = includeArchived ? WORKSPACES_WITH_ARCHIVED_URL : WORKSPACES_ROUTE;

  let items: Workspace[];

  try {
    ({ items } = await serverApiClient(listWorkspacesRequest(includeArchived)));
  } catch (error: unknown) {
    if (error instanceof ApiError && error.code === 'unauthenticated') {
      redirect(SIGN_IN_AFTER_EXPIRY_URL);
    }

    if (isRefreshBounce(error)) {
      redirect(refreshBounceUrl(ownPath));
    }

    throw error;
  }

  return (
    <main className="workspaces-page">
      <h1>Workspaces</h1>
      <WorkspaceList key={includeArchived ? 'with-archived' : 'active'} initialItems={items} includeArchived={includeArchived} />
    </main>
  );
}
