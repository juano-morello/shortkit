'use client';

/**
 * TASK-008 (STORY-003, AC-16/AC-17). The email/password form both auth screens render.
 *
 * Contract: docs/contracts/auth-tokens.md (`signUpRequestContract`, `signInRequestContract`,
 *   `authSessionContract`), docs/contracts/error-envelope.md (`ErrorCode`,
 *   `ValidationDetails`), docs/contracts/web-api-client.md (Client: `apiClient`, `ApiError`).
 * ADR: adr-0047 (password policy is the contract's two constants), adr-0061 (signup does not
 *   auto-sign-in; a duplicate address answers the same 200 as a fresh one and is not
 *   branched on here), adr-0029 (no caller value reaches an error string).
 *
 * WHAT THIS COMPONENT DOES NOT DO, ON PURPOSE:
 *   - It does not read, hold or write a token or a cookie. Sign-in's cookies are set by the
 *     BFF route on its own response; the browser body has `token` stripped (F-208), which is
 *     why the response contract below is `authSessionContract` WITHOUT `token`.
 *   - It does not put the address or the password anywhere but the JSON body of one POST:
 *     not a URL (the form is `method="post"` even before hydration), not a log, not an error
 *     message. `messageForSubmitError` never echoes a server message verbatim.
 *   - It does not invent a password rule. Client-side validation IS the shared contract's
 *     `safeParse`; the copy is keyed by the field `toValidationDetails` reports, and reads
 *     the bounds off `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH`.
 *   - It does not tell "no such account" from "wrong password": one message for
 *     `unauthenticated`, whichever it was.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  authSessionContract,
  signInRequestContract,
  signUpRequestContract,
  toValidationDetails,
  validationDetailsContract,
} from '@shortkit/contracts';
import type { SignInRequest, SignUpRequest, ValidationDetails } from '@shortkit/contracts';

import { ApiError, RequestAbortedError, apiClient } from '../../lib/api/client';

export type CredentialFormMode = 'signup' | 'sign-in';

type FieldName = 'name' | 'email' | 'password';

export interface CredentialFormProps {
  mode: CredentialFormMode;
  /** Called once, after the BFF answered 2xx with a body the contract accepts. */
  onSuccess: () => void;
}

/**
 * The BFF strips `token` from every proxied auth-surface body (F-208), so the browser never
 * sees the field the shared contract types as nullable. Derived from the shared contract by
 * `.omit`, not re-declared (ADR-0005). The parse output is discarded: nothing in the response
 * is rendered.
 */
const authScreenResponseContract = authSessionContract.omit({ token: true });

/** Route templates (ADR-0029): literals, no interpolation. */
const SIGN_UP_PATH = '/auth/sign-up/email';
const SIGN_IN_PATH = '/auth/sign-in/email';

const FIELDS: Record<CredentialFormMode, readonly FieldName[]> = {
  signup: ['name', 'email', 'password'],
  'sign-in': ['email', 'password'],
};

const LABELS: Record<FieldName, string> = {
  name: 'Name',
  email: 'Email',
  password: 'Password',
};

/**
 * Copy for a field the CONTRACT rejected client-side. Keyed by field, never by the value:
 * zod's default text ("Too small: expected string to have >=8 characters") is exact but
 * reads as a stack trace, and the numbers come from the same constants the contract reads.
 */
function clientFieldMessage(field: FieldName, mode: CredentialFormMode): string {
  switch (field) {
    case 'name':
      return 'Enter your name.';
    case 'email':
      return 'Enter a valid email address.';
    case 'password':
      return mode === 'signup'
        ? `Use between ${String(PASSWORD_MIN_LENGTH)} and ${String(PASSWORD_MAX_LENGTH)} characters.`
        : 'Enter your password.';
  }
}

export const SUBMIT_MESSAGES = {
  invalidCredentials: 'The email address or password is incorrect.',
  validationFailed: 'Some of the details were not accepted. Check them and try again.',
  rateLimited: (seconds: number | undefined): string =>
    seconds === undefined
      ? 'Too many attempts. Try again in a moment.'
      : `Too many attempts. Try again in ${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}.`,
  generic: 'Something went wrong on our side. Try again in a moment.',
} as const;

/**
 * The form-level message for a submit failure, keyed by `ApiError.code` and NOT by status
 * (TASK-008 card: "Error copy is driven by `code`"). Returns `null` for a caller-initiated
 * abort, which is not a failure to show. Never returns the server's `message` verbatim.
 *
 * `validation_failed` reaches here only when its `details` carried nothing this form could
 * put under a field (see `serverFieldErrors`).
 */
export function messageForSubmitError(error: unknown): string | null {
  if (error instanceof RequestAbortedError) {
    return null;
  }

  if (error instanceof ApiError) {
    switch (error.code) {
      case 'unauthenticated':
        return SUBMIT_MESSAGES.invalidCredentials;
      case 'validation_failed':
        return SUBMIT_MESSAGES.validationFailed;
      case 'rate_limited':
        return SUBMIT_MESSAGES.rateLimited(error.retryAfterSeconds);
      default:
        return SUBMIT_MESSAGES.generic;
    }
  }

  // NetworkError, ContractViolationError, and anything else: one retry message.
  return SUBMIT_MESSAGES.generic;
}

/**
 * Splits `ValidationDetails.fieldErrors` into messages for the fields this form renders and
 * a form-level remainder (`FORM_ERROR_KEY` and any key that is not a rendered field). The
 * remainder is joined; if everything is empty the caller falls back to the generic copy.
 */
function splitFieldErrors(
  details: ValidationDetails,
  fields: readonly FieldName[],
): { byField: Partial<Record<FieldName, string>>; form: string | null } {
  const byField: Partial<Record<FieldName, string>> = {};
  const rest: string[] = [];

  for (const [key, messages] of Object.entries(details.fieldErrors)) {
    if (messages.length === 0) {
      continue;
    }

    if ((fields as readonly string[]).includes(key)) {
      byField[key as FieldName] = messages.join(' ');
    } else {
      // FORM_ERROR_KEY, and any key that is not a rendered field: shown at form level.
      rest.push(...messages);
    }
  }

  return { byField, form: rest.length === 0 ? null : rest.join(' ') };
}

/** `ApiError.details` as `ValidationDetails`, when the API sent that shape; else `null`. */
function serverFieldErrors(error: ApiError): ValidationDetails | null {
  if (error.code !== 'validation_failed') {
    return null;
  }

  const parsed = validationDetailsContract.safeParse(error.details);

  return parsed.success ? parsed.data : null;
}

export function CredentialForm({ mode, onSuccess }: CredentialFormProps): ReactElement {
  const fields = FIELDS[mode];
  const idBase = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const inFlight = useRef(false);

  const [values, setValues] = useState<Record<FieldName, string>>({ name: '', email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Bumped per failed attempt so an identical message re-mounts and is announced again.
  const [attempt, setAttempt] = useState(0);

  // Focus after a failed attempt (review round 1, medium): a field failure lands on the first
  // invalid field; a form-level failure lands on the alert region itself. Either way a
  // keyboard or screen-reader user is moved to the message rather than left on the control.
  useEffect(() => {
    if (Object.keys(fieldErrors).length > 0) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();

      return;
    }

    if (formError !== null) {
      alertRef.current?.focus();
    }
  }, [fieldErrors, formError, attempt]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    // The submit control is `aria-disabled`, not `disabled`, so it keeps keyboard focus
    // mid-submit (review round 1, medium); this ref, not the rendered state, is the guard —
    // a second submit in the same tick would still see the stale closure's `submitting`.
    if (inFlight.current) {
      return;
    }

    setFormError(null);
    setFieldErrors({});

    // Client-side validation IS the shared contract. The same object is what the wire gets.
    const parsed =
      mode === 'signup'
        ? signUpRequestContract.safeParse({ name: values.name, email: values.email, password: values.password })
        : signInRequestContract.safeParse({ email: values.email, password: values.password });

    if (!parsed.success) {
      const details = toValidationDetails(parsed.error);
      const split = splitFieldErrors(details, fields);
      const byField: Partial<Record<FieldName, string>> = {};

      for (const field of Object.keys(split.byField) as FieldName[]) {
        byField[field] = clientFieldMessage(field, mode);
      }

      setFieldErrors(byField);
      setFormError(split.form);
      setAttempt((n) => n + 1);

      return;
    }

    inFlight.current = true;
    setSubmitting(true);

    try {
      if (mode === 'signup') {
        await apiClient({
          method: 'POST',
          path: SIGN_UP_PATH,
          body: parsed.data as SignUpRequest,
          contract: authScreenResponseContract,
        });
      } else {
        await apiClient({
          method: 'POST',
          path: SIGN_IN_PATH,
          body: parsed.data as SignInRequest,
          contract: authScreenResponseContract,
        });
      }
    } catch (error: unknown) {
      // `submitting` stays true on success so the control cannot fire again while the
      // caller navigates; it is released only here, on failure.
      inFlight.current = false;
      setSubmitting(false);
      setAttempt((n) => n + 1);

      const details = error instanceof ApiError ? serverFieldErrors(error) : null;

      if (details !== null) {
        const split = splitFieldErrors(details, fields);
        const anyField = Object.keys(split.byField).length > 0;

        setFieldErrors(split.byField);
        setFormError(split.form ?? (anyField ? null : SUBMIT_MESSAGES.validationFailed));

        return;
      }

      const message = messageForSubmitError(error);

      if (message !== null) {
        setFormError(message);
      }

      return;
    }

    onSuccess();
  }

  const submitLabel = mode === 'signup' ? 'Create account' : 'Sign in';
  const pendingLabel = mode === 'signup' ? 'Creating account…' : 'Signing in…';
  const formErrorId = `${idBase}-form-error`;

  return (
    <form
      ref={formRef}
      className="auth-form"
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

      {fields.map((field) => {
        const inputId = `${idBase}-${field}`;
        const errorId = `${inputId}-error`;
        const error = fieldErrors[field];

        return (
          <div className="field" key={field}>
            <label htmlFor={inputId}>{LABELS[field]}</label>
            <input
              id={inputId}
              name={field}
              type={inputType(field)}
              autoComplete={autoCompleteFor(field, mode)}
              autoCapitalize={field === 'name' ? 'words' : 'none'}
              spellCheck={false}
              required
              value={values[field]}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setValues((current) => ({ ...current, [field]: next }));
              }}
              aria-invalid={error === undefined ? undefined : true}
              aria-describedby={error === undefined ? undefined : errorId}
            />
            {error === undefined ? null : (
              <p id={errorId} className="field-error">
                {error}
              </p>
            )}
          </div>
        );
      })}

      <button type="submit" aria-disabled={submitting}>
        {submitting ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}

function inputType(field: FieldName): 'text' | 'email' | 'password' {
  switch (field) {
    case 'name':
      return 'text';
    case 'email':
      return 'email';
    case 'password':
      return 'password';
  }
}

function autoCompleteFor(field: FieldName, mode: CredentialFormMode): string {
  switch (field) {
    case 'name':
      return 'name';
    case 'email':
      return 'email';
    case 'password':
      return mode === 'signup' ? 'new-password' : 'current-password';
  }
}
