/**
 * TASK-2-13 (STORY-2-10; the classification half of AC-2-49, the transport half of
 * AC-2-51). The requests the links screens issue, the slug pre-check they run before
 * sending one, and the classifier that turns any of their failures into something a form
 * can render. One module so the list, the create form and the edit screen (TASK-2-14)
 * agree on every path, body, code and string, the way `workspaces-api.ts` and
 * `invitations-api.ts` do for the surfaces before this one.
 *
 * Contract: docs/contracts/web-api-client.md (route templates, `ApiRequest`, `ApiError`),
 *   docs/contracts/error-envelope.md (`validation_failed` details, invariant 5's 404,
 *   the fixed 409 message), docs/contracts/slug.md (the violation order and the
 *   `fieldErrors.slug = ['<violation>']` mapping), docs/contracts/click-events.md.
 * ADR: adr-0029 (a route template is a source literal; a caller value goes in `params`),
 *   adr-0014 (the browser reaches the API through the BFF, the server component directly),
 *   adr-0007 (slugs are case-sensitive and the violation order is fixed).
 * Decision: D-2-12 (the six routes and their role minimums), D-2-18 (the screens),
 *   D-2-19 (`linkContract` carries `hostname`; `ipHash` is on no wire shape).
 *
 * The requests, as the wire sees them (browser leg through `apiClient`; the server leg,
 * `serverApiClient`, drops the `/api/bff` prefix for `{API_BASE_URL}`):
 *
 *   POST   /api/bff/links                    { workspaceId, destinationUrl, slug?, ... } -> linkContract
 *   GET    /api/bff/links?workspaceId=&cursor=                                           -> paginated(linkContract)
 *   GET    /api/bff/links/:linkId                                                        -> linkContract
 *   PATCH  /api/bff/links/:linkId            { destinationUrl?, slug?, ... }             -> linkContract
 *   DELETE /api/bff/links/:linkId                                                        -> linkContract
 *   GET    /api/bff/links/:linkId/clicks?from=&to=&limit=&cursor=                        -> paginated(clickEventContract)
 *
 * The BFF needs no new work: `app/api/bff/[...path]/route.ts` is a catch-all and forwards
 * `/api/bff/links/...` by construction.
 *
 * ============================================================================
 * THE BUILDERS CARRY THE `Request` SUFFIX, AS BOTH PRECEDENTS DO.
 * ============================================================================
 *
 * The card names the six operations `createLink`, `listLinks` and so on. They are named
 * `createLinkRequest`, `listLinksRequest` here for the reason the two shipped modules
 * settled on: these functions BUILD an `ApiRequest` and issue nothing, and a bare
 * `createLink()` reads like a call that talks to the network. The caller is always
 * `apiClient(createLinkRequest(body))`.
 *
 * ============================================================================
 * CLASSIFICATION LIVES HERE, NOT IN A COMPONENT.
 * ============================================================================
 *
 * The lesson item 1b's wave 4 recorded: a screen that reads `error.code` inline drifts
 * from the next screen that does the same. `classifyLinkFormError` is the only place a
 * link failure is interpreted, and `LINK_MESSAGES` the only place the copy lives, so the
 * list, the create form and the edit screen cannot disagree about which code puts a
 * message under the slug input.
 *
 * NO MODULE HERE READS A COOKIE OR HOLDS A SESSION TOKEN. The two clients carry the
 * session. Nothing here composes a redirect URL either: that is `lib/short-url.ts`, for
 * display and copy only.
 */
import {
  FORM_ERROR_KEY,
  SLUG_MAX_LENGTH,
  clickEventContract,
  isLinkActive,
  linkContract,
  paginated,
  validateSlug,
  validationDetailsContract,
} from '@shortkit/contracts';
import type {
  ClickEvent,
  CreateLinkRequest,
  Link,
  LinkValidityBound,
  LinkValidityWindow,
  Paginated,
  SlugViolation,
  UpdateLinkRequest,
} from '@shortkit/contracts';

import { ApiError, RequestAbortedError } from '../api/client';
import type { ApiRequest } from '../api/client';
import { WORKSPACES_ROUTE } from '../../components/auth/routes';

/**
 * Re-exported so a screen reads the RULE and the COPY from one module and is never tempted
 * to restate either. `validateSlug` is the shared contract's own function, unwrapped and
 * unmodified: the five violations keep their fixed order, the input comes back verbatim,
 * and this module adds only the sentence for each (see `SLUG_VIOLATION_MESSAGES`).
 */
export { validateSlug } from '@shortkit/contracts';

/** Route templates (ADR-0029): literals. Every id goes in `params`. */
export const LINKS_PATH = '/links';
export const LINK_PATH = '/links/:linkId';
export const LINK_CLICKS_PATH = '/links/:linkId/clicks';

/**
 * The two page shapes, built once from the shared item contract and the shared
 * `paginated` helper rather than re-declared per call site, so `req.contract` is a stable
 * reference a spec can compare and a screen re-rendering does not rebuild a schema.
 */
export const linkPageContract = paginated(linkContract);
export const clickEventPageContract = paginated(clickEventContract);

/**
 * The screen routes (D-2-18). `WORKSPACES_ROUTE` has one home in `components/auth/routes.ts`
 * and is composed here rather than repeated, the way `INVITATIONS_ROUTE` composes it. The
 * ids are uuids the API produced; encoded anyway, so a value that is not one cannot add a
 * segment to the path a `<Link>` navigates to.
 */
export function LINKS_ROUTE(workspaceId: string): string {
  return `${WORKSPACES_ROUTE}/${encodeURIComponent(workspaceId)}/links`;
}

export function LINK_ROUTE(workspaceId: string, linkId: string): string {
  return `${LINKS_ROUTE(workspaceId)}/${encodeURIComponent(linkId)}`;
}

/**
 * The click-stream query. Declared here rather than reusing `ClickQuery` from the contract
 * because that type is the schema's OUTPUT, where `limit` has already been defaulted to 25
 * and is therefore required; a caller sending no bounds at all is the common case and must
 * not have to name one. The shared contract still governs on the API side.
 */
export type ClickListQuery = {
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
};

export function createLinkRequest(body: CreateLinkRequest): ApiRequest<Link, CreateLinkRequest> {
  return { method: 'POST', path: LINKS_PATH, body, contract: linkContract };
}

/**
 * `cursor` is passed straight through: it is the API's own opaque string, and `appendQuery`
 * omits an `undefined` value rather than sending the text "undefined", so the first page
 * is the bare path.
 */
export function listLinksRequest(workspaceId: string, cursor?: string): ApiRequest<Paginated<Link>> {
  return { method: 'GET', path: LINKS_PATH, query: { workspaceId, cursor }, contract: linkPageContract };
}

export function getLinkRequest(linkId: string): ApiRequest<Link> {
  return { method: 'GET', path: LINK_PATH, params: { linkId }, contract: linkContract };
}

export function updateLinkRequest(linkId: string, body: UpdateLinkRequest): ApiRequest<Link, UpdateLinkRequest> {
  return { method: 'PATCH', path: LINK_PATH, params: { linkId }, body, contract: linkContract };
}

/** Hard delete (D-2-12), and the deleted row comes back so the list can say what went. */
export function deleteLinkRequest(linkId: string): ApiRequest<Link> {
  return { method: 'DELETE', path: LINK_PATH, params: { linkId }, contract: linkContract };
}

export function listClicksRequest(linkId: string, query?: ClickListQuery): ApiRequest<Paginated<ClickEvent>> {
  return {
    method: 'GET',
    path: LINK_CLICKS_PATH,
    params: { linkId },
    query: query === undefined ? undefined : { ...query },
    contract: clickEventPageContract,
  };
}

/**
 * ============================================================================
 * THE WINDOW STATE IS DERIVED HERE, NOT IN WHICHEVER COMPONENT NEEDED IT FIRST.
 * ============================================================================
 *
 * AC-2-48 shows one of three words per row, and item 1b paid to learn where that belongs:
 * a derivation written inside the component that needed it first gets imported by two
 * siblings and then has to be moved. The list row, the state badge and any filter over
 * them read this one function.
 *
 * `isLinkActive` DECIDES `'active'` AND NOTHING HERE SECOND-GUESSES IT. That is the whole
 * point of the shared rule (ADR-0009): the redirect and the screens answer "is this link
 * serving" with the same code, and this function only splits the NOT-active case into the
 * two words an operator can act on. The spec pins the agreement over a matrix of bounds,
 * so a future edit that made them disagree fails rather than drifts.
 *
 * `now` IS INJECTED, as the invitations list injects it for the same reason: derived state
 * computed from a clock read inside a component goes stale in place, and a re-fetch has no
 * way to refresh it. A screen passes the instant it rendered with; the default is for a
 * one-shot caller with no clock of its own.
 *
 * ============================================================================
 * AN UNREADABLE BOUND ANSWERS `'expired'`. FAIL CLOSED, THE SAME DIRECTION.
 * ============================================================================
 *
 * `isLinkActive` fails closed on a bound it cannot parse, so `'active'` is already
 * impossible there and the only question is which of the other two words to show. It is
 * `'expired'`, deliberately: `'scheduled'` PROMISES the link starts serving later, and a
 * bound nobody can read supports no such promise, so the operator would be told to wait
 * for something that will never happen. `'expired'` says what is true and observable, that
 * the link is not serving now, and it is also the word that prompts the repair (open the
 * link, look at its dates) rather than one that suggests waiting. The same rule holds when
 * only ONE bound is unreadable and the other would have read as `'scheduled'`: the
 * unreadable one outranks it, because the readable half cannot vouch for the other.
 *
 * Neither the API nor the contracts can produce such a value today (`linkContract` parses
 * both fields as `z.string().datetime()`), so this is the answer to a case that should be
 * unreachable rather than a case being handled routinely.
 */
export type LinkWindowState = 'active' | 'scheduled' | 'expired';

export function linkWindowState(link: LinkValidityWindow, now: Date = new Date()): LinkWindowState {
  const activatesAt = boundMs(link.activatesAt);
  const expiresAt = boundMs(link.expiresAt);

  if (isUnreadable(activatesAt) || isUnreadable(expiresAt)) {
    return 'expired';
  }

  if (isLinkActive(link, now)) {
    return 'active';
  }

  // Not active, both bounds readable: either it has not opened yet, or it has closed. An
  // inverted window would read as `'scheduled'` and never open, but `createLinkContract`
  // and `updateLinkContract` refuse `activatesAt >= expiresAt`, so no such row exists.
  return activatesAt !== null && now.getTime() < activatesAt ? 'scheduled' : 'expired';
}

/**
 * Epoch milliseconds, `null` for an absent bound, `NaN` for one that cannot be read: the
 * same three answers `is-link-active.ts` computes internally, by the same two rules
 * (`Date.parse` for the wire's ISO strings, `getTime()` for a real `Date`). It is repeated
 * rather than imported because the contract keeps it private, and it is safe to repeat
 * only because it decides nothing on its own: whether a link SERVES stays `isLinkActive`'s
 * answer, and this reader only splits the remaining two words apart.
 */
function boundMs(bound: LinkValidityBound): number | null {
  if (bound === null) {
    return null;
  }

  return typeof bound === 'string' ? Date.parse(bound) : bound.getTime();
}

/** A bound that is present and unparseable. An absent bound is not unreadable. */
function isUnreadable(bound: number | null): boolean {
  return bound !== null && Number.isNaN(bound);
}

/**
 * ============================================================================
 * ONE STRING PER SLUG VIOLATION, SHARED BY THE PRE-CHECK AND THE SERVER'S ANSWER.
 * ============================================================================
 *
 * `slug.md`'s error table puts the VIOLATION TOKEN itself in
 * `details.fieldErrors.slug` (`['too_short']`, `['reserved']`, and so on), not prose. That
 * is what lets the two paths agree to the string: `slugFieldError` maps a local
 * `validateSlug` answer through this map before any request is made, and
 * `classifyLinkFormError` maps the server's token through the SAME map when one is made
 * anyway. An operator therefore reads one sentence per rule, whichever side refused.
 *
 * Keyed by the contract's own `SlugViolation` union, so a sixth violation added upstream
 * fails typecheck here rather than rendering an empty message under the input.
 *
 * `too_short` reads the way it does because `SLUG_MIN_LENGTH` is 1: the only value it can
 * refuse is the empty string, and an empty slug field means "draw one for me" (see
 * `slugFieldError`), so the sentence has to say what the blank state actually does.
 */
export const SLUG_VIOLATION_MESSAGES: Record<SlugViolation, string> = {
  too_short: 'Enter a slug, or leave this blank to have one generated.',
  too_long: `Use ${String(SLUG_MAX_LENGTH)} characters or fewer.`,
  invalid_characters: 'Use letters, numbers, hyphens and underscores only.',
  leading_or_trailing_separator: 'Start and end with a letter or a number.',
  reserved: 'That slug is reserved. Choose another.',
};

/**
 * The create/edit form's pre-check (AC-2-49): the message to show under the slug input, or
 * `null` when there is nothing to say. The rule itself is `validateSlug`'s, imported from
 * the shared package and never restated, so the five violations keep their fixed order and
 * the form refuses exactly what the API refuses, one round-trip earlier.
 *
 * A BLANK FIELD IS NOT AN ERROR. `slug` is optional on create and the API draws one when
 * it is absent (D-2-12), so the form omits the key rather than sending an empty string,
 * and the operator is not asked to clear a message from a field they never filled in. The
 * rule lives here rather than in the form so both screens read it the same way.
 */
export function slugFieldError(input: string): string | null {
  if (input === '') {
    return null;
  }

  const validated = validateSlug(input);

  return validated.ok ? null : SLUG_VIOLATION_MESSAGES[validated.violation];
}

/**
 * The copy, keyed by outcome and never echoing a server string verbatim (the exception is
 * a `validation_failed` message the shared contracts produced, which is already the text
 * a form should show and has one source).
 */
export const LINK_MESSAGES = {
  /** The fixed 409 copy. The envelope carries one bit and no `details` (error-envelope invariant 10). */
  slugTaken: 'That slug is already taken. Choose another.',
  validationFailed: 'Some of the details were not accepted. Check them and try again.',
  notFound: 'That link no longer exists.',
  forbidden: 'Your role in this workspace does not allow that.',
  unauthenticated: 'Your session has ended. Sign in again to continue.',
  generic: 'Something went wrong on our side. Try again in a moment.',
  rateLimited: (seconds: number | undefined): string =>
    seconds === undefined
      ? 'Too many attempts. Try again shortly.'
      : `Too many attempts. Try again in ${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}.`,
  deleteCascade: 'Deleting this link deletes it for good, and its click history goes with it.',
} as const;

/** The inputs a failure can be attributed to. `workspaceId` is not one: no form shows it. */
export type LinkFormField = 'slug' | 'destinationUrl' | 'expiresAt' | 'activatesAt';

export type LinkFieldErrors = Partial<Record<LinkFormField, string>>;

/**
 * What a failed link request means to a screen. One classifier for all six requests, so
 * the list, the create form and the edit screen cannot drift on which code does what:
 *
 *   fields           validation_failed / slug_taken -> under the inputs, banner for the rest
 *   rate_limited     429, with the seconds when `apiClient` normalised them (D-16)
 *   not_found        404: unknown, deleted, or another tenant's link (envelope invariant 5)
 *   forbidden        403: a viewer reaching a write, or the tenant role refusing
 *   unauthenticated  401: the session ended mid-flow
 *   aborted          the caller cancelled (unmount); nothing to show
 *   generic          any other code, a transport failure, a contract violation
 *
 * Keyed by `ApiError.code`, never by status: the status is the TRANSPORT status and is
 * independent of the code (F-289).
 */
export type LinkFormFailure =
  | { kind: 'fields'; fieldErrors: LinkFieldErrors; formMessage: string | undefined }
  | { kind: 'rate_limited'; retryAfterSeconds: number | undefined }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'unauthenticated' }
  | { kind: 'aborted' }
  | { kind: 'generic' };

export function classifyLinkFormError(error: unknown): LinkFormFailure {
  if (error instanceof RequestAbortedError) {
    return { kind: 'aborted' };
  }

  if (!(error instanceof ApiError)) {
    // NetworkError, ContractViolationError, and anything else: one retry message.
    return { kind: 'generic' };
  }

  switch (error.code) {
    case 'validation_failed':
      return fieldFailure(error.details);
    case 'slug_taken':
      // AC-2-49: the 409 lands on the slug field, not on a banner. The envelope's own
      // message is fixed and carries no `details`, so there is nothing to read off it.
      return { kind: 'fields', fieldErrors: { slug: LINK_MESSAGES.slugTaken }, formMessage: undefined };
    case 'rate_limited':
      return { kind: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds };
    case 'not_found':
      return { kind: 'not_found' };
    case 'insufficient_workspace_role':
    case 'insufficient_tenant_role':
      return { kind: 'forbidden' };
    case 'unauthenticated':
      return { kind: 'unauthenticated' };
    default:
      return { kind: 'generic' };
  }
}

/** The four inputs a `fieldErrors` key can name. Anything else belongs on the banner. */
const LINK_FORM_FIELDS: readonly LinkFormField[] = ['slug', 'destinationUrl', 'expiresAt', 'activatesAt'];

/**
 * `details` -> the messages under each input, plus whatever is left for the banner.
 *
 * Three ways a message reaches the banner rather than an input, and all three are
 * deliberate: the API put it under `FORM_ERROR_KEY` (the truncation notice, or an
 * object-level issue with no path); it named a key no form field owns (`workspaceId`,
 * which only a defect could break); or `details` was not the shape it should have been, in
 * which case nothing is known and one sentence is all that can honestly be shown. In no
 * case is a message dropped silently.
 */
function fieldFailure(details: unknown): LinkFormFailure {
  const parsed = validationDetailsContract.safeParse(details);

  if (!parsed.success) {
    return { kind: 'fields', fieldErrors: {}, formMessage: LINK_MESSAGES.validationFailed };
  }

  const { fieldErrors } = parsed.data;
  const attributed: LinkFieldErrors = {};

  for (const field of LINK_FORM_FIELDS) {
    const messages = fieldErrors[field] ?? [];

    if (messages.length > 0) {
      attributed[field] = messages.map((message) => fieldMessage(field, message)).join(' ');
    }
  }

  const formMessages = fieldErrors[FORM_ERROR_KEY] ?? [];

  if (formMessages.length > 0) {
    return { kind: 'fields', fieldErrors: attributed, formMessage: formMessages.join(' ') };
  }

  const nothingAttributed = Object.keys(attributed).length === 0;

  return {
    kind: 'fields',
    fieldErrors: attributed,
    formMessage: nothingAttributed ? LINK_MESSAGES.validationFailed : undefined,
  };
}

/**
 * The slug field is the one place the API sends a TOKEN rather than a sentence
 * (`slug.md`'s error table), so it is translated through the same map the local pre-check
 * uses. Every other field carries a message the shared contracts wrote
 * (`DESTINATION_URL_INVALID_MESSAGE`, `LINK_WINDOW_MESSAGE`, zod's own), which is already
 * the text to show. A slug string that is not a known violation is passed through for the
 * same reason: it came from a schema, not from a caller, and inventing a substitute would
 * hide what was actually refused.
 */
function fieldMessage(field: LinkFormField, message: string): string {
  if (field !== 'slug') {
    return message;
  }

  return isSlugViolation(message) ? SLUG_VIOLATION_MESSAGES[message] : message;
}

function isSlugViolation(value: string): value is SlugViolation {
  return Object.prototype.hasOwnProperty.call(SLUG_VIOLATION_MESSAGES, value);
}

/**
 * The banner sentence for a failure, or `null` when there is nothing to show at that
 * level: an abort the caller asked for, or a failure that is entirely under the inputs.
 * Exported so a screen rendering the copy in its own layout reads the same string every
 * other screen does.
 */
export function messageForLinkFailure(failure: LinkFormFailure): string | null {
  switch (failure.kind) {
    case 'fields':
      return failure.formMessage ?? null;
    case 'rate_limited':
      return LINK_MESSAGES.rateLimited(failure.retryAfterSeconds);
    case 'not_found':
      return LINK_MESSAGES.notFound;
    case 'forbidden':
      return LINK_MESSAGES.forbidden;
    case 'unauthenticated':
      return LINK_MESSAGES.unauthenticated;
    case 'aborted':
      return null;
    case 'generic':
      return LINK_MESSAGES.generic;
  }
}
