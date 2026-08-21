'use client';

/**
 * TASK-2-14 (STORY-2-10, AC-2-48/49/51). The client half of `/workspaces/[workspaceId]/links`:
 * the create form (for `member`+), the list with its cursor, and the one live region that
 * announces what changed. The `invitations-screen.tsx` shape, for links.
 *
 * Contract: docs/contracts/workspace-authorization.md (`GET /api/links` viewer,
 *   `POST /api/links` member), docs/contracts/error-envelope.md,
 *   docs/contracts/web-api-client.md (`apiClient`).
 * ADR: adr-0014 (the browser never holds a token; every request goes through `/api/bff/*`).
 * Decision: D-2-12 (an archived workspace refuses a create and keeps serving its links),
 *   D-2-18.
 *
 * RE-FETCH, NOT OPTIMISTIC INSERT (the two shipped screens' ruling, kept). After a
 * successful create this component re-fetches the FIRST page and replaces its rows: the
 * order is the API's (`created_at DESC, id`), the window badges are judged against one
 * clock taken when that answer arrived, and what is rendered is by construction what the
 * API holds. A create lands on the first page by that order, so the operator sees the row
 * they just made; pages loaded through "load more" are dropped, deliberately. The
 * alternative is stitching a new row into a cursor-paginated list the client did not
 * order, which is the bug that ships six months later.
 *
 * "LOAD MORE" APPENDS AND DOES NOT TOUCH THE CLOCK. It adds the next cursor page to what
 * is already on screen; re-judging the rows already rendered against a newer clock would
 * make a row change state because the operator asked for more rows, which is not something
 * they did.
 *
 * A VIEWER GETS THE LIST AND NOTHING ELSE (D-2-18). No create form, no row action. The API
 * enforces it (403 on every write); this only keeps the screen from offering a refusal.
 *
 * AN ARCHIVED WORKSPACE gets the list and no create form: the API answers 400
 * `validation_failed` to a create on one (D-2-12), and its existing links keep redirecting,
 * which the note says out loud so nobody assumes archiving took them down.
 *
 * FAILURES BY `code`, never by status (`classifyLinkFormError`): `unauthenticated` mid-use
 * navigates to sign-in with a `returnTo` back to this page; `not_found` means the row was
 * stale, so re-fetch and say so; everything else is one banner with a reload control.
 *
 * ACCESSIBILITY as the sibling screens: ONE polite `role="status"` region, always mounted
 * and focusable; failures are `role="alert"`, `tabIndex={-1}`, re-mounted per attempt; the
 * reload and load-more controls are `aria-disabled` with refs as the real guards.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { Link as LinkRow, Paginated, Workspace } from '@shortkit/contracts';

import { WORKSPACES_ROUTE } from '../../../../../src/components/auth/routes';
import { LinkForm } from '../../../../../src/components/links/link-form';
import { LinkList } from '../../../../../src/components/links/link-list';
import {
  LINK_SCREEN_MESSAGES,
  canManageLinks,
  signInAfterExpiryUrl,
} from '../../../../../src/components/links/links-view';
import { apiClient } from '../../../../../src/lib/api/client';
import {
  LINKS_ROUTE,
  LINK_MESSAGES,
  classifyLinkFormError,
  listLinksRequest,
  messageForLinkFailure,
} from '../../../../../src/lib/links/links-api';
import type { LinkFormFailure } from '../../../../../src/lib/links/links-api';

export interface LinksScreenProps {
  /** The workspace the SERVER fetched; its `workspaceRole` is the render gate. */
  workspace: Workspace;
  /** The first page the SERVER fetched for this render, never fetched again on mount. */
  initialPage: Paginated<LinkRow>;
  /** `SHORT_LINK_ORIGIN`, read on the server: it carries no `NEXT_PUBLIC_` prefix by design. */
  shortLinkOrigin: string;
}

export function LinksScreen({ workspace, initialPage, shortLinkOrigin }: LinksScreenProps): ReactElement {
  const router = useRouter();
  const idBase = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const reloadInFlight = useRef(false);
  const loadMoreInFlight = useRef(false);

  const [items, setItems] = useState<LinkRow[]>(initialPage.items);
  const [cursor, setCursor] = useState<string | null>(initialPage.nextCursor);
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  /**
   * ============================================================================
   * THE ANNOUNCEMENT CARRIES A NONCE, BUMPED ON EVERY SET AND NOT ON EVERY CHANGE.
   * ============================================================================
   *
   * React writes no DOM text node when the string it renders is unchanged, so copying the
   * same short link twice fired the clipboard twice and announced once: the second
   * `setStatus` produced an identical render and the live region never mutated. The
   * banners already solved this with a per attempt `key`; the same mechanism belongs here,
   * with the counter bumped on every set rather than on every change, because "the same
   * thing happened again" is exactly the case that has to be announced.
   *
   * THE REGION ITSELF STAYS MOUNTED and the keyed element is the span INSIDE it. A live
   * region has to be in the accessibility tree before its contents change or assistive
   * technology may never announce it at all, so keying the `<p role="status">` would trade
   * a dropped repeat for a dropped announcement. Keying the child makes each announcement a
   * real removal and insertion INSIDE a region that was already there.
   */
  const [status, setStatus] = useState<{ message: string; nonce: number }>({ message: '', nonce: 0 });
  const [error, setError] = useState<string | null>(null);
  // Bumped when an announcement must also take focus; a counter rather than a
  // reset-in-effect boolean, so the effect below only reads it (react-hooks/set-state-in-effect).
  const [focusStatus, setFocusStatus] = useState(0);
  // Bumped per failure so an identical alert re-mounts and is announced again.
  const [attempt, setAttempt] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * ONE CLOCK PER LIST CHANGE, so every row's window badge agrees and no badge is derived
   * from a `Date.now()` read during render (which would make render impure and re-date the
   * page on every unrelated re-render). Taken when the first page arrived, and again after
   * each re-fetch.
   */
  const [now, setNow] = useState<Date>(() => new Date());

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

  const ownPath = LINKS_ROUTE(workspace.id);

  /** Every write to the live region goes through here, so no caller can forget the nonce. */
  function announce(message: string): void {
    setStatus((current) => ({ message, nonce: current.nonce + 1 }));
  }

  /**
   * Replaces the rows with the API's first page. Returns `true` when it did; on failure it
   * either navigates (session expired) or leaves the current rows in place with a retry.
   */
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const page = await apiClient(listLinksRequest(workspace.id));
      setItems(page.items);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setNow(new Date());

      return true;
    } catch (caught: unknown) {
      const failure = classifyLinkFormError(caught);

      if (failure.kind === 'unauthenticated') {
        router.replace(signInAfterExpiryUrl(LINKS_ROUTE(workspace.id)));
      } else if (failure.kind !== 'aborted') {
        setError(LINK_SCREEN_MESSAGES.refreshFailed);
        setAttempt((n) => n + 1);
      }

      return false;
    }
  }, [router, workspace.id]);

  /**
   * Re-fetches, then announces. A standing "could not be refreshed" alert stays up until the
   * re-fetch succeeds (its reload control has to stay mounted while it runs).
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
      await announceAfter(LINK_SCREEN_MESSAGES.reloaded, false);
    } finally {
      reloadInFlight.current = false;
      setReloading(false);
    }
  }

  async function handleLoadMore(): Promise<void> {
    if (loadMoreInFlight.current || cursor === null) {
      return;
    }

    loadMoreInFlight.current = true;
    setLoadingMore(true);

    try {
      const page = await apiClient(listLinksRequest(workspace.id, cursor));
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setError(null);
      announce(LINK_SCREEN_MESSAGES.loadedMore);
    } catch (caught: unknown) {
      handleFailure(classifyLinkFormError(caught));
    } finally {
      loadMoreInFlight.current = false;
      setLoadingMore(false);
    }
  }

  function showError(message: string): void {
    setError(message);
    setAttempt((n) => n + 1);
  }

  function handleFailure(failure: LinkFormFailure): void {
    switch (failure.kind) {
      case 'unauthenticated':
        router.replace(signInAfterExpiryUrl(ownPath));
        break;
      case 'not_found':
        // The row was stale: someone (or another tab) removed it. Re-sync and say so.
        void announceAfter(LINK_SCREEN_MESSAGES.gone, true);
        break;
      case 'aborted':
        break;
      case 'fields':
      case 'rate_limited':
      case 'forbidden':
      case 'generic':
        showError(messageForLinkFailure(failure) ?? LINK_MESSAGES.generic);
        break;
    }
  }

  const archived = workspace.archivedAt !== null;
  const canManage = canManageLinks(workspace.workspaceRole);
  const empty = items.length === 0;
  const errorId = `${idBase}-error`;

  return (
    <div className="links">
      <p className="invitations-back">
        <Link href={WORKSPACES_ROUTE}>{LINK_SCREEN_MESSAGES.backToWorkspaces}</Link>
      </p>

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

      {canManage ? null : <p className="links-note">{LINK_SCREEN_MESSAGES.readOnly}</p>}
      {archived ? <p className="links-note">{LINK_SCREEN_MESSAGES.archived}</p> : null}

      {canManage && !archived ? (
        <LinkForm
          mode={{ kind: 'create', workspaceId: workspace.id }}
          onSaved={(link) => announceAfter(LINK_SCREEN_MESSAGES.created(link.slug), false)}
          onFailure={handleFailure}
        />
      ) : null}

      {empty ? (
        <p className="links-empty">{canManage && !archived ? LINK_SCREEN_MESSAGES.empty : LINK_SCREEN_MESSAGES.emptyForViewer}</p>
      ) : (
        <LinkList
          items={items}
          workspaceId={workspace.id}
          shortLinkOrigin={shortLinkOrigin}
          now={now}
          canManage={canManage}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={() => {
            void handleLoadMore();
          }}
          onCopied={(copied) => {
            announce(copied ? LINK_SCREEN_MESSAGES.copied : LINK_SCREEN_MESSAGES.copyFailed);
          }}
        />
      )}
    </div>
  );
}
