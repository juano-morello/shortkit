'use client';

/**
 * TASK-2-14 (STORY-2-10, AC-2-49 and the field half of AC-2-50). One form for both link
 * mutations: `create` on the list page (`POST /api/bff/links`) and `edit` on
 * `/workspaces/[workspaceId]/links/[linkId]` (`PATCH /api/bff/links/:linkId`). Destination,
 * optional slug, and the activation/expiry pair as `datetime-local` inputs with the
 * operator zone stated beside them.
 *
 * Contract: docs/contracts/slug.md (five violations, fixed order, the token in
 *   `details.fieldErrors.slug`), docs/contracts/error-envelope.md (the fixed 409 with no
 *   `details`; the 429 with `Retry-After`), docs/contracts/web-api-client.md (`apiClient`).
 * ADR: adr-0007 (slugs are case-sensitive), adr-0014 (the browser goes through `/api/bff/*`).
 * Decision: D-2-12 (patchable fields; no `domainId` in the create body), D-2-18.
 * Consumes: TASK-2-13's `createLinkRequest`, `updateLinkRequest`, `slugFieldError`,
 *   `classifyLinkFormError`, `messageForLinkFailure`, `LINK_MESSAGES`.
 *
 * ============================================================================
 * TWO CHECKS RUN BEFORE ANY REQUEST, AND THE SLUG'S ONE WINS ITS FIELD (AC-2-49).
 * ============================================================================
 *
 * 1. `slugFieldError`: the shared `validateSlug`, unmodified, so the five violations keep
 *    their fixed order and the form refuses exactly what the API refuses, one round trip
 *    earlier and in the same words. A BLANK FIELD IS NOT A VIOLATION: on create the API
 *    draws a code, and on edit the key is simply omitted (a link cannot have no slug).
 * 2. The shared request contract's `safeParse`. The SAME object then goes on the wire, so
 *    `javascript:` and `data:` destinations, an over-long one, and `activatesAt >= expiresAt`
 *    are refused here by the rule that refuses them there. The destination sent is the
 *    parser's `href`, never the raw input (D-2-08).
 *
 * The two run TOGETHER rather than in sequence: an operator who mistyped a slug and a
 * destination is told about both at once. The pre-check wins the slug field, because the
 * contract deliberately declares `slug` presence-and-type only and has nothing to say
 * about it.
 *
 * THE DATETIME FIELDS ARE CONVERTED FIRST (`fromLocalInput`), because the contract speaks
 * UTC instants and the field speaks local time. A field that is not a date and time at all
 * is refused on its own field; a blank one is `null`, which CLEARS the bound.
 *
 * ============================================================================
 * FORM STATE SURVIVES EVERY REFUSAL (the AC-87 posture, restated for links).
 * ============================================================================
 *
 * Nothing here clears a field on a failure: not a 400, not the 409, not the 429. The
 * create form empties itself on SUCCESS only, and returns focus to the destination so the
 * next link can be typed without a pointer; the edit form keeps what was saved on screen,
 * because the operator is still on that link.
 *
 * `not_found` and `unauthenticated` are the only failures handed up (`onFailure`): one is
 * a navigation, the other means the link or workspace is gone and the SCREEN owns what
 * happens next. Everything else is rendered here, keyed by `classifyLinkFormError`.
 *
 * ACCESSIBILITY, as the sibling forms: the submit control is `aria-disabled` (never
 * `disabled`) with an in-flight ref as the real guard, so it keeps keyboard focus
 * mid-submit; each failure moves focus to the first field it names, or to the banner when
 * it names none; the banner is `role="alert"`, `tabIndex={-1}`, and re-mounted per attempt
 * so an identical message is announced again.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import {
  DESTINATION_URL_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  createLinkContract,
  updateLinkContract,
} from '@shortkit/contracts';
import type { Link } from '@shortkit/contracts';

import { apiClient } from '../../lib/api/client';
import type { ApiRequest } from '../../lib/api/client';
import {
  LINK_MESSAGES,
  classifyLinkFormError,
  createLinkRequest,
  messageForLinkFailure,
  slugFieldError,
  updateLinkRequest,
} from '../../lib/links/links-api';
import type { LinkFieldErrors, LinkFormFailure, LinkFormField } from '../../lib/links/links-api';
import { fromLocalInput, resolvedTimeZone, timeZoneNote, toLocalInputValue } from './links-view';

/** Create on a workspace, or edit the link the page is on. Nothing else is a mode. */
export type LinkFormMode = { kind: 'create'; workspaceId: string } | { kind: 'edit'; link: Link };

/** This form's own copy. The per-code sentences are `LINK_MESSAGES` (TASK-2-13's). */
export const LINK_FORM_MESSAGES = {
  createHeading: 'Create a link',
  editHeading: 'Link details',
  destinationLabel: 'Destination URL',
  destinationHint: 'Where the short link sends a visitor. It must be an http:// or https:// address.',
  createSlugLabel: 'Custom slug',
  editSlugLabel: 'Slug',
  createSlugHint: 'The last part of the short link. Leave it empty for a generated code.',
  editSlugHint: 'Changing this changes the short link. The old one stops working straight away.',
  activatesLabel: 'Activates at',
  expiresLabel: 'Expires at',
  windowHint: 'Both are optional. Leave them empty and the link serves from the moment it is created until it is deleted.',
  badInstant: 'Enter a date and a time, or leave it empty.',
  create: 'Create link',
  creating: 'Creating…',
  save: 'Save changes',
  saving: 'Saving…',
} as const;

export interface LinkFormProps {
  mode: LinkFormMode;
  /** Called once the API answered with a body the contract accepts. */
  onSaved: (link: Link) => void | Promise<void>;
  /** The two failures this form does not render: `unauthenticated` and `not_found`. */
  onFailure: (failure: LinkFormFailure) => void;
}

/** The order a failure's fields are visited in when deciding where focus goes. */
const FOCUS_ORDER: readonly LinkFormField[] = ['destinationUrl', 'slug', 'activatesAt', 'expiresAt'];

type FocusTarget = LinkFormField | 'form-error';

export function LinkForm({ mode, onSaved, onFailure }: LinkFormProps): ReactElement {
  const idBase = useId();
  const destinationRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const activatesRef = useRef<HTMLInputElement>(null);
  const expiresRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  // The submit control is `aria-disabled`, not `disabled`; this ref is the real guard.
  const inFlight = useRef(false);

  const editing = mode.kind === 'edit' ? mode.link : null;
  const workspaceId = mode.kind === 'create' ? mode.workspaceId : null;

  const [destination, setDestination] = useState(editing === null ? '' : editing.destinationUrl);
  const [slug, setSlug] = useState(editing === null ? '' : editing.slug);
  const [activatesAt, setActivatesAt] = useState(editing === null ? '' : toLocalInputValue(editing.activatesAt));
  const [expiresAt, setExpiresAt] = useState(editing === null ? '' : toLocalInputValue(editing.expiresAt));

  const [fieldErrors, setFieldErrors] = useState<LinkFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * Bumped on every refusal so an identical banner RE-MOUNTS and is announced again. React
   * writes no DOM node for an unchanged string, and `role="alert"` is announced on
   * insertion, so without this a second failure with the same message would be silent to a
   * screen reader. Same mechanism as `invite-form.tsx` and the two link screens.
   */
  const [attempt, setAttempt] = useState(0);
  /**
   * Focus is moved in an effect, once the target is mounted. Each request is a FRESH
   * object, so asking for the same target twice still re-runs the effect and the effect
   * never has to reset the state it reads (react-hooks/set-state-in-effect).
   */
  const [focusMove, setFocusMove] = useState<{ target: FocusTarget } | null>(null);

  useEffect(() => {
    switch (focusMove?.target) {
      case 'destinationUrl':
        destinationRef.current?.focus();
        break;
      case 'slug':
        slugRef.current?.focus();
        break;
      case 'activatesAt':
        activatesRef.current?.focus();
        break;
      case 'expiresAt':
        expiresRef.current?.focus();
        break;
      case 'form-error':
        alertRef.current?.focus();
        break;
      case undefined:
        break;
    }
  }, [focusMove]);

  function show(errors: LinkFieldErrors, message: string | null): void {
    setFieldErrors(errors);
    setFormError(message);
    setAttempt((n) => n + 1);

    const firstField = FOCUS_ORDER.find((field) => errors[field] !== undefined);

    if (firstField !== undefined) {
      setFocusMove({ target: firstField });
    } else if (message !== null) {
      setFocusMove({ target: 'form-error' });
    }
  }

  /**
   * Everything refusable without the network: the slug rule, the two local instants, and
   * the shared request contract. Returns the body to send, or the messages to render.
   */
  function validate():
    | { ok: true; request: ApiRequest<Link> }
    | { ok: false; fieldErrors: LinkFieldErrors; formMessage: string | null } {
    const errors: LinkFieldErrors = {};

    const slugMessage = slugFieldError(slug);

    if (slugMessage !== null) {
      errors.slug = slugMessage;
    }

    const activates = fromLocalInput(activatesAt);
    const expires = fromLocalInput(expiresAt);

    if (!activates.ok) {
      errors.activatesAt = LINK_FORM_MESSAGES.badInstant;
    }

    if (!expires.ok) {
      errors.expiresAt = LINK_FORM_MESSAGES.badInstant;
    }

    const bounds = {
      activatesAt: activates.ok ? activates.instant : null,
      expiresAt: expires.ok ? expires.instant : null,
    };
    // Blank means "the API draws one" on create and "leave it alone" on edit; both omit it.
    const slugKey = slug === '' ? {} : { slug };

    const candidate = { destinationUrl: destination, ...slugKey, ...bounds };

    if (editing === null) {
      const parsed = createLinkContract.safeParse({ workspaceId, ...candidate });

      if (!parsed.success) {
        return refusal(errors, attributeIssues(parsed.error.issues, errors));
      }

      return Object.keys(errors).length > 0 ? refusal(errors, null) : { ok: true, request: createLinkRequest(parsed.data) };
    }

    const parsed = updateLinkContract.safeParse(candidate);

    if (!parsed.success) {
      return refusal(errors, attributeIssues(parsed.error.issues, errors));
    }

    return Object.keys(errors).length > 0
      ? refusal(errors, null)
      : { ok: true, request: updateLinkRequest(editing.id, parsed.data) };
  }

  function renderFailure(failure: LinkFormFailure): void {
    switch (failure.kind) {
      case 'fields':
        show(failure.fieldErrors, failure.formMessage ?? null);
        break;
      case 'rate_limited':
      case 'generic':
      case 'forbidden':
        show({}, messageForLinkFailure(failure));
        break;
      case 'aborted':
        break;
      case 'not_found':
      case 'unauthenticated':
        onFailure(failure);
        break;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (inFlight.current) {
      return;
    }

    const checked = validate();

    if (!checked.ok) {
      show(checked.fieldErrors, checked.formMessage);

      return;
    }

    setFieldErrors({});
    setFormError(null);
    inFlight.current = true;
    setSubmitting(true);

    let saved: Link;

    try {
      saved = await apiClient(checked.request);
    } catch (error: unknown) {
      inFlight.current = false;
      setSubmitting(false);
      renderFailure(classifyLinkFormError(error));

      return;
    }

    inFlight.current = false;
    setSubmitting(false);

    if (editing === null) {
      setDestination('');
      setSlug('');
      setActivatesAt('');
      setExpiresAt('');
      setFocusMove({ target: 'destinationUrl' });
    }

    await onSaved(saved);
  }

  const creating = editing === null;
  const headingId = `${idBase}-heading`;
  const destinationId = `${idBase}-destination`;
  const destinationHintId = `${destinationId}-hint`;
  const destinationErrorId = `${destinationId}-error`;
  const slugId = `${idBase}-slug`;
  const slugHintId = `${slugId}-hint`;
  const slugErrorId = `${slugId}-error`;
  const activatesId = `${idBase}-activates`;
  const activatesErrorId = `${activatesId}-error`;
  const expiresId = `${idBase}-expires`;
  const expiresErrorId = `${expiresId}-error`;
  const zoneId = `${idBase}-zone`;
  const formErrorId = `${idBase}-form-error`;

  function describedBy(hintId: string, errorId: string, field: LinkFormField): string {
    return fieldErrors[field] === undefined ? hintId : `${hintId} ${errorId}`;
  }

  return (
    <section className="link-form-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{creating ? LINK_FORM_MESSAGES.createHeading : LINK_FORM_MESSAGES.editHeading}</h2>
      <form
        className="link-form"
        method="post"
        noValidate
        aria-busy={submitting}
        aria-describedby={formError === null ? undefined : formErrorId}
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        {formError === null ? null : (
          <p key={attempt} id={formErrorId} ref={alertRef} role="alert" tabIndex={-1} className="form-error">
            {formError}
          </p>
        )}

        <div className="field">
          <label htmlFor={destinationId}>{LINK_FORM_MESSAGES.destinationLabel}</label>
          <p id={destinationHintId} className="field-hint">
            {LINK_FORM_MESSAGES.destinationHint}
          </p>
          <input
            ref={destinationRef}
            id={destinationId}
            name="destinationUrl"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={DESTINATION_URL_MAX_LENGTH}
            value={destination}
            onChange={(event) => {
              setDestination(event.currentTarget.value);
              setFieldErrors((current) => withoutField(current, 'destinationUrl'));
            }}
            aria-invalid={fieldErrors.destinationUrl === undefined ? undefined : true}
            aria-describedby={describedBy(destinationHintId, destinationErrorId, 'destinationUrl')}
          />
          {fieldErrors.destinationUrl === undefined ? null : (
            <p id={destinationErrorId} className="field-error">
              {fieldErrors.destinationUrl}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor={slugId}>{creating ? LINK_FORM_MESSAGES.createSlugLabel : LINK_FORM_MESSAGES.editSlugLabel}</label>
          <p id={slugHintId} className="field-hint">
            {creating ? LINK_FORM_MESSAGES.createSlugHint : LINK_FORM_MESSAGES.editSlugHint}
          </p>
          <input
            ref={slugRef}
            id={slugId}
            name="slug"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={SLUG_MAX_LENGTH}
            value={slug}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setSlug(next);
              // The card asks for the pre-check "on change/submit". It runs on change ONLY
              // WHILE A MESSAGE IS ALREADY SHOWING, so the operator watches it change and
              // disappear as they correct the field, and is never told mid-word that the
              // slug they have not finished typing is wrong.
              setFieldErrors((current) =>
                current.slug === undefined ? current : withField(current, 'slug', slugFieldError(next)),
              );
            }}
            aria-invalid={fieldErrors.slug === undefined ? undefined : true}
            aria-describedby={describedBy(slugHintId, slugErrorId, 'slug')}
          />
          {fieldErrors.slug === undefined ? null : (
            <p id={slugErrorId} className="field-error">
              {fieldErrors.slug}
            </p>
          )}
        </div>

        <fieldset className="link-window">
          <legend>Validity window</legend>
          <p className="field-hint">{LINK_FORM_MESSAGES.windowHint}</p>
          {/* The zone differs between the server render and the browser's; the client's is
              the operator's and wins. See `resolvedTimeZone`. */}
          <p id={zoneId} className="field-hint" suppressHydrationWarning>
            {timeZoneNote(resolvedTimeZone())}
          </p>

          <div className="field">
            <label htmlFor={activatesId}>{LINK_FORM_MESSAGES.activatesLabel}</label>
            <input
              ref={activatesRef}
              id={activatesId}
              name="activatesAt"
              type="datetime-local"
              value={activatesAt}
              suppressHydrationWarning
              onChange={(event) => {
                setActivatesAt(event.currentTarget.value);
                setFieldErrors((current) => withoutField(current, 'activatesAt'));
              }}
              aria-invalid={fieldErrors.activatesAt === undefined ? undefined : true}
              aria-describedby={describedBy(zoneId, activatesErrorId, 'activatesAt')}
            />
            {fieldErrors.activatesAt === undefined ? null : (
              <p id={activatesErrorId} className="field-error">
                {fieldErrors.activatesAt}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor={expiresId}>{LINK_FORM_MESSAGES.expiresLabel}</label>
            <input
              ref={expiresRef}
              id={expiresId}
              name="expiresAt"
              type="datetime-local"
              value={expiresAt}
              suppressHydrationWarning
              onChange={(event) => {
                setExpiresAt(event.currentTarget.value);
                setFieldErrors((current) => withoutField(current, 'expiresAt'));
              }}
              aria-invalid={fieldErrors.expiresAt === undefined ? undefined : true}
              aria-describedby={describedBy(zoneId, expiresErrorId, 'expiresAt')}
            />
            {fieldErrors.expiresAt === undefined ? null : (
              <p id={expiresErrorId} className="field-error">
                {fieldErrors.expiresAt}
              </p>
            )}
          </div>
        </fieldset>

        <button type="submit" aria-disabled={submitting}>
          {submitLabel(creating, submitting)}
        </button>
      </form>
    </section>
  );
}

/** The four words the submit control can carry. */
function submitLabel(creating: boolean, submitting: boolean): string {
  if (creating) {
    return submitting ? LINK_FORM_MESSAGES.creating : LINK_FORM_MESSAGES.create;
  }

  return submitting ? LINK_FORM_MESSAGES.saving : LINK_FORM_MESSAGES.save;
}

/**
 * The contract's issues, spread over the four inputs. A field the pre-checks already spoke
 * for keeps THEIR message: `validateSlug`'s violation is the deterministic one AC-2-49
 * names, and the contract has nothing to say about a slug beyond its type. An issue whose
 * path names no input (the object-level window refinement is pathed to `activatesAt`, so
 * this is the case nothing produces today) becomes the banner sentence rather than being
 * dropped.
 *
 * Mutates `errors` and returns the banner text, so one pass fills both.
 */
function attributeIssues(issues: readonly { path: PropertyKey[]; message: string }[], errors: LinkFieldErrors): string | null {
  let formMessage: string | null = null;

  for (const issue of issues) {
    const [first] = issue.path;
    const field = FOCUS_ORDER.find((candidate) => candidate === first);

    if (field === undefined) {
      formMessage = formMessage === null ? issue.message : `${formMessage} ${issue.message}`;
    } else if (errors[field] === undefined) {
      errors[field] = issue.message;
    }
  }

  return formMessage;
}

/** A refusal with something to show. One sentence when nothing could be attributed. */
function refusal(errors: LinkFieldErrors, formMessage: string | null): { ok: false; fieldErrors: LinkFieldErrors; formMessage: string | null } {
  const nothingAttributed = Object.keys(errors).length === 0 && formMessage === null;

  return { ok: false, fieldErrors: errors, formMessage: nothingAttributed ? LINK_MESSAGES.validationFailed : formMessage };
}

/** One field's message removed as soon as the operator edits it; the others are left alone. */
function withoutField(errors: LinkFieldErrors, field: LinkFormField): LinkFieldErrors {
  if (errors[field] === undefined) {
    return errors;
  }

  const next = { ...errors };
  delete next[field];

  return next;
}

/** One field's message replaced, or removed when the new answer is "nothing to say". */
function withField(errors: LinkFieldErrors, field: LinkFormField, message: string | null): LinkFieldErrors {
  if (message === null) {
    return withoutField(errors, field);
  }

  return errors[field] === message ? errors : { ...errors, [field]: message };
}
