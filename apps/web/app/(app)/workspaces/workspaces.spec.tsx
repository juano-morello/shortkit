/**
 * TASK-013 (STORY-004, AC-27; STORY-003 AC-19 and AC-16's reload clause). The workspace list
 * page at `/workspaces`.
 *
 * The page is an async server component: jsdom cannot render it, so the page function is
 * awaited for its element (with `next/headers` mocked, as `sign-in.spec.tsx` does) and the
 * element is rendered. `requireAuth` and `serverApiClient` are wrapped through `vi.mock` so
 * their CALL ORDER can be asserted — the card's rule is redirect-before-fetch, never
 * render-then-hide — and so the initial list can be answered without a network.
 *
 * Contract: docs/contracts/workspaces.md ("Endpoints"), docs/contracts/web-api-client.md.
 */
import { render, screen, within } from '@testing-library/react';
import type { Workspace } from '@shortkit/contracts';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClientModule from '../../../src/lib/api/client';
import type * as SessionModule from '../../../src/lib/session/session';

const { calls, cookieStore, redirect, serverApiClientMock } = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly digest: string;

    constructor(public readonly url: string) {
      super(`redirect:${url}`);
      // Next's own redirect error carries this digest; the page reads it to re-issue the
      // refresh bounce with a returnTo, so the mock has to look like the real thing.
      this.digest = `NEXT_REDIRECT;replace;${url};307;`;
    }
  }

  return {
    calls: [] as string[],
    cookieStore: { get: vi.fn<(name: string) => { value: string } | undefined>() },
    redirect: vi.fn<(url: string) => never>((url: string) => {
      throw new RedirectSignal(url);
    }),
    serverApiClientMock: vi.fn<(req: unknown) => Promise<unknown>>(),
  };
});

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve({ get: () => null }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  redirect: (url: string) => redirect(url),
}));

vi.mock('../../../src/lib/session/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();

  return {
    ...actual,
    requireAuth: vi.fn(() => {
      calls.push('requireAuth');

      return actual.requireAuth();
    }),
  };
});

vi.mock('../../../src/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();

  return {
    ...actual,
    serverApiClient: vi.fn((req: unknown) => {
      calls.push('serverApiClient');

      return serverApiClientMock(req);
    }),
  };
});

import WorkspacesPage from './page';
import { RETURN_TO_PARAM, WORKSPACES_ROUTE } from '../../../src/components/auth/routes';
import { ARCHIVED_PARAM, ARCHIVED_VALUE } from '../../../src/components/workspaces/workspaces-api';
import { ApiError, SERVER_COMPONENT_REFRESH_PATH } from '../../../src/lib/api/client';
import { ACCESS_COOKIE, SIGN_IN_ROUTE } from '../../../src/lib/session/session';

const T0 = '2026-08-17T10:00:00.000Z';
const FAR_FUTURE = 4_102_444_800; // 2100-01-01

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

function workspace(id: string, name: string, archivedAt: string | null = null): Workspace {
  return { id, name, archivedAt, createdAt: T0, updatedAt: T0 };
}

const ACME = workspace('11111111-1111-4111-8111-111111111111', 'Acme');
const BOLT = workspace('22222222-2222-4222-8222-222222222222', 'Bolt');
const OLD = workspace('33333333-3333-4333-8333-333333333333', 'Old client', '2026-08-18T09:00:00.000Z');

function signedIn(): void {
  cookieStore.get.mockImplementation((name: string) =>
    name === ACCESS_COOKIE ? { value: SIGNED_IN_JWT } : undefined,
  );
}

async function renderPage(query: Record<string, string | string[] | undefined> = {}): Promise<void> {
  const element = (await WorkspacesPage({ searchParams: Promise.resolve(query) })) as ReactElement;
  render(element);
}

async function pageRejection(query: Record<string, string | string[] | undefined> = {}): Promise<unknown> {
  try {
    await WorkspacesPage({ searchParams: Promise.resolve(query) });
  } catch (error: unknown) {
    return error;
  }

  throw new Error('the page did not throw');
}

beforeEach(() => {
  calls.length = 0;
  cookieStore.get.mockReset();
  cookieStore.get.mockReturnValue(undefined);
  redirect.mockClear();
  serverApiClientMock.mockReset();
  serverApiClientMock.mockResolvedValue({ items: [ACME, BOLT] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workspaces page: AC-19, protection is server-side and comes first', () => {
  it('with no session it redirects to the sign-in screen before any workspace data is fetched', async () => {
    const error = await pageRejection();

    expect((error as { url?: string }).url).toBe(SIGN_IN_ROUTE);
    expect(redirect).toHaveBeenCalledWith(SIGN_IN_ROUTE);
    expect(serverApiClientMock).not.toHaveBeenCalled();
    expect(calls).toEqual(['requireAuth']);
  });

  it('with a session it calls requireAuth first, then fetches the list, in that order', async () => {
    signedIn();
    await renderPage();

    expect(calls).toEqual(['requireAuth', 'serverApiClient']);
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('workspaces page: what it fetches and renders', () => {
  it('fetches the default (active) list and renders it under a level-1 heading', async () => {
    signedIn();
    await renderPage();

    expect(serverApiClientMock).toHaveBeenCalledTimes(1);
    const req = serverApiClientMock.mock.calls[0][0] as { method: string; path: string; query?: unknown };
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/workspaces');
    expect(req.query).toBeUndefined();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/workspaces/i);
    const items = within(screen.getByRole('list', { name: /your workspaces/i })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Acme');
    expect(screen.getByRole('link', { name: /show archived/i }).getAttribute('href')).toBe(
      `${WORKSPACES_ROUTE}?${ARCHIVED_PARAM}=${ARCHIVED_VALUE}`,
    );
  });

  it('with ?archived=1 it asks the API for archived workspaces too and shows them with the badge', async () => {
    signedIn();
    serverApiClientMock.mockResolvedValue({ items: [ACME, OLD] });
    await renderPage({ [ARCHIVED_PARAM]: ARCHIVED_VALUE });

    const req = serverApiClientMock.mock.calls[0][0] as { query?: Record<string, unknown> };
    expect(req.query).toEqual({ includeArchived: 'true' });

    const items = within(screen.getByRole('list', { name: /your workspaces/i })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[1]).getByText(/^archived$/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /hide archived/i }).getAttribute('href')).toBe(WORKSPACES_ROUTE);
  });

  it('any other value of ?archived is the default list', async () => {
    signedIn();
    await renderPage({ [ARCHIVED_PARAM]: 'yes' });

    const req = serverApiClientMock.mock.calls[0][0] as { query?: unknown };
    expect(req.query).toBeUndefined();
  });

  it('an empty tenant renders the empty state and the create form', async () => {
    signedIn();
    serverApiClientMock.mockResolvedValue({ items: [] });
    await renderPage();

    expect(screen.getByText(/one workspace per client/i)).toBeTruthy();
    expect(screen.getByLabelText(/^workspace name$/i)).toBeTruthy();
    expect(screen.queryByRole('list', { name: /your workspaces/i })).toBeNull();
  });
});

describe('workspaces page: a session the API refuses', () => {
  it('unauthenticated from the API redirects to sign in with a return path', async () => {
    signedIn();
    serverApiClientMock.mockRejectedValue(new ApiError({ code: 'unauthenticated', status: 401, message: 'x' }));

    const error = await pageRejection();
    expect((error as { url?: string }).url).toBe(`${SIGN_IN_ROUTE}?${RETURN_TO_PARAM}=${WORKSPACES_ROUTE}`);
  });

  it('the token_expired refresh bounce is re-issued with a return path to this page', async () => {
    signedIn();
    serverApiClientMock.mockImplementation(() => redirect(SERVER_COMPONENT_REFRESH_PATH));

    const error = await pageRejection({ [ARCHIVED_PARAM]: ARCHIVED_VALUE });
    expect((error as { url?: string }).url).toBe(
      `${SERVER_COMPONENT_REFRESH_PATH}?${RETURN_TO_PARAM}=${encodeURIComponent(
        `${WORKSPACES_ROUTE}?${ARCHIVED_PARAM}=${ARCHIVED_VALUE}`,
      )}`,
    );
  });

  it('any other failure of the initial fetch is not swallowed', async () => {
    signedIn();
    serverApiClientMock.mockRejectedValue(new ApiError({ code: 'internal_error', status: 500, message: 'x' }));

    const error = await pageRejection();
    expect(error).toBeInstanceOf(ApiError);
    expect(redirect).not.toHaveBeenCalled();
  });
});
