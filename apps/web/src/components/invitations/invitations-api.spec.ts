/**
 * TASK-1b-12 (STORY-1b-02, AC-1b-12/16 as the plumbing under them). The invitation request
 * builders, the token helpers and the failure classifier the accept page (TASK-1b-13) and the
 * invitations screen (TASK-1b-14) share.
 *
 * The load-bearing assertion is GC-K's: THE TOKEN IS NEVER A `params` VALUE. It travels in
 * the body of `lookup` and `accept`, and no template in this module carries a `:token`
 * placeholder. Everything else is the workspaces-api precedent: builders produce the
 * templates and bodies, and the classifier keys on `ApiError.code`, never on status.
 *
 * Contract: docs/contracts/web-api-client.md, docs/contracts/error-envelope.md,
 *   docs/contracts/invitation-tokens.md (D-03: fragment + body).
 */
import {
  ERROR_CODE_STATUS,
  acceptInvitationResponseContract,
  invitationContract,
  invitationListResponseContract,
  invitationPreviewContract,
  workspaceContract,
} from '@shortkit/contracts';
import type { ErrorCode } from '@shortkit/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError, ContractViolationError, NetworkError, RequestAbortedError, buildRequestUrl } from '../../lib/api/client';
import { INVITATION_ACCEPT_ROUTE as ROUTES_INVITATION_ACCEPT_ROUTE } from '../auth/routes';
import {
  INVITATIONS_ROUTE,
  INVITATION_ACCEPT_PATH,
  INVITATION_ACCEPT_ROUTE,
  INVITATION_LOOKUP_PATH,
  INVITATION_PATH,
  INVITATION_TOKEN_STORAGE_KEY,
  INVITATIONS_PATH,
  WORKSPACE_BY_ID_PATH,
  acceptInvitationRequest,
  classifyInvitationError,
  classifyInvitationScreenError,
  clearStoredInvitationToken,
  createInvitationRequest,
  getWorkspaceRequest,
  invitationTokenFromHash,
  listInvitationsRequest,
  lookupInvitationRequest,
  readStoredInvitationToken,
  revokeInvitationRequest,
  storeInvitationToken,
} from './invitations-api';

/** A well-formed capability token: canonical uuid, '.', 43 base64url chars. Never a real one. */
const A_TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const A_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const AN_INVITATION_ID = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  window.sessionStorage.clear();
});

describe('the request builders (D-03: the token rides in the BODY, never in params)', () => {
  it('lookupInvitationRequest posts { token } to /invitations/lookup against the preview contract', () => {
    const req = lookupInvitationRequest(A_TOKEN);

    expect(req.method).toBe('POST');
    expect(req.path).toBe(INVITATION_LOOKUP_PATH);
    expect(req.body).toEqual({ token: A_TOKEN });
    expect(req.params).toBeUndefined();
    expect(req.contract).toBe(invitationPreviewContract);
    expect(buildRequestUrl(req)).toBe('/api/bff/invitations/lookup');
  });

  it('acceptInvitationRequest posts { token } to /invitations/accept against the accept response contract', () => {
    const req = acceptInvitationRequest(A_TOKEN);

    expect(req.method).toBe('POST');
    expect(req.path).toBe(INVITATION_ACCEPT_PATH);
    expect(req.body).toEqual({ token: A_TOKEN });
    expect(req.params).toBeUndefined();
    expect(req.contract).toBe(acceptInvitationResponseContract);
    expect(buildRequestUrl(req)).toBe('/api/bff/invitations/accept');
  });

  it('GC-K: no template in this module carries a token placeholder, and the token is in no URL', () => {
    for (const path of [INVITATIONS_PATH, INVITATION_PATH, INVITATION_LOOKUP_PATH, INVITATION_ACCEPT_PATH, WORKSPACE_BY_ID_PATH]) {
      expect(path).not.toMatch(/:token/);
    }

    for (const url of [buildRequestUrl(lookupInvitationRequest(A_TOKEN)), buildRequestUrl(acceptInvitationRequest(A_TOKEN))]) {
      expect(url).not.toContain(A_TOKEN);
      expect(url).not.toContain('0f8fad5b');
    }
  });

  it('createInvitationRequest posts the body to /invitations against invitationContract', () => {
    const body = { email: 'x@example.com', workspaces: [{ workspaceId: A_WORKSPACE_ID, workspaceRole: 'member' as const }] };
    const req = createInvitationRequest(body);

    expect(req).toMatchObject({ method: 'POST', path: INVITATIONS_PATH, body });
    expect(req.contract).toBe(invitationContract);
  });

  it('listInvitationsRequest is GET /invitations?workspaceId= against the list contract', () => {
    const req = listInvitationsRequest(A_WORKSPACE_ID);

    expect(req.method).toBe('GET');
    expect(req.path).toBe(INVITATIONS_PATH);
    expect(req.query).toEqual({ workspaceId: A_WORKSPACE_ID });
    expect(req.contract).toBe(invitationListResponseContract);
    expect(buildRequestUrl(req)).toBe(`/api/bff/invitations?workspaceId=${A_WORKSPACE_ID}`);
  });

  it('revokeInvitationRequest is DELETE /invitations/:id with the id in params', () => {
    const req = revokeInvitationRequest(AN_INVITATION_ID);

    expect(req.method).toBe('DELETE');
    expect(req.path).toBe(INVITATION_PATH);
    expect(req.params).toEqual({ id: AN_INVITATION_ID });
    expect(req.contract).toBe(invitationContract);
    expect(buildRequestUrl(req)).toBe(`/api/bff/invitations/${AN_INVITATION_ID}`);
  });

  it('getWorkspaceRequest is GET /workspaces/:workspaceId against workspaceContract', () => {
    const req = getWorkspaceRequest(A_WORKSPACE_ID);

    expect(req.method).toBe('GET');
    expect(req.path).toBe(WORKSPACE_BY_ID_PATH);
    expect(req.params).toEqual({ workspaceId: A_WORKSPACE_ID });
    expect(req.contract).toBe(workspaceContract);
    expect(buildRequestUrl(req)).toBe(`/api/bff/workspaces/${A_WORKSPACE_ID}`);
  });
});

describe('the route constants', () => {
  it('INVITATION_ACCEPT_ROUTE has one home (routes.ts) and is re-exported unchanged', () => {
    expect(INVITATION_ACCEPT_ROUTE).toBe('/invitations/accept');
    expect(INVITATION_ACCEPT_ROUTE).toBe(ROUTES_INVITATION_ACCEPT_ROUTE);
  });

  it('INVITATIONS_ROUTE builds the per-workspace invitations page path', () => {
    expect(INVITATIONS_ROUTE(A_WORKSPACE_ID)).toBe(`/workspaces/${A_WORKSPACE_ID}/invitations`);
  });

  it('INVITATION_TOKEN_STORAGE_KEY is the fixed sessionStorage key', () => {
    expect(INVITATION_TOKEN_STORAGE_KEY).toBe('shortkit.invitation.token');
  });
});

describe('invitationTokenFromHash reads #token=<raw> and admits only a well-formed token', () => {
  it('returns the token from a bare fragment', () => {
    expect(invitationTokenFromHash(`#token=${A_TOKEN}`)).toBe(A_TOKEN);
  });

  it('accepts the fragment without the leading # and with sibling pairs', () => {
    expect(invitationTokenFromHash(`token=${A_TOKEN}`)).toBe(A_TOKEN);
    expect(invitationTokenFromHash(`#a=1&token=${A_TOKEN}&b=2`)).toBe(A_TOKEN);
  });

  it('returns null for an empty, absent or malformed token', () => {
    expect(invitationTokenFromHash('')).toBeNull();
    expect(invitationTokenFromHash('#')).toBeNull();
    expect(invitationTokenFromHash('#other=1')).toBeNull();
    expect(invitationTokenFromHash('#token=')).toBeNull();
    expect(invitationTokenFromHash('#token=not-a-token')).toBeNull();
    // Right length, wrong alphabet in the uuid half.
    expect(invitationTokenFromHash(`#token=${A_TOKEN.replace('0f8fad5b', 'ZZZZZZZZ')}`)).toBeNull();
  });
});

describe('the sessionStorage helpers (D-04, D-14: the token survives a sign-in round-trip)', () => {
  it('store / read / clear round-trip under the fixed key', () => {
    expect(readStoredInvitationToken()).toBeNull();

    storeInvitationToken(A_TOKEN);
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBe(A_TOKEN);
    expect(readStoredInvitationToken()).toBe(A_TOKEN);

    clearStoredInvitationToken();
    expect(readStoredInvitationToken()).toBeNull();
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('read admits only a well-formed token, so a tampered store value is not posted', () => {
    window.sessionStorage.setItem(INVITATION_TOKEN_STORAGE_KEY, 'garbage');

    expect(readStoredInvitationToken()).toBeNull();
  });
});

describe('classifyInvitationError: one kind per code, keyed by code and never by status', () => {
  const api = (code: ErrorCode, extra: { details?: unknown; retryAfterSeconds?: number } = {}): ApiError =>
    new ApiError({ code, status: ERROR_CODE_STATUS[code], message: 'x', ...extra });

  it('maps the five invitation outcomes', () => {
    expect(classifyInvitationError(api('not_found'))).toEqual({ kind: 'not_found' });
    expect(classifyInvitationError(api('invitation_already_accepted'))).toEqual({ kind: 'already_accepted' });
    expect(classifyInvitationError(api('invitation_tenant_conflict'))).toEqual({ kind: 'tenant_conflict' });
    expect(classifyInvitationError(api('invitation_expired'))).toEqual({ kind: 'expired' });
    expect(classifyInvitationError(api('invitation_revoked'))).toEqual({ kind: 'revoked' });
  });

  it('rate_limited carries retryAfterSeconds when the client normalised one, and undefined otherwise', () => {
    expect(classifyInvitationError(api('rate_limited', { retryAfterSeconds: 12 }))).toEqual({ kind: 'rate_limited', retryAfterSeconds: 12 });
    expect(classifyInvitationError(api('rate_limited'))).toEqual({ kind: 'rate_limited', retryAfterSeconds: undefined });
  });

  it('unauthenticated is its own kind (the session ended mid-flow)', () => {
    expect(classifyInvitationError(api('unauthenticated'))).toEqual({ kind: 'unauthenticated' });
  });

  it('validation_failed carries the field errors when the details parse, and an empty record otherwise', () => {
    expect(
      classifyInvitationError(api('validation_failed', { details: { fieldErrors: { email: ['Enter a valid address.'] } } })),
    ).toEqual({ kind: 'validation', fieldErrors: { email: ['Enter a valid address.'] } });
    expect(classifyInvitationError(api('validation_failed'))).toEqual({ kind: 'validation', fieldErrors: {} });
  });

  it('a caller-initiated abort is its own kind, so an unmount race renders nothing', () => {
    expect(classifyInvitationError(new RequestAbortedError('POST', '/invitations/lookup'))).toEqual({ kind: 'aborted' });
  });

  it('everything else is unknown: another code, a transport failure, a contract violation, a plain Error', () => {
    expect(classifyInvitationError(api('internal_error'))).toEqual({ kind: 'unknown' });
    expect(classifyInvitationError(api('insufficient_workspace_role'))).toEqual({ kind: 'unknown' });
    expect(classifyInvitationError(new NetworkError('Request to POST /x could not be sent.', '/x'))).toEqual({ kind: 'unknown' });
    expect(classifyInvitationError(new ContractViolationError('POST', '/x', []))).toEqual({ kind: 'unknown' });
    expect(classifyInvitationError(new Error('anything'))).toEqual({ kind: 'unknown' });
  });

  it('keys on code, not status: a not_found envelope at an unexpected status is still not_found', () => {
    expect(classifyInvitationError(new ApiError({ code: 'not_found', status: 400, message: 'x' }))).toEqual({ kind: 'not_found' });
  });
});

describe('classifyInvitationScreenError', () => {
  it('maps the two 403 codes to forbidden and defers everything else to the shared classifier', () => {
    expect(classifyInvitationScreenError(new ApiError({ code: 'insufficient_workspace_role', status: 403, message: 'x' }))).toEqual({
      kind: 'forbidden',
    });
    expect(classifyInvitationScreenError(new ApiError({ code: 'insufficient_tenant_role', status: 403, message: 'x' }))).toEqual({
      kind: 'forbidden',
    });
    expect(classifyInvitationScreenError(new ApiError({ code: 'not_found', status: 404, message: 'x' }))).toEqual({ kind: 'not_found' });
    expect(classifyInvitationScreenError(new Error('boom'))).toEqual({ kind: 'unknown' });
  });
});
