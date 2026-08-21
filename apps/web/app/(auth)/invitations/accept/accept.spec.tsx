/**
 * TASK-1b-13 (STORY-1b-02 AC-1b-12; STORY-1b-03 AC-1b-16). The accept page, rendered in
 * jsdom with `fetch` mocked to answer the BFF's shapes (session projection, lookup, accept,
 * signup) and `next/navigation`'s `useRouter` mocked to observe navigation. The token is
 * placed in `location.hash` the way the email link puts it there.
 *
 * The invariant this spec keeps (GC-K, D-03): the raw token appears in `location.hash` on
 * first paint and in exactly three request BODIES (lookup, accept, signup): never in the
 * document URL after load, never in a fetch URL, never in an `href`, never in rendered text.
 *
 * Journeys (ruled 2026-08-18): a NEW address signs up here with the token; the API's hook
 * accepts on creation, the page clears the stored token, and signup lands on
 * `/sign-in?created=1` (default landing `/workspaces`). An EXISTING account follows "Sign
 * in" with `returnTo=/invitations/accept`, comes back, and presses Accept.
 *
 * Contract: docs/contracts/invitation-tokens.md, docs/contracts/web-api-client.md,
 * docs/contracts/error-envelope.md.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

const replace = vi.fn<(url: string) => void>();
const push = vi.fn<(url: string) => void>();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

import AcceptInvitationPage from './page';
import { ACCEPT_PAGE_MESSAGES, SIGN_IN_TO_ACCEPT_URL } from './accept-invitation';
import {
  INVITATION_ACCEPT_ROUTE,
  SIGN_IN_AFTER_INVITED_SIGNUP_URL,
  WORKSPACES_ROUTE,
} from '../../../../src/components/auth/routes';
import { INVITATION_MESSAGES } from '../../../../src/components/invitations/invitation-state-message';
import { INVITATION_TOKEN_STORAGE_KEY } from '../../../../src/components/invitations/invitations-api';

const A_TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const A_SECRET_HALF = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const SESSION_URL = '/api/bff/session';
const LOOKUP_URL = '/api/bff/invitations/lookup';
const ACCEPT_URL = '/api/bff/invitations/accept';
const SIGNUP_URL = '/api/bff/auth/sign-up/email';

const INVITEE_EMAIL = 'invitee@client.test';
const INVITER_EMAIL = 'owner@agency.test';
const SIGNED_IN_EMAIL = 'colleague@agency.test';

const PREVIEW = {
  email: INVITEE_EMAIL,
  tenantName: 'Acme Agency',
  inviterEmail: INVITER_EMAIL,
  workspaces: [
    { workspaceName: 'Client One', workspaceRole: 'member' },
    { workspaceName: 'Client Three', workspaceRole: 'viewer' },
  ],
  expiresAt: '2026-08-25T10:00:00.000Z',
};

const SIGNED_OUT = { user: null, status: 'unauthenticated' };
const SIGNED_IN = {
  user: { id: 'user_colleague', email: SIGNED_IN_EMAIL, emailVerified: true },
  status: 'authenticated',
};

const FRESH_USER = {
  id: 'user_fresh',
  name: 'Ada Invitee',
  email: INVITEE_EMAIL,
  emailVerified: false,
  createdAt: '2026-08-18T10:00:00.000Z',
  updatedAt: '2026-08-18T10:00:00.000Z',
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type Route = () => Response | Promise<Response>;

let fetchMock: MockInstance<typeof fetch>;
let routes: Record<string, Route>;

/** One `fetch` implementation routed by URL, so a test declares only the legs it exercises. */
function routeFetch(overrides: Record<string, Route>): void {
  routes = {
    [SESSION_URL]: () => jsonResponse(200, SIGNED_OUT),
    [LOOKUP_URL]: () => jsonResponse(200, PREVIEW),
    ...overrides,
  };
  fetchMock.mockImplementation((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[url];

    if (route === undefined) {
      return Promise.reject(new TypeError(`unrouted fetch: ${url}`));
    }

    return Promise.resolve(route());
  });
}

function callsTo(url: string): RequestInit[] {
  return fetchMock.mock.calls.filter(([input]) => input === url).map(([, init]) => init as RequestInit);
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function arriveWithFragment(token: string = A_TOKEN): void {
  window.history.replaceState(null, '', `${INVITATION_ACCEPT_ROUTE}#token=${token}`);
}

/** The GC-K sweep: the token is in no URL, no href, no rendered text: only in the bodies named. */
function expectTokenNowhereButBodies(): void {
  expect(window.location.href).not.toContain(A_SECRET_HALF);
  expect(window.location.hash).toBe('');
  for (const [input] of fetchMock.mock.calls) {
    expect(String(input)).not.toContain(A_SECRET_HALF);
  }
  for (const anchor of Array.from(document.querySelectorAll('a'))) {
    expect(anchor.getAttribute('href') ?? '').not.toContain(A_SECRET_HALF);
  }
  expect(document.body.textContent ?? '').not.toContain(A_SECRET_HALF);
}

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
  routeFetch({});
  replace.mockClear();
  push.mockClear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', INVITATION_ACCEPT_ROUTE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('accept page: the token comes from the fragment and goes nowhere but a body (AC-1b-12, D-03)', () => {
  it('reads #token=, strips the fragment, stores the token, and posts { token } to lookup', async () => {
    arriveWithFragment();

    render(<AcceptInvitationPage />);

    await waitFor(() => {
      expect(callsTo(LOOKUP_URL)).toHaveLength(1);
    });

    const [lookup] = callsTo(LOOKUP_URL);
    expect(lookup?.method).toBe('POST');
    expect(bodyOf(lookup as RequestInit)).toEqual({ token: A_TOKEN });

    expect(window.location.pathname).toBe(INVITATION_ACCEPT_ROUTE);
    expect(window.location.hash).toBe('');
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBe(A_TOKEN);

    await screen.findByText(/acme agency/i);
    expectTokenNowhereButBodies();
  });

  it('with no fragment, re-reads the token sessionStorage kept across the sign-in round-trip', async () => {
    window.sessionStorage.setItem(INVITATION_TOKEN_STORAGE_KEY, A_TOKEN);

    render(<AcceptInvitationPage />);

    await waitFor(() => {
      expect(callsTo(LOOKUP_URL)).toHaveLength(1);
    });
    expect(bodyOf(callsTo(LOOKUP_URL)[0] as RequestInit)).toEqual({ token: A_TOKEN });
  });

  it('with no fragment and nothing stored, shows the incomplete-link state and requests no lookup', async () => {
    render(<AcceptInvitationPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(ACCEPT_PAGE_MESSAGES.missing);
    expect(alert.getAttribute('data-invitation-state')).toBe('missing');
    expect(callsTo(LOOKUP_URL)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
  });

  it('a fragment that names a malformed token is the not-found copy with no request sent', async () => {
    arriveWithFragment('not-a-capability-token');

    render(<AcceptInvitationPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITATION_MESSAGES.notFound);
    expect(callsTo(LOOKUP_URL)).toHaveLength(0);
    expect(window.location.hash).toBe('');
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBeNull();
  });
});

describe('accept page: structure and accessibility', () => {
  it('renders a level-1 heading and a polite status region while the lookup is in flight', async () => {
    arriveWithFragment();
    routeFetch({ [LOOKUP_URL]: () => new Promise<Response>(() => undefined) });

    render(<AcceptInvitationPage />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/invitation/i);
    const status = await screen.findByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe(ACCEPT_PAGE_MESSAGES.checking);
  });

  it('a lookup failure moves focus to the alert', async () => {
    arriveWithFragment();
    routeFetch({ [LOOKUP_URL]: () => jsonResponse(410, { code: 'invitation_expired', message: 'Gone.' }) });

    render(<AcceptInvitationPage />);

    const alert = await screen.findByRole('alert');
    await waitFor(() => {
      expect(document.activeElement).toBe(alert);
    });
  });
});

describe('accept page: one render per lookup failure code (AC-1b-12)', () => {
  const cases: Array<[string, number, string, string, boolean]> = [
    ['not_found', 404, 'not_found', INVITATION_MESSAGES.notFound, true],
    ['already accepted', 409, 'invitation_already_accepted', INVITATION_MESSAGES.alreadyAccepted, true],
    ['expired', 410, 'invitation_expired', INVITATION_MESSAGES.expired, true],
    ['revoked', 410, 'invitation_revoked', INVITATION_MESSAGES.revoked, true],
    ['internal_error', 500, 'internal_error', INVITATION_MESSAGES.generic, false],
  ];

  for (const [label, status, code, message, clearsStorage] of cases) {
    it(`${label} renders its own copy, no form and no Accept control${clearsStorage ? ', and clears the stored token' : ''}`, async () => {
      arriveWithFragment();
      routeFetch({ [LOOKUP_URL]: () => jsonResponse(status, { code, message: 'server text' }) });

      render(<AcceptInvitationPage />);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(message);
      expect(alert.textContent).not.toContain('server text');
      expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
      expect(screen.queryByLabelText(/^password$/i)).toBeNull();
      expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBe(clearsStorage ? null : A_TOKEN);
      expectTokenNowhereButBodies();
    });
  }

  it('already accepted offers a sign-in link that carries no token', async () => {
    arriveWithFragment();
    routeFetch({
      [LOOKUP_URL]: () => jsonResponse(409, { code: 'invitation_already_accepted', message: 'Used.' }),
    });

    render(<AcceptInvitationPage />);

    await screen.findByRole('alert');
    const link = screen.getByRole('link', { name: /sign in/i });
    expect(link.getAttribute('href')).toBe('/sign-in');
  });

  it('rate_limited renders the retry copy with the seconds and a Try again control that re-runs the lookup', async () => {
    arriveWithFragment();
    let attempts = 0;
    routeFetch({
      [LOOKUP_URL]: () => {
        attempts += 1;

        return attempts === 1
          ? jsonResponse(429, { code: 'rate_limited', message: 'Slow down.' }, { 'retry-after': '30' })
          : jsonResponse(200, PREVIEW);
      },
    });

    render(<AcceptInvitationPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITATION_MESSAGES.rateLimited(30));
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBe(A_TOKEN);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await screen.findByText(/acme agency/i);
    expect(callsTo(LOOKUP_URL)).toHaveLength(2);
    expect(bodyOf(callsTo(LOOKUP_URL)[1] as RequestInit)).toEqual({ token: A_TOKEN });
  });
});

describe('accept page: the preview', () => {
  it('shows the tenant name, the inviter, the invited address, each workspace with its role, and the expiry', async () => {
    arriveWithFragment();

    render(<AcceptInvitationPage />);

    await screen.findByText(/acme agency/i);
    expect(screen.getByText(new RegExp(INVITER_EMAIL))).toBeTruthy();
    expect(screen.getByText(new RegExp(INVITEE_EMAIL))).toBeTruthy();

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toMatch(/client one/i);
    expect(items[0]?.textContent).toMatch(/member/i);
    expect(items[1]?.textContent).toMatch(/client three/i);
    expect(items[1]?.textContent).toMatch(/viewer/i);

    const time = document.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(PREVIEW.expiresAt);
    expect(time?.textContent?.trim()).not.toBe('');
  });
});

describe('accept page: signed out → create an account with the token, or sign in (AC-1b-12)', () => {
  it('renders the signup form; a submit posts invitationToken in the body, clears the stored token, and lands on sign-in (no returnTo: the hook already accepted)', async () => {
    arriveWithFragment();
    routeFetch({ [SIGNUP_URL]: () => jsonResponse(200, { user: FRESH_USER }) });

    render(<AcceptInvitationPage />);

    const name = await screen.findByLabelText(/^name$/i);
    fireEvent.change(name, { target: { value: 'Ada Invitee' } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: INVITEE_EMAIL } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(SIGN_IN_AFTER_INVITED_SIGNUP_URL);
    });

    const [signup] = callsTo(SIGNUP_URL);
    expect(bodyOf(signup as RequestInit)).toEqual({
      name: 'Ada Invitee',
      email: INVITEE_EMAIL,
      password: 'correct horse battery',
      invitationToken: A_TOKEN,
    });
    expect(SIGN_IN_AFTER_INVITED_SIGNUP_URL).toBe('/sign-in?created=1');
    // The API's signup hook accepted on user creation (D-18): the token is spent, so the
    // stored copy is cleared and sign-in lands on /workspaces, not back here.
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBeNull();
    expectTokenNowhereButBodies();
  });

  it('a failed signup keeps the stored token and the form, so the visitor can retry or sign in', async () => {
    arriveWithFragment();
    routeFetch({ [SIGNUP_URL]: () => jsonResponse(500, { code: 'internal_error', message: 'x' }) });

    render(<AcceptInvitationPage />);

    const name = await screen.findByLabelText(/^name$/i);
    fireEvent.change(name, { target: { value: 'Ada Invitee' } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: INVITEE_EMAIL } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await screen.findByRole('alert');
    expect(replace).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBe(A_TOKEN);
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
  });

  it('offers "Already have an account? Sign in" pointing back here (an existing member accepts through this page), and no Accept control', async () => {
    arriveWithFragment();

    render(<AcceptInvitationPage />);

    await screen.findByLabelText(/^password$/i);
    const link = screen.getByRole('link', { name: /sign in/i });
    expect(link.getAttribute('href')).toBe(SIGN_IN_TO_ACCEPT_URL);
    expect(SIGN_IN_TO_ACCEPT_URL).toBe('/sign-in?returnTo=/invitations/accept');
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull();
  });
});

describe('accept page: signed in → Accept posts the token and routes to the workspaces (AC-1b-16)', () => {
  it('shows an Accept control instead of the form; success clears the stored token and replaces to /workspaces', async () => {
    arriveWithFragment();
    routeFetch({
      [SESSION_URL]: () => jsonResponse(200, SIGNED_IN),
      [ACCEPT_URL]: () =>
        jsonResponse(200, { workspaces: [{ workspaceId: '11111111-1111-4111-8111-111111111111', workspaceRole: 'member' }] }),
    });

    render(<AcceptInvitationPage />);

    const accept = await screen.findByRole('button', { name: /accept invitation/i });
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();

    fireEvent.click(accept);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(WORKSPACES_ROUTE);
    });

    const [call] = callsTo(ACCEPT_URL);
    expect(call?.method).toBe('POST');
    expect(bodyOf(call as RequestInit)).toEqual({ token: A_TOKEN });
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBeNull();
    expectTokenNowhereButBodies();
  });

  it('after the sign-in round-trip (no fragment, token in storage) Accept posts the stored token', async () => {
    window.sessionStorage.setItem(INVITATION_TOKEN_STORAGE_KEY, A_TOKEN);
    routeFetch({
      [SESSION_URL]: () => jsonResponse(200, SIGNED_IN),
      [ACCEPT_URL]: () => jsonResponse(200, { workspaces: [] }),
    });

    render(<AcceptInvitationPage />);

    fireEvent.click(await screen.findByRole('button', { name: /accept invitation/i }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(WORKSPACES_ROUTE);
    });
    expect(bodyOf(callsTo(ACCEPT_URL)[0] as RequestInit)).toEqual({ token: A_TOKEN });
  });

  it('sends exactly one accept while a request is in flight; the control is aria-disabled, not disabled', async () => {
    arriveWithFragment();
    let resolveAccept: (value: Response) => void = () => undefined;
    routeFetch({
      [SESSION_URL]: () => jsonResponse(200, SIGNED_IN),
      [ACCEPT_URL]: () =>
        new Promise<Response>((resolve) => {
          resolveAccept = resolve;
        }),
    });

    render(<AcceptInvitationPage />);

    const accept = (await screen.findByRole('button', { name: /accept invitation/i })) as HTMLButtonElement;
    fireEvent.click(accept);
    fireEvent.click(accept);

    await waitFor(() => {
      expect(accept.getAttribute('aria-disabled')).toBe('true');
    });
    expect(accept.disabled).toBe(false);
    expect(callsTo(ACCEPT_URL)).toHaveLength(1);

    resolveAccept(jsonResponse(200, { workspaces: [] }));
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(WORKSPACES_ROUTE);
    });
  });

  it('409 tenant_conflict renders the other-agency copy, names no address, and keeps no Accept control', async () => {
    arriveWithFragment();
    routeFetch({
      [SESSION_URL]: () => jsonResponse(200, SIGNED_IN),
      [ACCEPT_URL]: () => jsonResponse(409, { code: 'invitation_tenant_conflict', message: 'Conflict.' }),
    });

    render(<AcceptInvitationPage />);

    fireEvent.click(await screen.findByRole('button', { name: /accept invitation/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITATION_MESSAGES.tenantConflict);
    expect(alert.textContent).not.toContain(SIGNED_IN_EMAIL);
    expect(alert.textContent).not.toContain(INVITEE_EMAIL);
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('429 on accept renders the retry copy with the seconds and keeps the preview and the Accept control', async () => {
    arriveWithFragment();
    routeFetch({
      [SESSION_URL]: () => jsonResponse(200, SIGNED_IN),
      [ACCEPT_URL]: () => jsonResponse(429, { code: 'rate_limited', message: 'Slow down.' }, { 'retry-after': '7' }),
    });

    render(<AcceptInvitationPage />);

    fireEvent.click(await screen.findByRole('button', { name: /accept invitation/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITATION_MESSAGES.rateLimited(7));
    expect(screen.getByRole('button', { name: /accept invitation/i })).toBeTruthy();
    expect(screen.getByText(/acme agency/i)).toBeTruthy();
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBe(A_TOKEN);
    await waitFor(() => {
      expect(document.activeElement).toBe(alert);
    });
  });

  it('401 unauthenticated mid-flow sends the visitor to sign in with returnTo and keeps the stored token', async () => {
    arriveWithFragment();
    routeFetch({
      [SESSION_URL]: () => jsonResponse(200, SIGNED_IN),
      [ACCEPT_URL]: () => jsonResponse(401, { code: 'unauthenticated', message: 'Sign in.' }),
    });

    render(<AcceptInvitationPage />);

    fireEvent.click(await screen.findByRole('button', { name: /accept invitation/i }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(SIGN_IN_TO_ACCEPT_URL);
    });
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBe(A_TOKEN);
  });

  it('a terminal accept failure (already accepted) replaces the preview with its copy and clears the stored token', async () => {
    arriveWithFragment();
    routeFetch({
      [SESSION_URL]: () => jsonResponse(200, SIGNED_IN),
      [ACCEPT_URL]: () => jsonResponse(409, { code: 'invitation_already_accepted', message: 'Used.' }),
    });

    render(<AcceptInvitationPage />);

    fireEvent.click(await screen.findByRole('button', { name: /accept invitation/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITATION_MESSAGES.alreadyAccepted);
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull();
    expect(window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY)).toBeNull();
  });
});
