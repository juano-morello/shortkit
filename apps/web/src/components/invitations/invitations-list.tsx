'use client';

/**
 * TASK-1b-14 (STORY-1b-05, AC-1b-29: "it lists the invitations from AC-1b-23 with state
 * badges and a Revoke control per pending row"). The list half of the per-workspace
 * invitations screen: one row per invitation — address, the role for THIS workspace, a
 * state badge, created and expiry times — and the two-step revoke.
 *
 * Contract: docs/contracts/invitation-tokens.md (states: `pending | accepted | revoked`
 *   written; `expired` derived), docs/contracts/workspace-authorization.md
 *   (`DELETE /api/invitations/:id`: `workspace_admin` on every workspace the invitation
 *   names — 404 unknown/other-tenant, 409 `invitation_already_accepted`, 200 idempotent on
 *   an already-revoked row, D-09), docs/contracts/error-envelope.md.
 * Consumes: TASK-1b-12's `revokeInvitationRequest` and `classifyInvitationScreenError`;
 *   `ROLE_LABELS` from `invite-form.tsx`.
 *
 * "EXPIRED" IS DERIVED HERE, CLIENT-SIDE. 1b never writes `invitation_state = 'expired'`
 * (D-11; the enum value is reserved for a later sweeper): a row past its `expiresAt` still
 * reads `state: 'pending'` from the API and its token answers 410 `invitation_expired`.
 * `displayState` turns a pending row whose `expiresAt` is at or before `now` into
 * `expired` for the badge; every other state — including an API-sent `expired`, should a
 * sweeper land — renders as-is. `now` is a prop so the screen passes one clock per render
 * and a spec pins it.
 *
 * REVOKE IS OFFERED ON DISPLAYED-PENDING ROWS ONLY. An accepted row cannot be revoked
 * (409), a revoked one already is, and a derived-expired one is spent: its token answers
 * 410 already and the API's "revoke anyway" (D-09) would only change a badge that reads
 * Expired into one that reads Revoked. Not offering it keeps the row honest about what
 * a click would do. Hiding is not enforcement — the API is.
 *
 * REVOKE IS A TWO-STEP INLINE CONFIRM, the `workspace-row.tsx` archive shape: there is no
 * un-revoke (ADR-0017: revoke and re-invite), so "Revoke <address>" only reveals "Revoke
 * the invitation for <address>? [Confirm] [Cancel]" in the row, with focus on Confirm;
 * only Confirm sends the DELETE; Escape or Cancel closes it and returns focus to Revoke.
 * The row owns its one request and reports the outcome; the screen re-fetches and
 * announces (`onRevoked`) or renders the failure (`onFailure`) — 404 and 409 mean the row
 * was stale, and the screen re-syncs on both.
 *
 * THIS SCREEN'S WORKSPACE, AND "+N MORE". An invitation may name several workspaces (the
 * API's shape; this screen's form names one). The row shows the role for the workspace
 * the page is on and a "+N more" for the others; the other workspaces' names are not
 * listed here — the caller administers this workspace, and what else the invitation
 * grants is the API's to disclose through their own pages.
 *
 * Every per-row control names its address (visually hidden text) so a screen reader
 * hears which invitation it acts on; the times are `<time>` elements carrying the ISO
 * value with a locale rendering as text.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

import type { Invitation, InvitationStateValue } from '@shortkit/contracts';

import { apiClient } from '../../lib/api/client';
import { ROLE_LABELS } from './invite-form';
import { classifyInvitationScreenError, revokeInvitationRequest } from './invitations-api';
import type { InvitationScreenFailure } from './invitations-api';

export const STATE_LABELS: Record<InvitationStateValue, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  expired: 'Expired',
  revoked: 'Revoked',
};

export const INVITATIONS_LIST_MESSAGES = {
  heading: 'Invitations',
  otherWorkspaces: (count: number): string => `+${String(count)} more`,
} as const;

/** The state the badge shows: `expired` derived for a pending row at or past its `expiresAt`; every other state as-is. */
export function displayState(invitation: Invitation, now: number): InvitationStateValue {
  if (invitation.state === 'pending') {
    const expiresAt = Date.parse(invitation.expiresAt);

    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      return 'expired';
    }
  }

  return invitation.state;
}

/**
 * The row's second timestamp, by displayed state: when a pending row expires, when an
 * expired one did, when an accepted one was accepted, when a revoked one was revoked. The
 * two nullable timestamps are set by the transition that names them; should one be null
 * against its state (a shape the API does not produce), the expiry is shown instead.
 */
function secondInstant(invitation: Invitation, state: InvitationStateValue): ReactElement {
  switch (state) {
    case 'pending':
      return <>Expires <time dateTime={invitation.expiresAt}>{formatInstant(invitation.expiresAt)}</time></>;
    case 'expired':
      return <>Expired <time dateTime={invitation.expiresAt}>{formatInstant(invitation.expiresAt)}</time></>;
    case 'accepted': {
      const at = invitation.acceptedAt ?? invitation.expiresAt;

      return <>Accepted <time dateTime={at}>{formatInstant(at)}</time></>;
    }
    case 'revoked': {
      const at = invitation.revokedAt ?? invitation.expiresAt;

      return <>Revoked <time dateTime={at}>{formatInstant(at)}</time></>;
    }
  }
}

function formatInstant(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export interface InvitationsListProps {
  /** Newest first, as the API sent them; the screen owns the state and re-fetches. */
  items: Invitation[];
  /** The workspace this page is on: the role shown is the grant for this one. */
  workspaceId: string;
  /** The clock `displayState` derives expiry against; one value per render. */
  now: number;
  /** After the API answered 200 to a revoke: the screen re-fetches and announces. */
  onRevoked: (invitation: Invitation) => void | Promise<void>;
  /** Every non-aborted failure of a revoke; the screen renders or navigates. */
  onFailure: (failure: InvitationScreenFailure) => void;
}

export function InvitationsList({ items, workspaceId, now, onRevoked, onFailure }: InvitationsListProps): ReactElement {
  const idBase = useId();
  const headingId = `${idBase}-heading`;

  return (
    <section className="invitations-list" aria-labelledby={headingId}>
      <h2 id={headingId}>{INVITATIONS_LIST_MESSAGES.heading}</h2>
      <ul className="invitation-rows" aria-labelledby={headingId}>
        {items.map((invitation) => (
          <InvitationRow
            key={invitation.id}
            invitation={invitation}
            workspaceId={workspaceId}
            state={displayState(invitation, now)}
            onRevoked={onRevoked}
            onFailure={onFailure}
          />
        ))}
      </ul>
    </section>
  );
}

interface InvitationRowProps {
  invitation: Invitation;
  workspaceId: string;
  state: InvitationStateValue;
  onRevoked: (invitation: Invitation) => void | Promise<void>;
  onFailure: (failure: InvitationScreenFailure) => void;
}

type FocusTarget = 'revoke-button' | 'confirm-button';

function InvitationRow({ invitation, workspaceId, state, onRevoked, onFailure }: InvitationRowProps): ReactElement {
  const idBase = useId();
  const revokeButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Focus is moved in an effect, once the target is actually mounted. Each request is
  // a fresh object, so asking for the same target twice still re-runs the effect and
  // the effect never has to reset the state it depends on (react-hooks/set-state-in-effect).
  const [focusMove, setFocusMove] = useState<{ target: FocusTarget } | null>(null);

  useEffect(() => {
    switch (focusMove?.target) {
      case 'revoke-button':
        revokeButtonRef.current?.focus();
        break;
      case 'confirm-button':
        confirmButtonRef.current?.focus();
        break;
      case undefined:
        break;
    }
  }, [focusMove]);

  function openConfirm(): void {
    setConfirming(true);
    setFocusMove({ target: 'confirm-button' });
  }

  function closeConfirm(): void {
    setConfirming(false);
    setFocusMove({ target: 'revoke-button' });
  }

  async function handleRevokeConfirmed(): Promise<void> {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;
    setBusy(true);

    let revoked: Invitation;

    try {
      revoked = await apiClient(revokeInvitationRequest(invitation.id));
    } catch (error: unknown) {
      inFlight.current = false;
      setBusy(false);

      const failure = classifyInvitationScreenError(error);

      if (failure.kind !== 'aborted') {
        // The row stays as it was; the confirm closes and the screen shows the message.
        setConfirming(false);
        setFocusMove({ target: 'revoke-button' });
        onFailure(failure);
      }

      return;
    }

    inFlight.current = false;
    setBusy(false);
    setConfirming(false);

    await onRevoked(revoked);
  }

  function handleConfirmKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeConfirm();
    }
  }

  const grant = invitation.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
  const otherWorkspaces = invitation.workspaces.length - (grant === undefined ? 0 : 1);
  const confirmId = `${idBase}-revoke-confirm`;
  const confirmLabelId = `${confirmId}-label`;

  return (
    <li className="invitation-row" data-invitation-id={invitation.id}>
      <div className="invitation-row-main">
        <span className="invitation-email">{invitation.email}</span>
        {grant === undefined ? null : <span className="workspace-badge">{ROLE_LABELS[grant.workspaceRole]}</span>}
        {otherWorkspaces > 0 ? (
          <span className="invitation-more">{INVITATIONS_LIST_MESSAGES.otherWorkspaces(otherWorkspaces)}</span>
        ) : null}
        <span className="invitation-state" data-state={state}>
          {STATE_LABELS[state]}
        </span>
      </div>

      <p className="invitation-times">
        Sent <time dateTime={invitation.createdAt}>{formatInstant(invitation.createdAt)}</time>
        {' · '}
        {secondInstant(invitation, state)}
      </p>

      {state !== 'pending' ? null : (
        <>
          <div className="invitation-row-actions">
            <button
              ref={revokeButtonRef}
              type="button"
              className="secondary"
              aria-expanded={confirming}
              aria-controls={confirmId}
              onClick={confirming ? closeConfirm : openConfirm}
            >
              Revoke <span className="visually-hidden">{invitation.email}</span>
            </button>
          </div>

          {confirming ? (
            <div
              id={confirmId}
              className="invitation-revoke-confirm"
              role="group"
              aria-labelledby={confirmLabelId}
              aria-busy={busy}
            >
              <p id={confirmLabelId} className="invitation-revoke-question">
                Revoke the invitation for {invitation.email}? The link in their email stops working.
              </p>
              <div className="invitation-row-actions">
                <button
                  ref={confirmButtonRef}
                  type="button"
                  aria-disabled={busy}
                  onClick={() => {
                    void handleRevokeConfirmed();
                  }}
                  onKeyDown={handleConfirmKeyDown}
                >
                  {busy ? 'Revoking…' : 'Confirm'} <span className="visually-hidden">revoking {invitation.email}</span>
                </button>
                <button type="button" className="secondary" onClick={closeConfirm} onKeyDown={handleConfirmKeyDown}>
                  Cancel <span className="visually-hidden">revoking {invitation.email}</span>
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}
