/**
 * TASK-2-14 (STORY-2-10, AC-2-50/51). One link's edit and delete surface, at
 * `/workspaces/[workspaceId]/links/[linkId]` (D-2-18).
 *
 * Contract: docs/contracts/workspace-authorization.md (`GET /api/links/:linkId` viewer,
 *   `PATCH` and `DELETE` member; unknown or another tenant's id is 404, envelope
 *   invariant 5), docs/contracts/web-api-client.md (`serverApiClient`).
 * ADR: adr-0014, adr-0006.
 * Decision: D-2-02, D-2-12, D-2-18.
 *
 * The list page's eight design points hold here unchanged; the two that differ:
 *
 * 2'. THE WORKSPACE, THEN THE LINK, sequentially. The workspace supplies `workspaceRole`
 *     (the render gate) and its name, and a workspace the caller cannot read ends the page
 *     before the link is asked for. Both ids are checked against `idContract` first, so a
 *     value that is not a uuid is not-found without a request.
 *
 * 4'. A LINK THAT BELONGS TO ANOTHER WORKSPACE IS NOT-FOUND HERE TOO. The API scopes by
 *     tenant, not by the workspace in this URL, so `GET /links/:linkId` would happily
 *     answer with a link from a sibling workspace the caller also belongs to; this page
 *     refuses it, because the row it would then PATCH is not the row the URL names and the
 *     "back to the list" it returns to would not contain it. One rendering, the same
 *     `notFound()` a stranger's id gets.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import type { ReactElement } from 'react';

import { idContract } from '@shortkit/contracts';
import type { Link as LinkRow, Workspace } from '@shortkit/contracts';

import { getWorkspaceRequest } from '../../../../../../src/components/invitations/invitations-api';
import { signInAfterExpiryUrl } from '../../../../../../src/components/links/links-view';
import { ApiError, serverApiClient } from '../../../../../../src/lib/api/client';
import { LINK_ROUTE, getLinkRequest } from '../../../../../../src/lib/links/links-api';
import { requireAuth } from '../../../../../../src/lib/session/session';
import { shortLinkOrigin } from '../../../../../../src/lib/short-url';
import { isRefreshBounce, refreshBounceUrl } from '../../../refresh-bounce';
import { LinkEditScreen } from './link-edit-screen';

export const metadata: Metadata = {
  title: 'Edit link · Shortkit',
  description: 'Change or delete a short link.',
};

/** Reads cookies on every request; never prerendered, never cached. */
export const dynamic = 'force-dynamic';

interface LinkPageProps {
  params: Promise<{ workspaceId: string; linkId: string }>;
}

/** Not exported: a Next page module may export only Next's own fields. */
function isNotFoundForLink(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'not_found' ||
      error.code === 'insufficient_workspace_role' ||
      error.code === 'insufficient_tenant_role')
  );
}

export default async function LinkPage({ params }: LinkPageProps): Promise<ReactElement> {
  await requireAuth();

  const { workspaceId: rawWorkspaceId, linkId: rawLinkId } = await params;
  const parsedWorkspaceId = idContract.safeParse(rawWorkspaceId);
  const parsedLinkId = idContract.safeParse(rawLinkId);

  if (!parsedWorkspaceId.success || !parsedLinkId.success) {
    notFound();
  }

  const workspaceId = parsedWorkspaceId.data;
  const linkId = parsedLinkId.data;
  const ownPath = LINK_ROUTE(workspaceId, linkId);
  const origin = shortLinkOrigin();

  let workspace: Workspace;
  let link: LinkRow;

  try {
    workspace = await serverApiClient(getWorkspaceRequest(workspaceId));
    link = await serverApiClient(getLinkRequest(linkId));
  } catch (error: unknown) {
    if (isNotFoundForLink(error)) {
      notFound();
    }

    if (error instanceof ApiError && error.code === 'unauthenticated') {
      redirect(signInAfterExpiryUrl(ownPath));
    }

    if (isRefreshBounce(error)) {
      redirect(refreshBounceUrl(ownPath));
    }

    throw error;
  }

  // Design point 4': the link must belong to the workspace this URL names.
  if (link.workspaceId !== workspaceId) {
    notFound();
  }

  return (
    <main className="workspaces-page links-page">
      <h1>Edit link</h1>
      <LinkEditScreen workspace={workspace} link={link} shortLinkOrigin={origin} />
    </main>
  );
}
