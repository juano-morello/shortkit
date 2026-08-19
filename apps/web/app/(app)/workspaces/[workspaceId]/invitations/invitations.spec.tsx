/**
 * TASK-1b-14 (STORY-1b-05, AC-1b-29). The per-workspace invitations page at
 * `/workspaces/[workspaceId]/invitations`.
 *
 * The page is an async server component: jsdom cannot render it, so the page function is
 * awaited for its element (with `next/headers` mocked, as `workspaces.spec.tsx` does) and
 * the element — the client `<InvitationsScreen>` under the page's heading — is rendered.
 * `requireAuth`, `serverApiClient` and `notFound` are wrapped through `vi.mock` so the CALL
 * ORDER can be asserted (redirect-before-fetch; workspace-before-list) and the initial data
 * answered without a network. The browser legs (`apiClient`) go through a `fetch` spy
 * routed by URL.
 *
 * Invariants kept here: an unauthenticated visitor is redirected before any fetch; a
 * workspace the caller cannot read (404) or cannot administer (403) renders not-found with
 * nothing of the workspace in the output; an invite success re-fetches and announces; a
 * revoke sends one DELETE and re-fetches; the invited address reaches request BODIES only,
 * never a URL.
 *
 * Contract: docs/contracts/workspace-authorization.md, docs/contracts/invitation-tokens.md,
 * docs/contracts/workspaces.md, docs/contracts/web-api-client.md.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Invitation, Workspace } from '@shortkit/contracts';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import type * as ApiClientModule from '../../../../../src/lib/api/client';
import type * as SessionModule from '../../../../../src/lib/session/session';

const { calls, cookieStore, notFound, redirect, replace, serverApiClientMock } = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly digest: string;

    constructor(public readonly url: string) {
      super(`redirect:${url}`);
      this.digest = `NEXT_REDIRECT;replace;${url};307;`;
    }
  }

  class NotFoundSignal extends Error {
    readonly digest = 'NEXT_HTTP_ERROR_FALLBACK;404';

    constructor() {
      super('not-found');
    }
  }

  return {
    calls: [] as string[],
    cookieStore: { get: vi.fn<(name: string) => { value: string } | undefined>() },
    notFound: vi.fn<() => never>(() => {
      calls.push('notFound');

      throw new NotFoundSignal();
    }),
    redirect: vi.fn<(url: string) => never>((url: string) => {
      throw new RedirectSignal(url);
    }),
    replace: vi.fn<(url: string) => void>(),
    serverApiClientMock: vi.fn<(req: unknown) => Promise<unknown>>(),
  };
});

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve({ get: () => null }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  redirect: (url: string) => redirect(url),
  notFound: () => notFound(),
}));

vi.mock('../../../../../src/lib/session/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();

  return {
    ...actual,
    requireAuth: vi.fn(() => {
      calls.push('requireAuth');

      return actual.requireAuth();
    }),
  };
});

vi.mock('../../../../../src/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();

  return {
    ...actual,
    serverApiClient: vi.fn((req: unknown) => {
      const { method, path } = req as { method: string; path: string };
      calls.push(`serverApiClient ${method} ${path}`);

      return serverApiClientMock(req);
    }),
  };
});

import InvitationsPage from './page';
import { INVITATIONS_SCREEN_MESSAGES, signInAfterExpiryUrl } from './invitations-screen';
import { RETURN_TO_PARAM, WORKSPACES_ROUTE } from '../../../../../src/components/auth/routes';
import { INVITE_FORM_MESSAGES } from '../../../../../src/components/invitations/invite-form';
import { INVITATIONS_ROUTE } from '../../../../../src/components/invitations/invitations-api';
import { STATE_LABELS } from '../../../../../src/components/invitations/invitations-list';
import { ApiError, SERVER_COMPONENT_REFRESH_PATH } from '../../../../../src/lib/api/client';
import { ACCESS_COOKIE, SIGN_IN_ROUTE } from '../../../../../src/lib/session/session';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const FAR_FUTURE = 4_102_444_800; // 2100-01-01
const T0 = '2026-08-17T10:00:00.000Z';
const INVITEE = 'new.teammate@client.test';

function jwtWith(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');

  return `header.${payload}.signature`;
}

const SIGNED_IN_JWT = jwtWith({
  sub: 'user_1',
  email: 'operator@agency.test',
  ev: true,
  exp: FAR_FUTURE,
  iat: 1,
  iss: 'shortkit',
  aud: 'shortkit',
});

const ACME: Workspace = {
  id: WORKSPACE_ID,
  name: 'Acme Secret Client',
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
  workspaceRole: 'workspace_admin',
};

function invitation(overrides: Partial<Invitation> & Pick<Invitation, 'id' | 'email'>): Invitation {
  return {
    state: 'pending',
    workspaces: [{ workspaceId: WORKSPACE_ID, workspaceName: ACME.name, workspaceRole: 'member' }],
    expiresAt: '2999-01-01T00:00:00.000Z',
    createdAt: T0,
    acceptedAt: null,
    revokedAt: null,
    invitedByUserId: 'user_1',
    acceptedByUserId: null,
    ...overrides,
  };
}

const PENDING = invitation({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'pending@client.test' });
const STALE = invitation({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  email: 'stale@client.test',
  createdAt: '2020-01-01T00:00:00.000Z',
  expiresAt: '2020-01-08T00:00:00.000Z',
});
const CREATED = invitation({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', email: INVITEE });

const INVITATIONS_URL = `/api/bff/invitations?workspaceId=${WORKSPACE_ID}`;
const CREATE_URL = '/api/bff/invitations';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

type Route = (init: RequestInit) => Response | Promise<Response>;

let fetchMock: MockInstance<typeof fetch>;
let routes: Record<string, Route>;

/** One `fetch` implementation routed by `METHOD url`, so a test declares only the legs it exercises. */
function routeFetch(overrides: Record<string, Route>): void {
  routes = {
    [`GET ${INVITATIONS_URL}`]: () => jsonResponse(200, { items: [PENDING] }),
    ...overrides,
  };
  fetchMock.mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[`${init?.method ?? 'GET'} ${url}`];

    if (route === undefined) {
      return Promise.reject(new TypeError(`unrouted fetch: ${init?.method ?? 'GET'} ${url}`));
    }

    return Promise.resolve(route(init ?? {}));
  });
}

function fetchCalls(): { method: string; url: string; init: RequestInit }[] {
  return fetchMock.mock.calls.map(([input, init]) => ({
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    url: String(input),
    init: (init as RequestInit | undefined) ?? {},
  }));
}

function signedIn(): void {
  cookieStore.get.mockImplementation((name: string) => (name === ACCESS_COOKIE ? { value: SIGNED_IN_JWT } : undefined));
}

async function renderPage(workspaceId: string = WORKSPACE_ID): Promise<void> {
  const element = (await InvitationsPage({ params: Promise.resolve({ workspaceId }) })) as ReactElement;
  render(element);
}

async function pageRejection(workspaceId: string = WORKSPACE_ID): Promise<unknown> {
  try {
    await InvitationsPage({ params: Promise.resolve({ workspaceId }) });
  } catch (error: unknown) {
    return error;
  }

  throw new Error('the page did not throw');
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: /^invitations$/i })).getAllByRole('listitem');
}

function invite(email: string): void {
  fireEvent.change(screen.getByLabelText(/^email address$/i), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: /^send invitation$/i }));
}

/** The address travels in request BODIES only; the sweep covers every fetch URL and the document URL. */
function expectAddressInNoUrl(): void {
  for (const { url } of fetchCalls()) {
    expect(url).not.toContain('teammate');
    expect(url).not.toContain('%40');
  }
  expect(window.location.href).not.toContain('teammate');
}

beforeEach(() => {
  calls.length = 0;
  cookieStore.get.mockReset();
  cookieStore.get.mockReturnValue(undefined);
  redirect.mockClear();
  notFound.mockClear();
  replace.mockClear();
  serverApiClientMock.mockReset();
  serverApiClientMock.mockImplementation((req: unknown) => {
    const { path } = req as { path: string };

    if (path === '/workspaces/:workspaceId') {
      return Promise.resolve(ACME);
    }

    return Promise.resolve({ items: [PENDING, STALE] });
  });
  fetchMock = vi.spyOn(globalThis, 'fetch');
  routeFetch({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invitations page: protection is server-side and comes first', () => {
  it('with no session it redirects to the sign-in screen before any data is fetched', async () => {
    const error = await pageRejection();

    expect((error as { url?: string }).url).toBe(SIGN_IN_ROUTE);
    expect(serverApiClientMock).not.toHaveBeenCalled();
    expect(calls).toEqual(['requireAuth']);
  });

  it('with a session it calls requireAuth, then fetches the workspace, then its invitations, in that order', async () => {
    signedIn();
    await renderPage();

    expect(calls).toEqual(['requireAuth', 'serverApiClient GET /workspaces/:workspaceId', 'serverApiClient GET /invitations']);
    const [workspaceReq, listReq] = serverApiClientMock.mock.calls.map(([req]) => req as { params?: unknown; query?: unknown });
    expect(workspaceReq.params).toEqual({ workspaceId: WORKSPACE_ID });
    expect(listReq.query).toEqual({ workspaceId: WORKSPACE_ID });
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe('invitations page: a workspace the caller cannot read or cannot administer', () => {
  it.each([
    ['not_found', 404],
    ['insufficient_workspace_role', 403],
  ])('%s on the workspace fetch renders not-found and never fetches the list', async (code, status) => {
    signedIn();
    serverApiClientMock.mockRejectedValueOnce(new ApiError({ code: code as 'not_found', status, message: 'x' }));

    const error = await pageRejection();

    expect((error as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(calls).toEqual(['requireAuth', 'serverApiClient GET /workspaces/:workspaceId', 'notFound']);
    // Nothing of the workspace reached the output.
    expect(document.body.textContent).not.toContain('Secret');
  });

  it('a member (403 on the list, 200 on the workspace) renders the same not-found', async () => {
    signedIn();
    serverApiClientMock.mockImplementation((req: unknown) => {
      const { path } = req as { path: string };

      return path === '/workspaces/:workspaceId'
        ? Promise.resolve({ ...ACME, workspaceRole: 'member' })
        : Promise.reject(new ApiError({ code: 'insufficient_workspace_role', status: 403, message: 'x' }));
    });

    const error = await pageRejection();

    expect((error as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(document.body.textContent).not.toContain('Secret');
  });

  it('a workspace id that is not a uuid is not-found without a request', async () => {
    signedIn();

    const error = await pageRejection('..');

    expect((error as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(serverApiClientMock).not.toHaveBeenCalled();
  });
});

describe('invitations page: a session the API refuses', () => {
  it('unauthenticated from the API redirects to sign in with a return path to this page', async () => {
    signedIn();
    serverApiClientMock.mockRejectedValueOnce(new ApiError({ code: 'unauthenticated', status: 401, message: 'x' }));

    const error = await pageRejection();
    expect((error as { url?: string }).url).toBe(signInAfterExpiryUrl(WORKSPACE_ID));
    expect(signInAfterExpiryUrl(WORKSPACE_ID)).toBe(
      `${SIGN_IN_ROUTE}?${RETURN_TO_PARAM}=${encodeURIComponent(INVITATIONS_ROUTE(WORKSPACE_ID))}`,
    );
  });

  it('the token_expired refresh bounce is re-issued with a return path to this page', async () => {
    signedIn();
    serverApiClientMock.mockImplementationOnce(() => redirect(SERVER_COMPONENT_REFRESH_PATH));

    const error = await pageRejection();
    expect((error as { url?: string }).url).toBe(
      `${SERVER_COMPONENT_REFRESH_PATH}?${RETURN_TO_PARAM}=${encodeURIComponent(INVITATIONS_ROUTE(WORKSPACE_ID))}`,
    );
  });

  it('any other failure of the initial fetch is not swallowed', async () => {
    signedIn();
    serverApiClientMock.mockRejectedValueOnce(new ApiError({ code: 'internal_error', status: 500, message: 'x' }));

    const error = await pageRejection();
    expect(error).toBeInstanceOf(ApiError);
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe('invitations page: what it renders', () => {
  it('a level-1 heading with the workspace name, a back link, the form, one live region, and the list with derived states', async () => {
    signedIn();
    await renderPage();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(ACME.name);
    expect(screen.getByRole('link', { name: /back to workspaces/i }).getAttribute('href')).toBe(WORKSPACES_ROUTE);
    expect(screen.getByLabelText(/^email address$/i)).toBeTruthy();
    expect(screen.getByLabelText(/^role$/i)).toBeTruthy();

    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].getAttribute('aria-live')).toBe('polite');
    expect(statuses[0].textContent).toBe('');

    const items = rows();
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('[data-state]')?.textContent).toBe(STATE_LABELS.pending);
    // Pending on the API, past its expiresAt: the screen says Expired and offers no Revoke.
    expect(items[1].querySelector('[data-state]')?.textContent).toBe(STATE_LABELS.expired);
    expect(screen.getByRole('button', { name: 'Revoke pending@client.test' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke stale@client.test' })).toBeNull();
    // Nothing fetched in the browser on mount: the server data is the initial state.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with no invitations it renders the empty state with the form and no list', async () => {
    signedIn();
    serverApiClientMock.mockImplementation((req: unknown) =>
      Promise.resolve((req as { path: string }).path === '/workspaces/:workspaceId' ? ACME : { items: [] }),
    );
    await renderPage();

    expect(screen.getByText(INVITATIONS_SCREEN_MESSAGES.empty)).toBeTruthy();
    expect(screen.queryByRole('list', { name: /^invitations$/i })).toBeNull();
    expect(screen.getByLabelText(/^email address$/i)).toBeTruthy();
  });

  it('an archived workspace says invitations cannot be sent and hides the form', async () => {
    signedIn();
    serverApiClientMock.mockImplementation((req: unknown) =>
      Promise.resolve(
        (req as { path: string }).path === '/workspaces/:workspaceId'
          ? { ...ACME, archivedAt: '2026-08-18T09:00:00.000Z' }
          : { items: [PENDING] },
      ),
    );
    await renderPage();

    expect(screen.getByText(INVITATIONS_SCREEN_MESSAGES.archived)).toBeTruthy();
    expect(screen.queryByLabelText(/^email address$/i)).toBeNull();
    expect(rows()).toHaveLength(1);
  });
});

describe('invitations page: invite', () => {
  it('a success re-fetches the list, shows the new row and announces it — the address in bodies only', async () => {
    signedIn();
    routeFetch({
      [`POST ${CREATE_URL}`]: () => jsonResponse(201, CREATED),
      [`GET ${INVITATIONS_URL}`]: () => jsonResponse(200, { items: [CREATED, PENDING, STALE] }),
    });
    await renderPage();

    invite(INVITEE);

    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    expect(rows()[0].textContent).toContain(INVITEE);
    expect(screen.getByRole('status').textContent).toBe(INVITATIONS_SCREEN_MESSAGES.sent(INVITEE));

    const sent = fetchCalls();
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([`POST ${CREATE_URL}`, `GET ${INVITATIONS_URL}`]);
    expect(JSON.parse(String(sent[0].init.body))).toEqual({
      email: INVITEE,
      workspaces: [{ workspaceId: WORKSPACE_ID, workspaceRole: 'member' }],
    });
    expectAddressInNoUrl();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a validation failure lands under the field and nothing is re-fetched or announced', async () => {
    signedIn();
    routeFetch({
      [`POST ${CREATE_URL}`]: () =>
        jsonResponse(400, {
          code: 'validation_failed',
          message: 'Validation failed.',
          details: { fieldErrors: { email: ['That address cannot be invited.'] } },
        }),
    });
    await renderPage();

    invite(INVITEE);

    await screen.findByText('That address cannot be invited.');
    expect(screen.getByLabelText(/^email address$/i).getAttribute('aria-invalid')).toBe('true');
    expect(fetchCalls()).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('');
    expect(rows()).toHaveLength(2);
  });

  it('a 403 says this account cannot invite here', async () => {
    signedIn();
    routeFetch({
      [`POST ${CREATE_URL}`]: () => jsonResponse(403, { code: 'insufficient_workspace_role', message: 'x' }),
    });
    await renderPage();

    invite(INVITEE);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITE_FORM_MESSAGES.forbidden);
    expect(fetchCalls()).toHaveLength(1);
  });

  it('a 401 mid-use navigates to sign-in with a return path to this page', async () => {
    signedIn();
    routeFetch({
      [`POST ${CREATE_URL}`]: () => jsonResponse(401, { code: 'unauthenticated', message: 'x' }),
    });
    await renderPage();

    invite(INVITEE);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(signInAfterExpiryUrl(WORKSPACE_ID));
    });
  });
});

describe('invitations page: revoke', () => {
  it('Revoke → Cancel sends nothing; Revoke → Confirm sends one DELETE, re-fetches and announces', async () => {
    signedIn();
    const revoked = { ...PENDING, state: 'revoked' as const, revokedAt: '2026-08-20T12:00:00.000Z' };
    routeFetch({
      [`DELETE /api/bff/invitations/${PENDING.id}`]: () => jsonResponse(200, revoked),
      [`GET ${INVITATIONS_URL}`]: () => jsonResponse(200, { items: [revoked, STALE] }),
    });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke pending@client.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel revoking pending@client.test' }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke pending@client.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoking pending@client.test' }));

    await waitFor(() => {
      expect(rows()[0].querySelector('[data-state]')?.textContent).toBe(STATE_LABELS.revoked);
    });
    expect(screen.queryByRole('button', { name: /^revoke /i })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(INVITATIONS_SCREEN_MESSAGES.revoked('pending@client.test'));
    expect(fetchCalls().map(({ method, url }) => `${method} ${url}`)).toEqual([
      `DELETE /api/bff/invitations/${PENDING.id}`,
      `GET ${INVITATIONS_URL}`,
    ]);
    // Focus lands on the announcement: the Revoke control that had it is gone. The move is
    // an effect, flushed in a later task than the commit the wait above settled on, so this
    // waits for the move rather than reading the gap between commit and effect.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('status'));
    });
  });

  it('409 already accepted re-fetches and says so', async () => {
    signedIn();
    const accepted = { ...PENDING, state: 'accepted' as const, acceptedAt: '2026-08-20T12:00:00.000Z', acceptedByUserId: 'user_new' };
    routeFetch({
      [`DELETE /api/bff/invitations/${PENDING.id}`]: () => jsonResponse(409, { code: 'invitation_already_accepted', message: 'x' }),
      [`GET ${INVITATIONS_URL}`]: () => jsonResponse(200, { items: [accepted, STALE] }),
    });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke pending@client.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoking pending@client.test' }));

    await waitFor(() => {
      expect(rows()[0].querySelector('[data-state]')?.textContent).toBe(STATE_LABELS.accepted);
    });
    expect(screen.getByRole('status').textContent).toBe(INVITATIONS_SCREEN_MESSAGES.alreadyAccepted);
  });

  it('404 re-fetches and says the invitation is gone', async () => {
    signedIn();
    routeFetch({
      [`DELETE /api/bff/invitations/${PENDING.id}`]: () => jsonResponse(404, { code: 'not_found', message: 'x' }),
      [`GET ${INVITATIONS_URL}`]: () => jsonResponse(200, { items: [STALE] }),
    });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke pending@client.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoking pending@client.test' }));

    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    expect(screen.getByRole('status').textContent).toBe(INVITATIONS_SCREEN_MESSAGES.gone);
  });

  it('403 says this account cannot revoke here, and the row stays', async () => {
    signedIn();
    routeFetch({
      [`DELETE /api/bff/invitations/${PENDING.id}`]: () => jsonResponse(403, { code: 'insufficient_workspace_role', message: 'x' }),
    });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke pending@client.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoking pending@client.test' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITATIONS_SCREEN_MESSAGES.forbidden);
    expect(rows()).toHaveLength(2);
    expect(fetchCalls()).toHaveLength(1);
  });

  it('a re-fetch that fails after a revoke that succeeded keeps the rows and offers a reload', async () => {
    signedIn();
    const revoked = { ...PENDING, state: 'revoked' as const, revokedAt: '2026-08-20T12:00:00.000Z' };
    let listCalls = 0;
    routeFetch({
      [`DELETE /api/bff/invitations/${PENDING.id}`]: () => jsonResponse(200, revoked),
      [`GET ${INVITATIONS_URL}`]: () => {
        listCalls += 1;

        return listCalls === 1
          ? jsonResponse(500, { code: 'internal_error', message: 'x' })
          : jsonResponse(200, { items: [revoked, STALE] });
      },
    });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke pending@client.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoking pending@client.test' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITATIONS_SCREEN_MESSAGES.refreshFailed);
    expect(rows()).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /reload the list/i }));

    await waitFor(() => {
      expect(rows()[0].querySelector('[data-state]')?.textContent).toBe(STATE_LABELS.revoked);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(INVITATIONS_SCREEN_MESSAGES.reloaded);
  });
});
