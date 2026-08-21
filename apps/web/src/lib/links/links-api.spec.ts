/**
 * TASK-2-13 (STORY-2-10; the classification half of AC-2-49 and the transport half of
 * AC-2-51). The six request builders, the slug pre-check copy, and the one classifier the
 * links screens (TASK-2-14) share.
 *
 * Two things this file is here to pin, because neither is visible by eye in the module:
 *
 *   1. EVERY REQUEST IS A `/api/bff/...` TEMPLATE AND EVERY ID IS A `params` VALUE
 *      (AC-2-51, ADR-0029). `buildRequestUrl` is the real one, so a template that a future
 *      edit turned into an interpolated string fails here rather than at review.
 *   2. THE SLUG FIELD CARRIES BOTH FAILURES (AC-2-49). A 400 whose
 *      `details.fieldErrors.slug` names a `SlugViolation`, and a 409 `slug_taken`, both
 *      land under the slug input with the same copy the local pre-check would have shown,
 *      never on a banner.
 *
 * `fetch` is the only thing stubbed, as in `lib/api/client.spec.ts`: the contracts are the
 * shared ones, the errors are the real classes, and a body "fails narrowing" because
 * `@shortkit/contracts` rejects it. Premise guards below keep the negative cases honest.
 *
 * Contract: docs/contracts/web-api-client.md, docs/contracts/error-envelope.md,
 *   docs/contracts/slug.md (the `fieldErrors.slug = ['<violation>']` mapping).
 */
import {
  ERROR_CODE_STATUS,
  FORM_ERROR_KEY,
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  clickEventContract,
  isLinkActive,
  linkContract,
  validateSlug,
} from '@shortkit/contracts';
import type { ErrorCode, LinkValidityWindow, SlugViolation } from '@shortkit/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ContractViolationError, NetworkError, RequestAbortedError, apiClient, buildRequestUrl } from '../api/client';
import {
  LINKS_PATH,
  LINKS_ROUTE,
  LINK_CLICKS_PATH,
  LINK_MESSAGES,
  LINK_PATH,
  LINK_ROUTE,
  SLUG_VIOLATION_MESSAGES,
  classifyLinkFormError,
  clickEventPageContract,
  createLinkRequest,
  deleteLinkRequest,
  getLinkRequest,
  linkPageContract,
  linkWindowState,
  listClicksRequest,
  listLinksRequest,
  messageForLinkFailure,
  slugFieldError,
  updateLinkRequest,
  validateSlug as reExportedValidateSlug,
} from './links-api';

const A_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const A_LINK_ID = '22222222-2222-4222-8222-222222222222';
const A_DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const A_CLICK_ID = '44444444-4444-4444-8444-444444444444';

/** One link exactly as the API sends it: every timestamp an ISO string (TASK-2-01's rule). */
const A_LINK = {
  id: A_LINK_ID,
  workspaceId: A_WORKSPACE_ID,
  domainId: A_DOMAIN_ID,
  hostname: 'localhost',
  slug: 'spring-sale-2026',
  destinationUrl: 'https://example.com/a?b=c',
  expiresAt: null,
  activatesAt: null,
  createdAt: '2026-08-19T10:00:00.000Z',
};

const A_CLICK = {
  id: A_CLICK_ID,
  linkId: A_LINK_ID,
  occurredAt: '2026-08-19T10:00:01.000Z',
  userAgent: 'Mozilla/5.0',
};

/** Premise guard: the fixtures above are bodies the SHARED contracts accept. */
function premiseCheckedFixtures(): void {
  if (!linkContract.safeParse(A_LINK).success) {
    throw new Error('premise broken: the link fixture is not a body linkContract accepts');
  }

  if (!clickEventContract.safeParse(A_CLICK).success) {
    throw new Error('premise broken: the click fixture is not a body clickEventContract accepts');
  }
}

premiseCheckedFixtures();

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The network is the only boundary stubbed. Returns the spy so a URL can be read off it. */
function networkAnswers(response: Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(response.clone()));
}

/** The URL the one stubbed call was made against. */
function urlOf(spy: ReturnType<typeof networkAnswers>): string {
  expect(spy).toHaveBeenCalledTimes(1);

  return String(spy.mock.calls[0][0]);
}

function apiError(code: ErrorCode, extra: { details?: unknown; retryAfterSeconds?: number } = {}): ApiError {
  return new ApiError({ code, status: ERROR_CODE_STATUS[code], message: 'x', ...extra });
}

/** Resolves to the rejection reason, or to the resolved value when the call did not throw. */
function outcomeOf<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    (value) => value,
    (reason: unknown) => reason,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the six request builders (ADR-0029: templates are literals, ids go in params)', () => {
  it('createLinkRequest posts the body to /links against linkContract', () => {
    const body = { workspaceId: A_WORKSPACE_ID, destinationUrl: 'https://example.com/a' };
    const req = createLinkRequest(body);

    expect(req.method).toBe('POST');
    expect(req.path).toBe(LINKS_PATH);
    expect(req.body).toEqual(body);
    expect(req.params).toBeUndefined();
    expect(req.contract).toBe(linkContract);
    expect(buildRequestUrl(req)).toBe('/api/bff/links');
  });

  it('listLinksRequest is GET /links?workspaceId= against a page of links', () => {
    const req = listLinksRequest(A_WORKSPACE_ID);

    expect(req.method).toBe('GET');
    expect(req.path).toBe(LINKS_PATH);
    expect(req.query).toEqual({ workspaceId: A_WORKSPACE_ID, cursor: undefined });
    expect(req.contract).toBe(linkPageContract);
    expect(buildRequestUrl(req)).toBe(`/api/bff/links?workspaceId=${A_WORKSPACE_ID}`);
  });

  it('listLinksRequest passes a cursor through verbatim, and omits it when there is none', () => {
    const cursor = '2026-08-19T10:00:00.000Z|22222222-2222-4222-8222-222222222222';

    expect(buildRequestUrl(listLinksRequest(A_WORKSPACE_ID, cursor))).toBe(
      `/api/bff/links?workspaceId=${A_WORKSPACE_ID}&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(buildRequestUrl(listLinksRequest(A_WORKSPACE_ID))).not.toContain('cursor');
  });

  it('getLinkRequest is GET /links/:linkId with the id in params', () => {
    const req = getLinkRequest(A_LINK_ID);

    expect(req.method).toBe('GET');
    expect(req.path).toBe(LINK_PATH);
    expect(req.params).toEqual({ linkId: A_LINK_ID });
    expect(req.contract).toBe(linkContract);
    expect(buildRequestUrl(req)).toBe(`/api/bff/links/${A_LINK_ID}`);
  });

  it('updateLinkRequest is PATCH /links/:linkId with the patch as the body', () => {
    const req = updateLinkRequest(A_LINK_ID, { slug: 'summer-sale' });

    expect(req.method).toBe('PATCH');
    expect(req.path).toBe(LINK_PATH);
    expect(req.params).toEqual({ linkId: A_LINK_ID });
    expect(req.body).toEqual({ slug: 'summer-sale' });
    expect(req.contract).toBe(linkContract);
    expect(buildRequestUrl(req)).toBe(`/api/bff/links/${A_LINK_ID}`);
  });

  it('updateLinkRequest carries an explicit null through, which is how an expiry is cleared', () => {
    // Absent means "leave it alone", null means "clear it" (createLinkBaseContract). A
    // builder that dropped the key would make an expiry unremovable.
    expect(updateLinkRequest(A_LINK_ID, { expiresAt: null }).body).toEqual({ expiresAt: null });
  });

  it('deleteLinkRequest is DELETE /links/:linkId and expects the deleted link back', () => {
    const req = deleteLinkRequest(A_LINK_ID);

    expect(req.method).toBe('DELETE');
    expect(req.path).toBe(LINK_PATH);
    expect(req.params).toEqual({ linkId: A_LINK_ID });
    expect(req.contract).toBe(linkContract);
    expect(buildRequestUrl(req)).toBe(`/api/bff/links/${A_LINK_ID}`);
  });

  it('listClicksRequest is GET /links/:linkId/clicks against a page of click events', () => {
    const req = listClicksRequest(A_LINK_ID);

    expect(req.method).toBe('GET');
    expect(req.path).toBe(LINK_CLICKS_PATH);
    expect(req.params).toEqual({ linkId: A_LINK_ID });
    expect(req.contract).toBe(clickEventPageContract);
    expect(buildRequestUrl(req)).toBe(`/api/bff/links/${A_LINK_ID}/clicks`);
  });

  it('listClicksRequest sends only the query bounds it was given', () => {
    const req = listClicksRequest(A_LINK_ID, { from: '2026-08-01T00:00:00.000Z', limit: 50 });

    expect(buildRequestUrl(req)).toBe(
      `/api/bff/links/${A_LINK_ID}/clicks?from=${encodeURIComponent('2026-08-01T00:00:00.000Z')}&limit=50`,
    );
    expect(buildRequestUrl(listClicksRequest(A_LINK_ID, {}))).toBe(`/api/bff/links/${A_LINK_ID}/clicks`);
  });

  it('AC-2-51: no template names an id, and every built URL sits under /api/bff', () => {
    for (const path of [LINKS_PATH, LINK_PATH, LINK_CLICKS_PATH]) {
      expect(path).not.toContain(A_LINK_ID);
      expect(path).not.toContain(A_WORKSPACE_ID);
    }

    // Built one at a time rather than in an array: each builder has its own response type,
    // and a heterogeneous array would erase them into a union `buildRequestUrl` cannot take.
    for (const url of [
      buildRequestUrl(createLinkRequest({ workspaceId: A_WORKSPACE_ID, destinationUrl: 'https://example.com/a' })),
      buildRequestUrl(listLinksRequest(A_WORKSPACE_ID)),
      buildRequestUrl(getLinkRequest(A_LINK_ID)),
      buildRequestUrl(updateLinkRequest(A_LINK_ID, {})),
      buildRequestUrl(deleteLinkRequest(A_LINK_ID)),
      buildRequestUrl(listClicksRequest(A_LINK_ID)),
    ]) {
      expect(url.startsWith('/api/bff/links')).toBe(true);
    }
  });
});

describe('the screen routes (D-2-18: the links surface lives under the workspace)', () => {
  it('LINKS_ROUTE and LINK_ROUTE build the two page paths', () => {
    expect(LINKS_ROUTE(A_WORKSPACE_ID)).toBe(`/workspaces/${A_WORKSPACE_ID}/links`);
    expect(LINK_ROUTE(A_WORKSPACE_ID, A_LINK_ID)).toBe(`/workspaces/${A_WORKSPACE_ID}/links/${A_LINK_ID}`);
  });
});

describe('linkWindowState: the badge AC-2-48 shows, derived from the shared rule', () => {
  const NOON = new Date('2026-08-19T12:00:00.000Z');
  const MORNING = '2026-08-19T09:00:00.000Z';
  const EVENING = '2026-08-19T18:00:00.000Z';
  const UNREADABLE = 'the day after tomorrow';

  it('is active when neither bound is set (AC-2-27: absence of both is active)', () => {
    expect(linkWindowState({ activatesAt: null, expiresAt: null }, NOON)).toBe('active');
  });

  it('is active AT activatesAt, and scheduled one millisecond earlier (half-open)', () => {
    const link = { activatesAt: NOON.toISOString(), expiresAt: null };

    expect(linkWindowState(link, NOON)).toBe('active');
    expect(linkWindowState(link, new Date(NOON.getTime() - 1))).toBe('scheduled');
  });

  it('is expired AT expiresAt, and active one millisecond earlier (half-open)', () => {
    const link = { activatesAt: null, expiresAt: NOON.toISOString() };

    expect(linkWindowState(link, NOON)).toBe('expired');
    expect(linkWindowState(link, new Date(NOON.getTime() - 1))).toBe('active');
  });

  it('reads one present bound in each direction', () => {
    expect(linkWindowState({ activatesAt: MORNING, expiresAt: null }, NOON)).toBe('active');
    expect(linkWindowState({ activatesAt: EVENING, expiresAt: null }, NOON)).toBe('scheduled');
    expect(linkWindowState({ activatesAt: null, expiresAt: EVENING }, NOON)).toBe('active');
    expect(linkWindowState({ activatesAt: null, expiresAt: MORNING }, NOON)).toBe('expired');
  });

  it('reads both bounds together', () => {
    expect(linkWindowState({ activatesAt: MORNING, expiresAt: EVENING }, NOON)).toBe('active');
    expect(linkWindowState({ activatesAt: EVENING, expiresAt: '2026-08-19T19:00:00.000Z' }, NOON)).toBe('scheduled');
    expect(linkWindowState({ activatesAt: '2026-08-19T07:00:00.000Z', expiresAt: MORNING }, NOON)).toBe('expired');
  });

  it('an unreadable bound in EITHER position answers expired, never scheduled and never active', () => {
    // `isLinkActive` fails closed on a bound it cannot read, and this follows it in the
    // same direction: 'scheduled' would promise the link starts serving later, which is
    // the one claim an unreadable bound cannot support.
    for (const link of [
      { activatesAt: UNREADABLE, expiresAt: null },
      { activatesAt: null, expiresAt: UNREADABLE },
      { activatesAt: UNREADABLE, expiresAt: EVENING },
      { activatesAt: MORNING, expiresAt: UNREADABLE },
      { activatesAt: UNREADABLE, expiresAt: UNREADABLE },
      // The activation alone would read as 'scheduled'; the unreadable expiry outranks it.
      { activatesAt: EVENING, expiresAt: UNREADABLE },
    ]) {
      expect(isLinkActive(link, NOON)).toBe(false);
      expect(linkWindowState(link, NOON)).toBe('expired');
    }
  });

  it('cannot disagree with isLinkActive: active is exactly what the shared rule admits', () => {
    const bounds = [null, MORNING, EVENING, NOON.toISOString(), UNREADABLE];

    for (const activatesAt of bounds) {
      for (const expiresAt of bounds) {
        const link: LinkValidityWindow = { activatesAt, expiresAt };

        expect(linkWindowState(link, NOON) === 'active').toBe(isLinkActive(link, NOON));
      }
    }
  });

  it('accepts the wire shape and real Dates alike, since the shared rule takes both', () => {
    expect(linkWindowState(A_LINK, NOON)).toBe('active');
    expect(linkWindowState({ activatesAt: new Date(EVENING), expiresAt: null }, NOON)).toBe('scheduled');
  });

  it('falls back to the process clock when no instant is passed', () => {
    // The screens pass `now` so a re-render re-derives rather than the row going stale in
    // place; the default is for a one-shot call that has no clock of its own.
    expect(linkWindowState({ activatesAt: null, expiresAt: '2020-01-01T00:00:00.000Z' })).toBe('expired');
    expect(linkWindowState({ activatesAt: '2099-01-01T00:00:00.000Z', expiresAt: null })).toBe('scheduled');
    expect(linkWindowState({ activatesAt: null, expiresAt: null })).toBe('active');
  });
});

describe('the requests on the wire, with fetch spied', () => {
  it('a create reaches /api/bff/links and resolves the body narrowed by linkContract', async () => {
    const spy = networkAnswers(jsonResponse(201, A_LINK));

    const link = await apiClient(
      createLinkRequest({ workspaceId: A_WORKSPACE_ID, destinationUrl: 'https://example.com/a?b=c' }),
    );

    expect(urlOf(spy)).toBe('/api/bff/links');
    expect(link).toEqual(A_LINK);
  });

  it('a create whose 200 body fails linkContract raises a contract violation, not data', async () => {
    // Premise: the shared contract is what refuses it (a link with no hostname).
    const malformed = { ...A_LINK, hostname: undefined };
    expect(linkContract.safeParse(malformed).success).toBe(false);
    networkAnswers(jsonResponse(201, malformed));

    const outcome = await outcomeOf(
      apiClient(createLinkRequest({ workspaceId: A_WORKSPACE_ID, destinationUrl: 'https://example.com/a' })),
    );

    expect(outcome).toBeInstanceOf(ContractViolationError);
  });

  it('a list sends the cursor and resolves a page narrowed by the shared pagination shape', async () => {
    const spy = networkAnswers(jsonResponse(200, { items: [A_LINK], nextCursor: 'next-page', hasMore: true }));

    const page = await apiClient(listLinksRequest(A_WORKSPACE_ID, 'a-cursor'));

    expect(urlOf(spy)).toBe(`/api/bff/links?workspaceId=${A_WORKSPACE_ID}&cursor=a-cursor`);
    expect(page).toEqual({ items: [A_LINK], nextCursor: 'next-page', hasMore: true });
  });

  it('a clicks read is narrowed by clickEventContract, and an ipHash the API never sends is dropped', async () => {
    // GC-R and D-2-19: `ipHash` is on no wire shape. If a future API leaked one, the
    // screens would still never hold it, because the contract has no such key.
    const spy = networkAnswers(
      jsonResponse(200, { items: [{ ...A_CLICK, ipHash: 'deadbeef' }], nextCursor: null, hasMore: false }),
    );

    const page = await apiClient(listClicksRequest(A_LINK_ID, { limit: 10 }));

    expect(urlOf(spy)).toBe(`/api/bff/links/${A_LINK_ID}/clicks?limit=10`);
    expect(page.items).toEqual([A_CLICK]);
    expect(page.items[0]).not.toHaveProperty('ipHash');
  });

  it('AC-2-49: a 400 naming a slug violation classifies onto the slug field, with the local copy', async () => {
    networkAnswers(
      jsonResponse(400, {
        code: 'validation_failed',
        message: 'Some of the fields were not accepted.',
        details: { fieldErrors: { slug: ['reserved'] } },
      }),
    );

    const failure = classifyLinkFormError(
      await outcomeOf(apiClient(createLinkRequest({ workspaceId: A_WORKSPACE_ID, destinationUrl: 'https://example.com/a', slug: 'admin' }))),
    );

    expect(failure).toEqual({
      kind: 'fields',
      fieldErrors: { slug: SLUG_VIOLATION_MESSAGES.reserved },
      formMessage: undefined,
    });
  });

  it('AC-2-49: a 409 slug_taken lands on the slug field with the fixed copy, never on a banner', async () => {
    networkAnswers(jsonResponse(409, { code: 'slug_taken', message: 'That slug is taken.' }));

    const failure = classifyLinkFormError(
      await outcomeOf(apiClient(createLinkRequest({ workspaceId: A_WORKSPACE_ID, destinationUrl: 'https://example.com/a', slug: 'taken' }))),
    );

    expect(failure).toEqual({ kind: 'fields', fieldErrors: { slug: LINK_MESSAGES.slugTaken }, formMessage: undefined });
    expect(messageForLinkFailure(failure)).toBeNull();
  });

  it('AC-2-49: a 429 carries the seconds through the client normalisation onto the banner', async () => {
    networkAnswers(jsonResponse(429, { code: 'rate_limited', message: 'Slow down.' }, { 'retry-after': '30' }));

    const failure = classifyLinkFormError(
      await outcomeOf(apiClient(createLinkRequest({ workspaceId: A_WORKSPACE_ID, destinationUrl: 'https://example.com/a' }))),
    );

    expect(failure).toEqual({ kind: 'rate_limited', retryAfterSeconds: 30 });
    expect(messageForLinkFailure(failure)).toBe(LINK_MESSAGES.rateLimited(30));
  });
});

describe('classifyLinkFormError: keyed by code, never by status', () => {
  it('maps each validated field onto its own input', () => {
    const failure = classifyLinkFormError(
      apiError('validation_failed', {
        details: {
          fieldErrors: {
            destinationUrl: ['Enter a valid URL.'],
            activatesAt: ['The activation time must be before the expiry time.'],
            expiresAt: ['Invalid datetime.'],
          },
        },
      }),
    );

    expect(failure).toEqual({
      kind: 'fields',
      fieldErrors: {
        destinationUrl: 'Enter a valid URL.',
        activatesAt: 'The activation time must be before the expiry time.',
        expiresAt: 'Invalid datetime.',
      },
      formMessage: undefined,
    });
  });

  it('translates every SlugViolation the API can name into the copy the pre-check shows', () => {
    for (const violation of Object.keys(SLUG_VIOLATION_MESSAGES) as SlugViolation[]) {
      expect(classifyLinkFormError(apiError('validation_failed', { details: { fieldErrors: { slug: [violation] } } }))).toEqual({
        kind: 'fields',
        fieldErrors: { slug: SLUG_VIOLATION_MESSAGES[violation] },
        formMessage: undefined,
      });
    }
  });

  it('passes a slug message that is not a violation token through unchanged', () => {
    const failure = classifyLinkFormError(
      apiError('validation_failed', { details: { fieldErrors: { slug: ['Expected string, received number'] } } }),
    );

    expect(failure).toEqual({
      kind: 'fields',
      fieldErrors: { slug: 'Expected string, received number' },
      formMessage: undefined,
    });
  });

  it('puts form-level and unrecognised field errors on the banner rather than dropping them', () => {
    expect(classifyLinkFormError(apiError('validation_failed', { details: { fieldErrors: { [FORM_ERROR_KEY]: ['Too many issues.'] } } }))).toEqual({
      kind: 'fields',
      fieldErrors: {},
      formMessage: 'Too many issues.',
    });

    expect(classifyLinkFormError(apiError('validation_failed', { details: { fieldErrors: { workspaceId: ['Invalid uuid.'] } } }))).toEqual({
      kind: 'fields',
      fieldErrors: {},
      formMessage: LINK_MESSAGES.validationFailed,
    });
  });

  it('falls back to one form-level sentence when the details do not parse at all', () => {
    expect(classifyLinkFormError(apiError('validation_failed'))).toEqual({
      kind: 'fields',
      fieldErrors: {},
      formMessage: LINK_MESSAGES.validationFailed,
    });
  });

  it('gives the screen its own kind for the outcomes that are not a field', () => {
    expect(classifyLinkFormError(apiError('rate_limited', { retryAfterSeconds: 12 }))).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 12,
    });
    expect(classifyLinkFormError(apiError('rate_limited'))).toEqual({ kind: 'rate_limited', retryAfterSeconds: undefined });
    expect(classifyLinkFormError(apiError('not_found'))).toEqual({ kind: 'not_found' });
    expect(classifyLinkFormError(apiError('insufficient_workspace_role'))).toEqual({ kind: 'forbidden' });
    expect(classifyLinkFormError(apiError('insufficient_tenant_role'))).toEqual({ kind: 'forbidden' });
    expect(classifyLinkFormError(apiError('unauthenticated'))).toEqual({ kind: 'unauthenticated' });
  });

  it('a caller-initiated abort is its own kind, so an unmount race renders nothing', () => {
    const failure = classifyLinkFormError(new RequestAbortedError('GET', LINKS_PATH));

    expect(failure).toEqual({ kind: 'aborted' });
    expect(messageForLinkFailure(failure)).toBeNull();
  });

  it('everything else is generic: another code, a transport failure, a contract violation, a plain Error', () => {
    expect(classifyLinkFormError(apiError('internal_error'))).toEqual({ kind: 'generic' });
    expect(classifyLinkFormError(apiError('slug_generation_exhausted'))).toEqual({ kind: 'generic' });
    expect(classifyLinkFormError(new NetworkError('Request to POST /links could not be sent.', LINKS_PATH))).toEqual({ kind: 'generic' });
    expect(classifyLinkFormError(new ContractViolationError('POST', LINKS_PATH, []))).toEqual({ kind: 'generic' });
    expect(classifyLinkFormError(new Error('anything'))).toEqual({ kind: 'generic' });
  });

  it('keys on the code, not the status: a slug_taken at an unexpected status is still the slug field', () => {
    expect(classifyLinkFormError(new ApiError({ code: 'slug_taken', status: 400, message: 'x' }))).toEqual({
      kind: 'fields',
      fieldErrors: { slug: LINK_MESSAGES.slugTaken },
      formMessage: undefined,
    });
  });
});

describe('messageForLinkFailure: one sentence per failure, or nothing to show', () => {
  it('renders the banner copy for the kinds that have one', () => {
    expect(messageForLinkFailure({ kind: 'not_found' })).toBe(LINK_MESSAGES.notFound);
    expect(messageForLinkFailure({ kind: 'forbidden' })).toBe(LINK_MESSAGES.forbidden);
    expect(messageForLinkFailure({ kind: 'unauthenticated' })).toBe(LINK_MESSAGES.unauthenticated);
    expect(messageForLinkFailure({ kind: 'generic' })).toBe(LINK_MESSAGES.generic);
    expect(messageForLinkFailure({ kind: 'rate_limited', retryAfterSeconds: undefined })).toBe(LINK_MESSAGES.rateLimited(undefined));
  });

  it('says nothing for an abort, and nothing for a failure that is entirely under the inputs', () => {
    expect(messageForLinkFailure({ kind: 'aborted' })).toBeNull();
    expect(messageForLinkFailure({ kind: 'fields', fieldErrors: { slug: 'x' }, formMessage: undefined })).toBeNull();
    expect(messageForLinkFailure({ kind: 'fields', fieldErrors: {}, formMessage: 'said it' })).toBe('said it');
  });

  it('counts the seconds in words a human reads, singular included', () => {
    expect(LINK_MESSAGES.rateLimited(1)).toContain('1 second');
    expect(LINK_MESSAGES.rateLimited(30)).toContain('30 seconds');
    expect(LINK_MESSAGES.rateLimited(undefined)).not.toMatch(/\d/);
  });
});

describe('the slug pre-check (AC-2-49: the same violation text before any request)', () => {
  it('covers every violation the shared validator can report, and only those', () => {
    // The map is keyed by the contract's own union, so a sixth violation added upstream
    // fails typecheck here rather than rendering an empty message on the form.
    expect(Object.keys(SLUG_VIOLATION_MESSAGES).sort()).toEqual(
      ['invalid_characters', 'leading_or_trailing_separator', 'reserved', 'too_long', 'too_short'].sort(),
    );

    for (const message of Object.values(SLUG_VIOLATION_MESSAGES)) {
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('reports the first violation in the shared validator order, so the form and the API agree', () => {
    const cases: [string, SlugViolation][] = [
      ['a'.repeat(SLUG_MAX_LENGTH + 1), 'too_long'],
      ['spring sale', 'invalid_characters'],
      ['-sale', 'leading_or_trailing_separator'],
      ['sale-', 'leading_or_trailing_separator'],
      ['admin', 'reserved'],
      ['Admin', 'reserved'],
    ];

    for (const [input, violation] of cases) {
      // Premise: the shared validator is what decides, and this file only maps its answer.
      const validated = validateSlug(input);
      expect(validated.ok === false && validated.violation).toBe(violation);
      expect(slugFieldError(input)).toBe(SLUG_VIOLATION_MESSAGES[violation]);
    }
  });

  it('re-exports the shared validator itself, so a screen never re-implements the rule', () => {
    expect(reExportedValidateSlug).toBe(validateSlug);
  });

  it('accepts a valid custom slug and says nothing', () => {
    expect(slugFieldError('spring-sale-2026')).toBeNull();
    expect(slugFieldError('gH7kM2p')).toBeNull();
  });

  it('treats a blank field as "generate one for me", not as too_short', () => {
    // The create form omits `slug` entirely when the input is empty (D-2-12: no slug means
    // the API draws one), so the blank state is not an error the operator has to clear.
    expect(slugFieldError('')).toBeNull();
    expect(validateSlug('').ok).toBe(false);
  });

  it('refuses every reserved slug, whatever rung refuses it', () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(slugFieldError(reserved)).not.toBeNull();
    }
  });
});
