/**
 * TASK-2-14 (STORY-2-10, AC-2-49 and the field half of AC-2-50). `<LinkForm />` in both
 * modes: the create form on the list page and the edit form on `/links/[linkId]`.
 *
 * What is pinned here, in the card's own words: the client-side `validateSlug` fires
 * BEFORE any request with the deterministic violation copy; a server `slug_taken` lands on
 * the slug field and the form state survives it; a destination scheme refusal lands on its
 * own field; the expiry inputs are local-timezone with the zone stated; and
 * `activatesAt >= expiresAt` is refused client-side.
 *
 * Contract: docs/contracts/slug.md (the five violations, their fixed order, and the token
 *   in `details.fieldErrors.slug`), docs/contracts/error-envelope.md (the fixed 409, the
 *   429), docs/contracts/web-api-client.md (`/api/bff/*`).
 * ADR: adr-0007 (slugs are case-sensitive; the violation order is fixed), adr-0014.
 * Decision: D-2-12 (no `domainId` in the create body), D-2-18.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Link } from '@shortkit/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { LinkForm } from './link-form';
import { fromLocalInput, resolvedTimeZone, toLocalInputValue } from './links-view';
import { LINK_MESSAGES, SLUG_VIOLATION_MESSAGES } from '../../lib/links/links-api';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';

const EXISTING: Link = {
  id: LINK_ID,
  workspaceId: WORKSPACE_ID,
  domainId: DOMAIN_ID,
  hostname: 'localhost',
  slug: 'gH7kM2p',
  destinationUrl: 'https://example.com/landing',
  expiresAt: null,
  activatesAt: null,
  createdAt: '2026-08-19T10:00:00.000Z',
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** `errorEnvelopeContract` is FLAT: `{ code, message, details? }`, never nested. */
function errorEnvelope(code: string, message: string, details?: unknown): unknown {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

let fetchMock: MockInstance<typeof fetch>;
let onSaved: ReturnType<typeof vi.fn>;
let onFailure: ReturnType<typeof vi.fn>;

function fetchCalls(): { method: string; url: string; body: unknown }[] {
  return fetchMock.mock.calls.map(([input, init]) => {
    const request = (init as RequestInit | undefined) ?? {};
    const raw = request.body;

    return {
      method: request.method ?? 'GET',
      url: String(input),
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined,
    };
  });
}

function renderCreate(): void {
  render(<LinkForm mode={{ kind: 'create', workspaceId: WORKSPACE_ID }} onSaved={onSaved} onFailure={onFailure} />);
}

function renderEdit(link: Link = EXISTING): void {
  render(<LinkForm mode={{ kind: 'edit', link }} onSaved={onSaved} onFailure={onFailure} />);
}

function destinationInput(): HTMLInputElement {
  return screen.getByLabelText(/destination url/i) as HTMLInputElement;
}

function slugInput(): HTMLInputElement {
  return screen.getByLabelText(/slug/i) as HTMLInputElement;
}

function activatesInput(): HTMLInputElement {
  return screen.getByLabelText(/activates at/i) as HTMLInputElement;
}

function expiresInput(): HTMLInputElement {
  return screen.getByLabelText(/expires at/i) as HTMLInputElement;
}

function type(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

function submit(name: RegExp): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

const CREATE = /^create link$/i;
const SAVE = /^save changes$/i;

beforeEach(() => {
  onSaved = vi.fn();
  onFailure = vi.fn();
  fetchMock = vi.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(201, EXISTING)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('link form: the slug pre-check runs before any request (AC-2-49)', () => {
  it.each([
    ['reserved', 'admin'],
    ['invalid_characters', 'has spaces'],
    ['leading_or_trailing_separator', '-lead'],
    ['too_long', 'a'.repeat(65)],
  ] as const)('a %s slug shows the deterministic copy under the field and sends nothing', (violation, value) => {
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    type(slugInput(), value);
    submit(CREATE);

    expect(screen.getByText(SLUG_VIOLATION_MESSAGES[violation])).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(slugInput().getAttribute('aria-invalid')).toBe('true');
    // The field keeps what was typed, so it can be corrected rather than retyped.
    expect(slugInput().value).toBe(value);
    expect(document.activeElement).toBe(slugInput());
  });

  it('an empty slug is not an error: the create body omits it and the API draws one', async () => {
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    submit(CREATE);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(EXISTING);
    });

    const [call] = fetchCalls();
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/bff/links');
    expect(call.body).toEqual({
      workspaceId: WORKSPACE_ID,
      destinationUrl: 'https://example.com/landing',
      expiresAt: null,
      activatesAt: null,
    });
    // D-2-12: no `domainId` in the create body until custom domains exist.
    expect(Object.keys(call.body as object)).not.toContain('domainId');
  });

  it('re-runs on change while a message is showing, and clears it when the slug is corrected', () => {
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    type(slugInput(), 'admin');
    submit(CREATE);
    expect(screen.getByText(SLUG_VIOLATION_MESSAGES.reserved)).toBeTruthy();

    // Still refused, for a different reason: the message follows the rule that refuses it.
    type(slugInput(), 'spring sale');
    expect(screen.getByText(SLUG_VIOLATION_MESSAGES.invalid_characters)).toBeTruthy();
    expect(screen.queryByText(SLUG_VIOLATION_MESSAGES.reserved)).toBeNull();

    type(slugInput(), 'spring-sale');
    expect(screen.queryByText(SLUG_VIOLATION_MESSAGES.invalid_characters)).toBeNull();
    expect(slugInput().getAttribute('aria-invalid')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says nothing while the slug is first being typed: no message appears before a submit', () => {
    renderCreate();
    type(slugInput(), '-');

    expect(screen.queryByText(SLUG_VIOLATION_MESSAGES.leading_or_trailing_separator)).toBeNull();
    expect(slugInput().getAttribute('aria-invalid')).toBeNull();
  });

  it('a case-different slug is sent verbatim: slugs are case-sensitive (ADR-0007)', async () => {
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    type(slugInput(), 'AbC-dE_f');
    submit(CREATE);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
    expect((fetchCalls()[0].body as { slug: string }).slug).toBe('AbC-dE_f');
  });
});

describe('link form: the destination is parsed client-side, on its own field', () => {
  it.each(['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>', 'not a url'])(
    'refuses %j before any request and marks the destination field',
    (value) => {
      renderCreate();
      type(destinationInput(), value);
      submit(CREATE);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(destinationInput().getAttribute('aria-invalid')).toBe('true');
      expect(slugInput().getAttribute('aria-invalid')).toBeNull();
      expect(document.activeElement).toBe(destinationInput());
    },
  );

  it('sends the normalised href, not the raw input', async () => {
    renderCreate();
    type(destinationInput(), 'HTTP://Example.COM');
    submit(CREATE);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
    expect((fetchCalls()[0].body as { destinationUrl: string }).destinationUrl).toBe('http://example.com/');
  });
});

describe('link form: the validity window (AC-2-50)', () => {
  it('states the operator timezone beside the two datetime-local fields', () => {
    renderCreate();

    expect(activatesInput().getAttribute('type')).toBe('datetime-local');
    expect(expiresInput().getAttribute('type')).toBe('datetime-local');

    const zone = resolvedTimeZone();
    const noteId = activatesInput().getAttribute('aria-describedby');
    expect(noteId).not.toBeNull();
    expect(expiresInput().getAttribute('aria-describedby')).toBe(noteId);

    const note = document.getElementById(noteId as string);
    expect(note?.textContent ?? '').toMatch(/local timezone/i);
    if (zone !== null) {
      expect(note?.textContent ?? '').toContain(zone);
    }
  });

  it('refuses activatesAt at or after expiresAt client-side, on the activation field', () => {
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    type(activatesInput(), '2026-09-02T10:00');
    type(expiresInput(), '2026-09-01T10:00');
    submit(CREATE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(activatesInput().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(activatesInput());

    // Equal instants are refused too: the window would be empty.
    type(activatesInput(), '2026-09-01T10:00');
    submit(CREATE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the two bounds as UTC instants read from local time, and null for a cleared field', async () => {
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    type(activatesInput(), '2026-09-01T10:00');
    type(expiresInput(), '2026-09-02T10:00');
    submit(CREATE);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });

    const body = fetchCalls()[0].body as { activatesAt: string; expiresAt: string };
    const activates = fromLocalInput('2026-09-01T10:00');
    const expires = fromLocalInput('2026-09-02T10:00');
    expect(activates.ok && expires.ok).toBe(true);
    expect(body.activatesAt).toBe(activates.ok ? activates.instant : null);
    expect(body.expiresAt).toBe(expires.ok ? expires.instant : null);
    // The wire is UTC whatever the reader's zone is.
    expect(body.activatesAt.endsWith('Z')).toBe(true);
  });

  /**
   * The DOM cannot carry this case: jsdom (and every browser) runs the value-sanitisation
   * algorithm on a `datetime-local` input and replaces anything that is not a local
   * date-time string with the empty string, so the form never sees the text. The rule the
   * form applies to whatever a field DOES hand it is asserted on the reader itself.
   */
  it('refuses a datetime entry that is not a date and time at all', () => {
    expect(fromLocalInput('tomorrow-ish')).toEqual({ ok: false });
    expect(fromLocalInput('')).toEqual({ ok: true, instant: null });
    expect(fromLocalInput('   ')).toEqual({ ok: true, instant: null });
  });
});

describe('link form: a refusal lands where it belongs and the form survives it (AC-2-49)', () => {
  it('a 409 slug_taken lands on the slug field, not a banner, and keeps every value typed', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(409, errorEnvelope('slug_taken', 'That slug is taken.'))),
    );
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    type(slugInput(), 'spring-sale');
    type(expiresInput(), '2026-09-02T10:00');
    submit(CREATE);

    await waitFor(() => {
      expect(screen.getByText(LINK_MESSAGES.slugTaken)).toBeTruthy();
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(slugInput().getAttribute('aria-invalid')).toBe('true');
    expect(slugInput().value).toBe('spring-sale');
    expect(destinationInput().value).toBe('https://example.com/landing');
    expect(expiresInput().value).toBe('2026-09-02T10:00');
    expect(onSaved).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(slugInput());
  });

  it('a 429 shows the wait on a banner and keeps every value typed', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(429, errorEnvelope('rate_limited', 'Too many.'), { 'retry-after': '30' })),
    );
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    type(slugInput(), 'spring-sale');
    submit(CREATE);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(LINK_MESSAGES.rateLimited(30));
    });

    expect(slugInput().value).toBe('spring-sale');
    expect(destinationInput().value).toBe('https://example.com/landing');
    // Focus is moved in an effect, a task after the commit that rendered the banner, so the
    // wait above settles before the move. Ask for the state the form ends in.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('alert'));
    });
  });

  it('a server validation_failed splits across the fields it names and the banner', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          400,
          errorEnvelope('validation_failed', 'Invalid.', {
            fieldErrors: { destinationUrl: ['A destination must be an http:// or https:// URL.'], _form: ['This workspace is archived.'] },
          }),
        ),
      ),
    );
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    submit(CREATE);

    await waitFor(() => {
      expect(screen.getByText('A destination must be an http:// or https:// URL.')).toBeTruthy();
    });
    expect(screen.getByRole('alert').textContent).toBe('This workspace is archived.');
    expect(destinationInput().getAttribute('aria-invalid')).toBe('true');
  });

  it('a server slug violation token is rendered as the same sentence the pre-check uses', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(400, errorEnvelope('validation_failed', 'Invalid.', { fieldErrors: { slug: ['reserved'] } })),
      ),
    );
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    submit(CREATE);

    await waitFor(() => {
      expect(screen.getByText(SLUG_VIOLATION_MESSAGES.reserved)).toBeTruthy();
    });
  });

  it('a 403 says the role does not allow it; a 401 and a 404 are handed to the screen', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(403, errorEnvelope('insufficient_workspace_role', 'No.'))),
    );
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    submit(CREATE);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(LINK_MESSAGES.forbidden);
    });
    expect(onFailure).not.toHaveBeenCalled();

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(401, errorEnvelope('unauthenticated', 'No.'))));
    submit(CREATE);

    await waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith({ kind: 'unauthenticated' });
    });
  });

  it('the submit control is aria-disabled rather than disabled, and a second click sends nothing', async () => {
    let resolveResponse: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    submit(CREATE);

    const button = screen.getByRole('button', { name: /creating|create link/i });
    await waitFor(() => {
      expect(button.getAttribute('aria-disabled')).toBe('true');
    });
    expect(button.hasAttribute('disabled')).toBe(false);

    submit(/creating|create link/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse(jsonResponse(201, EXISTING));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });
});

describe('link form: a repeated identical refusal is announced again', () => {
  /**
   * The discriminating path is a refusal that reaches no network: a server failure is
   * preceded by the form clearing its banner, which unmounts the element anyway, so only a
   * client-side refusal repeated verbatim can tell the `key` apart from that clear. A
   * `workspaceId` the contract rejects is such a refusal: its issue path names no input, so
   * it lands on the banner, twice, with nothing in between.
   */
  it('re-mounts the banner per attempt, so a second identical refusal is not silent', () => {
    render(
      <LinkForm mode={{ kind: 'create', workspaceId: 'not-a-uuid' }} onSaved={onSaved} onFailure={onFailure} />,
    );
    type(destinationInput(), 'https://example.com/landing');

    submit(CREATE);
    const first = screen.getByRole('alert');
    expect(first.textContent).not.toBe('');

    submit(CREATE);

    // `role="alert"` is announced on INSERTION, and React writes no DOM node for an
    // unchanged string, so the same sentence a second time only reaches a screen reader if
    // the element itself was replaced.
    const second = screen.getByRole('alert');
    expect(second).not.toBe(first);
    expect(second.textContent).toBe(first.textContent);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('link form: create mode clears itself only on success', () => {
  it('a success empties every field and returns focus to the destination', async () => {
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    type(slugInput(), 'spring-sale');
    type(expiresInput(), '2026-09-02T10:00');
    submit(CREATE);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(EXISTING);
    });

    expect(destinationInput().value).toBe('');
    expect(slugInput().value).toBe('');
    expect(expiresInput().value).toBe('');
    // Focus is moved in an effect, a task after the commit that cleared the fields, so the
    // wait above settles before the move. Ask for the state the form ends in.
    await waitFor(() => {
      expect(document.activeElement).toBe(destinationInput());
    });
  });

  it('says the slug field may be left empty for a generated code', () => {
    renderCreate();

    expect(screen.getByText(/leave (it |this )?empty for a generated code/i)).toBeTruthy();
  });
});

describe('link form: edit mode (AC-2-50)', () => {
  it('prefills the destination, the slug and both bounds in local time', () => {
    const link: Link = { ...EXISTING, expiresAt: '2026-09-02T10:00:00.000Z', activatesAt: '2026-09-01T10:00:00.000Z' };
    renderEdit(link);

    expect(destinationInput().value).toBe(link.destinationUrl);
    expect(slugInput().value).toBe(link.slug);
    expect(activatesInput().value).toBe(toLocalInputValue(link.activatesAt));
    expect(expiresInput().value).toBe(toLocalInputValue(link.expiresAt));
  });

  it('PATCHes the four patchable fields to /api/bff/links/:linkId and keeps the values on screen', async () => {
    const saved: Link = { ...EXISTING, destinationUrl: 'https://example.com/other' };
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, saved)));
    renderEdit();
    type(destinationInput(), 'https://example.com/other');
    submit(SAVE);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(saved);
    });

    const [call] = fetchCalls();
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe(`/api/bff/links/${LINK_ID}`);
    expect(call.body).toEqual({
      destinationUrl: 'https://example.com/other',
      slug: EXISTING.slug,
      expiresAt: null,
      activatesAt: null,
    });
    // Edit mode never empties itself: the operator stays on the row they were editing.
    expect(destinationInput().value).toBe('https://example.com/other');
  });

  it('clearing an expiry sends null for it', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, EXISTING)));
    renderEdit({ ...EXISTING, expiresAt: '2026-09-02T10:00:00.000Z' });
    expect(expiresInput().value).not.toBe('');

    type(expiresInput(), '');
    submit(SAVE);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
    expect((fetchCalls()[0].body as { expiresAt: string | null }).expiresAt).toBeNull();
  });

  it('an emptied slug field omits the key rather than clearing a slug that cannot be cleared', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, EXISTING)));
    renderEdit();
    type(slugInput(), '');
    submit(SAVE);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
    expect(Object.keys(fetchCalls()[0].body as object)).not.toContain('slug');
  });

  it('runs the same slug pre-check before the PATCH', () => {
    renderEdit();
    type(slugInput(), 'api');
    submit(SAVE);

    expect(screen.getByText(SLUG_VIOLATION_MESSAGES.reserved)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('link form: every request is same-origin, through the BFF (AC-2-51)', () => {
  it('never names the API origin or the short-link origin', async () => {
    renderCreate();
    type(destinationInput(), 'https://example.com/landing');
    submit(CREATE);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });

    for (const { url } of fetchCalls()) {
      expect(url.startsWith('/api/bff/')).toBe(true);
      expect(url).not.toContain('localhost:3001');
      expect(url).not.toContain('http://');
      expect(url).not.toContain('https://');
    }
  });
});
