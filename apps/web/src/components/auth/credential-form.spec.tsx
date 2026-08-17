/**
 * TASK-008. The shared credential form's error copy, keyed by `ApiError.code`.
 *
 * `apiClient` is mocked here (the page specs go through a mocked `fetch` instead) because
 * one branch cannot be reached through the real client today: `ApiError.retryAfterSeconds`
 * is populated by the 429 normalisation `web-api-client.md` step 4 describes, which
 * `client.ts` defers to TASK-052. The copy is written for the contract, not for the gap.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
