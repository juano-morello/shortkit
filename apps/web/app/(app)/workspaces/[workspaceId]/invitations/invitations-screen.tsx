'use client';

/**
 * TASK-1b-14 (STORY-1b-05, AC-1b-29). The client half of `/workspaces/[workspaceId]/invitations`:
 * the invite form, the list (or its empty state), and the one live region that announces
 * what changed. The `workspace-list.tsx` shape, for invitations.
 *
 * Contract: docs/contracts/workspace-authorization.md, docs/contracts/invitation-tokens.md,
 *   docs/contracts/error-envelope.md, docs/contracts/web-api-client.md (`apiClient`).
 * ADR: adr-0014 (the browser never holds a token; every request goes through `/api/bff/*`).
 * Consumes: TASK-1b-12's `listInvitationsRequest`, `INVITATIONS_ROUTE`; `InviteForm`,
 *   `InvitationsList` (this card's).
 *
 * RE-FETCH, NOT OPTIMISTIC STATE (the workspaces screen's ruling, kept). After a successful
 * invite or revoke this component re-fetches `GET /api/bff/invitations?workspaceId=<id>`
 * and REPLACES its rows with the answer: the order is the API's (newest first, D-09), the
 * derived Expired badge is computed against one clock per render, and what is rendered is
 * by construction what the API holds. A failed invite shows its error under the field and
 * adds nothing; a failed revoke leaves the row and shows the message. A re-fetch that
 * fails after a change that succeeded keeps the rows and offers "Reload the list".
 *
 * FAILURES BY `code`, never by status: `unauthenticated` mid-use navigates to sign-in with
 * a `returnTo` back to THIS page; `not_found` / `invitation_already_accepted` on a revoke
 * mean the row was stale — re-fetch and say so; `forbidden` (the two 403 codes) says this
 * account cannot revoke here; `rate_limited` says how long; the rest is one retry line.
 *
 * AN ARCHIVED WORKSPACE gets the list (viewing) and no form: the API answers 400
 * `validation_failed` under `workspaces` to an invite on it (D-09), and offering the form
 * would offer that refusal. Should the workspace be archived AFTER this page loaded, the
 * form's own copy renders that 400 (`INVITE_FORM_MESSAGES.workspaceRefused`).
 *
 * THE ADDRESS is the operator's own input, echoed in the announcement ("Invitation sent to
 * <address>") and the revoke question; it travels in request bodies and never in a URL.
 *
 * ACCESSIBILITY as the sibling screens: the `h1` is the server page's; ONE polite
 * `role="status"` live region, always mounted, focusable so a change that removes the
 * control the operator was on (a revoke takes its Revoke button away) lands focus on the
 * announcement; failures are `role="alert"`, `tabIndex={-1}`, focused when they appear and
 * re-mounted per attempt; the Reload control is `aria-disabled` with a ref as the guard.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { Invitation, Workspace } from '@shortkit/contracts';

import { RETURN_TO_PARAM, SIGN_IN_ROUTE, WORKSPACES_ROUTE } from '../../../../../src/components/auth/routes';
import { INVITATION_MESSAGES } from '../../../../../src/components/invitations/invitation-state-message';
import { InviteForm } from '../../../../../src/components/invitations/invite-form';
import {
  INVITATIONS_ROUTE,
  classifyInvitationScreenError,
  listInvitationsRequest,
} from '../../../../../src/components/invitations/invitations-api';
import type { InvitationScreenFailure } from '../../../../../src/components/invitations/invitations-api';
import { InvitationsList } from '../../../../../src/components/invitations/invitations-list';
import { apiClient } from '../../../../../src/lib/api/client';

/**
 * Where a session that expired mid-use is sent: sign in, then straight back to this
 * workspace's invitations. The sign-in page vets `returnTo` (same-origin relative only)
 * before following it. The workspace id is a uuid the API produced; encoded anyway.
 */
export function signInAfterExpiryUrl(workspaceId: string): string {
  const query = new URLSearchParams({ [RETURN_TO_PARAM]: INVITATIONS_ROUTE(workspaceId) });

  return `${SIGN_IN_ROUTE}?${query.toString()}`;
}

/** This screen's copy; the per-code sentences are `INVITATION_MESSAGES` (TASK-1b-12). */
export const INVITATIONS_SCREEN_MESSAGES = {
  back: 'Back to workspaces',
  empty: 'No invitations yet. Invite a teammate below and their invitation appears here.',
  archived: 'This workspace is archived, so it cannot receive invitations. Its existing invitations are listed below.',
  sent: (email: string): string => `Invitation sent to ${email}.`,
  revoked: (email: string): string => `Invitation for ${email} revoked.`,
  alreadyAccepted: 'That invitation was already accepted, so it cannot be revoked. The list has been refreshed.',
  gone: 'That invitation no longer exists. The list has been refreshed.',
  forbidden: 'This account cannot revoke invitations for this workspace. Only a workspace admin can.',
  refreshFailed: 'The change was saved, but the list could not be refreshed. Reload the list to see it.',
  reloaded: 'List reloaded.',
} as const;

export interface InvitationsScreenProps {
  /** The workspace the SERVER fetched (`GET /workspaces/:workspaceId`); its name is the page's heading. */
  workspace: Workspace;
  /** The list the SERVER fetched for this render, never fetched again on mount. */
  initialItems: Invitation[];
}

export function InvitationsScreen({ workspace, initialItems }: InvitationsScreenProps): ReactElement {
  const router = useRouter();
  const idBase = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  // The "Reload the list" control is `aria-disabled`, not `disabled`; this ref is its guard.
  const reloadInFlight = useRef(false);

  const [items, setItems] = useState<Invitation[]>(initialItems);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Bumped when an announcement must also take focus; a counter rather than a
  // reset-in-effect boolean, so the effect below only reads it (react-hooks/set-state-in-effect).
  const [focusStatus, setFocusStatus] = useState(0);
  const [reloading, setReloading] = useState(false);
  // Bumped per failure so an identical alert re-mounts and is announced again.
  const [attempt, setAttempt] = useState(0);
  // One clock per list change, so every row's derived Expired badge agrees. Taken once at
  // first render and again after each re-fetch (a row is only ever re-judged when the list
  // is). The server and client renders read clocks milliseconds apart; a row whose expiry
  // falls in that gap would hydrate with a different badge — accepted, it self-corrects on
  // the next change and the API's own answer to its token is unaffected.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (focusStatus > 0) {
      statusRef.current?.focus();
    }
  }, [focusStatus]);

  useEffect(() => {
    if (error !== null) {
      alertRef.current?.focus();
    }
  }, [error, attempt]);

  /**
   * Replaces the rows with what the API holds. Returns `true` when it did; on failure it
   * either navigates (session expired) or leaves the current rows in place with a retry.
   */
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const response = await apiClient(listInvitationsRequest(workspace.id));
      setItems(response.items);
      setNow(Date.now());

      return true;
    } catch (caught: unknown) {
      const failure = classifyInvitationScreenError(caught);

      if (failure.kind === 'unauthenticated') {
        router.replace(signInAfterExpiryUrl(workspace.id));
      } else if (failure.kind !== 'aborted') {
        setError(INVITATIONS_SCREEN_MESSAGES.refreshFailed);
        setAttempt((n) => n + 1);
      }

      return false;
    }
  }, [router, workspace.id]);

  /**
   * Re-fetches, then announces. A standing "could not be refreshed" alert stays up UNTIL the
   * re-fetch succeeds (its "Reload the list" control has to stay mounted while it runs), and
   * is cleared only then.
   */
  async function announceAfter(message: string, moveFocusToStatus: boolean): Promise<void> {
    if (await refresh()) {
      setError(null);
      setStatus(message);

      if (moveFocusToStatus) {
        setFocusStatus((n) => n + 1);
      }
    }
  }

  async function handleReload(): Promise<void> {
    if (reloadInFlight.current) {
      return;
    }

    reloadInFlight.current = true;
    setReloading(true);

    try {
      await announceAfter(INVITATIONS_SCREEN_MESSAGES.reloaded, false);
    } finally {
      reloadInFlight.current = false;
      setReloading(false);
    }
  }

  function showError(message: string): void {
    setError(message);
    setAttempt((n) => n + 1);
  }

  function handleFailure(failure: InvitationScreenFailure): void {
    switch (failure.kind) {
      case 'unauthenticated':
        router.replace(signInAfterExpiryUrl(workspace.id));
        break;
      case 'not_found':
        // The row was stale: someone (or another tab) removed it. Re-sync and say so.
        void announceAfter(INVITATIONS_SCREEN_MESSAGES.gone, true);
        break;
      case 'already_accepted':
        // Accepted between the render and the click. Re-sync; the row shows Accepted.
        void announceAfter(INVITATIONS_SCREEN_MESSAGES.alreadyAccepted, true);
        break;
      case 'forbidden':
        showError(INVITATIONS_SCREEN_MESSAGES.forbidden);
        break;
      case 'rate_limited':
        showError(INVITATION_MESSAGES.rateLimited(failure.retryAfterSeconds));
        break;
      case 'validation':
      case 'tenant_conflict':
      case 'expired':
      case 'revoked':
      case 'unknown':
        showError(INVITATION_MESSAGES.generic);
        break;
      case 'aborted':
        break;
    }
  }

  const empty = items.length === 0;
  const archived = workspace.archivedAt !== null;
  const errorId = `${idBase}-error`;

  return (
    <div className="invitations">
      <p className="invitations-back">
        <Link href={WORKSPACES_ROUTE}>{INVITATIONS_SCREEN_MESSAGES.back}</Link>
      </p>

      <p ref={statusRef} role="status" aria-live="polite" tabIndex={-1} className="workspaces-status">
        {status}
      </p>

      {error === null ? null : (
        <div key={attempt} className="workspaces-error">
          <p id={errorId} ref={alertRef} role="alert" tabIndex={-1} className="form-error">
            {error}
          </p>
          <button
            type="button"
            className="secondary"
            aria-describedby={errorId}
            aria-disabled={reloading}
            onClick={() => {
              void handleReload();
            }}
          >
            {reloading ? 'Reloading…' : 'Reload the list'}
          </button>
        </div>
      )}

      {archived ? (
        <p className="invitations-archived">{INVITATIONS_SCREEN_MESSAGES.archived}</p>
      ) : (
        <InviteForm
          workspaceId={workspace.id}
          onCreated={(invitation) => announceAfter(INVITATIONS_SCREEN_MESSAGES.sent(invitation.email), false)}
          onFailure={handleFailure}
        />
      )}

      {empty ? (
        <p className="invitations-empty">{INVITATIONS_SCREEN_MESSAGES.empty}</p>
      ) : (
        <InvitationsList
          items={items}
          workspaceId={workspace.id}
          now={now}
          onRevoked={(invitation) => announceAfter(INVITATIONS_SCREEN_MESSAGES.revoked(invitation.email), true)}
          onFailure={handleFailure}
        />
      )}
    </div>
  );
}
