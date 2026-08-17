/**
 * TASK-008 (STORY-003, AC-17; AC-16's landing). The sign-in screen.
 *
 * The page is an async server component: it reads `sk_at` through `next/headers` and the
 * query through `searchParams`. jsdom cannot render an async component, so the page function
 * is awaited for its element (with `next/headers` mocked, as `session.spec.ts` does) and the
 * element is rendered. `fetch` is mocked to answer the BFF's shapes; `useRouter` is mocked to
 * observe navigation.
 *
 * Contract: docs/contracts/auth-tokens.md, docs/contracts/error-envelope.md,
 * docs/contracts/web-api-client.md.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

const cookieStore = {
  get: vi.fn<(name: string) => { value: string } | undefined>(),
};
const replace = vi.fn<(url: string) => void>();
const push = vi.fn<(url: string) => void>();

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`redirect:${url}`);
  }
}

const redirect = vi.fn<(url: string) => never>((url: string) => {
  throw new RedirectSignal(url);
});

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve({ get: () => null }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  redirect: (url: string) => redirect(url),
}));

import SignInPage from './page';
import {
  RETURN_TO_PARAM,
  SIGNUP_CREATED_PARAM,
  SIGNUP_CREATED_VALUE,
  SIGN_IN_ROUTE,
  SIGN_UP_ROUTE,
  WORKSPACES_ROUTE,
} from '../../../src/components/auth/routes';
import { ACCESS_COOKIE, SIGN_IN_ROUTE as SESSION_SIGN_IN_ROUTE } from '../../../src/lib/session/session';

const EMAIL = 'operator@agency.test';
const PASSWORD = 'not the right one';

const USER = {
  id: 'user_1',
  name: 'Ada Operator',
  email: EMAIL,
  emailVerified: false,
  createdAt: '2026-08-17T10:00:00.000Z',
  updatedAt: '2026-08-17T10:00:00.000Z',
};

const FAR_FUTURE = 4_102_444_800; // 2100-01-01

function jwtWith(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');

  return `header.${payload}.signature`;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function renderSignIn(query: Record<string, string | string[] | undefined> = {}): Promise<void> {
  const element = (await SignInPage({ searchParams: Promise.resolve(query) })) as ReactElement;
  render(element);
}

function fillAndSubmit(values: { email?: string; password?: string } = {}): void {
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: values.email ?? EMAIL } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: values.password ?? PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
}

let fetchMock: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
  cookieStore.get.mockReset();
  cookieStore.get.mockReturnValue(undefined);
  replace.mockClear();
  push.mockClear();
  redirect.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sign-in screen: routes it fixes', () => {
  it('lives at the route requireAuth redirects to', () => {
    expect(SIGN_IN_ROUTE).toBe('/sign-in');
    expect(SIGN_IN_ROUTE).toBe(SESSION_SIGN_IN_ROUTE);
    expect(SIGN_UP_ROUTE).toBe('/signup');
    expect(WORKSPACES_ROUTE).toBe('/workspaces');
  });
});

describe('sign-in screen: structure and accessibility', () => {
  it('renders a level-1 heading, two labelled fields with autocomplete hints, and a link to signup', async () => {
    await renderSignIn();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/sign in/i);

    const email = screen.getByLabelText(/^email$/i);
    const password = screen.getByLabelText(/^password$/i);

    expect(email.getAttribute('type')).toBe('email');
    expect(email.getAttribute('autocomplete')).toBe('email');
    expect(password.getAttribute('type')).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expect(screen.queryByLabelText(/^name$/i)).toBeNull();

    expect(screen.getByRole('link', { name: /create an account/i }).getAttribute('href')).toBe(SIGN_UP_ROUTE);
  });

  it('shows no confirmation without the created flag', async () => {
    await renderSignIn();

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/your account is ready/i)).toBeNull();
  });

  it('shows the account-ready confirmation when signup just landed here (?created=1)', async () => {
    await renderSignIn({ [SIGNUP_CREATED_PARAM]: SIGNUP_CREATED_VALUE });

    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/your account is ready/i);
    expect(status.textContent).toMatch(/sign in to continue/i);
  });
});

describe('sign-in screen: an existing session skips the form', () => {
  it('redirects to the workspace list when sk_at holds a decodable session', async () => {
    cookieStore.get.mockImplementation((name) =>
      name === ACCESS_COOKIE
        ? { value: jwtWith({ sub: 'user_1', email: EMAIL, ev: false, exp: FAR_FUTURE }) }
        : undefined,
    );

    await expect(SignInPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirect).toHaveBeenCalledWith(WORKSPACES_ROUTE);
  });

  it('honours a safe returnTo when redirecting an already-signed-in visitor', async () => {
    cookieStore.get.mockReturnValue({ value: jwtWith({ sub: 'user_1', email: EMAIL, ev: false, exp: FAR_FUTURE }) });

    await expect(SignInPage({ searchParams: Promise.resolve({ [RETURN_TO_PARAM]: '/workspaces/abc' }) })).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(redirect).toHaveBeenCalledWith('/workspaces/abc');
  });

  it('renders the form when sk_at is present but not a decodable JWT', async () => {
    cookieStore.get.mockReturnValue({ value: 'not-a-jwt' });

    await renderSignIn();

    expect(screen.getByLabelText(/^email$/i)).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('sign-in screen: success navigation', () => {
  it('posts to the BFF sign-in route and lands on the workspace list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: USER, redirect: false, url: undefined }));

    await renderSignIn();
    fillAndSubmit({ password: 'the right one' });

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(WORKSPACES_ROUTE);
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/bff/auth/sign-in/email');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ email: EMAIL, password: 'the right one' });
    expect(url).not.toContain(EMAIL);
  });

  it('honours a same-origin relative returnTo', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: USER }));

    await renderSignIn({ [RETURN_TO_PARAM]: '/workspaces/abc/links?page=2' });
    fillAndSubmit();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/workspaces/abc/links?page=2');
    });
  });

  it.each(['https://evil.test/x', '//evil.test', '/\\evil.test', '/..//evil.test', 'javascript:alert(1)'])(
    'falls back to the workspace list for an unsafe returnTo (%s)',
    async (candidate) => {
      fetchMock.mockResolvedValue(jsonResponse(200, { user: USER }));

      await renderSignIn({ [RETURN_TO_PARAM]: candidate });
      fillAndSubmit();

      await waitFor(() => {
        expect(replace).toHaveBeenCalledWith(WORKSPACES_ROUTE);
      });
    },
  );

  it('does not read a token from the response or write a cookie: the BFF set the session', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: USER }));
    const before = document.cookie;

    await renderSignIn();
    fillAndSubmit();

    await waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });
    expect(document.cookie).toBe(before);
  });
});

describe('sign-in screen: AC-17 wrong password', () => {
  it('shows one failure message, stays on the screen, keeps the form and writes no cookie', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { code: 'unauthenticated', message: 'Invalid email or password' }),
    );
    const before = document.cookie;

    await renderSignIn();
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/email address or password/i);
    // No enumeration in the copy: the message never says which of the two was wrong.
    expect(alert.textContent).not.toMatch(/account|not found|no such|unknown|exist|registered/i);
    expect(alert.textContent).not.toContain(EMAIL);

    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    expect(document.cookie).toBe(before);
    expect((screen.getByLabelText(/^email$/i) as HTMLInputElement).value).toBe(EMAIL);
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeTruthy();
  });

  it('gives an unknown address the same message as a wrong password', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { code: 'unauthenticated', message: 'Invalid email or password' }),
    );

    await renderSignIn();
    fillAndSubmit({ email: 'nobody@agency.test' });
    const first = (await screen.findByRole('alert')).textContent;

    fetchMock.mockResolvedValue(
      jsonResponse(401, { code: 'unauthenticated', message: 'Invalid email or password' }),
    );
    fillAndSubmit({ email: EMAIL, password: 'still wrong' });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const second = (await screen.findByRole('alert')).textContent;

    expect(first).toBe(second);
  });
});

describe('sign-in screen: other envelopes and transport', () => {
  it('rejects an empty password and a malformed email client-side without a request', async () => {
    await renderSignIn();
    fillAndSubmit({ email: 'nope', password: '' });

    await waitFor(() => {
      expect(screen.getByLabelText(/^email$/i).getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByLabelText(/^password$/i).getAttribute('aria-invalid')).toBe('true');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rate_limited renders a retry message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { code: 'rate_limited', message: 'Too many requests.', retryAfterSeconds: 42 }, { 'retry-after': '42' }),
    );

    await renderSignIn();
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/too many attempts/i);
    expect(replace).not.toHaveBeenCalled();
  });

  it('a transport failure renders a generic retry message that names nothing the operator typed', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await renderSignIn();
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/try again/i);
    expect(alert.textContent).not.toContain(EMAIL);
    expect(alert.textContent).not.toContain(PASSWORD);
  });

  it('a 401 with a non-envelope body still renders a generic message rather than nothing', async () => {
    fetchMock.mockResolvedValue(new Response('<html>nope</html>', { status: 401 }));

    await renderSignIn();
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent?.trim()).not.toBe('');
  });
});
