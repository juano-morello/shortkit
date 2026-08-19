'use client';

/**
 * TASK-013 (STORY-004, AC-22, AC-23 as the screen sees them). One workspace in the list:
 * its name, an "Archived" text badge when it is archived, and — for an active workspace —
 * the inline rename control and the archive control.
 *
 * Contract: docs/contracts/workspaces.md ("Endpoints": `PATCH /api/workspaces/:id`,
 *   `POST /api/workspaces/:id/archive`, 404 `not_found` for a stale/foreign/malformed id).
 *
 * RENAME IS INLINE. "Rename <name>" is a disclosure button (`aria-expanded`, `aria-controls`
 * the form; it stays rendered while the form is open, so the state is announced) and
 * reveals a small form prefilled with the current name; Enter or Save sends the PATCH,
 * Escape or Cancel closes it. Focus goes to the field when it opens and back to the
 * Rename button when it closes, whichever way it closed. The field is labelled "New name for
 * <name>", so a screen reader hears which workspace it is renaming. A failed save moves
 * focus to the field every time, including a second identical failure (`attempt`).
 *
 * ARCHIVE IS A TWO-STEP INLINE CONFIRM (the architect's ruling). There is no unarchive route
 * in this initiative (workspaces.md, "Route policy on archived workspaces"), so a mis-click
 * would be permanent: "Archive <name>" only reveals "Archive <name>? [Confirm] [Cancel]" in
 * the row, with focus on Confirm; only Confirm sends the POST; Escape or Cancel closes it
 * and returns focus to the Archive button. The API call itself is idempotent.
 *
 * An archived row shows the badge and NO rename or archive controls: the API allows renaming
 * an archived workspace, but the screen keeps the archived row read-only — there is nothing
 * to do with an archived client here yet, and a control on a row that reads "Archived" is
 * an invitation to confusion. That is a screen decision, not a contract one.
 *
 * The row owns its two requests and the field-level rename message; the list owns what
 * happens next (`onChanged` re-fetches and announces; `onFailure` handles `not_found`, the
 * session expiry and the generic message).
 *
 * THE "INVITE" LINK (TASK-1b-14, AC-1b-29: "`/workspaces` shows the link only on rows with
 * `workspaceRole: 'workspace_admin'`"). An active row the caller administers links to
 * `/workspaces/<id>/invitations` (`INVITATIONS_ROUTE`), named "Invite to <name>". A member
 * or viewer, a row whose `workspaceRole` the API did not send (the field is additive and
 * optional on the contract until TASK-1b-06's `.optional()` is removed), and an archived
 * row get no link: the API answers 403 to a member and 400 to an invite on an archived
 * workspace, and the row does not offer what would be refused. HIDING IS NOT ENFORCEMENT —
 * the API is (workspace-authorization.md, "Minimum role per surface"). Rename and archive
 * are left as they were (shown on every active row; the API refuses a non-admin with 403).
 *
 * THE "LINKS" LINK (TASK-2-14, D-2-18: "Row on `/workspaces` links to it for any
 * membership; viewer sees the list"). It sits BESIDE the Invite link and is gated
 * differently on purpose: `GET /api/links?workspaceId=` is `viewer`, and every row in this
 * list is a workspace the caller belongs to, which is what the list returns, so the link
 * always leads somewhere useful and the links screen itself decides whether to render a
 * form. It is first in the row's actions because it is the daily one.
 *
 * An ARCHIVED row still gets no link, which is this component's existing rule rather than a
 * new one (the archived row is read-only, and the whole action block below is inside that
 * branch). The cost is stated rather than hidden: an archived workspace's links keep
 * redirecting (D-2-12) and its screen is still reachable at `/workspaces/<id>/links` by
 * URL, so nothing becomes unmanageable. The shortcut saves one navigation, for active rows.
 */
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';

import { WORKSPACE_NAME_MAX_LENGTH } from '@shortkit/contracts';
import type { Workspace } from '@shortkit/contracts';

import { apiClient } from '../../lib/api/client';
import { LINKS_ROUTE } from '../../lib/links/links-api';
import { INVITATIONS_ROUTE } from '../invitations/invitations-api';
import {
  WORKSPACE_MESSAGES,
  archiveWorkspaceRequest,
  classifyWorkspaceError,
  parseWorkspaceName,
  renameWorkspaceRequest,
} from './workspaces-api';
import type { WorkspaceFailure } from './workspaces-api';

export type WorkspaceChange = { kind: 'renamed'; workspace: Workspace } | { kind: 'archived'; workspace: Workspace };

export interface WorkspaceRowProps {
  workspace: Workspace;
  /** After the API answered 200: the list re-fetches and announces. */
  onChanged: (change: WorkspaceChange) => void | Promise<void>;
  /** Failures the row does not render itself: `not_found`, `unauthenticated`, `generic`. */
  onFailure: (failure: WorkspaceFailure) => void;
}

type RowMode = 'idle' | 'renaming' | 'confirming-archive';
type FocusTarget = 'rename-input' | 'rename-button' | 'archive-button' | 'confirm-button';

export function WorkspaceRow({ workspace, onChanged, onFailure }: WorkspaceRowProps): ReactElement {
  const idBase = useId();
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const archiveButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);

  const [mode, setMode] = useState<RowMode>('idle');
  const [draft, setDraft] = useState(workspace.name);
  const [fieldError, setFieldError] = useState<string | null>(null);
  // Bumped per failed rename attempt so an identical failure still moves focus to the field.
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<'rename' | 'archive' | null>(null);
  // Focus is moved in an effect, once the target is actually mounted. Each request is
  // a fresh object, so asking for the same target twice still re-runs the effect and
  // the effect never has to reset the state it depends on (react-hooks/set-state-in-effect).
  const [focusMove, setFocusMove] = useState<{ target: FocusTarget } | null>(null);

  useEffect(() => {
    switch (focusMove?.target) {
      case 'rename-input':
        inputRef.current?.focus();
        inputRef.current?.select();
        break;
      case 'rename-button':
        renameButtonRef.current?.focus();
        break;
      case 'archive-button':
        archiveButtonRef.current?.focus();
        break;
      case 'confirm-button':
        confirmButtonRef.current?.focus();
        break;
      case undefined:
        break;
    }
  }, [focusMove]);

  useEffect(() => {
    if (fieldError !== null) {
      inputRef.current?.focus();
    }
  }, [fieldError, attempt]);

  function openRename(): void {
    setDraft(workspace.name);
    setFieldError(null);
    setMode('renaming');
    setFocusMove({ target: 'rename-input' });
  }

  function closeRename(): void {
    setMode('idle');
    setFieldError(null);
    setFocusMove({ target: 'rename-button' });
  }

  function openArchiveConfirm(): void {
    setMode('confirming-archive');
    setFocusMove({ target: 'confirm-button' });
  }

  function closeArchiveConfirm(): void {
    setMode('idle');
    setFocusMove({ target: 'archive-button' });
  }

  async function handleRename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (inFlight.current) {
      return;
    }

    setFieldError(null);

    const body = parseWorkspaceName(draft, 'rename');

    if (body === null) {
      setFieldError(WORKSPACE_MESSAGES.nameRule);
      setAttempt((n) => n + 1);

      return;
    }

    inFlight.current = true;
    setBusy('rename');

    let renamed: Workspace;

    try {
      renamed = await apiClient(renameWorkspaceRequest(workspace.id, body));
    } catch (error: unknown) {
      inFlight.current = false;
      setBusy(null);
      setAttempt((n) => n + 1);

      const failure = classifyWorkspaceError(error);

      switch (failure.kind) {
        case 'field':
          setFieldError(failure.message);
          break;
        case 'validation':
          setFieldError(WORKSPACE_MESSAGES.validationFailed);
          break;
        case 'aborted':
          break;
        case 'not_found':
        case 'unauthenticated':
        case 'generic':
          onFailure(failure);
          break;
      }

      return;
    }

    inFlight.current = false;
    setBusy(null);
    setMode('idle');
    setFocusMove({ target: 'rename-button' });

    await onChanged({ kind: 'renamed', workspace: renamed });
  }

  async function handleArchiveConfirmed(): Promise<void> {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;
    setBusy('archive');

    let archived: Workspace;

    try {
      archived = await apiClient(archiveWorkspaceRequest(workspace.id));
    } catch (error: unknown) {
      inFlight.current = false;
      setBusy(null);

      const failure = classifyWorkspaceError(error);

      if (failure.kind !== 'aborted') {
        // The row stays as it was; the confirm closes and the list shows the message.
        setMode('idle');
        setFocusMove({ target: 'archive-button' });
        onFailure(failure);
      }

      return;
    }

    inFlight.current = false;
    setBusy(null);
    setMode('idle');

    await onChanged({ kind: 'archived', workspace: archived });
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeRename();
    }
  }

  function handleConfirmKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeArchiveConfirm();
    }
  }

  const isArchived = workspace.archivedAt !== null;
  const canInvite = !isArchived && workspace.workspaceRole === 'workspace_admin';
  const renameFormId = `${idBase}-rename-form`;
  const inputId = `${idBase}-rename`;
  const errorId = `${inputId}-error`;
  const confirmId = `${idBase}-archive-confirm`;
  const confirmLabelId = `${confirmId}-label`;

  return (
    <li className="workspace-row" data-workspace-id={workspace.id}>
      <div className="workspace-row-main">
        <span className="workspace-name">{workspace.name}</span>
        {isArchived ? <span className="workspace-badge">Archived</span> : null}
      </div>

      {isArchived ? null : (
        <>
          <div className="workspace-row-actions">
            <Link className="workspace-row-link" href={LINKS_ROUTE(workspace.id)}>
              Links <span className="visually-hidden">in {workspace.name}</span>
            </Link>
            {canInvite ? (
              <Link className="workspace-row-link" href={INVITATIONS_ROUTE(workspace.id)}>
                Invite <span className="visually-hidden">to {workspace.name}</span>
              </Link>
            ) : null}
            <button
              ref={renameButtonRef}
              type="button"
              className="secondary"
              aria-expanded={mode === 'renaming'}
              aria-controls={renameFormId}
              onClick={mode === 'renaming' ? closeRename : openRename}
            >
              Rename <span className="visually-hidden">{workspace.name}</span>
            </button>
            <button
              ref={archiveButtonRef}
              type="button"
              className="secondary"
              aria-expanded={mode === 'confirming-archive'}
              aria-controls={confirmId}
              onClick={mode === 'confirming-archive' ? closeArchiveConfirm : openArchiveConfirm}
            >
              Archive <span className="visually-hidden">{workspace.name}</span>
            </button>
          </div>

          {mode === 'renaming' ? (
            <form
              id={renameFormId}
              className="workspace-rename"
              method="post"
              noValidate
              aria-busy={busy === 'rename'}
              onSubmit={(event) => {
                void handleRename(event);
              }}
            >
              <div className="field">
                <label htmlFor={inputId}>New name for {workspace.name}</label>
                <input
                  ref={inputRef}
                  id={inputId}
                  name="name"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  maxLength={WORKSPACE_NAME_MAX_LENGTH}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.currentTarget.value);
                  }}
                  onKeyDown={handleRenameKeyDown}
                  aria-invalid={fieldError === null ? undefined : true}
                  aria-describedby={fieldError === null ? undefined : errorId}
                />
                {fieldError === null ? null : (
                  <p id={errorId} className="field-error">
                    {fieldError}
                  </p>
                )}
              </div>
              <div className="workspace-row-actions">
                <button type="submit" aria-disabled={busy === 'rename'}>
                  {busy === 'rename' ? 'Saving…' : 'Save'}
                </button>
                <button type="button" className="secondary" onClick={closeRename}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {mode === 'confirming-archive' ? (
            <div
              id={confirmId}
              className="workspace-archive-confirm"
              role="group"
              aria-labelledby={confirmLabelId}
              aria-busy={busy === 'archive'}
            >
              <p id={confirmLabelId} className="workspace-archive-question">
                Archive {workspace.name}? This cannot be undone here.
              </p>
              <div className="workspace-row-actions">
                <button
                  ref={confirmButtonRef}
                  type="button"
                  aria-disabled={busy === 'archive'}
                  onClick={() => {
                    void handleArchiveConfirmed();
                  }}
                  onKeyDown={handleConfirmKeyDown}
                >
                  {busy === 'archive' ? 'Archiving…' : 'Confirm'}{' '}
                  <span className="visually-hidden">archiving {workspace.name}</span>
                </button>
                <button type="button" className="secondary" onClick={closeArchiveConfirm} onKeyDown={handleConfirmKeyDown}>
                  Cancel <span className="visually-hidden">archiving {workspace.name}</span>
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}
