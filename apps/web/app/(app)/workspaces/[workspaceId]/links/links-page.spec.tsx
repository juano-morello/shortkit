/**
 * TASK-2-14 (STORY-2-10, AC-2-48/50/51). The two link screens:
 * `/workspaces/[workspaceId]/links` (list + create) and
 * `/workspaces/[workspaceId]/links/[linkId]` (edit + delete).
 *
 * Both pages are async server components: jsdom cannot render them, so each page function
 * is awaited for its element (with `next/headers` mocked, as the sibling specs do) and the
 * element, the client screen under the page's heading, is rendered. `requireAuth`,
 * `serverApiClient` and `notFound` are wrapped through `vi.mock` so the CALL ORDER can be
 * asserted (redirect-before-fetch; workspace-before-links) and the initial data answered
 * without a network. The browser legs (`apiClient`) go through a `fetch` spy routed by URL.
 *
 * Invariants kept here: an unauthenticated visitor is redirected before any fetch; a
 * workspace the caller cannot read renders not-found with nothing of it in the output; the
 * list shows the slug, the `SHORT_LINK_ORIGIN`-composed short URL with a copy control, the
 * destination as TEXT, and the window word `isLinkActive` decides; the cursor's "load more"
 * appends; a viewer sees no form and no row action; the delete confirm names the click
 * history; and every browser request goes to `/api/bff/*`.
 *
 * Contract: docs/contracts/workspace-authorization.md, docs/contracts/slug.md,
 *   docs/contracts/redirect-resolution.md, docs/contracts/web-api-client.md.
 * Decision: D-2-02 (`http://localhost:3001/<slug>`), D-2-12, D-2-18.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { isLinkActive } from '@shortkit/contracts';
import type { Link as LinkRow, Workspace } from '@shortkit/contracts';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import type * as ApiClientModule from '../../../../../src/lib/api/client';
import type * as SessionModule from '../../../../../src/lib/session/session';

const { calls, cookieStore, notFound, push, redirect, replace, serverApiClientMock } = vi.hoisted(() => {
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
    push: vi.fn<(url: string) => void>(),
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
  useRouter: () => ({ replace, push, refresh: vi.fn() }),
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

import LinksPage from './page';
import { LinksScreen } from './links-screen';
import LinkPage from './[linkId]/page';
import { LINK_EDIT_MESSAGES } from './[linkId]/link-edit-screen';
import { RETURN_TO_PARAM, WORKSPACES_ROUTE } from '../../../../../src/components/auth/routes';
import { LINK_LIST_MESSAGES } from '../../../../../src/components/links/link-list';
import { LINK_SCREEN_MESSAGES, signInAfterExpiryUrl } from '../../../../../src/components/links/links-view';
import { ApiError, SERVER_COMPONENT_REFRESH_PATH } from '../../../../../src/lib/api/client';
import { LINKS_ROUTE, LINK_MESSAGES, LINK_ROUTE } from '../../../../../src/lib/links/links-api';
import { ACCESS_COOKIE, SIGN_IN_ROUTE } from '../../../../../src/lib/session/session';
import { SHORT_LINK_ORIGIN_VAR } from '../../../../../src/lib/short-url';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '99999999-9999-4999-8999-999999999999';
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const FAR_FUTURE = 4_102_444_800; // 2100-01-01
const T0 = '2026-08-19T10:00:00.000Z';
/** What compose sets, literally (D-2-02, ruled 2026-08-19). */
const THE_COMPOSE_ORIGIN = 'http://localhost:3001';

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
  workspaceRole: 'member',
};

function link(overrides: Partial<LinkRow> & Pick<LinkRow, 'id' | 'slug'>): LinkRow {
  return {
    workspaceId: WORKSPACE_ID,
    domainId: DOMAIN_ID,
    hostname: 'localhost',
    destinationUrl: 'https://example.com/landing',
    expiresAt: null,
    activatesAt: null,
    createdAt: T0,
    ...overrides,
  };
}

const ACTIVE = link({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'gH7kM2p' });
const SCHEDULED = link({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  slug: 'spring-sale',
  activatesAt: '2999-01-01T00:00:00.000Z',
});
const EXPIRED = link({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  slug: 'old-promo',
  expiresAt: '2020-01-01T00:00:00.000Z',
});
const NEXT_PAGE_LINK = link({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', slug: 'page-two' });
const THIRD_PAGE_LINK = link({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', slug: 'page-three' });

const LIST_URL = `/api/bff/links?workspaceId=${WORKSPACE_ID}`;
const CURSOR = 'cursor-1';
const SECOND_CURSOR = 'cursor-2';
const NEXT_PAGE_URL = `${LIST_URL}&cursor=${CURSOR}`;
const THIRD_PAGE_URL = `${LIST_URL}&cursor=${SECOND_CURSOR}`;

function page(items: LinkRow[], nextCursor: string | null = null): unknown {
  return { items, nextCursor, hasMore: nextCursor !== null };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** `errorEnvelopeContract` is FLAT: `{ code, message, details? }`. */
function errorEnvelope(code: string, message: string): unknown {
  return { code, message };
}

type Route = (init: RequestInit) => Response | Promise<Response>;

let fetchMock: MockInstance<typeof fetch>;
let routes: Record<string, Route>;

/** One `fetch` implementation routed by `METHOD url`, so a test declares only the legs it exercises. */
function routeFetch(overrides: Record<string, Route>): void {
  routes = {
    [`GET ${LIST_URL}`]: () => jsonResponse(200, page([ACTIVE, SCHEDULED, EXPIRED])),
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

function fetchUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

function signedIn(): void {
  cookieStore.get.mockImplementation((name: string) => (name === ACCESS_COOKIE ? { value: SIGNED_IN_JWT } : undefined));
}

/** The server answers: the workspace first, then whatever the second call asks for. */
function serverAnswers(workspace: Workspace, second: unknown): void {
  serverApiClientMock.mockImplementation((req: unknown) =>
    Promise.resolve((req as { path: string }).path === '/workspaces/:workspaceId' ? workspace : second),
  );
}

async function renderListPage(workspaceId: string = WORKSPACE_ID): Promise<void> {
  const element = (await LinksPage({ params: Promise.resolve({ workspaceId }) })) as ReactElement;
  render(element);
}

async function listPageRejection(workspaceId: string = WORKSPACE_ID): Promise<unknown> {
  try {
    await LinksPage({ params: Promise.resolve({ workspaceId }) });
  } catch (error: unknown) {
    return error;
  }

  throw new Error('the page did not throw');
}

async function renderEditPage(linkId: string = ACTIVE.id, workspaceId: string = WORKSPACE_ID): Promise<void> {
  const element = (await LinkPage({ params: Promise.resolve({ workspaceId, linkId }) })) as ReactElement;
  render(element);
}

async function editPageRejection(linkId: string = ACTIVE.id, workspaceId: string = WORKSPACE_ID): Promise<unknown> {
  try {
    await LinkPage({ params: Promise.resolve({ workspaceId, linkId }) });
  } catch (error: unknown) {
    return error;
  }

  throw new Error('the page did not throw');
}

/**
 * A MONOTONIC count of the mutations inside the polite live region.
 *
 * React writes no DOM node when the string it renders is unchanged, so an announcement
 * repeated verbatim can leave the region untouched and a screen reader silent. Asserting
 * the rendered text is therefore not enough: the second copy of "Short link copied" reads
 * identically whether it was announced again or dropped. This watches the region itself.
 */
function statusMutations(): () => number {
  const region = screen.getByRole('status');
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((list) => {
    records.push(...list);
  });

  observer.observe(region, { childList: true, characterData: true, subtree: true });

  return () => {
    records.push(...observer.takeRecords());

    return records.length;
  };
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: /^links$/i })).getAllByRole('listitem');
}

beforeEach(() => {
  vi.stubEnv(SHORT_LINK_ORIGIN_VAR, THE_COMPOSE_ORIGIN);
  calls.length = 0;
  cookieStore.get.mockReset();
  cookieStore.get.mockReturnValue(undefined);
  redirect.mockClear();
  notFound.mockClear();
  replace.mockClear();
  push.mockClear();
  serverApiClientMock.mockReset();
  serverAnswers(ACME, page([ACTIVE, SCHEDULED, EXPIRED]));
  fetchMock = vi.spyOn(globalThis, 'fetch');
  routeFetch({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('links page: protection is server-side and comes first', () => {
  it('with no session it redirects to the sign-in screen before any data is fetched', async () => {
    const error = await listPageRejection();

    expect((error as { url?: string }).url).toBe(SIGN_IN_ROUTE);
    expect(serverApiClientMock).not.toHaveBeenCalled();
    expect(calls).toEqual(['requireAuth']);
  });

  it('with a session it calls requireAuth, then fetches the workspace, then its links, in that order', async () => {
    signedIn();
    await renderListPage();

    expect(calls).toEqual(['requireAuth', 'serverApiClient GET /workspaces/:workspaceId', 'serverApiClient GET /links']);
    const [workspaceReq, listReq] = serverApiClientMock.mock.calls.map(([req]) => req as { params?: unknown; query?: unknown });
    expect(workspaceReq.params).toEqual({ workspaceId: WORKSPACE_ID });
    expect(listReq.query).toEqual({ workspaceId: WORKSPACE_ID, cursor: undefined });
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
    // Nothing fetched in the browser on mount: the server data is the initial state.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404],
    ['insufficient_workspace_role', 403],
  ])('%s on the workspace fetch renders not-found and never fetches the list', async (code, status) => {
    signedIn();
    serverApiClientMock.mockRejectedValueOnce(new ApiError({ code: code as 'not_found', status, message: 'x' }));

    const error = await listPageRejection();

    expect((error as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(calls).toEqual(['requireAuth', 'serverApiClient GET /workspaces/:workspaceId', 'notFound']);
    expect(document.body.textContent).not.toContain('Secret');
  });

  it('a workspace id that is not a uuid is not-found without a request', async () => {
    signedIn();

    const error = await listPageRejection('..');

    expect((error as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(serverApiClientMock).not.toHaveBeenCalled();
  });

  it('unauthenticated from the API redirects to sign in with a return path to this page', async () => {
    signedIn();
    serverApiClientMock.mockRejectedValueOnce(new ApiError({ code: 'unauthenticated', status: 401, message: 'x' }));

    const error = await listPageRejection();

    expect((error as { url?: string }).url).toBe(signInAfterExpiryUrl(LINKS_ROUTE(WORKSPACE_ID)));
    expect(signInAfterExpiryUrl(LINKS_ROUTE(WORKSPACE_ID))).toBe(
      `${SIGN_IN_ROUTE}?${RETURN_TO_PARAM}=${encodeURIComponent(LINKS_ROUTE(WORKSPACE_ID))}`,
    );
  });

  it('the token_expired refresh bounce is re-issued with a return path to this page', async () => {
    signedIn();
    serverApiClientMock.mockImplementationOnce(() => redirect(SERVER_COMPONENT_REFRESH_PATH));

    const error = await listPageRejection();

    expect((error as { url?: string }).url).toBe(
      `${SERVER_COMPONENT_REFRESH_PATH}?${RETURN_TO_PARAM}=${encodeURIComponent(LINKS_ROUTE(WORKSPACE_ID))}`,
    );
  });

  it('any other failure of the initial fetch is not swallowed', async () => {
    signedIn();
    serverApiClientMock.mockRejectedValueOnce(new ApiError({ code: 'internal_error', status: 500, message: 'x' }));

    const error = await listPageRejection();

    expect(error).toBeInstanceOf(ApiError);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('refuses to render when SHORT_LINK_ORIGIN is unset rather than composing undefined/<slug>', async () => {
    signedIn();
    vi.stubEnv(SHORT_LINK_ORIGIN_VAR, '');

    const error = await listPageRejection();

    expect((error as Error).message).toMatch(/SHORT_LINK_ORIGIN/);
    expect(serverApiClientMock).not.toHaveBeenCalled();
  });
});

describe('links page: what the list shows (AC-2-48)', () => {
  it('the slug, the composed short URL with a copy control, the destination as text, and the window word', async () => {
    signedIn();
    await renderListPage();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(ACME.name);
    expect(screen.getByRole('link', { name: /back to workspaces/i }).getAttribute('href')).toBe(WORKSPACES_ROUTE);

    const items = rows();
    expect(items).toHaveLength(3);

    // The short URL is D-2-02's, in full, selectable, and a copy control sits beside it.
    expect(within(items[0]).getByText(`${THE_COMPOSE_ORIGIN}/${ACTIVE.slug}`)).toBeTruthy();
    expect(within(items[0]).getByText(ACTIVE.slug, { selector: '.link-slug' })).toBeTruthy();
    expect(screen.getByRole('button', { name: `${LINK_LIST_MESSAGES.copy} ${LINK_LIST_MESSAGES.shortUrlLabel} ${ACTIVE.slug}` })).toBeTruthy();

    // The window word is the shared rule's, per row.
    const now = new Date();
    expect(isLinkActive(ACTIVE, now)).toBe(true);
    expect(items[0].querySelector('[data-state]')?.textContent).toBe(LINK_SCREEN_MESSAGES.windowStates.active);
    expect(items[1].querySelector('[data-state]')?.textContent).toBe(LINK_SCREEN_MESSAGES.windowStates.scheduled);
    expect(items[2].querySelector('[data-state]')?.textContent).toBe(LINK_SCREEN_MESSAGES.windowStates.expired);

    // The destination is TEXT, in full, and never an href a reader can be induced to follow.
    const destination = items[0].querySelector('.link-destination');
    expect(destination?.textContent).toContain(ACTIVE.destinationUrl);
    expect(destination?.getAttribute('title')).toBe(ACTIVE.destinationUrl);
    for (const anchor of Array.from(document.querySelectorAll('a'))) {
      expect(anchor.getAttribute('href')).not.toContain('example.com');
    }
  });

  it('a member gets the create form and an Edit link per row', async () => {
    signedIn();
    await renderListPage();

    expect(screen.getByLabelText(/destination url/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^create link$/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: `${LINK_LIST_MESSAGES.edit} ${ACTIVE.slug}` }).getAttribute('href')).toBe(
      LINK_ROUTE(WORKSPACE_ID, ACTIVE.id),
    );
  });

  it('a viewer sees the list and no form and no row action (D-2-18)', async () => {
    signedIn();
    serverAnswers({ ...ACME, workspaceRole: 'viewer' }, page([ACTIVE]));
    await renderListPage();

    expect(rows()).toHaveLength(1);
    expect(screen.queryByLabelText(/destination url/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^create link$/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /^edit/i })).toBeNull();
    expect(screen.getByText(LINK_SCREEN_MESSAGES.readOnly)).toBeTruthy();
  });

  it('a workspace whose role did not arrive is treated as read-only', async () => {
    signedIn();
    serverAnswers({ id: WORKSPACE_ID, name: ACME.name, archivedAt: null, createdAt: T0, updatedAt: T0 }, page([ACTIVE]));
    await renderListPage();

    expect(screen.queryByLabelText(/destination url/i)).toBeNull();
  });

  it('an archived workspace keeps its list and loses the create form, and says the links keep redirecting', async () => {
    signedIn();
    serverAnswers({ ...ACME, archivedAt: '2026-08-18T09:00:00.000Z' }, page([ACTIVE]));
    await renderListPage();

    expect(screen.getByText(LINK_SCREEN_MESSAGES.archived)).toBeTruthy();
    expect(screen.queryByLabelText(/destination url/i)).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('with no links it renders the empty state with the form and no list', async () => {
    signedIn();
    serverAnswers(ACME, page([]));
    await renderListPage();

    expect(screen.getByText(LINK_SCREEN_MESSAGES.empty)).toBeTruthy();
    expect(screen.queryByRole('list', { name: /^links$/i })).toBeNull();
    expect(screen.getByLabelText(/destination url/i)).toBeTruthy();
  });

  it('one polite live region, empty on arrival', async () => {
    signedIn();
    await renderListPage();

    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].getAttribute('aria-live')).toBe('polite');
    expect(statuses[0].textContent).toBe('');
  });
});

describe('links page: the cursor (AC-2-48)', () => {
  it('offers "load more" only when the page says there is more, and appends the next page', async () => {
    signedIn();
    serverAnswers(ACME, page([ACTIVE], CURSOR));
    routeFetch({ [`GET ${NEXT_PAGE_URL}`]: () => jsonResponse(200, page([NEXT_PAGE_LINK])) });
    await renderListPage();

    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(LINK_LIST_MESSAGES.loadMore, 'i') }));

    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });

    expect(fetchUrls()).toEqual([NEXT_PAGE_URL]);
    expect(rows()[1].textContent).toContain(NEXT_PAGE_LINK.slug);
    // The last page carries no cursor, so the control goes away.
    expect(screen.queryByRole('button', { name: new RegExp(LINK_LIST_MESSAGES.loadMore, 'i') })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.loadedMore);
  });

  it('does not offer it when the first page is the only one', async () => {
    signedIn();
    await renderListPage();

    expect(screen.queryByRole('button', { name: new RegExp(LINK_LIST_MESSAGES.loadMore, 'i') })).toBeNull();
  });
});

describe('links page: create re-fetches the first page and announces it (AC-2-49)', () => {
  it('a success sends one POST, re-fetches the list and names the new slug', async () => {
    signedIn();
    const created = link({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', slug: 'brand-new' });
    routeFetch({
      'POST /api/bff/links': () => jsonResponse(201, created),
      [`GET ${LIST_URL}`]: () => jsonResponse(200, page([created, ACTIVE])),
    });
    await renderListPage();

    fireEvent.change(screen.getByLabelText(/destination url/i), { target: { value: 'https://example.com/new' } });
    fireEvent.click(screen.getByRole('button', { name: /^create link$/i }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.created(created.slug));
    });

    expect(fetchUrls()).toEqual(['/api/bff/links', LIST_URL]);
    expect(rows()).toHaveLength(2);
    expect(rows()[0].textContent).toContain('brand-new');
  });

  it('a 403 on the create leaves the list alone and shows the role message', async () => {
    signedIn();
    routeFetch({
      'POST /api/bff/links': () => jsonResponse(403, errorEnvelope('insufficient_workspace_role', 'No.')),
    });
    await renderListPage();

    fireEvent.change(screen.getByLabelText(/destination url/i), { target: { value: 'https://example.com/new' } });
    fireEvent.click(screen.getByRole('button', { name: /^create link$/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(LINK_MESSAGES.forbidden);
    });
    expect(fetchUrls()).toEqual(['/api/bff/links']);
    expect(rows()).toHaveLength(3);
  });

  it('a session that ended mid-use navigates to sign in with a return path to this page', async () => {
    signedIn();
    routeFetch({ 'POST /api/bff/links': () => jsonResponse(401, errorEnvelope('unauthenticated', 'No.')) });
    await renderListPage();

    fireEvent.change(screen.getByLabelText(/destination url/i), { target: { value: 'https://example.com/new' } });
    fireEvent.click(screen.getByRole('button', { name: /^create link$/i }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(signInAfterExpiryUrl(LINKS_ROUTE(WORKSPACE_ID)));
    });
  });
});

describe('links page: the copy control', () => {
  it('writes the composed short URL to the clipboard and announces it', async () => {
    signedIn();
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderListPage();

    fireEvent.click(
      screen.getByRole('button', { name: `${LINK_LIST_MESSAGES.copy} ${LINK_LIST_MESSAGES.shortUrlLabel} ${ACTIVE.slug}` }),
    );

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.copied);
    });
    expect(writeText).toHaveBeenCalledWith(`${THE_COMPOSE_ORIGIN}/${ACTIVE.slug}`);
    // Copying reaches no network at all: the short URL is display and copy only.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so when the clipboard is unavailable, and the URL stays on screen to be selected', async () => {
    signedIn();
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: undefined, configurable: true });
    await renderListPage();

    fireEvent.click(
      screen.getByRole('button', { name: `${LINK_LIST_MESSAGES.copy} ${LINK_LIST_MESSAGES.shortUrlLabel} ${ACTIVE.slug}` }),
    );

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.copyFailed);
    });
    expect(screen.getByText(`${THE_COMPOSE_ORIGIN}/${ACTIVE.slug}`)).toBeTruthy();
  });
});

describe('links page: a repeated announcement still reaches the live region', () => {
  it('every copy is announced, including an identical repeat', async () => {
    signedIn();
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderListPage();

    const mutations = statusMutations();
    const copy = screen.getByRole('button', {
      name: `${LINK_LIST_MESSAGES.copy} ${LINK_LIST_MESSAGES.shortUrlLabel} ${ACTIVE.slug}`,
    });

    fireEvent.click(copy);
    await waitFor(() => {
      expect(mutations()).toBeGreaterThan(0);
    });
    const afterFirst = mutations();
    expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.copied);

    // The same message a second time: the clipboard is written again, so the region must
    // change again. Before the nonce this fired the clipboard twice and announced once.
    fireEvent.click(copy);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(mutations()).toBeGreaterThan(afterFirst);
    });
    expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.copied);
  });

  it('every "load more" is announced, including the second identical one', async () => {
    signedIn();
    serverAnswers(ACME, page([ACTIVE], CURSOR));
    routeFetch({
      [`GET ${NEXT_PAGE_URL}`]: () => jsonResponse(200, page([NEXT_PAGE_LINK], SECOND_CURSOR)),
      [`GET ${THIRD_PAGE_URL}`]: () => jsonResponse(200, page([THIRD_PAGE_LINK])),
    });
    await renderListPage();

    const mutations = statusMutations();
    const loadMore = new RegExp(LINK_LIST_MESSAGES.loadMore, 'i');

    fireEvent.click(screen.getByRole('button', { name: loadMore }));
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    await waitFor(() => {
      expect(mutations()).toBeGreaterThan(0);
    });
    const afterFirst = mutations();
    expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.loadedMore);

    fireEvent.click(screen.getByRole('button', { name: loadMore }));
    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    await waitFor(() => {
      expect(mutations()).toBeGreaterThan(afterFirst);
    });
    expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.loadedMore);
  });
});

describe('link edit page: the server half', () => {
  it('calls requireAuth, then the workspace, then the link, in that order', async () => {
    signedIn();
    serverAnswers(ACME, ACTIVE);
    await renderEditPage();

    expect(calls).toEqual(['requireAuth', 'serverApiClient GET /workspaces/:workspaceId', 'serverApiClient GET /links/:linkId']);
    const [, linkReq] = serverApiClientMock.mock.calls.map(([req]) => req as { params?: unknown });
    expect(linkReq.params).toEqual({ linkId: ACTIVE.id });
  });

  it('a link id that is not a uuid is not-found without a request', async () => {
    signedIn();

    const error = await editPageRejection('..');

    expect((error as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(serverApiClientMock).not.toHaveBeenCalled();
  });

  it('a link belonging to another workspace is not-found, not rendered under this URL', async () => {
    signedIn();
    serverAnswers(ACME, { ...ACTIVE, workspaceId: OTHER_WORKSPACE_ID });

    const error = await editPageRejection();

    expect((error as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(document.body.textContent).not.toContain(ACTIVE.slug);
  });

  it('a 404 on the link renders not-found', async () => {
    signedIn();
    serverApiClientMock.mockImplementation((req: unknown) =>
      (req as { path: string }).path === '/workspaces/:workspaceId'
        ? Promise.resolve(ACME)
        : Promise.reject(new ApiError({ code: 'not_found', status: 404, message: 'x' })),
    );

    const error = await editPageRejection();

    expect((error as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});

describe('link edit page: edit and delete (AC-2-50)', () => {
  beforeEach(() => {
    serverAnswers(ACME, ACTIVE);
  });

  it('shows the short URL, prefills the form, and saves back to the list', async () => {
    signedIn();
    routeFetch({ [`PATCH /api/bff/links/${ACTIVE.id}`]: () => jsonResponse(200, { ...ACTIVE, destinationUrl: 'https://example.com/other' }) });
    await renderEditPage();

    expect(screen.getByText(`${THE_COMPOSE_ORIGIN}/${ACTIVE.slug}`)).toBeTruthy();
    expect((screen.getByLabelText(/^slug$/i) as HTMLInputElement).value).toBe(ACTIVE.slug);
    expect(screen.getByRole('link', { name: LINK_SCREEN_MESSAGES.backToLinks }).getAttribute('href')).toBe(
      LINKS_ROUTE(WORKSPACE_ID),
    );

    fireEvent.change(screen.getByLabelText(/destination url/i), { target: { value: 'https://example.com/other' } });
    fireEvent.click(screen.getByRole('button', { name: /^save changes$/i }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(LINKS_ROUTE(WORKSPACE_ID));
    });
    expect(fetchUrls()).toEqual([`/api/bff/links/${ACTIVE.id}`]);
    expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.updated(ACTIVE.slug));
  });

  it('delete is a two-step confirm that names the click history, and only Confirm sends it', async () => {
    signedIn();
    routeFetch({ [`DELETE /api/bff/links/${ACTIVE.id}`]: () => jsonResponse(200, ACTIVE) });
    await renderEditPage();

    const deleteButton = screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.delete} ${ACTIVE.slug}` });
    expect(deleteButton.getAttribute('aria-expanded')).toBe('false');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(deleteButton);

    const question = screen.getByText(LINK_EDIT_MESSAGES.deleteQuestion(ACTIVE.slug));
    expect(question.textContent).toContain('click history');
    expect(question.textContent).toContain(LINK_MESSAGES.deleteCascade);
    expect(deleteButton.getAttribute('aria-expanded')).toBe('true');
    expect(fetchMock).not.toHaveBeenCalled();

    const confirm = screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.confirm} deleting ${ACTIVE.slug}` });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(LINKS_ROUTE(WORKSPACE_ID));
    });
    expect(fetchUrls()).toEqual([`/api/bff/links/${ACTIVE.id}`]);
    expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.deleted(ACTIVE.slug));
  });

  /**
   * The two step confirm exists because the delete is irreversible and takes the click
   * history with it. Once Confirm has sent the request there is nothing left to cancel, so
   * the screen must not offer a control whose plain reading is "the link was kept" while
   * the success branch is about to announce a deletion and navigate away.
   */
  it('Cancel is withdrawn once Confirm has sent the delete, and the screen never claims the link was kept', async () => {
    signedIn();
    let release: (response: Response) => void = () => undefined;
    routeFetch({
      [`DELETE /api/bff/links/${ACTIVE.id}`]: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    await renderEditPage();

    fireEvent.click(screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.delete} ${ACTIVE.slug}` }));
    fireEvent.click(screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.confirm} deleting ${ACTIVE.slug}` }));

    const cancel = screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.cancel} deleting ${ACTIVE.slug}` });
    await waitFor(() => {
      expect(cancel.getAttribute('aria-disabled')).toBe('true');
    });

    fireEvent.click(cancel);

    // The question stays up, no second request goes out, and nothing is announced: the
    // delete is already on its way and the screen says nothing it cannot keep.
    expect(screen.getByText(LINK_EDIT_MESSAGES.deleteQuestion(ACTIVE.slug))).toBeTruthy();
    expect(fetchUrls()).toEqual([`/api/bff/links/${ACTIVE.id}`]);
    expect(screen.getByRole('status').textContent).toBe('');
    expect(push).not.toHaveBeenCalled();

    release(jsonResponse(200, ACTIVE));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(LINKS_ROUTE(WORKSPACE_ID));
    });
    expect(screen.getByRole('status').textContent).toBe(LINK_SCREEN_MESSAGES.deleted(ACTIVE.slug));
  });

  it('Escape does not close the confirm once the delete is in flight either', async () => {
    signedIn();
    let release: (response: Response) => void = () => undefined;
    routeFetch({
      [`DELETE /api/bff/links/${ACTIVE.id}`]: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    await renderEditPage();

    fireEvent.click(screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.delete} ${ACTIVE.slug}` }));
    const confirm = screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.confirm} deleting ${ACTIVE.slug}` });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(confirm.getAttribute('aria-disabled')).toBe('true');
    });

    fireEvent.keyDown(confirm, { key: 'Escape' });

    expect(screen.getByText(LINK_EDIT_MESSAGES.deleteQuestion(ACTIVE.slug))).toBeTruthy();

    release(jsonResponse(200, ACTIVE));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(LINKS_ROUTE(WORKSPACE_ID));
    });
  });

  it('Cancel closes the confirm, sends nothing and returns focus to the delete control', async () => {
    signedIn();
    await renderEditPage();

    const deleteButton = screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.delete} ${ACTIVE.slug}` });
    fireEvent.click(deleteButton);
    fireEvent.click(screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.cancel} deleting ${ACTIVE.slug}` }));

    expect(screen.queryByText(LINK_EDIT_MESSAGES.deleteQuestion(ACTIVE.slug))).toBeNull();
    expect(document.activeElement).toBe(deleteButton);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Escape on the confirm closes it without sending', async () => {
    signedIn();
    await renderEditPage();

    fireEvent.click(screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.delete} ${ACTIVE.slug}` }));
    fireEvent.keyDown(screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.confirm} deleting ${ACTIVE.slug}` }), {
      key: 'Escape',
    });

    expect(screen.queryByText(LINK_EDIT_MESSAGES.deleteQuestion(ACTIVE.slug))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a delete the API refuses keeps the operator on the page with the reason', async () => {
    signedIn();
    routeFetch({ [`DELETE /api/bff/links/${ACTIVE.id}`]: () => jsonResponse(404, errorEnvelope('not_found', 'Gone.')) });
    await renderEditPage();

    fireEvent.click(screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.delete} ${ACTIVE.slug}` }));
    fireEvent.click(screen.getByRole('button', { name: `${LINK_EDIT_MESSAGES.confirm} deleting ${ACTIVE.slug}` }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(LINK_EDIT_MESSAGES.gone);
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('a viewer gets the details and neither the form nor the delete control', async () => {
    signedIn();
    serverAnswers({ ...ACME, workspaceRole: 'viewer' }, ACTIVE);
    await renderEditPage();

    expect(screen.getByText(`${THE_COMPOSE_ORIGIN}/${ACTIVE.slug}`)).toBeTruthy();
    expect(screen.queryByLabelText(/destination url/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete link/i })).toBeNull();
    expect(screen.getByText(LINK_SCREEN_MESSAGES.readOnly)).toBeTruthy();
  });
});

describe('links screens: every browser request goes through the BFF (AC-2-51)', () => {
  it('no fetch names the API origin or the short-link origin, on either screen', async () => {
    signedIn();
    serverAnswers(ACME, page([ACTIVE], CURSOR));
    routeFetch({ [`GET ${NEXT_PAGE_URL}`]: () => jsonResponse(200, page([NEXT_PAGE_LINK])) });
    await renderListPage();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(LINK_LIST_MESSAGES.loadMore, 'i') }));

    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });

    expect(fetchUrls().length).toBeGreaterThan(0);
    for (const url of fetchUrls()) {
      expect(url.startsWith('/api/bff/')).toBe(true);
      expect(url).not.toContain(THE_COMPOSE_ORIGIN);
      expect(url).not.toContain('http://');
      expect(url).not.toContain('https://');
    }
    // And the document itself never navigated to the short-link origin.
    expect(window.location.href).not.toContain('localhost:3001');
  });

  it('the screen renders without a browser fetch when the server already answered', async () => {
    signedIn();
    render(
      <LinksScreen
        workspace={ACME}
        initialPage={{ items: [ACTIVE], nextCursor: null, hasMore: false }}
        shortLinkOrigin={THE_COMPOSE_ORIGIN}
      />,
    );

    expect(screen.getByText(`${THE_COMPOSE_ORIGIN}/${ACTIVE.slug}`)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
