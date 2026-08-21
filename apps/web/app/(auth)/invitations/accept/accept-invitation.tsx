'use client';

/**
 * TASK-1b-13 (STORY-1b-02 AC-1b-12; STORY-1b-03 AC-1b-16). The client half of
 * `/invitations/accept`: reads the token from the URL fragment, previews the invitation
 * through the one `@Public()` lookup, and drives either signup-with-token (no account) or
 * accept (signed in).
 *
 * Contract: docs/contracts/invitation-tokens.md (D-03: fragment + body; the preview shape;
 *   the states and their codes), docs/contracts/web-api-client.md (`apiClient`, `ApiError`),
 *   docs/contracts/error-envelope.md (copy keyed by `code`).
 * ADR: adr-0021 (the link is the capability; D-01: not bound to the invited address),
 *   adr-0015 (tenant conflict copy), adr-0061 (signup does not sign in; the invited signup
 *   lands on sign-in with `?created=1` and comes back here), adr-0029 (no caller value in an
 *   error string).
 * Consumes: TASK-1b-12's builders (`lookupInvitationRequest`, `acceptInvitationRequest`),
 *   token helpers, `classifyInvitationError`, the shared copy in `INVITATION_MESSAGES`;
 *   `SignupForm.{invitationToken,successPath}`; `useSession`.
 *
 * ============================================================================
 * DESIGN, RECORDED.
 * ============================================================================
 *
 * 1. CLIENT COMPONENT UNDER A THIN SERVER PAGE. It needs `location.hash` and
 *    `sessionStorage`; neither exists on the server, and the token MUST NOT reach one (D-03,
 *    GC-K). No `requireAuth`: a stranger with no account is the main visitor.
 *
 * 2. THE TOKEN, ON MOUNT. `invitationTokenFromHash(location.hash)` (the fragment is what
 *    the email link carries) else `readStoredInvitationToken()`, what a previous visit in
 *    this tab left for the sign-in round-trip. A fragment token is stored
 *    (`storeInvitationToken`) and the fragment is stripped from the address bar with
 *    `history.replaceState(null, '', location.pathname)` before anything else happens, so it
 *    is not re-shared from the bar, not in the replaced history entry, and not in a
 *    screenshot. A fragment that NAMES a token but carries a malformed one is the not-found
 *    copy with no request (the API would answer the same 404; one hop earlier). No token
 *    anywhere → the "this link is incomplete" state, no request.
 *
 * 3. THE TOKEN, IN FLIGHT. It appears in exactly three request BODIES: `POST
 *    /api/bff/invitations/lookup { token }`, `POST /api/bff/invitations/accept { token }`,
 *    and `POST /api/bff/auth/sign-up/email { ..., invitationToken }` (through `SignupForm`).
 *    Never a URL, a `params` value, a `router.replace` argument, an `href`, a log line, or a
 *    rendered string. Every URL this file navigates to is a constant that carries no token;
 *    the spec sweeps the document URL, every fetch URL, every `href` and the rendered text.
 *
 * 4. THE TOKEN, AT REST. `sessionStorage` (per tab, gone with the tab) is what survives the
 *    sign-in round-trip: an invitee with an EXISTING account follows "Sign in" with
 *    `returnTo=/invitations/accept`, and this page re-reads the token on the way back
 *    (D-04, D-14). It is CLEARED on a terminal token outcome: accept succeeded, the
 *    invited signup succeeded (the API's hook accepted on user creation, D-18: the token is
 *    spent), or the API said not_found / expired / revoked / already_accepted, so a dead
 *    token does not outlive its usefulness in the tab. It is KEPT on tenant_conflict (the
 *    token is still valid; the person may sign in as another account and re-open the link),
 *    on 429 and on a transport failure (retry), and on 401 (the sign-in round-trip needs it).
 *
 * 5. WHO IS SIGNED IN. `useSession()`: the non-sensitive `{ user, status }` projection from
 *    `GET /api/bff/session`; the first consumer of that hook. `unauthenticated` → the
 *    signup form with the token attached and `successPath = SIGN_IN_AFTER_INVITED_SIGNUP_URL`
 *    (`/sign-in?created=1`, no `returnTo`: see 6), plus "Already have an account? Sign in"
 *    to `/sign-in?returnTo=/invitations/accept`: THAT path is for an existing member, who
 *    does come back through this page to press Accept. `authenticated` → an "Accept
 *    invitation" button. The link is the capability (D-01): no address is compared here or
 *    on the API; the invited address is shown as context. The session projection is DISPLAY
 *    CONTEXT: the API decides on the accept leg.
 *
 * 6. THE INVITED SIGNUP LEG IS `SignupForm`'s, AND IT ENDS THE JOURNEY. It posts
 *    `invitationToken` in the body; the API's signup hook accepts the invitation in the
 *    same transaction that creates the user (D-18), so by the time the BFF answers 2xx the
 *    token is spent. `SignupForm.onSuccess` (this page passes `clearStoredInvitationToken`)
 *    runs first, then the form replaces to `/sign-in?created=1`; sign-in's default landing
 *    is `/workspaces`. Sending the new account back here would only meet 409
 *    already_accepted (ruled 2026-08-18). An address that already has an account gets
 *    ADR-0061's synthetic 200 and no hook fires (D-04): the invitation stays pending and
 *    the copy under the form says to sign in instead.
 *
 * 7. FAILURES, BY `code`, NEVER BY STATUS (`classifyInvitationError`). Lookup: a terminal
 *    code replaces everything with its sentence; 429 / transport show the sentence and a
 *    "Try again" control that re-runs the lookup with the same token. Accept: 401 →
 *    `router.replace('/sign-in?returnTo=/invitations/accept')` (session ended mid-flow;
 *    token kept); 429 / transport / 400 → the sentence above the button, preview and button
 *    kept (the form-state-preserved rule); any terminal code (including 409
 *    tenant_conflict, ADR-0015's sentence, no address named) replaces the preview with its
 *    sentence. Success: clear storage, `router.replace('/workspaces')`.
 *
 * 8. THE COPY comes from `INVITATION_MESSAGES` (TASK-1b-12) through
 *    `messageForInvitationFailure`, rendered in this file's own alert element rather than
 *    `<InvitationStateMessage>`: the shared component exposes neither a ref nor a
 *    `tabIndex`, and this page moves focus to the message when it appears (the sibling
 *    screens' rule). Same string, same `data-invitation-state` attribute; the spec checks
 *    both against the shared constants.
 *
 * 9. ACCESSIBILITY as the sibling screens: the page's `h1` is the server page's; one polite
 *    `role="status"` live region that is always mounted (so a change is announced) carries
 *    "checking" and "accepted"; failures are `role="alert"`, `tabIndex={-1}`, focused when
 *    they appear, re-mounted per attempt so a repeat is announced again; the preview is a
 *    labelled region whose heading takes focus when it arrives; the Accept control is
 *    `aria-disabled` (not `disabled`) while in flight, with a ref as the real guard.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { InvitationPreview, WorkspaceRoleValue } from '@shortkit/contracts';

import {
  INVITATION_ACCEPT_ROUTE,
  RETURN_TO_PARAM,
  SIGN_IN_AFTER_INVITED_SIGNUP_URL,
  SIGN_IN_ROUTE,
  WORKSPACES_ROUTE,
} from '../../../../src/components/auth/routes';
import { SignupForm } from '../../../../src/components/auth/signup-form';
import { messageForInvitationFailure } from '../../../../src/components/invitations/invitation-state-message';
import {
  INVITATION_TOKEN_FRAGMENT_KEY,
  acceptInvitationRequest,
  classifyInvitationError,
  clearStoredInvitationToken,
  invitationTokenFromHash,
  lookupInvitationRequest,
  readStoredInvitationToken,
  storeInvitationToken,
} from '../../../../src/components/invitations/invitations-api';
import type { InvitationFailure } from '../../../../src/components/invitations/invitations-api';
import { apiClient } from '../../../../src/lib/api/client';
import { useSession } from '../../../../src/lib/session/use-session';

/**
 * Where "Sign in" goes from this page, and where a 401 mid-accept sends the visitor: back
 * here after sign-in, so the stored token is re-read (design point 4). A same-origin path,
 * which is what `successPathFrom` admits. No token in it, ever.
 */
export const SIGN_IN_TO_ACCEPT_URL = `${SIGN_IN_ROUTE}?${RETURN_TO_PARAM}=${INVITATION_ACCEPT_ROUTE}`;

/** This page's own copy; the per-code sentences are `INVITATION_MESSAGES` (TASK-1b-12). */
export const ACCEPT_PAGE_MESSAGES = {
  checking: 'Checking your invitation…',
  missing:
    'This link is missing its invitation. Open the link from your email again, or ask the person who invited you to send a new one.',
  accepted: 'Invitation accepted. Taking you to your workspaces…',
  createLede: 'Create an account to accept this invitation. If your address already has one, sign in instead.',
  signedInAs: (email: string): string => `You are signed in as ${email}.`,
} as const;

const ROLE_LABELS: Record<WorkspaceRoleValue, string> = {
  workspace_admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

type Phase =
  /** Before the mount effect ran, and through the first lookup: the same status line as 'looking-up'. */
  | { kind: 'reading' }
  /** No fragment token, nothing stored. */
  | { kind: 'missing' }
  /** A "Try again" retry in flight; set by its click handler, so the lookup effect never sets state synchronously. */
  | { kind: 'looking-up' }
  /** `now` is the clock read when the preview arrived; the relative expiry is computed against it, keeping render pure. */
  | { kind: 'preview'; preview: InvitationPreview; now: number }
  /** A failure that replaced the preview (or that the lookup produced). */
  | { kind: 'failed'; failure: InvitationFailure }
  | { kind: 'accepted' };

/**
 * A code that says the token will never work again (or never did): the stored copy is
 * cleared. `tenant_conflict` is deliberately absent: the token is still live for another
 * account (design point 4).
 */
function isDeadTokenFailure(failure: InvitationFailure): boolean {
  return (
    failure.kind === 'not_found' ||
    failure.kind === 'expired' ||
    failure.kind === 'revoked' ||
    failure.kind === 'already_accepted'
  );
}

/** A failure the visitor can simply retry, with the same token and the same state on screen. */
function isRetryableFailure(failure: InvitationFailure): boolean {
  return failure.kind === 'rate_limited' || failure.kind === 'unknown' || failure.kind === 'validation';
}

/** Whether the fragment names a `token` key at all (well-formed or not). */
function hashNamesToken(hash: string): boolean {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;

  if (raw === '') {
    return false;
  }

  const value = new URLSearchParams(raw).get(INVITATION_TOKEN_FRAGMENT_KEY);

  return value !== null && value !== '';
}

/** "in 6 days" / "in 3 hours" / "in less than an hour" / "very soon": the relative half of the expiry line. */
export function relativeExpiry(expiresAt: string, now: number): string {
  const remaining = Date.parse(expiresAt) - now;

  if (!Number.isFinite(remaining) || remaining <= 0) {
    return 'very soon';
  }

  const hours = Math.floor(remaining / 3_600_000);
  const days = Math.floor(hours / 24);

  if (days >= 1) {
    return `in ${String(days)} ${days === 1 ? 'day' : 'days'}`;
  }

  if (hours >= 1) {
    return `in ${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
  }

  return 'in less than an hour';
}

function absoluteExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);

  if (Number.isNaN(date.getTime())) {
    return expiresAt;
  }

  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function AcceptInvitation(): ReactElement {
  const router = useRouter();
  const session = useSession();
  const idBase = useId();
  const alertRef = useRef<HTMLParagraphElement>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  // The Accept control is `aria-disabled`, not `disabled`; this ref is its guard.
  const acceptInFlight = useRef(false);

  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'reading' });
  // Bumped by "Try again" so the lookup effect runs again with the same token.
  const [lookupAttempt, setLookupAttempt] = useState(0);
  // A non-terminal accept failure: shown above the button while the preview stays.
  const [acceptError, setAcceptError] = useState<InvitationFailure | null>(null);
  const [accepting, setAccepting] = useState(false);
  // Bumped per failure so an identical alert re-mounts and is announced again.
  const [attempt, setAttempt] = useState(0);

  // Design point 2: the token, on mount. Runs once; the fragment is gone by the time it
  // returns. (Under StrictMode's double-invoke the second run finds an empty hash and the
  // stored token, and lands in the same state.)
  //
  // `set-state-in-effect` is off for this one effect: it is a one-shot read of client-only
  // state, the fragment, `history`, `sessionStorage` (design point 2), and setState is how
  // that one-time answer enters React. There is no render-time source for any of it: the
  // fragment must be read AND ERASED after mount, on the client, exactly once.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot client-only init from location.hash/sessionStorage; no render-time source exists */
  useEffect(() => {
    const hash = window.location.hash;
    const named = hashNamesToken(hash);
    const fromHash = invitationTokenFromHash(hash);

    if (named) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    if (fromHash !== null) {
      storeInvitationToken(fromHash);
      setToken(fromHash);

      return;
    }

    if (named) {
      // A `token=` that is not token-shaped: the same 404 the API would give, without the request.
      setPhase({ kind: 'failed', failure: { kind: 'not_found' } });
      setAttempt((n) => n + 1);

      return;
    }

    const stored = readStoredInvitationToken();

    if (stored !== null) {
      setToken(stored);

      return;
    }

    setPhase({ kind: 'missing' });
    setAttempt((n) => n + 1);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Design point 7, the lookup leg. Aborted on unmount so a late answer never sets state.
  useEffect(() => {
    if (token === null) {
      return;
    }

    const controller = new AbortController();

    void (async () => {
      try {
        const preview = await apiClient({ ...lookupInvitationRequest(token), signal: controller.signal });

        if (!controller.signal.aborted) {
          setPhase({ kind: 'preview', preview, now: Date.now() });
        }
      } catch (caught: unknown) {
        const failure = classifyInvitationError(caught);

        if (failure.kind === 'aborted' || controller.signal.aborted) {
          return;
        }

        if (isDeadTokenFailure(failure)) {
          clearStoredInvitationToken();
        }

        setPhase({ kind: 'failed', failure });
        setAttempt((n) => n + 1);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [token, lookupAttempt]);

  // Focus follows the state (design point 9): a failure lands on its alert; the preview
  // lands on its heading, so a keyboard or screen-reader user is moved to what changed.
  useEffect(() => {
    if (phase.kind === 'failed' || phase.kind === 'missing' || acceptError !== null) {
      alertRef.current?.focus();

      return;
    }

    if (phase.kind === 'preview') {
      previewHeadingRef.current?.focus();
    }
  }, [phase, acceptError, attempt]);

  async function handleAccept(): Promise<void> {
    if (acceptInFlight.current || token === null) {
      return;
    }

    acceptInFlight.current = true;
    setAccepting(true);
    setAcceptError(null);

    try {
      await apiClient(acceptInvitationRequest(token));
    } catch (caught: unknown) {
      acceptInFlight.current = false;
      setAccepting(false);

      const failure = classifyInvitationError(caught);

      if (failure.kind === 'aborted') {
        return;
      }

      if (failure.kind === 'unauthenticated') {
        // The session ended mid-flow. The token stays stored for the way back.
        router.replace(SIGN_IN_TO_ACCEPT_URL);

        return;
      }

      setAttempt((n) => n + 1);

      if (isRetryableFailure(failure)) {
        setAcceptError(failure);

        return;
      }

      if (isDeadTokenFailure(failure)) {
        clearStoredInvitationToken();
      }

      setPhase({ kind: 'failed', failure });

      return;
    }

    // `accepting` stays true on success so the control cannot fire again while navigating.
    clearStoredInvitationToken();
    setPhase({ kind: 'accepted' });
    router.replace(WORKSPACES_ROUTE);
  }

  const busy = phase.kind === 'reading' || phase.kind === 'looking-up' || (phase.kind === 'preview' && session.status === 'loading');
  const statusText = busy ? ACCEPT_PAGE_MESSAGES.checking : phase.kind === 'accepted' ? ACCEPT_PAGE_MESSAGES.accepted : '';
  const previewHeadingId = `${idBase}-preview-heading`;
  const workspacesLabelId = `${idBase}-workspaces-label`;
  const alertId = `${idBase}-alert`;

  return (
    <div className="invitation-accept-body">
      <p role="status" aria-live="polite" className="invitation-status">
        {statusText}
      </p>

      {phase.kind === 'missing' ? (
        <p key={attempt} ref={alertRef} role="alert" tabIndex={-1} className="form-error" data-invitation-state="missing">
          {ACCEPT_PAGE_MESSAGES.missing}
        </p>
      ) : null}

      {phase.kind === 'failed' ? (
        <div key={attempt} className="invitation-failed">
          <p id={alertId} ref={alertRef} role="alert" tabIndex={-1} className="form-error" data-invitation-state={phase.failure.kind}>
            {messageForInvitationFailure(phase.failure)}
          </p>
          {phase.failure.kind === 'already_accepted' ? (
            <p className="auth-switch">
              <Link href={SIGN_IN_ROUTE}>Sign in</Link> to reach your workspaces.
            </p>
          ) : null}
          {token !== null && isRetryableFailure(phase.failure) ? (
            <button
              type="button"
              className="secondary"
              aria-describedby={alertId}
              onClick={() => {
                setPhase({ kind: 'looking-up' });
                setLookupAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      {phase.kind === 'preview' ? (
        <>
          <section className="invitation-preview" aria-labelledby={previewHeadingId}>
            <h2 id={previewHeadingId} ref={previewHeadingRef} tabIndex={-1}>
              {phase.preview.inviterEmail} invited you to join <strong>{phase.preview.tenantName}</strong>
            </h2>
            <p className="invitation-meta">Sent to {phase.preview.email}.</p>
            <p id={workspacesLabelId} className="invitation-meta">
              You will join:
            </p>
            <ul className="invitation-workspaces" aria-labelledby={workspacesLabelId}>
              {phase.preview.workspaces.map((workspace) => (
                <li key={`${workspace.workspaceName}:${workspace.workspaceRole}`}>
                  <span className="workspace-name">{workspace.workspaceName}</span>{' '}
                  <span className="workspace-badge">{ROLE_LABELS[workspace.workspaceRole]}</span>
                </li>
              ))}
            </ul>
            <p className="invitation-meta">
              This invitation expires <time dateTime={phase.preview.expiresAt}>{absoluteExpiry(phase.preview.expiresAt)}</time>{' '}
              ({relativeExpiry(phase.preview.expiresAt, phase.now)}).
            </p>
          </section>

          {session.status === 'unauthenticated' && token !== null ? (
            <section className="invitation-create" aria-label="Create your account">
              <p className="auth-lede">{ACCEPT_PAGE_MESSAGES.createLede}</p>
              <SignupForm
                invitationToken={token}
                successPath={SIGN_IN_AFTER_INVITED_SIGNUP_URL}
                onSuccess={clearStoredInvitationToken}
              />
              <p className="auth-switch">
                Already have an account? <Link href={SIGN_IN_TO_ACCEPT_URL}>Sign in</Link> to accept.
              </p>
            </section>
          ) : null}

          {session.status === 'authenticated' && session.user !== null ? (
            <section className="invitation-accept-action" aria-label="Accept the invitation">
              {acceptError === null ? null : (
                <p key={attempt} id={alertId} ref={alertRef} role="alert" tabIndex={-1} className="form-error" data-invitation-state={acceptError.kind}>
                  {messageForInvitationFailure(acceptError)}
                </p>
              )}
              <p className="invitation-meta">{ACCEPT_PAGE_MESSAGES.signedInAs(session.user.email)}</p>
              <button
                type="button"
                className="invitation-accept-button"
                aria-disabled={accepting}
                aria-describedby={acceptError === null ? undefined : alertId}
                onClick={() => {
                  void handleAccept();
                }}
              >
                {accepting ? 'Accepting…' : 'Accept invitation'}
              </button>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
