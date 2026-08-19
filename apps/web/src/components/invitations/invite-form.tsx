'use client';

/**
 * TASK-1b-14 (STORY-1b-05, AC-1b-29: "an invite form (email + role from
 * `INVITABLE_WORKSPACE_ROLES`) that posts `{ email, workspaces: [{ workspaceId: W1,
 * workspaceRole }] }`"). The invite control: one address field, one role picker, one
 * button. It owns the POST and the field-level message; the screen it lives in owns what
 * happens next (the re-fetch, the announcement, the session-expiry navigation).
 *
 * Contract: docs/contracts/workspace-authorization.md ("Minimum role per surface":
 *   `POST /api/invitations` is `workspace_admin` on every named workspace — Form B; a
 *   workspace the caller is not admin of is 404 `not_found`, D-09; an archived one is 400
 *   `validation_failed` under `workspaces`), docs/contracts/error-envelope.md,
 *   docs/contracts/rate-limit.md (429 with `Retry-After`).
 * ADR: adr-0048 (the wire role is unbranded), adr-0029 (no caller value in an error string).
 * Consumes: TASK-1b-12's `createInvitationRequest`, `classifyInvitationScreenError`,
 *   `INVITATION_MESSAGES`.
 *
 * ONE WORKSPACE PER INVITATION FROM THIS SCREEN (D-14). The API's body names up to twenty
 * workspaces; this form is on ONE workspace's page and names exactly that one. A
 * multi-workspace invitation is the API's shape, reachable through it, and the list renders
 * one when it meets it ("+N more"); the first UI offers one to stay small.
 *
 * THE ROLE PICKER OFFERS `INVITABLE_WORKSPACE_ROLES` — `workspace_admin` and `member`, no
 * `viewer` (roles.ts: nothing in launch-core grants it outside fixtures; the API accepts it,
 * the UI does not offer it). Default `member`, the role an invitee usually gets.
 *
 * CLIENT-SIDE VALIDATION IS THE SHARED CONTRACT'S `safeParse`
 * (`createInvitationRequestContract`): the normalised body it returns — trimmed,
 * lower-cased address — is what goes on the wire, so a malformed address is refused here
 * with `INVITE_FORM_MESSAGES.emailRule` and never sent, exactly as the API would refuse it.
 * A server `validation_failed` under `email` renders that message under the field (the
 * `create-workspace-form.tsx` precedent for a field the operator typed); one under
 * `workspaces` (an archived workspace, D-09) renders a FIXED sentence, since the operator
 * typed nothing there; one with nothing under either renders the shared validation line.
 *
 * WHO MAY INVITE IS THE API'S CALL. The row on `/workspaces` only offers the link to a
 * `workspace_admin`, but hiding is not enforcement: a 403 `insufficient_workspace_role` /
 * `insufficient_tenant_role` here renders `INVITE_FORM_MESSAGES.forbidden` (the shared
 * classifier has no 403 branch — `classifyInvitationScreenError` in `invitations-api.ts`
 * adds one for the two screens) and a 404 `not_found` — the caller no longer administers this workspace,
 * or it is gone — renders `workspaceGone`. 429 renders the seconds when the API sent them.
 *
 * THE ADDRESS is the operator's own input: echoed in the field and in the screen's
 * announcement, sent in the request BODY, never put in a URL, an `href` or a log line.
 * On success the field is cleared and KEEPS focus (the next teammate can be typed without
 * a pointer) and the role is kept; the screen announces through its one live region. On
 * failure the typed value stays so it can be corrected, and focus moves to the field
 * (field failure) or the alert (form-level failure), the sibling forms' pattern.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { INVITABLE_WORKSPACE_ROLES, INVITATION_EMAIL_MAX_LENGTH, createInvitationRequestContract } from '@shortkit/contracts';
import type { CreateInvitationRequest, Invitation, WorkspaceRoleValue } from '@shortkit/contracts';

import { apiClient } from '../../lib/api/client';
import { INVITATION_MESSAGES } from './invitation-state-message';
import { classifyInvitationScreenError, createInvitationRequest } from './invitations-api';
import type { InvitationScreenFailure } from './invitations-api';

/** The picker's value type: the roles the UI offers, a subset of `WorkspaceRoleValue`. */
export type InvitableWorkspaceRole = (typeof INVITABLE_WORKSPACE_ROLES)[number];

/** Human-readable role names, the same words the accept page and the list use. */
export const ROLE_LABELS: Record<WorkspaceRoleValue, string> = {
  workspace_admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

export const DEFAULT_INVITE_ROLE: InvitableWorkspaceRole = 'member';

/** The picker's value, admitted only when it is one of the offered roles; anything else falls back to the default. */
function asInvitableRole(value: string): InvitableWorkspaceRole {
  return INVITABLE_WORKSPACE_ROLES.find((role) => role === value) ?? DEFAULT_INVITE_ROLE;
}

/**
 * This form's own copy; the per-code sentences shared with the accept page are
 * `INVITATION_MESSAGES`. No message echoes a server string or the typed address.
 */
export const INVITE_FORM_MESSAGES = {
  heading: 'Invite a teammate',
  lede: 'They get an email with a link that is valid for seven days. The link is what admits them; keep the address right.',
  emailRule: 'Enter a valid email address.',
  workspaceRefused: 'This workspace cannot receive invitations right now. It may have been archived.',
  workspaceGone: 'This workspace is no longer yours to invite to: it may have been removed, or you no longer administer it.',
  forbidden: 'This account cannot invite people to this workspace. Only a workspace admin can.',
} as const;

/**
 * The client-side check IS the shared contract's `safeParse` (the same object goes on the
 * wire). Returns the normalised body, or `null` when the address breaks the rule.
 */
export function parseInvitation(email: string, workspaceId: string, workspaceRole: InvitableWorkspaceRole): CreateInvitationRequest | null {
  const parsed = createInvitationRequestContract.safeParse({ email, workspaces: [{ workspaceId, workspaceRole }] });

  return parsed.success ? parsed.data : null;
}

export interface InviteFormProps {
  /** The workspace this page is on: the one and only grant the body names. */
  workspaceId: string;
  /** Called once per created invitation, after the API answered 201 with a body the contract accepts. */
  onCreated: (invitation: Invitation) => void | Promise<void>;
  /**
   * Called for the failures this form cannot render itself — today only `unauthenticated`,
   * which the screen turns into a navigation. Everything else is shown here.
   */
  onFailure: (failure: InvitationScreenFailure) => void;
}

export function InviteForm({ workspaceId, onCreated, onFailure }: InviteFormProps): ReactElement {
  const idBase = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const inFlight = useRef(false);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableWorkspaceRole>(DEFAULT_INVITE_ROLE);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<{ message: string; kind: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Bumped per failed attempt so an identical message re-mounts and is announced again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (fieldError !== null) {
      inputRef.current?.focus();

      return;
    }

    if (formError !== null) {
      alertRef.current?.focus();
    }
  }, [fieldError, formError, attempt]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    // The submit control is `aria-disabled`, not `disabled`, so it keeps keyboard focus
    // mid-submit; this ref, not the rendered state, is the guard against a double submit.
    if (inFlight.current) {
      return;
    }

    setFieldError(null);
    setFormError(null);

    const body = parseInvitation(email, workspaceId, role);

    if (body === null) {
      setFieldError(INVITE_FORM_MESSAGES.emailRule);
      setAttempt((n) => n + 1);

      return;
    }

    inFlight.current = true;
    setSubmitting(true);

    let created: Invitation;

    try {
      created = await apiClient(createInvitationRequest(body));
    } catch (error: unknown) {
      inFlight.current = false;
      setSubmitting(false);
      setAttempt((n) => n + 1);

      const failure = classifyInvitationScreenError(error);

      switch (failure.kind) {
        case 'validation': {
          const emailMessages = failure.fieldErrors.email ?? [];
          const workspaceMessages = failure.fieldErrors.workspaces ?? [];

          if (emailMessages.length > 0) {
            setFieldError(emailMessages.join(' '));
          } else if (workspaceMessages.length > 0) {
            setFormError({ kind: 'validation', message: INVITE_FORM_MESSAGES.workspaceRefused });
          } else {
            setFormError({ kind: 'validation', message: INVITATION_MESSAGES.validationFailed });
          }

          break;
        }
        case 'forbidden':
          setFormError({ kind: failure.kind, message: INVITE_FORM_MESSAGES.forbidden });
          break;
        case 'not_found':
          setFormError({ kind: failure.kind, message: INVITE_FORM_MESSAGES.workspaceGone });
          break;
        case 'rate_limited':
          setFormError({ kind: failure.kind, message: INVITATION_MESSAGES.rateLimited(failure.retryAfterSeconds) });
          break;
        case 'aborted':
          break;
        case 'unauthenticated':
          onFailure(failure);
          break;
        case 'already_accepted':
        case 'tenant_conflict':
        case 'expired':
        case 'revoked':
        case 'unknown':
          // The four token codes cannot come from a create; anything else is one retry line.
          setFormError({ kind: 'unknown', message: INVITATION_MESSAGES.generic });
          break;
      }

      return;
    }

    inFlight.current = false;
    setSubmitting(false);
    setEmail('');
    inputRef.current?.focus();

    await onCreated(created);
  }

  const inputId = `${idBase}-email`;
  const errorId = `${inputId}-error`;
  const roleId = `${idBase}-role`;
  const formErrorId = `${idBase}-form-error`;
  const headingId = `${idBase}-heading`;

  return (
    <section className="invite" aria-labelledby={headingId}>
      <h2 id={headingId}>{INVITE_FORM_MESSAGES.heading}</h2>
      <p className="invite-lede">{INVITE_FORM_MESSAGES.lede}</p>
      <form
        className="invite-form"
        method="post"
        noValidate
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        aria-busy={submitting}
        aria-describedby={formError === null ? undefined : formErrorId}
      >
        {formError === null ? null : (
          <p
            key={attempt}
            id={formErrorId}
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            className="form-error"
            data-invitation-state={formError.kind}
          >
            {formError.message}
          </p>
        )}
        <div className="field">
          <label htmlFor={inputId}>Email address</label>
          <input
            ref={inputRef}
            id={inputId}
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={INVITATION_EMAIL_MAX_LENGTH}
            value={email}
            onChange={(event) => {
              setEmail(event.currentTarget.value);
            }}
            aria-invalid={fieldError === null ? undefined : true}
            aria-describedby={fieldError === null ? undefined : errorId}
          />
          {fieldError === null ? null : (
            <p id={errorId} className="field-error">
              {fieldError}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor={roleId}>Role</label>
          <select
            id={roleId}
            name="workspaceRole"
            value={role}
            onChange={(event) => {
              setRole(asInvitableRole(event.currentTarget.value));
            }}
          >
            {INVITABLE_WORKSPACE_ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" aria-disabled={submitting}>
          {submitting ? 'Sending…' : 'Send invitation'}
        </button>
      </form>
    </section>
  );
}
