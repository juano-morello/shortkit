/**
 * TASK-1b-14 (STORY-1b-05, AC-1b-29). The per-workspace invitations screen at
 * `/workspaces/[workspaceId]/invitations` — where a `workspace_admin` invites a teammate
 * to THIS workspace, sees who was invited and in what state, and revokes a pending one.
 * The only place 1b shows membership at all (D-14; member management is out of scope).
 *
 * Contract: docs/contracts/workspace-authorization.md ("Minimum role per surface":
 *   `GET /api/workspaces/:workspaceId` any membership; `GET /api/invitations?workspaceId=`
 *   and `POST /api/invitations` and `DELETE /api/invitations/:id` `workspace_admin`),
 *   docs/contracts/workspaces.md (`GET /api/workspaces/:workspaceId`, TASK-1b-06),
 *   docs/contracts/invitation-tokens.md (states), docs/contracts/web-api-client.md
 *   (`serverApiClient` — the server leg, direct to the API with the `sk_at` cookie).
 * ADR: adr-0014 (server components skip the proxy; the browser goes through the BFF).
 * Consumes: TASK-1b-12's `getWorkspaceRequest`, `listInvitationsRequest`,
 *   `INVITATIONS_ROUTE`; `requireAuth`, `serverApiClient`, `refresh-bounce.ts`.
 *
 * ============================================================================
 * DESIGN, RECORDED.
 * ============================================================================
 *
 * 1. PROTECTION IS SERVER-SIDE AND COMES FIRST. `await requireAuth()` is the first thing
 *    this page does: a visitor with no session is redirected to `/sign-in` before any
 *    workspace data is fetched. Never render-then-hide (the workspaces page's ruling 1).
 *
 * 2. THE WORKSPACE, THEN ITS INVITATIONS, ON THE SERVER — `serverApiClient(getWorkspaceRequest)`
 *    then `serverApiClient(listInvitationsRequest)`, sequentially: a workspace the caller
 *    cannot read ends the page before the list is asked for, and the order is assertable.
 *    The route param is checked against `idContract` first; a value that is not a uuid is
 *    not-found without a request (the API would answer 400 or 404; one hop earlier).
 *
 * 3. NOT-FOUND FOR "CANNOT READ" AND FOR "CANNOT ADMINISTER", ONE RENDERING. `not_found`
 *    (no membership, another tenant's id, unknown id) on either fetch and
 *    `insufficient_workspace_role` / `insufficient_tenant_role` (a `member` or `viewer`: the
 *    workspace fetch succeeds, the list is 403) both `notFound()`. A member sees exactly
 *    what a non-member sees — this page does not disclose that a workspace exists to
 *    someone it will not let administer it, matching the API's own 404-before-403 spirit
 *    for reads. Nothing of the workspace (its name) reaches the not-found output: it is
 *    rendered by `app/not-found.tsx`, which knows nothing of this page.
 *
 * 4. THE REST OF THE FAILURES are the workspaces page's: `unauthenticated` from the API
 *    redirects to sign-in with a `returnTo` to THIS page; the `token_expired` refresh
 *    bounce is re-issued with the same `returnTo` (`refresh-bounce.ts`); anything else is
 *    not swallowed.
 *
 * 5. THE SCREEN INVITES TO THIS ONE WORKSPACE. `POST /api/invitations` names up to twenty
 *    workspaces; the form on this page names exactly the one it is on (D-14: "this screen
 *    invites to the one workspace it is on; the API accepts many, the first UI offers one
 *    to stay small"). The role picker offers `INVITABLE_WORKSPACE_ROLES` (no `viewer`).
 *
 * 6. THE LIST comes from the server for the first render and is re-fetched by the client
 *    after every change (no optimistic state). "Expired" is derived client-side for a
 *    pending row past its `expiresAt` (1b never writes the state; `invitations-list.tsx`).
 *    Revoke is a two-step inline confirm on pending rows.
 *
 * 7. THE ADDRESS the operator types is echoed in the screen (the field, the announcement,
 *    the revoke question) and sent in a request BODY. It is never put in a URL, a query,
 *    an `href` or a log line; the specs sweep every fetch URL and the document URL. The
 *    page's `metadata` is static, so no workspace name reaches a `<title>` either.
 *
 * 8. NOTHING HERE READS A COOKIE OR HOLDS A TOKEN. `requireAuth` and `serverApiClient` read
 *    `sk_at` inside `src/lib`; the client component uses `apiClient` through the BFF.
 *
 * 9. ACCESSIBILITY: the `h1` names the workspace ("Invitations for <name>"); the client
 *    screen has one polite live region, list semantics, focus management and
 *    `aria-disabled` controls with in-flight refs (`invitations-screen.tsx`).
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import type { ReactElement } from 'react';

import { idContract } from '@shortkit/contracts';
import type { Invitation, Workspace } from '@shortkit/contracts';

import { INVITATIONS_ROUTE, getWorkspaceRequest, listInvitationsRequest } from '../../../../../src/components/invitations/invitations-api';
import { ApiError, serverApiClient } from '../../../../../src/lib/api/client';
import { requireAuth } from '../../../../../src/lib/session/session';
import { isRefreshBounce, refreshBounceUrl } from '../../refresh-bounce';
import { InvitationsScreen, signInAfterExpiryUrl } from './invitations-screen';

export const metadata: Metadata = {
  title: 'Invitations · Shortkit',
  description: 'Invite teammates to a workspace and see who was invited.',
};

/** Reads cookies on every request; never prerendered, never cached. */
export const dynamic = 'force-dynamic';

interface InvitationsPageProps {
  params: Promise<{ workspaceId: string }>;
}

/** The two codes that mean "not yours to see or to administer": one not-found rendering (design point 3). */
function isNotFoundForThisPage(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'not_found' || error.code === 'insufficient_workspace_role' || error.code === 'insufficient_tenant_role')
  );
}

export default async function InvitationsPage({ params }: InvitationsPageProps): Promise<ReactElement> {
  // Design point 1: redirect before any data fetch. `redirect()` throws, so nothing below
  // runs for a visitor with no session.
  await requireAuth();

  const { workspaceId: rawWorkspaceId } = await params;
  const parsedId = idContract.safeParse(rawWorkspaceId);

  if (!parsedId.success) {
    notFound();
  }

  const workspaceId = parsedId.data;
  const ownPath = INVITATIONS_ROUTE(workspaceId);

  let workspace: Workspace;
  let items: Invitation[];

  try {
    workspace = await serverApiClient(getWorkspaceRequest(workspaceId));
    ({ items } = await serverApiClient(listInvitationsRequest(workspaceId)));
  } catch (error: unknown) {
    if (isNotFoundForThisPage(error)) {
      notFound();
    }

    if (error instanceof ApiError && error.code === 'unauthenticated') {
      redirect(signInAfterExpiryUrl(workspaceId));
    }

    if (isRefreshBounce(error)) {
      redirect(refreshBounceUrl(ownPath));
    }

    throw error;
  }

  return (
    <main className="workspaces-page invitations-page">
      <h1>Invitations for {workspace.name}</h1>
      <InvitationsScreen workspace={workspace} initialItems={items} />
    </main>
  );
}
