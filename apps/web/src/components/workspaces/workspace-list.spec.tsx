/**
 * TASK-013 (STORY-004, AC-27; AC-22/AC-23 as the screen observes them). The workspace list,
 * its create form, the inline rename and the archive control, rendered in jsdom with `fetch`
 * mocked to answer the BFF's shapes and `next/navigation`'s `useRouter` mocked to observe
 * the session-expiry navigation.
 *
 * Contract: docs/contracts/workspaces.md ("Endpoints"), docs/contracts/error-envelope.md,
 * docs/contracts/web-api-client.md.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WORKSPACE_NAME_MAX_LENGTH } from '@shortkit/contracts';
import type { Workspace } from '@shortkit/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

const replace = vi.fn<(url: string) => void>();
const push = vi.fn<(url: string) => void>();
const routerRefresh = vi.fn<() => void>();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push, refresh: routerRefresh }),
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

import { WorkspaceList } from './workspace-list';
import { ARCHIVED_PARAM, ARCHIVED_VALUE, SIGN_IN_AFTER_EXPIRY_URL, WORKSPACE_MESSAGES } from './workspaces-api';
import { WORKSPACES_ROUTE } from '../auth/routes';

const T0 = '2026-08-17T10:00:00.000Z';

function workspace(overrides: Partial<Workspace> & Pick<Workspace, 'id' | 'name'>): Workspace {
  return { archivedAt: null, createdAt: T0, updatedAt: T0, ...overrides };
}

const ACME = workspace({ id: '11111111-1111-4111-8111-111111111111', name: 'Acme' });
const BOLT = workspace({ id: '22222222-2222-4222-8222-222222222222', name: 'Bolt' });
const CARO = workspace({ id: '33333333-3333-4333-8333-333333333333', name: 'Caro' });
const ACME_ARCHIVED = workspace({ ...ACME, archivedAt: '2026-08-18T09:00:00.000Z' });

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

let fetchMock: MockInstance<typeof fetch>;

/** The `[url, init]` of the n-th fetch call, so a spec reads the request the screen issued. */
function call(n: number): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];

  return { url, init };
}

function listItems(): HTMLElement[] {
  return within(screen.getByRole('list', { name: /your workspaces/i })).getAllByRole('listitem');
}

/** The two-step archive: the row's Archive button, then its Confirm. */
function archiveWorkspace(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: `Archive ${name}` }));
  fireEvent.click(screen.getByRole('button', { name: `Confirm archiving ${name}` }));
}

function createWorkspace(name: string): void {
  fireEvent.change(screen.getByLabelText(/^workspace name$/i), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: /^create workspace$/i }));
}

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
  replace.mockClear();
  push.mockClear();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workspace list: structure and accessibility', () => {
  it('renders the workspaces as a list, one item per workspace, with a labelled create form', () => {
    render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);

    const items = listItems();
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Acme');
    expect(items[1].textContent).toContain('Bolt');

    const input = screen.getByLabelText(/^workspace name$/i);
    expect(input.getAttribute('maxlength')).toBe(String(WORKSPACE_NAME_MAX_LENGTH));
    expect(screen.getByRole('button', { name: /^create workspace$/i })).toBeTruthy();
  });

  it('has one polite live region for list changes, empty until something happens', () => {
    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
  });

  it('the same announcement twice mutates the region twice, so the repeat is announced too', async () => {
    // Two stale rows, so both archives answer 404 and announce the IDENTICAL `gone` line.
    // React writes no DOM node for an unchanged string, so a region holding a bare string
    // sits silent the second time: the operator acts, hears nothing back, and cannot tell
    // whether the action was received at all. What is asserted here is the MUTATION, not
    // the text, because the text reads correctly either way.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { code: 'not_found', message: 'Not found.' }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [ACME, BOLT] }))
      .mockResolvedValueOnce(jsonResponse(404, { code: 'not_found', message: 'Not found.' }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [ACME, BOLT] }));

    render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);

    archiveWorkspace('Acme');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(WORKSPACE_MESSAGES.gone);
    });

    const region = screen.getByRole('status');
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(region, { childList: true, characterData: true, subtree: true });

    archiveWorkspace('Bolt');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    try {
      await waitFor(() => {
        expect(mutations).toBeGreaterThan(0);
      });
    } finally {
      observer.disconnect();
    }

    // The region itself must NOT be what changed. A live region has to be in the tree
    // before its contents change or assistive technology may never announce it at all, so
    // keying the <p> would trade a dropped repeat for a dropped announcement. Only what is
    // inside the region may be replaced.
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe(WORKSPACE_MESSAGES.gone);
  });

  it('every per-row control names its workspace, so a screen reader hears which one it acts on', () => {
    render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);

    expect(screen.getByRole('button', { name: 'Rename Acme' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive Acme' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rename Bolt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive Bolt' })).toBeTruthy();
  });

  it('the create form posts, never GETs, so a JS-less submit could not put the name in a URL', () => {
    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);

    const form = screen.getByRole('button', { name: /^create workspace$/i }).closest('form');
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
  });
});

describe('workspace list: empty state', () => {
  it('says what a workspace is for and offers the create form instead of an empty list', () => {
    render(<WorkspaceList initialItems={[]} includeArchived={false} />);

    expect(screen.queryByRole('list', { name: /your workspaces/i })).toBeNull();
    expect(screen.getByText(/one workspace per client/i)).toBeTruthy();
    expect(screen.getByLabelText(/^workspace name$/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^create workspace$/i })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('workspace list: AC-27 create', () => {
  it('posts the name, re-fetches the list, and shows the third workspace without a reload', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, CARO))
      .mockResolvedValueOnce(jsonResponse(200, { items: [ACME, BOLT, CARO] }));

    render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);
    expect(listItems()).toHaveLength(2);

    createWorkspace('Caro');

    await waitFor(() => {
      expect(listItems()).toHaveLength(3);
    });
    expect(screen.getByRole('button', { name: 'Rename Caro' })).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const post = call(0);
    expect(post.url).toBe('/api/bff/workspaces');
    expect(post.init.method).toBe('POST');
    expect(JSON.parse(String(post.init.body))).toEqual({ name: 'Caro' });
    expect(post.init.credentials).toBe('same-origin');

    const get = call(1);
    expect(get.url).toBe('/api/bff/workspaces');
    expect(get.init.method).toBe('GET');

    // Announced, and the field is cleared for the next one.
    expect(screen.getByRole('status').textContent).toBe(WORKSPACE_MESSAGES.created('Caro'));
    expect((screen.getByLabelText(/^workspace name$/i) as HTMLInputElement).value).toBe('');
    expect(replace).not.toHaveBeenCalled();
  });

  it('a create from the empty state replaces the empty copy with the list', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, ACME)).mockResolvedValueOnce(jsonResponse(200, { items: [ACME] }));

    render(<WorkspaceList initialItems={[]} includeArchived={false} />);
    createWorkspace('Acme');

    const list = await screen.findByRole('list', { name: /your workspaces/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText(/one workspace per client/i)).toBeNull();
  });

  it('sends the trimmed name (the contract trims before it measures)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, ACME)).mockResolvedValueOnce(jsonResponse(200, { items: [ACME] }));

    render(<WorkspaceList initialItems={[]} includeArchived={false} />);
    createWorkspace('  Acme  ');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(JSON.parse(String(call(0).init.body))).toEqual({ name: 'Acme' });
  });
});

describe('workspace list: create validation', () => {
  it('an empty name is refused client-side, under the field, and nothing is sent', async () => {
    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    createWorkspace('   ');

    const input = screen.getByLabelText(/^workspace name$/i);
    await waitFor(() => {
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });
    const errorId = input.getAttribute('aria-describedby');
    expect(errorId).not.toBeNull();
    expect(document.getElementById(String(errorId))?.textContent).toBe(WORKSPACE_MESSAGES.nameRule);
    expect(fetchMock).not.toHaveBeenCalled();
    // The list is untouched: nothing was added, nothing announced.
    expect(listItems()).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('');
    expect(document.activeElement).toBe(input);
  });

  it('a server validation_failed keyed under name lands under the field and adds nothing', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        code: 'validation_failed',
        message: 'Validation failed.',
        details: { fieldErrors: { name: ['That name cannot be used.'] } },
      }),
    );

    render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);
    createWorkspace('Acme Two');

    await screen.findByText('That name cannot be used.');
    expect(screen.getByLabelText(/^workspace name$/i).getAttribute('aria-invalid')).toBe('true');
    // No re-fetch after a failed create; the two rows are exactly what was there.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listItems()).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toBe('');
    // The typed value stays so it can be corrected.
    expect((screen.getByLabelText(/^workspace name$/i) as HTMLInputElement).value).toBe('Acme Two');
  });

  it('a validation_failed with no name detail shows one form-level alert', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { code: 'validation_failed', message: 'Validation failed.' }));

    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    createWorkspace('Acme Two');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(WORKSPACE_MESSAGES.validationFailed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('workspace list: create failures that are not validation', () => {
  it.each([
    ['rate_limited', 429],
    ['internal_error', 500],
  ])('%s renders one generic retry message and keeps the typed name', async (code, status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, { code, message: 'x' }));

    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    createWorkspace('Acme Two');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(WORKSPACE_MESSAGES.generic);
    expect((screen.getByLabelText(/^workspace name$/i) as HTMLInputElement).value).toBe('Acme Two');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('a transport failure renders the same generic retry message', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    createWorkspace('Acme Two');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(WORKSPACE_MESSAGES.generic);
    expect(replace).not.toHaveBeenCalled();
  });

  it('unauthenticated (the session expired mid-use) sends the operator to sign in with a return path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'unauthenticated', message: 'Sign in.' }));

    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    createWorkspace('Acme Two');

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(SIGN_IN_AFTER_EXPIRY_URL);
    });
    expect(SIGN_IN_AFTER_EXPIRY_URL).toBe(`/sign-in?returnTo=${WORKSPACES_ROUTE}`);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends exactly one request while a create is in flight', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [ACME, BOLT] }));

    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    createWorkspace('Bolt');

    const button = screen.getByRole('button', { name: /creating/i });
    await waitFor(() => {
      expect(button.getAttribute('aria-disabled')).toBe('true');
    });
    // aria-disabled, not disabled: the control stays focusable mid-submit.
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    fireEvent.submit(button.closest('form') as HTMLFormElement);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse(201, BOLT));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe('workspace list: AC-22 rename', () => {
  const ACME_GROUP = { ...ACME, name: 'Acme Group', updatedAt: '2026-08-18T09:00:00.000Z' };

  it('Rename reveals an inline form prefilled with the current name; Save patches by id and re-fetches', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ACME_GROUP))
      .mockResolvedValueOnce(jsonResponse(200, { items: [ACME_GROUP, BOLT] }));

    render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Acme' }));

    const input = screen.getByLabelText(/^new name for acme$/i) as HTMLInputElement;
    expect(input.value).toBe('Acme');
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'Acme Group' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Rename Acme Group' })).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Rename Acme' })).toBeNull();

    const patch = call(0);
    expect(patch.url).toBe(`/api/bff/workspaces/${ACME.id}`);
    expect(patch.init.method).toBe('PATCH');
    expect(JSON.parse(String(patch.init.body))).toEqual({ name: 'Acme Group' });
    expect(call(1).url).toBe('/api/bff/workspaces');

    // Same row, same id, new name; the count did not change.
    const items = listItems();
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('data-workspace-id')).toBe(ACME.id);
    expect(items[0].textContent).toContain('Acme Group');

    expect(screen.getByRole('status').textContent).toBe(WORKSPACE_MESSAGES.renamed('Acme Group'));
    // Focus returns to the control the operator started from.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Acme Group' }));
  });

  it('Enter in the rename field saves; Escape cancels and returns focus to Rename', async () => {
    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Acme' }));

    const input = screen.getByLabelText(/^new name for acme$/i);
    fireEvent.change(input, { target: { value: 'Something else' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByLabelText(/^new name for acme$/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const rename = screen.getByRole('button', { name: 'Rename Acme' });
    expect(document.activeElement).toBe(rename);

    // Enter submits the inline form (it is a real <form>).
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ...ACME, name: 'Acme Two' }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [{ ...ACME, name: 'Acme Two' }] }));
    fireEvent.click(rename);
    const again = screen.getByLabelText(/^new name for acme$/i);
    fireEvent.change(again, { target: { value: 'Acme Two' } });
    fireEvent.submit(again.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Rename Acme Two' })).toBeTruthy();
    });
    expect(call(0).init.method).toBe('PATCH');
  });

  it('Cancel closes the inline form without a request', () => {
    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Acme' }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByLabelText(/^new name for acme$/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Acme' }));
  });

  it('a rename to an empty name is refused under the field and nothing is sent', async () => {
    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Acme' }));

    const input = screen.getByLabelText(/^new name for acme$/i);
    fireEvent.change(input, { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });
    expect(screen.getByText(WORKSPACE_MESSAGES.nameRule)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a server validation_failed on rename lands under the rename field', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        code: 'validation_failed',
        message: 'Validation failed.',
        details: { fieldErrors: { name: ['Too long.'] } },
      }),
    );

    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Acme' }));
    const input = screen.getByLabelText(/^new name for acme$/i);
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText('Too long.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Rename is a disclosure: aria-expanded flips with the form and aria-controls names it', () => {
    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    const rename = screen.getByRole('button', { name: 'Rename Acme' });
    expect(rename.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(rename);
    expect(rename.getAttribute('aria-expanded')).toBe('true');
    const form = screen.getByLabelText(/^new name for acme$/i).closest('form') as HTMLFormElement;
    expect(form.id).toBe(rename.getAttribute('aria-controls'));

    fireEvent.click(rename);
    expect(rename.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText(/^new name for acme$/i)).toBeNull();
    expect(document.activeElement).toBe(rename);
  });

  it('two identical rename failures both move focus to the field', async () => {
    const refused = (): Response =>
      jsonResponse(400, {
        code: 'validation_failed',
        message: 'Validation failed.',
        details: { fieldErrors: { name: ['Too long.'] } },
      });
    fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(refused());

    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Acme' }));
    const input = screen.getByLabelText(/^new name for acme$/i);
    fireEvent.change(input, { target: { value: 'x' } });
    const save = screen.getByRole('button', { name: /^save$/i });

    fireEvent.click(save);
    await screen.findByText('Too long.');
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    // Move focus away, fail again with the same message: focus must come back.
    save.focus();
    expect(document.activeElement).toBe(save);
    fireEvent.click(save);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    expect(screen.getByText('Too long.')).toBeTruthy();
  });

  it('not_found on rename refreshes the list and says the workspace no longer exists', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { code: 'not_found', message: 'Not found.' }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [BOLT] }));

    render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Acme' }));
    fireEvent.change(screen.getByLabelText(/^new name for acme$/i), { target: { value: 'Acme Group' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(listItems()).toHaveLength(1);
    });
    expect(screen.getByRole('status').textContent).toBe(WORKSPACE_MESSAGES.gone);
    expect(call(1).url).toBe('/api/bff/workspaces');
  });
});

describe('workspace list: archive is a two-step inline confirm', () => {
  it('Archive only reveals the confirm (focus on Confirm) and sends nothing; Cancel closes it and returns focus', () => {
    render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);

    const archive = screen.getByRole('button', { name: 'Archive Acme' });
    expect(archive.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(archive);

    expect(archive.getAttribute('aria-expanded')).toBe('true');
    const group = screen.getByRole('group', { name: /archive acme\?/i });
    expect(group.id).toBe(archive.getAttribute('aria-controls'));
    const confirm = screen.getByRole('button', { name: 'Confirm archiving Acme' });
    expect(document.activeElement).toBe(confirm);
    expect(fetchMock).not.toHaveBeenCalled();
    // The other row is untouched.
    expect(screen.getByRole('button', { name: 'Archive Bolt' }).getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel archiving Acme' }));
    expect(screen.queryByRole('button', { name: 'Confirm archiving Acme' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Archive Acme' }));
    expect(listItems()).toHaveLength(2);
  });

  it('Escape inside the confirm closes it and returns focus to Archive, sending nothing', () => {
    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive Acme' }));

    fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm archiving Acme' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Confirm archiving Acme' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Archive Acme' }));
  });

  it('a second click on Archive while the confirm is open collapses it', () => {
    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    const archive = screen.getByRole('button', { name: 'Archive Acme' });
    fireEvent.click(archive);
    fireEvent.click(archive);

    expect(archive.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Confirm archiving Acme' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Confirm sends exactly one request even when clicked twice', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));

    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive Acme' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm archiving Acme' }));
    fireEvent.click(await screen.findByRole('button', { name: /archiving… archiving acme/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse(200, ACME_ARCHIVED));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe('workspace list: AC-23 archive and archived visibility', () => {
  it('Archive posts to the archive route, re-fetches, and the row leaves the default list', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ACME_ARCHIVED))
      .mockResolvedValueOnce(jsonResponse(200, { items: [BOLT] }));

    render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);
    archiveWorkspace('Acme');

    await waitFor(() => {
      expect(listItems()).toHaveLength(1);
    });
    expect(screen.queryByText('Acme')).toBeNull();

    const post = call(0);
    expect(post.url).toBe(`/api/bff/workspaces/${ACME.id}/archive`);
    expect(post.init.method).toBe('POST');
    expect(post.init.body).toBeUndefined();
    expect(call(1).url).toBe('/api/bff/workspaces');

    const status = screen.getByRole('status');
    expect(status.textContent).toBe(WORKSPACE_MESSAGES.archived('Acme'));
    // The row it was on is gone, so focus lands on the announcement rather than on <body>.
    // The move is an EFFECT, and React flushes passive effects in a later task than the
    // commit that removed the row. The wait above settles on that commit, so reading focus
    // straight after it reads the gap between the two, not the state the screen ends in.
    await waitFor(() => {
      expect(document.activeElement).toBe(status);
    });
  });

  it('with archived shown, an archived row carries a text badge and no rename/archive controls', () => {
    render(<WorkspaceList initialItems={[ACME_ARCHIVED, BOLT]} includeArchived />);

    const items = listItems();
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText(/^archived$/i)).toBeTruthy();
    expect(within(items[0]).queryByRole('button', { name: /rename/i })).toBeNull();
    expect(within(items[0]).queryByRole('button', { name: /archive/i })).toBeNull();
    expect(within(items[1]).queryByText(/^archived$/i)).toBeNull();
    expect(within(items[1]).getByRole('button', { name: 'Rename Bolt' })).toBeTruthy();
  });

  it('the visibility switch is a link to the other server-rendered list', () => {
    const { unmount } = render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    const show = screen.getByRole('link', { name: /show archived/i });
    expect(show.getAttribute('href')).toBe(`${WORKSPACES_ROUTE}?${ARCHIVED_PARAM}=${ARCHIVED_VALUE}`);
    unmount();

    render(<WorkspaceList initialItems={[ACME_ARCHIVED]} includeArchived />);
    const hide = screen.getByRole('link', { name: /hide archived/i });
    expect(hide.getAttribute('href')).toBe(WORKSPACES_ROUTE);
  });

  it('a re-fetch while archived are shown asks the API for them too', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, CARO))
      .mockResolvedValueOnce(jsonResponse(200, { items: [ACME_ARCHIVED, BOLT, CARO] }));

    render(<WorkspaceList initialItems={[ACME_ARCHIVED, BOLT]} includeArchived />);
    createWorkspace('Caro');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(call(1).url).toBe('/api/bff/workspaces?includeArchived=true');
    await waitFor(() => {
      expect(listItems()).toHaveLength(3);
    });
  });

  it('archive: not_found refreshes and reports; unauthenticated navigates to sign in', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { code: 'not_found', message: 'Not found.' }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [BOLT] }));

    const { unmount } = render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);
    archiveWorkspace('Acme');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(WORKSPACE_MESSAGES.gone);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();

    fetchMock.mockResolvedValueOnce(jsonResponse(401, { code: 'unauthenticated', message: 'Sign in.' }));
    render(<WorkspaceList initialItems={[BOLT]} includeArchived={false} />);
    archiveWorkspace('Bolt');
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(SIGN_IN_AFTER_EXPIRY_URL);
    });
  });

  it('a failed archive (server error) leaves the row in place and shows a retry message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { code: 'internal_error', message: 'x' }));

    render(<WorkspaceList initialItems={[ACME, BOLT]} includeArchived={false} />);
    archiveWorkspace('Acme');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(WORKSPACE_MESSAGES.generic);
    expect(listItems()).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The confirm closed and the row's controls are back.
    expect(screen.queryByRole('button', { name: 'Confirm archiving Acme' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Archive Acme' })).toBeTruthy();
  });
});

describe('workspace list: the re-fetch after a successful change fails', () => {
  it('keeps what it has, says the list could not be refreshed, and offers a retry that re-fetches', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, CARO))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(200, { items: [ACME, CARO] }));

    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    createWorkspace('Caro');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(WORKSPACE_MESSAGES.refreshFailed);
    expect(listItems()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /reload the list/i }));
    await waitFor(() => {
      expect(listItems()).toHaveLength(2);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(WORKSPACE_MESSAGES.reloaded);
    expect(call(2).url).toBe('/api/bff/workspaces');
  });

  it('a double-click on "Reload the list" issues one GET; the control is aria-disabled while it runs', async () => {
    let resolveReload: (value: Response) => void = () => undefined;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, CARO))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveReload = resolve;
        }),
      );

    render(<WorkspaceList initialItems={[ACME]} includeArchived={false} />);
    createWorkspace('Caro');
    await screen.findByRole('alert');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: /reload the list/i }));
    const busy = await screen.findByRole('button', { name: /reloading/i });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect((busy as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    resolveReload(jsonResponse(200, { items: [ACME, CARO] }));
    await waitFor(() => {
      expect(listItems()).toHaveLength(2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
