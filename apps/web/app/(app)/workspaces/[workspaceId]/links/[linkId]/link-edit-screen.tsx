'use client';

/**
 * TASK-2-14 (STORY-2-10, AC-2-50). The client half of
 * `/workspaces/[workspaceId]/links/[linkId]`: the short URL an operator copies, the edit
 * form, and the two-step delete that names what goes with the link.
 *
 * Contract: docs/contracts/workspace-authorization.md (`PATCH` and `DELETE /api/links/:linkId`
 *   are `member`), docs/contracts/link-mutation-events.md (delete is HARD),
 *   docs/contracts/web-api-client.md (`apiClient`).
 * ADR: adr-0014, adr-0009 (the window word is the shared rule's).
 * Decision: D-2-03 (the click rows cascade away with the link and item 2 states the cost),
 *   D-2-12 (hard delete), D-2-18 (this route).
 *
 * ============================================================================
 * DELETE IS A TWO-STEP INLINE CONFIRM THAT NAMES THE CASCADE (AC-2-50).
 * ============================================================================
 *
 * The `workspace-row.tsx` archive shape, for a heavier action: the delete is HARD, the
 * short link stops resolving the moment it lands, and the link's click history goes with
 * it (the FK cascade D-2-03 accepted and S-2-01 states). So "Delete link" only REVEALS the
 * question, the question says both costs in `LINK_MESSAGES.deleteCascade`'s own words, and
 * only Confirm sends the DELETE. Escape or Cancel closes it and returns focus to the
 * Delete control.
 *
 * SUCCESS RETURNS TO THE LIST, for a save as well as for a delete (the card: "success →
 * back to the list"). The announcement is written to the live region first, so the reason
 * for the navigation is announced even though the screen is leaving.
 *
 * A VIEWER GETS NO FORM AND NO DELETE. `GET /api/links/:linkId` is `viewer`, so a viewer
 * can legitimately be on this page (by URL; the list offers them no Edit control) and sees
 * the link's details read-only. The API answers 403 to their write; this only keeps the
 * screen from offering one.
 *
 * ACCESSIBILITY: one polite `role="status"` region, always mounted and focusable;
 * failures are `role="alert"`, `tabIndex={-1}`, re-mounted per attempt; the confirm
 * controls are `aria-disabled` with an in-flight ref as the real guard; focus is moved in
 * an effect keyed by a FRESH request object, never by state the effect resets.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

import type { Link as LinkRow, Workspace } from '@shortkit/contracts';

import { LinkForm } from '../../../../../../src/components/links/link-form';
import { composeShortUrl } from '../../../../../../src/components/links/link-list';
import {
  LINK_SCREEN_MESSAGES,
  canManageLinks,
  formatInstant,
  signInAfterExpiryUrl,
} from '../../../../../../src/components/links/links-view';
import { apiClient } from '../../../../../../src/lib/api/client';
import {
  LINKS_ROUTE,
  LINK_MESSAGES,
  classifyLinkFormError,
  deleteLinkRequest,
  linkWindowState,
  messageForLinkFailure,
} from '../../../../../../src/lib/links/links-api';
import type { LinkFormFailure } from '../../../../../../src/lib/links/links-api';

export const LINK_EDIT_MESSAGES = {
  delete: 'Delete link',
  deleting: 'Deleting…',
  confirm: 'Confirm',
  cancel: 'Cancel',
  deleteQuestion: (slug: string): string => `Delete ${slug}? ${LINK_MESSAGES.deleteCascade}`,
  shortUrlHeading: 'Short link',
  gone: 'That link no longer exists. It may have been deleted from another tab.',
} as const;

export interface LinkEditScreenProps {
  workspace: Workspace;
  /** The link the SERVER fetched for this render. */
  link: LinkRow;
  shortLinkOrigin: string;
}

type FocusTarget = 'delete-button' | 'confirm-button' | 'status';

export function LinkEditScreen({ workspace, link, shortLinkOrigin }: LinkEditScreenProps): ReactElement {
  const router = useRouter();
  const idBase = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);

  /**
   * The announcement carries a nonce bumped on every SET, not on every change: React writes
   * no DOM text node when the string is unchanged, so a repeated identical announcement
   * would never reach the live region. The `<p role="status">` itself stays mounted (a live
   * region must be in the accessibility tree before its contents change) and the keyed span
   * inside it is what is removed and re-inserted. Same mechanism as the list screen's.
   */
  const [status, setStatus] = useState<{ message: string; nonce: number }>({ message: '', nonce: 0 });
  const [error, setError] = useState<string | null>(null);
  // Bumped per failure so an identical alert re-mounts and is announced again.
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * Focus moves in an effect once the target is mounted. Each request is a FRESH object, so
   * asking for the same target twice still re-runs the effect and the effect never resets
   * the state it reads (react-hooks/set-state-in-effect).
   */
  const [focusMove, setFocusMove] = useState<{ target: FocusTarget } | null>(null);
  /** One clock for the window badge, taken when this render's link arrived. */
  const [now] = useState<Date>(() => new Date());

  useEffect(() => {
    switch (focusMove?.target) {
      case 'delete-button':
        deleteButtonRef.current?.focus();
        break;
      case 'confirm-button':
        confirmButtonRef.current?.focus();
        break;
      case 'status':
        statusRef.current?.focus();
        break;
      case undefined:
        break;
    }
  }, [focusMove]);

  useEffect(() => {
    if (error !== null) {
      alertRef.current?.focus();
    }
  }, [error, attempt]);

  const listPath = LINKS_ROUTE(workspace.id);

  /** Every write to the live region goes through here, so no caller can forget the nonce. */
  function announce(message: string): void {
    setStatus((current) => ({ message, nonce: current.nonce + 1 }));
  }

  function backToList(): void {
    router.push(listPath);
    router.refresh();
  }

  function showError(message: string): void {
    setError(message);
    setAttempt((n) => n + 1);
  }

  function handleFailure(failure: LinkFormFailure): void {
    switch (failure.kind) {
      case 'unauthenticated':
        router.replace(signInAfterExpiryUrl(listPath));
        break;
      case 'not_found':
        showError(LINK_EDIT_MESSAGES.gone);
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

  function openConfirm(): void {
    setConfirming(true);
    setFocusMove({ target: 'confirm-button' });
  }

  /**
   * ONCE CONFIRM HAS SENT THE DELETE, CANCEL IS NOT A CHOICE ANY MORE.
   *
   * The request is already on its way and its success branch announces and navigates, so a
   * Cancel that merely closed the question and moved focus back would read as "the link was
   * kept" while the link was being destroyed. There is nothing to race here and nothing
   * honest to undo: this guards on the SAME `inFlight` ref Confirm guards on, and the
   * control renders `aria-disabled` while it is set, so the screen never offers a choice it
   * cannot keep. This is the whole reason the two step confirm exists on an operation that
   * is irreversible and takes the click history with it (D-2-03).
   */
  function closeConfirm(): void {
    if (inFlight.current) {
      return;
    }

    setConfirming(false);
    setFocusMove({ target: 'delete-button' });
  }

  async function handleDeleteConfirmed(): Promise<void> {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;
    setBusy(true);

    let removed: LinkRow;

    try {
      removed = await apiClient(deleteLinkRequest(link.id));
    } catch (caught: unknown) {
      inFlight.current = false;
      setBusy(false);

      const failure = classifyLinkFormError(caught);

      if (failure.kind !== 'aborted') {
        setConfirming(false);
        setFocusMove({ target: 'delete-button' });
        handleFailure(failure);
      }

      return;
    }

    inFlight.current = false;
    setBusy(false);
    setConfirming(false);
    setError(null);
    announce(LINK_SCREEN_MESSAGES.deleted(removed.slug));
    setFocusMove({ target: 'status' });
    backToList();
  }

  function handleConfirmKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeConfirm();
    }
  }

  const canManage = canManageLinks(workspace.workspaceRole);
  const url = composeShortUrl(link.slug, shortLinkOrigin);
  const state = linkWindowState(link, now);
  const errorId = `${idBase}-error`;
  const confirmId = `${idBase}-delete-confirm`;
  const confirmLabelId = `${confirmId}-label`;

  return (
    <div className="links link-edit">
      <p className="invitations-back">
        <Link href={listPath}>{LINK_SCREEN_MESSAGES.backToLinks}</Link>
      </p>

      <p ref={statusRef} role="status" aria-live="polite" tabIndex={-1} className="workspaces-status">
        <span key={status.nonce}>{status.message}</span>
      </p>

      {error === null ? null : (
        <div key={attempt} className="workspaces-error">
          <p id={errorId} ref={alertRef} role="alert" tabIndex={-1} className="form-error">
            {error}
          </p>
        </div>
      )}

      <section className="link-summary" aria-label={LINK_EDIT_MESSAGES.shortUrlHeading}>
        <p className="link-short-url">
          {/* Selectable text, in full. Never `undefined/<slug>`: the origin is validated on
              the server and a URL that still cannot be composed shows the slug alone. */}
          <code>{url ?? link.slug}</code>
          <span className="link-state" data-state={state}>
            {LINK_SCREEN_MESSAGES.windowStates[state]}
          </span>
        </p>
        <p className="link-times">
          Created <time dateTime={link.createdAt} suppressHydrationWarning>{formatInstant(link.createdAt)}</time>
        </p>
      </section>

      {canManage ? (
        <>
          <LinkForm
            mode={{ kind: 'edit', link }}
            onSaved={(saved) => {
              setError(null);
              announce(LINK_SCREEN_MESSAGES.updated(saved.slug));
              backToList();
            }}
            onFailure={handleFailure}
          />

          <div className="link-row-actions">
            <button
              ref={deleteButtonRef}
              type="button"
              className="secondary"
              aria-expanded={confirming}
              aria-controls={confirmId}
              onClick={confirming ? closeConfirm : openConfirm}
            >
              {LINK_EDIT_MESSAGES.delete} <span className="visually-hidden">{link.slug}</span>
            </button>
          </div>

          {confirming ? (
            <div id={confirmId} className="link-delete-confirm" role="group" aria-labelledby={confirmLabelId} aria-busy={busy}>
              <p id={confirmLabelId} className="link-delete-question">
                {LINK_EDIT_MESSAGES.deleteQuestion(link.slug)}
              </p>
              <div className="link-row-actions">
                <button
                  ref={confirmButtonRef}
                  type="button"
                  aria-disabled={busy}
                  onClick={() => {
                    void handleDeleteConfirmed();
                  }}
                  onKeyDown={handleConfirmKeyDown}
                >
                  {busy ? LINK_EDIT_MESSAGES.deleting : LINK_EDIT_MESSAGES.confirm}{' '}
                  <span className="visually-hidden">deleting {link.slug}</span>
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-disabled={busy}
                  onClick={closeConfirm}
                  onKeyDown={handleConfirmKeyDown}
                >
                  {LINK_EDIT_MESSAGES.cancel} <span className="visually-hidden">deleting {link.slug}</span>
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="links-note">{LINK_SCREEN_MESSAGES.readOnly}</p>
          <p className="link-destination" title={link.destinationUrl}>
            Destination: {link.destinationUrl}
          </p>
        </>
      )}
    </div>
  );
}
