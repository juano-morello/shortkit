/**
 * TASK-1b-14 (STORY-1b-05, AC-1b-29: the list with state badges and a Revoke control per
 * pending row). Rendered in jsdom with `fetch` mocked. The invariants: one `listitem` per
 * invitation, newest first as the API sent them; the state badge is the row's state, with
 * `expired` DERIVED client-side for a pending row whose `expiresAt` has passed (1b never
 * writes `expired`, invitation-tokens.md); Revoke is offered on pending rows only and is a
 * two-step inline confirm that sends exactly one DELETE; the address never reaches a URL.
 *
 * Contract: docs/contracts/invitation-tokens.md (states), docs/contracts/workspace-authorization.md
 * (`DELETE /api/invitations/:id`), docs/contracts/error-envelope.md.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Invitation } from '@shortkit/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { INVITATIONS_LIST_MESSAGES, InvitationsList, STATE_LABELS, displayState } from './invitations-list';
import type { InvitationScreenFailure } from './invitations-api';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-08-20T12:00:00.000Z');

function invitation(overrides: Partial<Invitation> & Pick<Invitation, 'id' | 'email'>): Invitation {
  return {
    state: 'pending',
    workspaces: [{ workspaceId: WORKSPACE_ID, workspaceName: 'Acme', workspaceRole: 'member' }],
    expiresAt: '2026-08-25T10:00:00.000Z',
    createdAt: '2026-08-18T10:00:00.000Z',
    acceptedAt: null,
    revokedAt: null,
    invitedByUserId: 'user_owner',
    acceptedByUserId: null,
    ...overrides,
  };
}

const PENDING = invitation({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'pending@client.test' });
const ACCEPTED = invitation({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'accepted@client.test',
  state: 'accepted',
  acceptedAt: '2026-08-19T10:00:00.000Z',
  acceptedByUserId: 'user_new',
});
const REVOKED = invitation({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  email: 'revoked@client.test',
  state: 'revoked',
  revokedAt: '2026-08-19T11:00:00.000Z',
});
/** Pending on the API, past its `expiresAt`: the screen derives "Expired". */
const STALE = invitation({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  email: 'stale@client.test',
  createdAt: '2026-08-01T10:00:00.000Z',
  expiresAt: '2026-08-08T10:00:00.000Z',
});
/** Created through the API naming two workspaces; this screen shows the role for ITS workspace. */
const MULTI = invitation({
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  email: 'multi@client.test',
  workspaces: [
    { workspaceId: OTHER_WORKSPACE_ID, workspaceName: 'Bolt', workspaceRole: 'viewer' },
    { workspaceId: WORKSPACE_ID, workspaceName: 'Acme', workspaceRole: 'workspace_admin' },
  ],
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

let fetchMock: MockInstance<typeof fetch>;
let onRevoked: ReturnType<typeof vi.fn<(invitation: Invitation) => void>>;
let onFailure: ReturnType<typeof vi.fn<(failure: InvitationScreenFailure) => void>>;

function renderList(items: Invitation[]): void {
  render(<InvitationsList items={items} workspaceId={WORKSPACE_ID} now={NOW} onRevoked={onRevoked} onFailure={onFailure} />);
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: /^invitations$/i })).getAllByRole('listitem');
}

function rowFor(email: string): HTMLElement {
  const row = rows().find((item) => item.textContent?.includes(email));

  if (row === undefined) {
    throw new Error(`no row for ${email}`);
  }

  return row;
}

function badgeOf(row: HTMLElement): HTMLElement {
  const badge = row.querySelector('[data-state]');

  if (badge === null) {
    throw new Error('no state badge');
  }

  return badge as HTMLElement;
}

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
  onRevoked = vi.fn<(invitation: Invitation) => void>();
  onFailure = vi.fn<(failure: InvitationScreenFailure) => void>();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('displayState', () => {
  it('derives expired for a pending row past its expiresAt and passes every other state through', () => {
    expect(displayState(PENDING, NOW)).toBe('pending');
    expect(displayState(STALE, NOW)).toBe('expired');
    expect(displayState(ACCEPTED, NOW)).toBe('accepted');
    expect(displayState(REVOKED, NOW)).toBe('revoked');
    // A stale accepted row is still accepted: expiry only applies to pending.
    expect(displayState({ ...ACCEPTED, expiresAt: STALE.expiresAt }, NOW)).toBe('accepted');
    // The API's own `expired` (a later sweeper) renders as-is.
    expect(displayState({ ...PENDING, state: 'expired' }, NOW)).toBe('expired');
  });
});

describe('invitations list: structure and accessibility', () => {
  it('renders one list item per invitation, in the order given, each with its address, role and state badge', () => {
    renderList([PENDING, ACCEPTED, REVOKED, STALE]);

    const items = rows();
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain('pending@client.test');
    expect(items[3].textContent).toContain('stale@client.test');

    expect(badgeOf(rowFor('pending@client.test')).textContent).toBe(STATE_LABELS.pending);
    expect(badgeOf(rowFor('accepted@client.test')).textContent).toBe(STATE_LABELS.accepted);
    expect(badgeOf(rowFor('revoked@client.test')).textContent).toBe(STATE_LABELS.revoked);
    expect(badgeOf(rowFor('stale@client.test')).textContent).toBe(STATE_LABELS.expired);
    expect(badgeOf(rowFor('stale@client.test')).getAttribute('data-state')).toBe('expired');

    expect(within(rowFor('pending@client.test')).getByText('Member')).toBeTruthy();
    expect(rowFor('pending@client.test').getAttribute('data-invitation-id')).toBe(PENDING.id);
  });

  it('shows the role for THIS workspace and a "+N more" for an invitation naming others', () => {
    renderList([MULTI]);

    const row = rowFor('multi@client.test');
    expect(within(row).getByText('Admin')).toBeTruthy();
    expect(row.textContent).toContain('+1 more');
    expect(within(row).queryByText('Viewer')).toBeNull();
  });

  it('renders created and expiry as <time> elements carrying the ISO value', () => {
    renderList([PENDING]);

    const times = Array.from(rowFor('pending@client.test').querySelectorAll('time'));
    expect(times.map((time) => time.getAttribute('datetime'))).toEqual([PENDING.createdAt, PENDING.expiresAt]);
  });

  it('offers Revoke on pending rows only, named after the address', () => {
    renderList([PENDING, ACCEPTED, REVOKED, STALE]);

    expect(screen.getByRole('button', { name: 'Revoke pending@client.test' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke accepted@client.test' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke revoked@client.test' })).toBeNull();
    // A derived-expired row is spent already; nothing to revoke.
    expect(screen.queryByRole('button', { name: 'Revoke stale@client.test' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^revoke /i })).toHaveLength(1);
  });
});

describe('invitations list: revoke is a two-step inline confirm', () => {
  it('Revoke reveals the question with focus on Confirm; Cancel closes it and sends nothing', () => {
    renderList([PENDING]);

    const revoke = screen.getByRole('button', { name: 'Revoke pending@client.test' });
    expect(revoke.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(revoke);

    expect(revoke.getAttribute('aria-expanded')).toBe('true');
    const group = screen.getByRole('group', { name: /revoke the invitation for pending@client\.test\?/i });
    const confirm = within(group).getByRole('button', { name: 'Confirm revoking pending@client.test' });
    expect(document.activeElement).toBe(confirm);

    fireEvent.click(within(group).getByRole('button', { name: 'Cancel revoking pending@client.test' }));
    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(revoke);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Escape inside the confirm closes it and returns focus to Revoke', () => {
    renderList([PENDING]);

    const revoke = screen.getByRole('button', { name: 'Revoke pending@client.test' });
    fireEvent.click(revoke);
    // The key lands on the focused Confirm button, where a real keyboard user's would.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm revoking pending@client.test' }), { key: 'Escape' });

    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(revoke);
  });

  it('Confirm sends exactly one DELETE /api/bff/invitations/:id and reports the revoked row', async () => {
    const revoked = { ...PENDING, state: 'revoked' as const, revokedAt: '2026-08-20T12:00:00.000Z' };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, revoked));

    renderList([PENDING]);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke pending@client.test' }));
    const confirm = screen.getByRole('button', { name: 'Confirm revoking pending@client.test' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(onRevoked).toHaveBeenCalledWith(revoked);
    });
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/bff/invitations/${PENDING.id}`);
    expect(init.method).toBe('DELETE');
    expect(url).not.toContain('@');
    expect(url).not.toContain('%40');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404, { kind: 'not_found' }],
    ['invitation_already_accepted', 409, { kind: 'already_accepted' }],
    ['insufficient_workspace_role', 403, { kind: 'forbidden' }],
    ['internal_error', 500, { kind: 'unknown' }],
  ])('a failed revoke (%s) closes the confirm, hands the failure to the screen and reports no change', async (code, status, failure) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, { code, message: 'x' }));

    renderList([PENDING]);
    const revoke = screen.getByRole('button', { name: 'Revoke pending@client.test' });
    fireEvent.click(revoke);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoking pending@client.test' }));

    await waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith(failure);
    });
    expect(onRevoked).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).toBeNull();
    // The row moves focus in an effect, which React flushes a task after the commit that
    // closed the confirm. The wait above settles on that commit, so ask for the end state.
    await waitFor(() => {
      expect(document.activeElement).toBe(revoke);
    });
  });

  it('a 429 carries the seconds to the screen', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { code: 'rate_limited', message: 'x' }, { 'retry-after': '12' }));

    renderList([PENDING]);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke pending@client.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoking pending@client.test' }));

    await waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith({ kind: 'rate_limited', retryAfterSeconds: 12 });
    });
  });
});

describe('invitations list: copy', () => {
  it('names the states in plain words', () => {
    expect(STATE_LABELS).toEqual({ pending: 'Pending', accepted: 'Accepted', expired: 'Expired', revoked: 'Revoked' });
    expect(INVITATIONS_LIST_MESSAGES.heading).toBe('Invitations');
  });
});
