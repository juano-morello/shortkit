/**
 * TASK-1b-12 (STORY-1b-02; the plumbing under AC-1b-12/13/16 and STORY-1b-05's screen).
 * The requests the two invitation screens issue, the token helpers, and the failure
 * classifier — in one module so the accept page (TASK-1b-13) and the per-workspace
 * invitations screen (TASK-1b-14) agree on every path, body and code, the way
 * `workspaces-api.ts` does for the workspace screen.
 *
 * Contract: docs/contracts/web-api-client.md (Client: route templates, `ApiRequest`,
 *   `ApiError`), docs/contracts/error-envelope.md, docs/contracts/invitation-tokens.md
 *   (D-03: fragment + body), docs/contracts/workspace-authorization.md (who may invite,
 *   list, revoke), docs/contracts/rate-limit.md (the `@Public()` per-IP 429).
 * ADR: adr-0021 (the link is the capability; D-01 ruled it is not bound to the address),
 *   adr-0029 (route templates are source literals; a caller value goes in `params` — and
 *   the token goes in NEITHER, see below), adr-0014 (browser → BFF, server → API).
 * Produced by: TASK-1b-12
 *
 * The requests, as the wire sees them (browser leg through `apiClient`; the server leg,
 * `serverApiClient`, drops the `/api/bff` prefix for `{API_BASE_URL}`):
 *
 *   POST   /api/bff/invitations/lookup        { token }                 -> invitationPreviewContract   (@Public())
 *   POST   /api/bff/invitations/accept        { token }                 -> acceptInvitationResponseContract
 *   POST   /api/bff/invitations               { email, workspaces }     -> invitationContract
 *   GET    /api/bff/invitations?workspaceId=                            -> invitationListResponseContract
 *   DELETE /api/bff/invitations/:id                                     -> invitationContract
 *   GET    /api/bff/workspaces/:workspaceId                             -> workspaceContract
 *
 * ============================================================================
 * THE TOKEN IS A BODY FIELD. NEVER A `params` VALUE, NEVER A QUERY, NEVER A PATH (GC-K).
 * ============================================================================
 *
 * The raw capability token exists in the mail body and in the URL FRAGMENT of the accept
 * link, and nowhere else under this system's control. `lookupInvitationRequest` and
 * `acceptInvitationRequest` put it in `body`; no template here has a `:token` placeholder,
 * so `buildRequestUrl` never sees it and it reaches no URL, no `Referer`, no platform log
 * and no error string. `ROUTE_TEMPLATE_PATTERN` would reject it anyway (on the `.`
 * separator); that is the backstop, this file is the rule.
 *
 * NO MODULE HERE READS A COOKIE OR HOLDS A SESSION TOKEN. The two clients carry the session.
 * The one thing this module writes to browser storage is the INVITATION token, in
 * `sessionStorage`, so it survives the sign-in round-trip D-04 describes (the invitee with
 * an existing account signs in with `returnTo=/invitations/accept` and the page re-reads
 * it). `sessionStorage` is per-tab and cleared with the tab; the accept page clears it on
 * success (D-14).
 */
import {
  acceptInvitationResponseContract,
  capabilityTokenContract,
  invitationContract,
  invitationListResponseContract,
  invitationPreviewContract,
  validationDetailsContract,
  workspaceContract,
} from '@shortkit/contracts';
import type {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  CreateInvitationRequest,
  Invitation,
  InvitationListResponse,
  InvitationLookupRequest,
  InvitationPreview,
  Workspace,
} from '@shortkit/contracts';

import { ApiError, RequestAbortedError } from '../../lib/api/client';
import type { ApiRequest } from '../../lib/api/client';
import { INVITATION_ACCEPT_ROUTE, WORKSPACES_ROUTE } from '../auth/routes';

/** One home for the accept page's route is `auth/routes.ts`; re-exported so screens import from here. */
export { INVITATION_ACCEPT_ROUTE };

/** Route templates (ADR-0029): literals. The invitation id goes in `params`; the token never does. */
export const INVITATIONS_PATH = '/invitations';
export const INVITATION_PATH = '/invitations/:id';
export const INVITATION_LOOKUP_PATH = '/invitations/lookup';
export const INVITATION_ACCEPT_PATH = '/invitations/accept';
/**
 * `GET /api/workspaces/:workspaceId` (D-07; the route lands with TASK-1b-06 in wave 3). The
 * placeholder is `:workspaceId`, the name Form A resolves; `workspaces-api.ts`'s `:id`
 * templates are the older routes and resolve to the same URLs. The contract type gains
 * `workspaceRole` in wave 3; nothing here reads that field.
 */
export const WORKSPACE_BY_ID_PATH = '/workspaces/:workspaceId';

/**
 * The per-workspace invitations page (D-14: `app/(app)/workspaces/[workspaceId]/invitations`,
 * TASK-1b-14). The id is a uuid the API produced; encoded anyway, so a value that is not
 * one cannot add a segment.
 */
export function INVITATIONS_ROUTE(workspaceId: string): string {
  return `${WORKSPACES_ROUTE}/${encodeURIComponent(workspaceId)}/invitations`;
}

/**
 * The `sessionStorage` key the accept page keeps the token under across the sign-in
 * round-trip (D-04, D-14). `sessionStorage`, not `localStorage`: per-tab, gone with the tab,
 * never shared with another tab's origin state; and not a cookie, so it is never sent.
 */
export const INVITATION_TOKEN_STORAGE_KEY = 'shortkit.invitation.token';

/** The fragment key the email link uses: `/invitations/accept#token=<raw>` (D-03). */
export const INVITATION_TOKEN_FRAGMENT_KEY = 'token';

export function lookupInvitationRequest(token: string): ApiRequest<InvitationPreview, InvitationLookupRequest> {
  return { method: 'POST', path: INVITATION_LOOKUP_PATH, body: { token }, contract: invitationPreviewContract };
}

export function acceptInvitationRequest(token: string): ApiRequest<AcceptInvitationResponse, AcceptInvitationRequest> {
  return { method: 'POST', path: INVITATION_ACCEPT_PATH, body: { token }, contract: acceptInvitationResponseContract };
}

export function createInvitationRequest(body: CreateInvitationRequest): ApiRequest<Invitation, CreateInvitationRequest> {
  return { method: 'POST', path: INVITATIONS_PATH, body, contract: invitationContract };
}

export function listInvitationsRequest(workspaceId: string): ApiRequest<InvitationListResponse> {
  return { method: 'GET', path: INVITATIONS_PATH, query: { workspaceId }, contract: invitationListResponseContract };
}

export function revokeInvitationRequest(id: string): ApiRequest<Invitation> {
  return { method: 'DELETE', path: INVITATION_PATH, params: { id }, contract: invitationContract };
}

export function getWorkspaceRequest(workspaceId: string): ApiRequest<Workspace> {
  return { method: 'GET', path: WORKSPACE_BY_ID_PATH, params: { workspaceId }, contract: workspaceContract };
}

/**
 * The token out of `location.hash`, or `null`. Admits ONLY a value `capabilityTokenContract`
 * accepts — the same shape the API parses before `parseCapabilityToken` runs — so a
 * malformed fragment is a local `not_found` and never a request, and nothing but a
 * token-shaped string is ever posted or stored. Accepts the hash with or without its `#`
 * and with sibling pairs, since a mail client may append its own.
 */
export function invitationTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;

  if (raw === '') {
    return null;
  }

  const candidate = new URLSearchParams(raw).get(INVITATION_TOKEN_FRAGMENT_KEY);

  return asCapabilityToken(candidate);
}

/**
 * `value` when it is token-shaped, else `null`. THE ONE SHAPE CHECK on the web side: the
 * fragment reader, the storage reader and `CredentialForm` (before it spreads
 * `invitationToken` into the signup body) all go through it, so nothing but a
 * `capabilityTokenContract`-shaped string is ever posted or stored.
 */
export function asCapabilityToken(value: unknown): string | null {
  const parsed = capabilityTokenContract.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/**
 * The three `sessionStorage` helpers. Storage can throw (a disabled or full store, some
 * private modes); a failure to store degrades to "sign in, then paste the link again", not
 * to a crash on the accept page, so every call is guarded. Reading re-applies the shape
 * check, so a tampered value is never posted.
 */
export function storeInvitationToken(token: string): void {
  try {
    window.sessionStorage.setItem(INVITATION_TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage unavailable: the round-trip loses the token; the page's copy covers it.
  }
}

export function readStoredInvitationToken(): string | null {
  try {
    return asCapabilityToken(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearStoredInvitationToken(): void {
  try {
    window.sessionStorage.removeItem(INVITATION_TOKEN_STORAGE_KEY);
  } catch {
    // Nothing to clear, or nothing that can be.
  }
}

/**
 * What a failed invitation request means to a screen. One classifier for lookup, accept,
 * create, list and revoke, so the two screens cannot drift on which code does what:
 *
 *   not_found         404: malformed, unknown or wrong-tenant token; unknown or other-tenant id
 *   already_accepted  409 invitation_already_accepted: single use, or revoke after accept
 *   tenant_conflict   409 invitation_tenant_conflict: signed in to another tenant (ADR-0015)
 *   expired           410 invitation_expired
 *   revoked           410 invitation_revoked
 *   rate_limited      429, with the seconds when `apiClient` normalised them (D-16)
 *   unauthenticated   401: the session ended mid-flow (accept, create, list, revoke)
 *   validation        400 validation_failed, with the field errors when the details parse
 *   aborted           the caller cancelled (unmount); nothing to show
 *   unknown           any other code, a transport failure, a contract violation
 *
 * Keyed by `ApiError.code`, never by status: `ApiError.status` is the transport status and
 * is independent of the code (F-289).
 */
export type InvitationFailure =
  | { kind: 'not_found' }
  | { kind: 'already_accepted' }
  | { kind: 'tenant_conflict' }
  | { kind: 'expired' }
  | { kind: 'revoked' }
  | { kind: 'rate_limited'; retryAfterSeconds: number | undefined }
  | { kind: 'unauthenticated' }
  | { kind: 'validation'; fieldErrors: Record<string, string[]> }
  | { kind: 'aborted' }
  | { kind: 'unknown' };

export function classifyInvitationError(error: unknown): InvitationFailure {
  if (error instanceof RequestAbortedError) {
    return { kind: 'aborted' };
  }

  if (!(error instanceof ApiError)) {
    // NetworkError, ContractViolationError, and anything else: one retry message.
    return { kind: 'unknown' };
  }

  switch (error.code) {
    case 'not_found':
      return { kind: 'not_found' };
    case 'invitation_already_accepted':
      return { kind: 'already_accepted' };
    case 'invitation_tenant_conflict':
      return { kind: 'tenant_conflict' };
    case 'invitation_expired':
      return { kind: 'expired' };
    case 'invitation_revoked':
      return { kind: 'revoked' };
    case 'rate_limited':
      return { kind: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds };
    case 'unauthenticated':
      return { kind: 'unauthenticated' };
    case 'validation_failed': {
      const details = validationDetailsContract.safeParse(error.details);

      return { kind: 'validation', fieldErrors: details.success ? details.data.fieldErrors : {} };
    }
    default:
      return { kind: 'unknown' };
  }
}

/**
 * The failure a screen-side control reports: the classification above plus `forbidden`
 * for the two 403 codes the workspace-authorization interceptor answers.
 * `classifyInvitationError` maps them to `unknown` — the accept page never meets a 403,
 * and keeps the narrower `InvitationFailure` — but the per-workspace invitations screen
 * does, on invite and on revoke, and says why rather than "something went wrong".
 */
export type InvitationScreenFailure = InvitationFailure | { kind: 'forbidden' };

export function classifyInvitationScreenError(error: unknown): InvitationScreenFailure {
  if (error instanceof ApiError && (error.code === 'insufficient_workspace_role' || error.code === 'insufficient_tenant_role')) {
    return { kind: 'forbidden' };
  }

  return classifyInvitationError(error);
}
