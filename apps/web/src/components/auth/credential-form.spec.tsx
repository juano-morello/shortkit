/**
 * TASK-008. The shared credential form's error copy, keyed by `ApiError.code`.
 *
 * `apiClient` is mocked here (the page specs go through a mocked `fetch` instead) so each
 * case hands the form one `ApiError` and asserts the copy for it; the 429 normalisation
 * that populates `ApiError.retryAfterSeconds` (`web-api-client.md` step 4) is `client.ts`'s
 * and is covered in `client.spec.ts` (TASK-1b-12 closed W5-01).
 *
 * TASK-1b-12 (item 1b) adds the token-carrying signup cases at the bottom.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ClientModule from '../../lib/api/client';

vi.mock('../../lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ClientModule>();

  return { ...actual, apiClient: vi.fn() };
});

import { ApiError, ContractViolationError, NetworkError, RequestAbortedError, apiClient } from '../../lib/api/client';
import { CredentialForm, messageForSubmitError } from './credential-form';

const apiClientMock = vi.mocked(apiClient);

afterEach(() => {
  vi.restoreAllMocks();
  apiClientMock.mockReset();
});

function submitSignIn(): void {
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'op@agency.test' } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'whatever' } });
  fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
}

describe('CredentialForm: rate_limited copy', () => {
  it('names the retry seconds when the ApiError carries them', async () => {
    apiClientMock.mockRejectedValue(
      new ApiError({ code: 'rate_limited', status: 429, message: 'Too many requests.', retryAfterSeconds: 30 }),
    );
    const onSuccess = vi.fn();

    render(<CredentialForm mode="sign-in" onSuccess={onSuccess} />);
    submitSignIn();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/too many attempts/i);
    expect(alert.textContent).toContain('30 seconds');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('falls back to a moment-based message when no retry value reached the browser', () => {
    const message = messageForSubmitError(new ApiError({ code: 'rate_limited', status: 429, message: 'x' }));

    expect(message).toMatch(/too many attempts/i);
    expect(message).not.toMatch(/\d+ seconds/);
  });

  it('pluralises the retry value correctly', () => {
    expect(
      messageForSubmitError(new ApiError({ code: 'rate_limited', status: 429, message: 'x', retryAfterSeconds: 1 })),
    ).toContain('1 second.');
  });
});

describe('messageForSubmitError: one message per code, none of them a channel', () => {
  it('unauthenticated does not distinguish no-account from wrong-password', () => {
    const message = messageForSubmitError(new ApiError({ code: 'unauthenticated', status: 401, message: 'Invalid email or password' }));

    expect(message).toMatch(/email address or password/i);
    expect(message).not.toMatch(/account|not found|no such|exist/i);
  });

  it('validation_failed without usable details is a generic check-your-details message', () => {
    expect(messageForSubmitError(new ApiError({ code: 'validation_failed', status: 400, message: 'Password too short' }))).toMatch(
      /check/i,
    );
  });

  it('internal_error, an unmapped code, NetworkError and ContractViolationError share the generic retry message', () => {
    const generic = messageForSubmitError(new ApiError({ code: 'internal_error', status: 500, message: 'x' }));

    expect(generic).toMatch(/try again/i);
    expect(messageForSubmitError(new ApiError({ code: 'not_found', status: 404, message: 'x' }))).toBe(generic);
    expect(messageForSubmitError(new NetworkError('Request to POST /x could not be sent.', '/x'))).toBe(generic);
    expect(messageForSubmitError(new ContractViolationError('POST', '/x', []))).toBe(generic);
    expect(messageForSubmitError(new Error('anything'))).toBe(generic);
  });

  it('a caller-initiated abort renders no message', () => {
    expect(messageForSubmitError(new RequestAbortedError('POST', '/x'))).toBeNull();
  });

  it('never echoes the server message verbatim (it could carry what the operator typed)', () => {
    const message = messageForSubmitError(
      new ApiError({ code: 'internal_error', status: 500, message: 'user op@agency.test failed' }),
    );

    expect(message).not.toContain('op@agency.test');
  });
});

// ===========================================================================
// TASK-1b-12 (invitations wave 2): the token-carrying signup body (D-03, D-05, AC-1b-7/12).
// ===========================================================================
import { SIGN_IN_AFTER_INVITED_SIGNUP_URL, SIGN_IN_AFTER_SIGNUP_URL } from './routes';

/** A well-formed capability token shape (uuid '.' 43 base64url). Never a real one. */
const A_TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function submitSignup(): void {
  fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Op' } });
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'op@agency.test' } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'correct horse battery' } });
  fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));
}

function sentBody(): Record<string, unknown> {
  const [req] = apiClientMock.mock.calls[0] as [{ body?: unknown }];

  return req.body as Record<string, unknown>;
}

describe('CredentialForm: invitationToken rides in the signup body (D-03: a body field, never a param)', () => {
  it('signup with invitationToken posts { name, email, password, invitationToken }', async () => {
    apiClientMock.mockResolvedValue({});
    const onSuccess = vi.fn();

    render(<CredentialForm mode="signup" invitationToken={A_TOKEN} onSuccess={onSuccess} />);
    submitSignup();

    await vi.waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    const [req] = apiClientMock.mock.calls[0] as [{ method: string; path: string; params?: unknown; body?: unknown }];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/auth/sign-up/email');
    expect(req.params).toBeUndefined();
    expect(sentBody()).toEqual({
      name: 'Op',
      email: 'op@agency.test',
      password: 'correct horse battery',
      invitationToken: A_TOKEN,
    });
  });

  it('signup without the prop sends no invitationToken key at all', async () => {
    apiClientMock.mockResolvedValue({});
    const onSuccess = vi.fn();

    render(<CredentialForm mode="signup" onSuccess={onSuccess} />);
    submitSignup();

    await vi.waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    expect(sentBody()).toEqual({ name: 'Op', email: 'op@agency.test', password: 'correct horse battery' });
    expect('invitationToken' in sentBody()).toBe(false);
  });

  it('an empty invitationToken is treated as absent (AC-1b-10 on the API side; nothing to send)', async () => {
    apiClientMock.mockResolvedValue({});
    const onSuccess = vi.fn();

    render(<CredentialForm mode="signup" invitationToken="" onSuccess={onSuccess} />);
    submitSignup();

    await vi.waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    expect('invitationToken' in sentBody()).toBe(false);
  });

  it('a malformed invitationToken is treated as absent: the body has no invitationToken key and nothing malformed is posted', async () => {
    apiClientMock.mockResolvedValue({});
    const onSuccess = vi.fn();

    render(<CredentialForm mode="signup" invitationToken="not-a-capability-token" onSuccess={onSuccess} />);
    submitSignup();

    await vi.waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    expect('invitationToken' in sentBody()).toBe(false);
    expect(JSON.stringify(sentBody())).not.toContain('not-a-capability-token');
  });

  it('sign-in ignores the prop: the token is never posted to /auth/sign-in/email', async () => {
    apiClientMock.mockResolvedValue({});
    const onSuccess = vi.fn();

    render(<CredentialForm mode="sign-in" invitationToken={A_TOKEN} onSuccess={onSuccess} />);
    submitSignIn();

    await vi.waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    expect(sentBody()).toEqual({ email: 'op@agency.test', password: 'whatever' });
  });

  it('a client-side validation failure never sends the token anywhere', () => {
    render(<CredentialForm mode="signup" invitationToken={A_TOKEN} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'not-an-address' } });
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    expect(apiClientMock).not.toHaveBeenCalled();
  });
});

describe('the invited-signup landing URL (AC-1b-12)', () => {
  it('is the sign-in screen with ?created=1 and no returnTo: the hook already accepted, sign-in lands on /workspaces', () => {
    expect(SIGN_IN_AFTER_INVITED_SIGNUP_URL).toBe('/sign-in?created=1');
    expect(SIGN_IN_AFTER_INVITED_SIGNUP_URL).toBe(SIGN_IN_AFTER_SIGNUP_URL);
    expect(SIGN_IN_AFTER_INVITED_SIGNUP_URL).not.toContain('returnTo');
  });
});

const replace = vi.fn<(url: string) => void>();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));

import { SignupForm } from './signup-form';

describe('SignupForm: invitationToken and successPath pass through (AC-1b-12)', () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it('defaults to the plain signup landing and sends no token', async () => {
    apiClientMock.mockResolvedValue({});

    render(<SignupForm />);
    submitSignup();

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith(SIGN_IN_AFTER_SIGNUP_URL);
    });
    expect('invitationToken' in sentBody()).toBe(false);
  });

  it('with invitationToken and successPath, posts the token and replaces to the given path', async () => {
    apiClientMock.mockResolvedValue({});

    render(<SignupForm invitationToken={A_TOKEN} successPath={SIGN_IN_AFTER_INVITED_SIGNUP_URL} />);
    submitSignup();

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith(SIGN_IN_AFTER_INVITED_SIGNUP_URL);
    });
    expect(sentBody().invitationToken).toBe(A_TOKEN);
  });

  it('runs onSuccess before the navigation, once, and not on a failure', async () => {
    const order: string[] = [];
    const onSuccess = vi.fn(() => {
      order.push('onSuccess');
    });
    replace.mockImplementation(() => {
      order.push('replace');
    });
    apiClientMock.mockRejectedValueOnce(new Error('first attempt fails'));

    render(<SignupForm invitationToken={A_TOKEN} onSuccess={onSuccess} />);
    submitSignup();

    await screen.findByRole('alert');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    apiClientMock.mockResolvedValue({});
    submitSignup();

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['onSuccess', 'replace']);
    replace.mockReset();
  });
});
