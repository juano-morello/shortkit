/**
 * TASK-1b-14 (STORY-1b-05, AC-1b-29: the invite form). Rendered in jsdom with `fetch`
 * mocked to answer the BFF's shapes. The invariants: the role picker offers
 * `INVITABLE_WORKSPACE_ROLES` and nothing else; the body is
 * `{ email, workspaces: [{ workspaceId, workspaceRole }] }` for THIS workspace only; a
 * validation failure lands under the field; a 403 says this account cannot invite here;
 * the address reaches a request BODY and never a URL.
 *
 * Contract: docs/contracts/workspace-authorization.md ("Minimum role per surface"),
 * docs/contracts/error-envelope.md, docs/contracts/web-api-client.md.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { INVITABLE_WORKSPACE_ROLES, INVITATION_EMAIL_MAX_LENGTH } from '@shortkit/contracts';
import type { Invitation } from '@shortkit/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { INVITE_FORM_MESSAGES, InviteForm, ROLE_LABELS } from './invite-form';
import { INVITATION_MESSAGES } from './invitation-state-message';
import type { InvitationScreenFailure } from './invitations-api';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const INVITEE = 'new.teammate@client.test';
const T0 = '2026-08-18T10:00:00.000Z';
const T7 = '2026-08-25T10:00:00.000Z';

const CREATED: Invitation = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: INVITEE,
  state: 'pending',
  workspaces: [{ workspaceId: WORKSPACE_ID, workspaceName: 'Acme', workspaceRole: 'member' }],
  expiresAt: T7,
  createdAt: T0,
  acceptedAt: null,
  revokedAt: null,
  invitedByUserId: 'user_owner',
  acceptedByUserId: null,
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

let fetchMock: MockInstance<typeof fetch>;
let onCreated: ReturnType<typeof vi.fn<(invitation: Invitation) => void>>;
let onFailure: ReturnType<typeof vi.fn<(failure: InvitationScreenFailure) => void>>;

function renderForm(): void {
  render(<InviteForm workspaceId={WORKSPACE_ID} onCreated={onCreated} onFailure={onFailure} />);
}

function emailInput(): HTMLInputElement {
  return screen.getByLabelText(/^email address$/i) as HTMLInputElement;
}

function roleSelect(): HTMLSelectElement {
  return screen.getByLabelText(/^role$/i) as HTMLSelectElement;
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: /^send invitation$/i }));
}

function invite(email: string, role?: string): void {
  fireEvent.change(emailInput(), { target: { value: email } });

  if (role !== undefined) {
    fireEvent.change(roleSelect(), { target: { value: role } });
  }

  submit();
}

/** The one place the address may travel: a request BODY. Never a URL. */
function expectAddressInNoUrl(): void {
  for (const [input] of fetchMock.mock.calls) {
    expect(String(input)).not.toContain('teammate');
    expect(String(input)).not.toContain('%40');
  }
}

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
  onCreated = vi.fn<(invitation: Invitation) => void>();
  onFailure = vi.fn<(failure: InvitationScreenFailure) => void>();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invite form: structure and accessibility', () => {
  it('has an email field (autocomplete email, bounded), a role picker and a submit control', () => {
    renderForm();

    const input = emailInput();
    expect(input.getAttribute('type')).toBe('email');
    expect(input.getAttribute('autocomplete')).toBe('email');
    expect(input.getAttribute('maxlength')).toBe(String(INVITATION_EMAIL_MAX_LENGTH));
    expect(roleSelect()).toBeTruthy();
    expect(screen.getByRole('button', { name: /^send invitation$/i })).toBeTruthy();
  });

  it('the role picker offers INVITABLE_WORKSPACE_ROLES only, with human-readable labels, member selected', () => {
    renderForm();

    const options = Array.from(roleSelect().options);
    expect(options.map((option) => option.value)).toEqual([...INVITABLE_WORKSPACE_ROLES]);
    expect(options.map((option) => option.textContent)).toEqual(INVITABLE_WORKSPACE_ROLES.map((role) => ROLE_LABELS[role]));
    expect(options.map((option) => option.value)).not.toContain('viewer');
    expect(roleSelect().value).toBe('member');
  });

  it('posts, never GETs, so a JS-less submit could not put the address in a URL', () => {
    renderForm();

    const form = screen.getByRole('button', { name: /^send invitation$/i }).closest('form');
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form?.getAttribute('novalidate')).not.toBeNull();
  });
});

describe('invite form: AC-1b-29 the body shape', () => {
  it('posts { email, workspaces: [{ workspaceId, workspaceRole }] } for this workspace only, then reports the invitation', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, CREATED));

    renderForm();
    invite(`  ${INVITEE.toUpperCase()} `, 'workspace_admin');

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(CREATED);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/bff/invitations');
    expect(init.method).toBe('POST');
    // Trimmed and lower-cased by the shared contract, exactly as the API would.
    expect(JSON.parse(String(init.body))).toEqual({
      email: INVITEE,
      workspaces: [{ workspaceId: WORKSPACE_ID, workspaceRole: 'workspace_admin' }],
    });
    expectAddressInNoUrl();

    // The address field is cleared and keeps focus; the role is kept for the next one.
    expect(emailInput().value).toBe('');
    expect(document.activeElement).toBe(emailInput());
    expect(roleSelect().value).toBe('workspace_admin');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('defaults the role to member', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, CREATED));

    renderForm();
    invite(INVITEE);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      email: INVITEE,
      workspaces: [{ workspaceId: WORKSPACE_ID, workspaceRole: 'member' }],
    });
  });

  it('a double submit while one is in flight sends exactly one request', async () => {
    let release: (value: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    renderForm();
    invite(INVITEE);
    const sending = screen.getByRole('button', { name: /sending/i });
    fireEvent.click(sending);
    fireEvent.submit(sending.closest('form') as HTMLFormElement);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sending.getAttribute('aria-disabled')).toBe('true');
    // Never `disabled`: the control keeps keyboard focus mid-submit.
    expect(sending.hasAttribute('disabled')).toBe(false);

    release(jsonResponse(201, CREATED));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
  });
});

describe('invite form: validation', () => {
  it('a malformed address is refused client-side, under the field, and nothing is sent', async () => {
    renderForm();
    invite('not-an-address');

    const input = emailInput();
    await waitFor(() => {
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });
    const errorId = input.getAttribute('aria-describedby');
    expect(document.getElementById(String(errorId))?.textContent).toBe(INVITE_FORM_MESSAGES.emailRule);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    // The typed value stays so it can be corrected.
    expect(input.value).toBe('not-an-address');
  });

  it('a server validation_failed keyed under email lands under the field', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        code: 'validation_failed',
        message: 'Validation failed.',
        details: { fieldErrors: { email: ['That address cannot be invited.'] } },
      }),
    );

    renderForm();
    invite(INVITEE);

    await screen.findByText('That address cannot be invited.');
    expect(emailInput().getAttribute('aria-invalid')).toBe('true');
    expect(emailInput().value).toBe(INVITEE);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('a server validation_failed keyed under workspaces (an archived workspace) is one form-level line', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        code: 'validation_failed',
        message: 'Validation failed.',
        details: { fieldErrors: { workspaces: ['Workspace is archived.'] } },
      }),
    );

    renderForm();
    invite(INVITEE);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITE_FORM_MESSAGES.workspaceRefused);
    // The server string is not echoed.
    expect(document.body.textContent).not.toContain('Workspace is archived.');
    expect(emailInput().getAttribute('aria-invalid')).toBeNull();
  });

  it('a validation_failed with no detail shows the shared validation sentence', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { code: 'validation_failed', message: 'Validation failed.' }));

    renderForm();
    invite(INVITEE);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITATION_MESSAGES.validationFailed);
  });
});

describe('invite form: who may invite (the API is the enforcer; the screen only says why)', () => {
  it.each(['insufficient_workspace_role', 'insufficient_tenant_role'])(
    '403 %s says this account cannot invite here, and keeps the typed address',
    async (code) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(403, { code, message: 'x' }));

      renderForm();
      invite(INVITEE);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(INVITE_FORM_MESSAGES.forbidden);
      expect(alert.getAttribute('data-invitation-state')).toBe('forbidden');
      // Focus is moved in an effect, a task after the commit that mounted the banner, so
      // `findByRole` settles before the move. Ask for the state the form ends in.
      await waitFor(() => {
        expect(document.activeElement).toBe(alert);
      });
      expect(emailInput().value).toBe(INVITEE);
      expect(onCreated).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    },
  );

  it('404 not_found (no longer an admin here, or the workspace is gone) says so', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { code: 'not_found', message: 'x' }));

    renderForm();
    invite(INVITEE);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITE_FORM_MESSAGES.workspaceGone);
  });

  it('429 says how long to wait when the API said', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { code: 'rate_limited', message: 'x' }, { 'retry-after': '30' }));

    renderForm();
    invite(INVITEE);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITATION_MESSAGES.rateLimited(30));
  });

  it('a 500 is one generic retry line', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { code: 'internal_error', message: 'x' }));

    renderForm();
    invite(INVITEE);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(INVITATION_MESSAGES.generic);
  });

  it('401 mid-use is handed to the screen (which navigates to sign-in), nothing rendered here', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'unauthenticated', message: 'x' }));

    renderForm();
    invite(INVITEE);

    await waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith({ kind: 'unauthenticated' });
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
