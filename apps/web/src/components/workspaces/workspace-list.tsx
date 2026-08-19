'use client';

/**
 * TASK-013 (STORY-004, AC-27; AC-22/AC-23 as the screen observes them). The client half of
 * the workspace screen: the create form, the list (or its empty state), the
 * archived-visibility switch, and the one live region that announces what changed.
 *
 * Contract: docs/contracts/workspaces.md ("Endpoints"), docs/contracts/error-envelope.md,
 *   docs/contracts/web-api-client.md (Client: `apiClient` — the browser leg, through the BFF).
 * ADR: adr-0014 (the browser never holds a token; every request goes through `/api/bff/*`).
 *
 * ----------------------------------------------------------------------------
 * AC-27 MECHANISM: RE-FETCH, NOT OPTIMISTIC INSERT (Design's ruling, recorded here).
 * ----------------------------------------------------------------------------
 *
 * After a successful create, rename or archive this component re-fetches the list through
 * `apiClient` (`GET /api/bff/workspaces[?includeArchived=true]`) and REPLACES its state with
 * the answer. It never inserts, patches or removes a row on its own. Why: an optimistic
 * insert has to be undone on failure or the operator sees a workspace that does not exist
 * (the card's own warning), and the list order is the repository's (`created_at`, then
 * `id`), which the client would otherwise have to reproduce. A re-fetch costs one GET on a
 * list that holds a handful of rows, and what it renders is by construction what the API
 * holds — which is also what AC-21/22/23 measure ("a subsequent list request returns…").
 * A failed create shows its error under the name field and adds nothing.
 *
 * ARCHIVED VISIBILITY IS A SERVER ROUND-TRIP. The switch is a link to `?archived=1` (or back
 * to the bare route); the page re-renders with the other list from the API, so the server
 * and the API agree on what "archived" means, and this component honours the same flag on
 * every re-fetch. The page keys this component by the flag, so a switch remounts it with
 * the new `initialItems` rather than leaving stale state behind.
 *
 * NOTHING HERE READS A COOKIE OR HOLDS A TOKEN. `apiClient` sends the same-origin request;
 * the BFF attaches the session.
 *
 * Errors, by `code`: `validation_failed` under the field (the form and the row own that);
 * `not_found` re-fetches and announces WORKSPACE_MESSAGES.gone (the row was stale);
 * `unauthenticated` (the session expired mid-use) navigates to sign-in with a return path;
 * everything else — rate limit, server error, transport, contract — is one retry message.
 * A re-fetch that fails after a change that succeeded keeps what it has and offers a retry.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { Workspace } from '@shortkit/contracts';

import { apiClient } from '../../lib/api/client';
import { WORKSPACES_ROUTE } from '../auth/routes';
import { CreateWorkspaceForm } from './create-workspace-form';
import { WorkspaceRow } from './workspace-row';
import type { WorkspaceChange } from './workspace-row';
import {
  SIGN_IN_AFTER_EXPIRY_URL,
  WORKSPACES_WITH_ARCHIVED_URL,
  WORKSPACE_MESSAGES,
  classifyWorkspaceError,
  listWorkspacesRequest,
} from './workspaces-api';
import type { WorkspaceFailure } from './workspaces-api';

export interface WorkspaceListProps {
  /** The list the SERVER fetched for this render (`serverApiClient`), never fetched again on mount. */
  initialItems: Workspace[];
  /** `?archived=1` was on the URL: the server list included archived workspaces, and so must every re-fetch. */
  includeArchived: boolean;
}

export function WorkspaceList({ initialItems, includeArchived }: WorkspaceListProps): ReactElement {
  const router = useRouter();
  const idBase = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);

  const [items, setItems] = useState<Workspace[]>(initialItems);
  /**
   * The announcement carries a nonce bumped on every SET, not on every change: React writes
   * no DOM text node when the string is unchanged, so archiving one stale row and then
   * another announced "That workspace no longer exists." once and acted twice. The `<p
   * role="status">` itself stays mounted (a live region must be in the accessibility tree
   * before its contents change, or assistive technology may never announce it at all) and
   * the keyed span inside it is what is removed and re-inserted. Same mechanism as the
   * links screens'.
   */
  const [status, setStatus] = useState<{ message: string; nonce: number }>({ message: '', nonce: 0 });
  const [error, setError] = useState<string | null>(null);
  // Bumped when an announcement must also take focus; a counter rather than a
  // reset-in-effect boolean, so the effect below only reads it (react-hooks/set-state-in-effect).
  const [focusStatus, setFocusStatus] = useState(0);
  const [reloading, setReloading] = useState(false);
  // The "Reload the list" control is `aria-disabled`, not `disabled`; this ref is its guard.
  const reloadInFlight = useRef(false);
  // Bumped per failure so an identical alert re-mounts and is announced again.
  const [attempt, setAttempt] = useState(0);

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
   * Replaces the list with what the API holds. Returns `true` when it did; on failure it
   * either navigates (session expired) or leaves the current rows in place with a retry.
   */
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const response = await apiClient(listWorkspacesRequest(includeArchived));
      setItems(response.items);

      return true;
    } catch (caught: unknown) {
      const failure = classifyWorkspaceError(caught);

      if (failure.kind === 'unauthenticated') {
        router.replace(SIGN_IN_AFTER_EXPIRY_URL);
      } else if (failure.kind !== 'aborted') {
        setError(WORKSPACE_MESSAGES.refreshFailed);
        setAttempt((n) => n + 1);
      }

      return false;
    }
  }, [includeArchived, router]);

  /** Every write to the live region goes through here, so no caller can forget the nonce. */
  function announce(message: string): void {
    setStatus((current) => ({ message, nonce: current.nonce + 1 }));
  }

  /**
   * Re-fetches, then announces. A standing "could not be refreshed" alert stays up UNTIL the
   * re-fetch succeeds (its "Reload the list" control has to stay mounted while it runs), and
   * is cleared only then.
   */
  async function announceAfter(message: string, moveFocusToStatus: boolean): Promise<void> {
    if (await refresh()) {
      setError(null);
      announce(message);

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
      await announceAfter(WORKSPACE_MESSAGES.reloaded, false);
    } finally {
      reloadInFlight.current = false;
      setReloading(false);
    }
  }

  function handleFailure(failure: WorkspaceFailure): void {
    switch (failure.kind) {
      case 'unauthenticated':
        router.replace(SIGN_IN_AFTER_EXPIRY_URL);
        break;
      case 'not_found':
        // The row was stale: someone (or another tab) removed it. Re-sync and say so.
        void announceAfter(WORKSPACE_MESSAGES.gone, true);
        break;
      case 'generic':
      case 'validation':
      case 'field':
        setError(WORKSPACE_MESSAGES.generic);
        setAttempt((n) => n + 1);
        break;
      case 'aborted':
        break;
    }
  }

  function handleChanged(change: WorkspaceChange): Promise<void> {
    switch (change.kind) {
      case 'renamed':
        return announceAfter(WORKSPACE_MESSAGES.renamed(change.workspace.name), false);
      case 'archived':
        // The row leaves the default list (or loses its controls when archived are shown),
        // so focus would fall to <body>; land it on the announcement instead.
        return announceAfter(WORKSPACE_MESSAGES.archived(change.workspace.name), true);
    }
  }

  const empty = items.length === 0;
  const listHeadingId = `${idBase}-list-heading`;
  const errorId = `${idBase}-error`;

  return (
    <div className="workspaces">
      <p ref={statusRef} role="status" aria-live="polite" tabIndex={-1} className="workspaces-status">
        <span key={status.nonce}>{status.message}</span>
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

      <CreateWorkspaceForm
        empty={empty}
        onCreated={(workspace) => announceAfter(WORKSPACE_MESSAGES.created(workspace.name), false)}
        onFailure={handleFailure}
      />

      {/* The empty state is the create section above, not an empty list (TASK-013 card). */}
      {empty ? null : (
        <section className="workspaces-list" aria-labelledby={listHeadingId}>
          <h2 id={listHeadingId}>Your workspaces</h2>
          <ul className="workspace-rows" aria-labelledby={listHeadingId}>
            {items.map((workspace) => (
              <WorkspaceRow key={workspace.id} workspace={workspace} onChanged={handleChanged} onFailure={handleFailure} />
            ))}
          </ul>
        </section>
      )}

      <p className="workspaces-switch">
        {includeArchived ? (
          <Link href={WORKSPACES_ROUTE}>Hide archived workspaces</Link>
        ) : (
          <Link href={WORKSPACES_WITH_ARCHIVED_URL}>Show archived workspaces</Link>
        )}
      </p>
    </div>
  );
}
