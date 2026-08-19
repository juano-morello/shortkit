'use client';

/**
 * TASK-013 (STORY-004, AC-27; AC-24 as the screen sees it). The create control: one name
 * field, one button. It owns the POST and the field-level message; the list it lives in
 * owns what happens next (the re-fetch, the announcement, the session-expiry navigation).
 *
 * Contract: docs/contracts/workspaces.md ("Endpoints": `POST /api/workspaces` 201,
 *   400 `validation_failed` keyed under `name`), docs/contracts/error-envelope.md.
 *
 * Client-side validation IS the shared contract's `safeParse` (`parseWorkspaceName`): the
 * trimmed body it returns is what goes on the wire, so a whitespace-only name is refused
 * here with `WORKSPACE_MESSAGES.nameRule` and never sent, and a hundred characters wrapped
 * in whitespace is accepted, exactly as the API would. A server `validation_failed` whose
 * `details.fieldErrors.name` carries a message renders that message under the field
 * (`toValidationDetails` keys by the first path segment, so `name` it is); one with nothing
 * under `name` renders one form-level line.
 *
 * On success the field is cleared and KEEPS focus, so the next workspace can be typed
 * without a pointer; the list announces the creation through its live region. On failure
 * the typed value stays so it can be corrected, and focus moves to the field (field
 * failure) or the alert (form-level failure), the `credential-form.tsx` pattern.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { WORKSPACE_NAME_MAX_LENGTH } from '@shortkit/contracts';
import type { Workspace } from '@shortkit/contracts';

import { apiClient } from '../../lib/api/client';
import { WORKSPACE_MESSAGES, classifyWorkspaceError, createWorkspaceRequest, parseWorkspaceName } from './workspaces-api';
import type { WorkspaceFailure } from './workspaces-api';

export interface CreateWorkspaceFormProps {
  /** Called once per created workspace, after the API answered 201 with a body the contract accepts. */
  onCreated: (workspace: Workspace) => void | Promise<void>;
  /**
   * Called for the failures this form cannot render itself — today only `unauthenticated`,
   * which the list turns into a navigation. Everything else is shown here.
   */
  onFailure: (failure: WorkspaceFailure) => void;
  /** `true` when this is the first workspace: the heading and lede say so. */
  empty: boolean;
}

export function CreateWorkspaceForm({ onCreated, onFailure, empty }: CreateWorkspaceFormProps): ReactElement {
  const idBase = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const inFlight = useRef(false);

  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
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

    const body = parseWorkspaceName(name, 'create');

    if (body === null) {
      setFieldError(WORKSPACE_MESSAGES.nameRule);
      setAttempt((n) => n + 1);

      return;
    }

    inFlight.current = true;
    setSubmitting(true);

    let created: Workspace;

    try {
      created = await apiClient(createWorkspaceRequest(body));
    } catch (error: unknown) {
      inFlight.current = false;
      setSubmitting(false);
      setAttempt((n) => n + 1);

      const failure = classifyWorkspaceError(error);

      switch (failure.kind) {
        case 'field':
          setFieldError(failure.message);
          break;
        case 'validation':
          setFormError(WORKSPACE_MESSAGES.validationFailed);
          break;
        case 'aborted':
          break;
        case 'unauthenticated':
        case 'not_found':
          onFailure(failure);
          break;
        case 'generic':
          setFormError(WORKSPACE_MESSAGES.generic);
          break;
      }

      return;
    }

    inFlight.current = false;
    setSubmitting(false);
    setName('');
    inputRef.current?.focus();

    await onCreated(created);
  }

  const inputId = `${idBase}-name`;
  const errorId = `${inputId}-error`;
  const formErrorId = `${idBase}-form-error`;
  const headingId = `${idBase}-heading`;

  return (
    <section className="workspaces-create" aria-labelledby={headingId}>
      <h2 id={headingId}>{empty ? 'Create your first workspace' : 'Create a workspace'}</h2>
      {empty ? (
        <p className="workspaces-lede">
          A workspace holds one client&apos;s short links: one workspace per client, each with its own
          branded domain later. Name it after the client and it is ready.
        </p>
      ) : null}
      <form
        className="workspaces-form"
        method="post"
        noValidate
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        aria-busy={submitting}
        aria-describedby={formError === null ? undefined : formErrorId}
      >
        {formError === null ? null : (
          <p key={attempt} id={formErrorId} ref={alertRef} role="alert" tabIndex={-1} className="form-error">
            {formError}
          </p>
        )}
        <div className="field">
          <label htmlFor={inputId}>Workspace name</label>
          <input
            ref={inputRef}
            id={inputId}
            name="name"
            type="text"
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            required
            maxLength={WORKSPACE_NAME_MAX_LENGTH}
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
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
        <button type="submit" aria-disabled={submitting}>
          {submitting ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
    </section>
  );
}
