/**
 * TASK-008 (STORY-003, AC-16). The signup screen, rendered in jsdom with `fetch` mocked to
 * answer the BFF's shapes and `next/navigation`'s `useRouter` mocked to observe navigation.
 *
 * ADR-0061: signup does not auto-sign-in, so success lands on the sign-in screen carrying
 * `?created=1` (Juano's ruling, TASK-008 card). A duplicate address answers the same 200 a
 * fresh one does and the screen does not branch on it.
 *
 * Contract: docs/contracts/auth-tokens.md, docs/contracts/error-envelope.md,
 * docs/contracts/web-api-client.md.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PASSWORD_MIN_LENGTH } from '@shortkit/contracts';
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

import SignupPage from './page';
import { SIGN_IN_AFTER_SIGNUP_URL, SIGN_IN_ROUTE } from '../../../src/components/auth/routes';

const EMAIL = 'operator@agency.test';
const PASSWORD = 'correct horse battery';
const NAME = 'Ada Operator';

const FRESH_USER = {
  id: 'user_fresh',
  name: NAME,
  email: EMAIL,
  emailVerified: false,
  createdAt: '2026-08-17T10:00:00.000Z',
  updatedAt: '2026-08-17T10:00:00.000Z',
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fillAndSubmit(values: { name?: string; email?: string; password?: string } = {}): void {
  fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: values.name ?? NAME } });
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: values.email ?? EMAIL } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: values.password ?? PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: /create account/i }));
}

let fetchMock: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
  replace.mockClear();
  push.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signup screen: structure and accessibility', () => {
  it('renders a level-1 heading, three labelled fields with autocomplete hints, and a link to sign in', () => {
    render(<SignupPage />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/create your account/i);

    const name = screen.getByLabelText(/^name$/i);
    const email = screen.getByLabelText(/^email$/i);
    const password = screen.getByLabelText(/^password$/i);

    expect(name.getAttribute('autocomplete')).toBe('name');
    expect(email.getAttribute('type')).toBe('email');
    expect(email.getAttribute('autocomplete')).toBe('email');
    expect(password.getAttribute('type')).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('new-password');

    const link = screen.getByRole('link', { name: /sign in/i });
    expect(link.getAttribute('href')).toBe(SIGN_IN_ROUTE);
  });

  it('submits with POST, never GET, so a JS-less submit could not put the credentials in a URL', () => {
    render(<SignupPage />);

    const form = screen.getByRole('button', { name: /create account/i }).closest('form');
    expect(form).not.toBeNull();
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
  });
});

describe('signup screen: AC-16 success', () => {
  it('posts the three fields to the BFF signup route and lands on sign-in with the created flag', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: FRESH_USER }));

    render(<SignupPage />);
    fillAndSubmit();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(SIGN_IN_AFTER_SIGNUP_URL);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/bff/auth/sign-up/email');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ email: EMAIL, password: PASSWORD, name: NAME });
    expect(init.credentials).toBe('same-origin');

    // The URL the operator lands on carries no address and no credential.
    expect(SIGN_IN_AFTER_SIGNUP_URL).toBe('/sign-in?created=1');
    expect(url).not.toContain(EMAIL);
    expect(url).not.toContain(PASSWORD);
  });

  it('treats a duplicate address (same 200 shape, ADR-0061) exactly like a fresh signup', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: { ...FRESH_USER, image: null } }));

    render(<SignupPage />);
    fillAndSubmit();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(SIGN_IN_AFTER_SIGNUP_URL);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('writes no cookie from the browser: the session, if any, is the server’s to set', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: FRESH_USER }));
    const before = document.cookie;

    render(<SignupPage />);
    fillAndSubmit();

    await waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });
    expect(document.cookie).toBe(before);
  });
});

describe('signup screen: client-side validation through the contract', () => {
  it('shows a per-field message for an invalid email, a short password and an empty name, and sends nothing', async () => {
    render(<SignupPage />);
    fillAndSubmit({ name: '', email: 'not-an-address', password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1) });

    const name = screen.getByLabelText(/^name$/i);
    const email = screen.getByLabelText(/^email$/i);
    const password = screen.getByLabelText(/^password$/i);

    await waitFor(() => {
      expect(name.getAttribute('aria-invalid')).toBe('true');
      expect(email.getAttribute('aria-invalid')).toBe('true');
      expect(password.getAttribute('aria-invalid')).toBe('true');
    });

    for (const field of [name, email, password]) {
      const describedBy = field.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const message = document.getElementById(String(describedBy));
      expect(message?.textContent?.trim()).not.toBe('');
    }

    expect(document.getElementById(String(password.getAttribute('aria-describedby')))?.textContent).toContain(
      String(PASSWORD_MIN_LENGTH),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('accepts a password of exactly the contract minimum (no stricter client rule)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: FRESH_USER }));

    render(<SignupPage />);
    fillAndSubmit({ password: 'p'.repeat(PASSWORD_MIN_LENGTH) });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('signup screen: error envelopes keyed by code', () => {
  /**
   * Exercises CredentialForm's generic `ValidationDetails` handling. NOT a reachable-today
   * path for these two forms: `mapBetterAuthError` (client.ts) does not populate `details`
   * for the Better Auth surface, so a `validation_failed` from signup/sign-in arrives with
   * no `fieldErrors`. The branch exists for the envelope contract, which allows it.
   */
  it('validation_failed with fieldErrors details renders each message under its field', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        code: 'validation_failed',
        message: 'Validation failed.',
        details: { fieldErrors: { email: ['That address cannot be used.'], password: ['Password too weak.'] } },
      }),
    );

    render(<SignupPage />);
    fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByText('That address cannot be used.')).toBeTruthy();
    });
    expect(screen.getByText('Password too weak.')).toBeTruthy();
    expect(screen.getByLabelText(/^email$/i).getAttribute('aria-invalid')).toBe('true');
    expect(replace).not.toHaveBeenCalled();
  });

  it('validation_failed without details renders one generic form-level alert', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { code: 'validation_failed', message: 'Password too short' }));

    render(<SignupPage />);
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/check/i);
    expect(replace).not.toHaveBeenCalled();
  });

  it('rate_limited renders a retry message and keeps the form', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { code: 'rate_limited', message: 'Too many requests.' }, { 'retry-after': '30' }),
    );

    render(<SignupPage />);
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/too many attempts/i);
    expect((screen.getByLabelText(/^email$/i) as HTMLInputElement).value).toBe(EMAIL);
    expect(replace).not.toHaveBeenCalled();
  });

  it('internal_error renders a generic retry message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { code: 'internal_error', message: 'The request could not be completed.' }));

    render(<SignupPage />);
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/try again/i);
    expect(replace).not.toHaveBeenCalled();
  });

  it('a transport failure renders the same generic retry message and never navigates', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<SignupPage />);
    fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/try again/i);
    expect(alert.textContent).not.toContain(EMAIL);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('signup screen: double submit', () => {
  it('disables the submit control while a request is in flight and sends exactly one request', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    render(<SignupPage />);
    fillAndSubmit();

    const button = screen.getByRole('button', { name: /creating/i }) as HTMLButtonElement;
    await waitFor(() => {
      expect(button.getAttribute('aria-disabled')).toBe('true');
    });
    // aria-disabled, not disabled: the control stays focusable mid-submit.
    expect(button.disabled).toBe(false);
    expect((button.closest('form') as HTMLFormElement).getAttribute('aria-busy')).toBe('true');

    fireEvent.click(button);
    fireEvent.submit(button.closest('form') as HTMLFormElement);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse(200, { user: FRESH_USER }));
    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
  });
});

describe('signup screen: focus after a failed submit', () => {
  it('a form-level failure submitted from the keyboard moves focus to the alert region', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { code: 'internal_error', message: 'x' }));

    render(<SignupPage />);
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: NAME } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: EMAIL } });
    const password = screen.getByLabelText(/^password$/i);
    fireEvent.change(password, { target: { value: PASSWORD } });
    password.focus();
    // Enter in the last field submits the form; no pointer involved.
    fireEvent.submit(password.closest('form') as HTMLFormElement);

    const alert = await screen.findByRole('alert');
    await waitFor(() => {
      expect(document.activeElement).toBe(alert);
    });
    expect(alert.getAttribute('tabindex')).toBe('-1');
  });

  it('a field failure moves focus to the first invalid field, not the alert', async () => {
    render(<SignupPage />);
    fillAndSubmit({ name: '', email: 'bad' });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText(/^name$/i));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
