/**
 * TASK-013 (STORY-004). The requests the workspace screen issues, the query parameter the
 * page reads, and the copy its errors render — in one module so the server page, the client
 * list, the create form and the row agree on every string, and so TASK-017's compose check
 * can read the exact paths off one file.
 *
 * Contract: docs/contracts/workspaces.md ("Endpoints"), docs/contracts/error-envelope.md,
 *   docs/contracts/web-api-client.md (Client: route templates, `ApiRequest`, `ApiError`).
 * ADR: adr-0029 (route templates are source literals; a caller value goes in `params`),
 *   adr-0014 (the browser reaches the API through the BFF, the server component directly).
 *
 * The four requests, as the wire sees them:
 *
 *   browser (apiClient)                          server component (serverApiClient)
 *   GET   /api/bff/workspaces                    GET   {API_BASE_URL}/workspaces
 *   GET   /api/bff/workspaces?includeArchived=true                       ?includeArchived=true
 *   POST  /api/bff/workspaces         {name}
 *   PATCH /api/bff/workspaces/:id     {name}
 *   POST  /api/bff/workspaces/:id/archive
 *
 * `includeArchived` is sent only when it is `true`; absent means `false` on the API side
 * (workspaces.md, "`includeArchived`"), so the default list is the bare path.
 *
 * NO MODULE HERE READS A COOKIE OR HOLDS A TOKEN. The two clients carry the session.
 */
import {
  createWorkspaceRequestContract,
  renameWorkspaceRequestContract,
  validationDetailsContract,
  workspaceContract,
  workspaceListResponseContract,
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_NAME_MIN_LENGTH,
} from '@shortkit/contracts';
import type { CreateWorkspaceRequest, RenameWorkspaceRequest, Workspace, WorkspaceListResponse } from '@shortkit/contracts';

import { ApiError, RequestAbortedError } from '../../lib/api/client';
import type { ApiRequest } from '../../lib/api/client';
import { RETURN_TO_PARAM, SIGN_IN_ROUTE, WORKSPACES_ROUTE } from '../auth/routes';

/** Route templates (ADR-0029): literals, the id goes in `params`. */
export const WORKSPACES_PATH = '/workspaces';
export const WORKSPACE_PATH = '/workspaces/:id';
export const WORKSPACE_ARCHIVE_PATH = '/workspaces/:id/archive';

/**
 * `?archived=1` on `/workspaces` shows archived workspaces too. The page reads it, sends the
 * matching `includeArchived` to the API, and hands the flag to the client list, which
 * honours it on every re-fetch — so the server render and the browser's refreshes agree on
 * what "archived" means (TASK-013 card; AC-23 is the API's rule, this only exposes it).
 */
export const ARCHIVED_PARAM = 'archived';
export const ARCHIVED_VALUE = '1';

/** The list URL with archived workspaces shown, and the default one. */
export const WORKSPACES_WITH_ARCHIVED_URL = `${WORKSPACES_ROUTE}?${ARCHIVED_PARAM}=${ARCHIVED_VALUE}`;

/**
 * Where a session that expired mid-use is sent: sign in, then straight back here. The
 * sign-in page vets `returnTo` (same-origin relative only) before following it.
 */
export const SIGN_IN_AFTER_EXPIRY_URL = `${SIGN_IN_ROUTE}?${RETURN_TO_PARAM}=${WORKSPACES_ROUTE}`;

export function listWorkspacesRequest(includeArchived: boolean): ApiRequest<WorkspaceListResponse> {
  return {
    method: 'GET',
    path: WORKSPACES_PATH,
    query: includeArchived ? { includeArchived: 'true' } : undefined,
    contract: workspaceListResponseContract,
  };
}

export function createWorkspaceRequest(body: CreateWorkspaceRequest): ApiRequest<Workspace, CreateWorkspaceRequest> {
  return { method: 'POST', path: WORKSPACES_PATH, body, contract: workspaceContract };
}

export function renameWorkspaceRequest(id: string, body: RenameWorkspaceRequest): ApiRequest<Workspace, RenameWorkspaceRequest> {
  return { method: 'PATCH', path: WORKSPACE_PATH, params: { id }, body, contract: workspaceContract };
}

export function archiveWorkspaceRequest(id: string): ApiRequest<Workspace> {
  return { method: 'POST', path: WORKSPACE_ARCHIVE_PATH, params: { id }, contract: workspaceContract };
}

/**
 * The client-side check IS the shared contract's `safeParse` (the same object goes on the
 * wire), so `create` and `rename` refuse exactly what the API refuses, one round-trip
 * earlier. Returns the trimmed body, or `null` when the name breaks the rule.
 */
export function parseWorkspaceName(name: string, purpose: 'create' | 'rename'): { name: string } | null {
  const parsed =
    purpose === 'create'
      ? createWorkspaceRequestContract.safeParse({ name })
      : renameWorkspaceRequestContract.safeParse({ name });

  return parsed.success ? parsed.data : null;
}

/**
 * The copy, keyed by `ApiError.code` (TASK-013 card: "Error copy is driven by `code`") and
 * never by status. No message echoes a server string or a caller value verbatim.
 */
export const WORKSPACE_MESSAGES = {
  /** The client-side name rule; the numbers come from the contract's constants. */
  nameRule: `Use between ${String(WORKSPACE_NAME_MIN_LENGTH)} and ${String(WORKSPACE_NAME_MAX_LENGTH)} characters.`,
  validationFailed: 'That name was not accepted. Check it and try again.',
  generic: 'Something went wrong on our side. Try again in a moment.',
  refreshFailed: 'The change was saved, but the list could not be refreshed. Reload the list to see it.',
  gone: 'That workspace no longer exists.',
  reloaded: 'List reloaded.',
  created: (name: string): string => `Workspace ${name} created.`,
  renamed: (name: string): string => `Workspace renamed to ${name}.`,
  archived: (name: string): string => `Workspace ${name} archived.`,
} as const;

/**
 * What a failed request means to the screen. One classifier for create, rename and archive,
 * so the three controls cannot drift on which code does what:
 *
 *   field            validation_failed with a message under `name` -> under the input
 *   validation       validation_failed with nothing under `name`   -> one form-level line
 *   not_found        the row is stale                              -> refresh + WORKSPACE_MESSAGES.gone
 *   unauthenticated  the session expired mid-use                   -> SIGN_IN_AFTER_EXPIRY_URL
 *   aborted          the caller cancelled                          -> nothing to show
 *   generic          rate_limited, internal, transport, contract   -> WORKSPACE_MESSAGES.generic
 */
export type WorkspaceFailure =
  | { kind: 'field'; message: string }
  | { kind: 'validation' }
  | { kind: 'not_found' }
  | { kind: 'unauthenticated' }
  | { kind: 'aborted' }
  | { kind: 'generic' };

export function classifyWorkspaceError(error: unknown): WorkspaceFailure {
  if (error instanceof RequestAbortedError) {
    return { kind: 'aborted' };
  }

  if (!(error instanceof ApiError)) {
    // NetworkError, ContractViolationError, and anything else: one retry message.
    return { kind: 'generic' };
  }

  switch (error.code) {
    case 'validation_failed': {
      const details = validationDetailsContract.safeParse(error.details);
      const messages = details.success ? (details.data.fieldErrors.name ?? []) : [];

      return messages.length > 0 ? { kind: 'field', message: messages.join(' ') } : { kind: 'validation' };
    }
    case 'not_found':
      return { kind: 'not_found' };
    case 'unauthenticated':
      return { kind: 'unauthenticated' };
    default:
      return { kind: 'generic' };
  }
}
