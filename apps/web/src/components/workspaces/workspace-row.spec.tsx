/**
 * TASK-1b-14 (STORY-1b-05, AC-1b-29: "`/workspaces` shows the link only on rows with
 * `workspaceRole: 'workspace_admin'`"). The row's "Invite" link to the per-workspace
 * invitations screen: shown for an ACTIVE workspace the caller administers, named after
 * the workspace, pointing at `INVITATIONS_ROUTE(id)`; absent for a member, a viewer, an
 * archived row, and a row whose `workspaceRole` the API did not send.
 *
 * Hiding is not enforcement — the API 403s a member on `POST /api/invitations` — the row
 * just does not offer what would be refused.
 */
import { render, screen } from '@testing-library/react';
import type { Workspace } from '@shortkit/contracts';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceRow } from './workspace-row';
import { INVITATIONS_ROUTE } from '../invitations/invitations-api';

const T0 = '2026-08-17T10:00:00.000Z';

function workspace(overrides: Partial<Workspace> & Pick<Workspace, 'id' | 'name'>): Workspace {
  return { archivedAt: null, createdAt: T0, updatedAt: T0, ...overrides };
}

const ACME = workspace({ id: '11111111-1111-4111-8111-111111111111', name: 'Acme', workspaceRole: 'workspace_admin' });

function renderRow(row: Workspace): void {
  render(
    <ul>
      <WorkspaceRow workspace={row} onChanged={vi.fn()} onFailure={vi.fn()} />
    </ul>,
  );
}

describe('workspace row: the Invite link', () => {
  it('an active workspace the caller administers links to its invitations screen, named after the workspace', () => {
    renderRow(ACME);

    const link = screen.getByRole('link', { name: 'Invite to Acme' });
    expect(link.getAttribute('href')).toBe(INVITATIONS_ROUTE(ACME.id));
    expect(link.getAttribute('href')).toBe(`/workspaces/${ACME.id}/invitations`);
  });

  it.each([
    ['a member', workspace({ ...ACME, workspaceRole: 'member' })],
    ['a viewer', workspace({ ...ACME, workspaceRole: 'viewer' })],
    ['a row without the role field', workspace({ id: ACME.id, name: ACME.name })],
    ['an archived workspace', workspace({ ...ACME, archivedAt: '2026-08-18T09:00:00.000Z' })],
  ])('%s gets no Invite link', (_label, row) => {
    renderRow(row);

    expect(screen.queryByRole('link', { name: /^invite/i })).toBeNull();
  });

  it('the row keeps its rename and archive controls beside the link', () => {
    renderRow(ACME);

    expect(screen.getByRole('button', { name: 'Rename Acme' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive Acme' })).toBeTruthy();
  });
});
