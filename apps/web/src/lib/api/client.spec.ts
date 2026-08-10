/**
 * AC-15 (STORY-004, TASK-008).
 *
 * > Given the web API client receives a response, when the response body does not
 * > validate against the declared contract, then the client raises a distinguishable
 * > contract-violation error rather than returning malformed data.
 *
 * "Distinguishable" is the load-bearing word, so every test here fixes what the client
 * raises for ONE kind of response and asserts it is not confusable with a contract
 * violation. A caller has to be able to tell apart:
 *
 *   - a body that failed `contract.safeParse`          -> ContractViolationError
 *   - an error envelope the API deliberately returned  -> ApiError
 *   - a transport failure                              -> NetworkError
 *   - a 5xx body matching no contract at all           -> ApiError (web-api-client.md step 5)
 *
 * The first test is the falsifier for the rest: without it a client that threw
 * ContractViolationError unconditionally would pass every violation assertion below.
 *
 * Contract: design/contracts/web-api-client.md ("Response handling", ordered and
 * normative) and design/contracts/error-envelope.md.
 *
 * `fetch` is the only thing stubbed. It is the genuine external boundary; everything
 * else — the response objects, the zod contracts, the error classes — is real. Response
 * bodies are real `Response` instances and the contracts come from `@shortkit/contracts`,
 * so a fixture "fails validation" because the shared schema rejects it, not because this
 * file decided it does. The two premise guards below enforce exactly that.
 *
 * Only `apiClient` is exercised. `serverApiClient` shares the response-handling steps but
 * reads cookies through `next/headers`, which throws outside a request scope; stubbing it
 * would put a mock between the test and the behaviour AC-15 is about. Recorded as a gap
 * in the TASK-008 red-tests report rather than covered with a mock.
 */
import { idContract, isErrorEnvelope, paginated } from '@shortkit/contracts';
import type { ErrorCode } from '@shortkit/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ContractViolationError, NetworkError, apiClient } from './client';
// The rework block at the bottom of this file reads exports that do not exist yet
// (F-288, F-292). A named import of a missing export is a LINK error that takes the whole
// file down, including the six AC-15 tests above, so those are reached through the
// namespace and reported one by one instead.
import * as client from './client';

/** A real shared contract, not a schema invented for this file. */
const pageOfIds = paginated(idContract);

const AN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/**
 * Premise guard. A fixture is only a contract violation if the DECLARED contract rejects
 * it; if a later edit to `paginated`/`idContract` made this body valid, the violation
 * tests below would silently start asserting nothing.
 */
function bodyFailingTheContract(): unknown {
  const body = { items: ['not-a-uuid'], nextCursor: null, hasMore: false };

  if (pageOfIds.safeParse(body).success) {
    throw new Error('premise broken: the declared contract accepts the malformed fixture');
  }

  return body;
}

/**
 * Premise guard, mirrored. AC-15 asks the client to distinguish a contract violation from
 * an error the API deliberately returned, so the 4xx fixture has to be a body the API
 * really could send — i.e. one `errorEnvelopeContract` accepts.
 */
function wellFormedEnvelope(code: ErrorCode, message: string): unknown {
  const envelope = { code, message };

  if (!isErrorEnvelope(envelope)) {
    throw new Error('premise broken: the fixture is not a well-formed error envelope');
  }

  return envelope;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The network is the only boundary stubbed. */
function networkAnswers(outcome: Response | Error): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome.clone()),
  );
}

function listIds() {
  return { method: 'GET' as const, path: '/links', contract: pageOfIds };
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

describe('apiClient response validation', () => {
  it('AC-15: resolves with the body when it validates against the declared contract', async () => {
    networkAnswers(jsonResponse(200, { items: [AN_ID], nextCursor: null, hasMore: false }));

    await expect(apiClient(listIds())).resolves.toEqual({
      items: [AN_ID],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('AC-15: raises ContractViolationError when a 200 body fails the declared contract', async () => {
    networkAnswers(jsonResponse(200, bodyFailingTheContract()));

    await expect(apiClient(listIds())).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('AC-15: raises ContractViolationError when a 200 body is not JSON at all', async () => {
    networkAnswers(
      new Response('<html>upstream ate it</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(apiClient(listIds())).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('AC-15: raises ApiError, not a contract violation, for a well-formed error envelope', async () => {
    networkAnswers(jsonResponse(404, wellFormedEnvelope('not_found', 'No link lives there.')));

    const outcome = await outcomeOf(apiClient(listIds()));

    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).not.toBeInstanceOf(ContractViolationError);
  });

  it('AC-15: raises NetworkError, not a contract violation, when the transport fails', async () => {
    networkAnswers(new TypeError('Failed to fetch'));

    const outcome = await outcomeOf(apiClient(listIds()));

    expect(outcome).toBeInstanceOf(NetworkError);
    expect(outcome).not.toBeInstanceOf(ContractViolationError);
  });

  it('AC-15: raises ApiError, not a contract violation, for a 5xx body matching no contract', async () => {
    networkAnswers(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const outcome = await outcomeOf(apiClient(listIds()));

    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).not.toBeInstanceOf(ContractViolationError);
  });
});

/* ==========================================================================================
 * REWORK, round 1 (2026-08-10). F-284, F-285, F-286, F-288, F-290, F-292; ADR-0029.
 * ==========================================================================================
 *
 * Everything above this line is unchanged. F-290 is a finding against THIS FILE: the six
 * tests above never inspect what was handed to `fetch` and never inspect an `ApiError`'s
 * fields, so three mutations of `client.ts` kept them all green (`/api/bff` -> `/api`;
 * deleting the `req.body === undefined` branch; dropping `signal`) and so did collapsing
 * `toApiError` to a single `internal_error` arm. The blocks below close those four and add
 * the route-template, abort and normative-export properties the amended contract specifies.
 *
 * Two conventions carried from above: `fetch` is still the only thing stubbed, and every
 * fixture is still a real `Response` validated by a real shared contract. What is new is
 * that the stub's ARGUMENTS are now read — that is the whole of F-290.
 */

/**
 * TASK-022's invitation token: `<tenantId>.<43-char base64url secret>`
 * (`invitation-tokens.md`), a bearer credential granting workspace membership. It is the
 * value the security auditor measured reaching `Error.message` and the own enumerable
 * `path` property. Every character is URL-unreserved, so `encodeURIComponent` leaves it
 * byte-identical — hand-checked, so the URL assertions below can spell the result out.
 */
const INVITATION_SECRET = 'V1StGXR8Z5jdHi6B-myT-aB3cDeFgHiJkLmNoPqRsTu';
const INVITATION_TOKEN = `0f8fad5b-d9cb-469f-a165-70867728950e.${INVITATION_SECRET}`;

/** The route template a caller writes as a source literal (ADR-0029). */
const INVITATION_TEMPLATE = '/invitations/:token';

/**
 * Only used to run the built URL through the same WHATWG normalisation a browser would
 * before sending it. The client is never told this value; it builds a relative string.
 */
const BROWSER_ORIGIN = 'https://app.shortkit.dev';

/** Premise guard, in the shape of the two above: the invitation fixture must really fail. */
function idFailingTheContract(): unknown {
  const body = 'not-a-uuid';

  if (idContract.safeParse(body).success) {
    throw new Error('premise broken: idContract accepts the malformed fixture');
  }

  return body;
}

/** Premise guard for an envelope carrying `details`, which the 4xx fixture above omits. */
function wellFormedEnvelopeWithDetails(
  code: ErrorCode,
  message: string,
  details: unknown,
): unknown {
  const envelope = { code, message, details };

  if (!isErrorEnvelope(envelope)) {
    throw new Error('premise broken: the fixture is not a well-formed error envelope');
  }

  return envelope;
}

/** How many times the client went to the network. */
function fetchCallCount(): number {
  return vi.mocked(globalThis.fetch).mock.calls.length;
}

/**
 * What the client handed `fetch`. `web-api-client.md` step 5: "The string built at step 5
 * is what reaches `fetch`" — a `Request` or absolute `URL` would be a different contract,
 * so it is refused here as a broken premise rather than coerced.
 */
function sentRequest(): { url: string; init: RequestInit } {
  const calls = vi.mocked(globalThis.fetch).mock.calls;

  if (calls.length !== 1) {
    throw new Error(`premise broken: fetch was called ${calls.length} times, expected once`);
  }

  const [input, init] = calls[0];

  if (typeof input !== 'string') {
    throw new Error('premise broken: the client handed fetch something other than a string URL');
  }

  return { url: input, init: init ?? {} };
}

/** Reads a header without pinning whether the client used a literal or a `Headers`. */
function sentHeader(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

/**
 * Everything a default sink prints with no code written to make it happen: the browser's
 * unhandled-rejection line, the Next error overlay, `JSON.stringify` inside a telemetry
 * SDK that spreads the error. `path` was an own ENUMERABLE property, which is how the
 * token survived structured cloning, so the spread is not decoration.
 */
function errorSurface(error: unknown): string {
  return `${String(error)} ${JSON.stringify({ ...(error as object) })}`;
}

/**
 * Invariant 10, asserted in one place. Callers of this assert the URL FIRST: a client that
 * ignored `params` altogether would satisfy the redaction half on its own, and that is the
 * cheapest wrong fix available here.
 */
function expectTemplateOnlySurface(error: unknown): void {
  const surface = errorSurface(error);

  expect((error as { path?: unknown }).path).toBe(INVITATION_TEMPLATE);
  expect(surface).toContain(INVITATION_TEMPLATE);
  expect(surface).not.toContain(INVITATION_TOKEN);
  expect(surface).not.toContain(INVITATION_SECRET);
}

/**
 * A named export that `web-api-client.md` requires of the NORMATIVE FORM but that
 * `client.ts` does not carry yet. Reached dynamically so its absence is one failing test
 * with a legible reason, not a link error that takes the file down.
 */
function exportedFromClient(name: string): unknown {
  return (client as unknown as Record<string, unknown>)[name];
}

/** Same, for a class an `instanceof` assertion needs. */
function errorClassFromClient(name: string): new (...args: never[]) => Error {
  const exported = exportedFromClient(name);

  if (typeof exported !== 'function') {
    throw new Error(`client.ts exports no ${name} class (F-292); nothing to be an instance of`);
  }

  return exported as new (...args: never[]) => Error;
}

/**
 * Steps 1, 2, 3 and 6 of the path construction throw before any promise is involved. The
 * contract does not say whether the throw is synchronous or a rejection, so neither does
 * this file.
 */
function attempt(call: () => Promise<unknown>): Promise<unknown> {
  return outcomeOf(Promise.resolve().then(call));
}

/**
 * The wrapper F-292 describes, written the way a caller reasonably would: a transport
 * failure is worth one more attempt, and the class is the discriminator. It is test-local
 * because the client does not ship one; what it proves is about the client's error class,
 * not about this function.
 */
async function retryOnNetworkError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof NetworkError) {
      return await call();
    }

    throw error;
  }
}

/** The caller aborts while the request is in flight. `fetch` then rejects with the reason. */
function networkAbortsInFlight(controller: AbortController, reason: unknown): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    controller.abort(reason);

    return Promise.reject(controller.signal.reason);
  });
}

/** The caller aborts after the headers arrive; the body stream then errors, as it would. */
function networkAbortsWhileReadingBody(controller: AbortController, reason: unknown): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const answer = new Response(
      new ReadableStream({
        start(streamController) {
          streamController.error(new Error('socket closed'));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    controller.abort(reason);

    return Promise.resolve(answer);
  });
}

describe('apiClient request path construction (F-284, F-285, ADR-0029)', () => {
  it('F-285: sends a paramless request to the same-origin BFF prefix', async () => {
    networkAnswers(jsonResponse(200, { items: [], nextCursor: null, hasMore: false }));

    await apiClient(listIds());

    expect(sentRequest().url).toBe('/api/bff/links');
  });

  it('F-285: percent-encodes a param value, so traversal in it cannot escape /api/bff', async () => {
    networkAnswers(jsonResponse(200, AN_ID));

    await apiClient({
      method: 'GET',
      path: '/links/:id',
      params: { id: '../../auth/token' },
      contract: idContract,
    });

    const { url } = sentRequest();

    expect(url).toBe('/api/bff/links/..%2F..%2Fauth%2Ftoken');
    // The browser normalises before sending, which is why the raw form never reaches the
    // proxy's own segment rejection. Assert the URL AFTER that normalisation.
    expect(new URL(url, BROWSER_ORIGIN).pathname).toBe('/api/bff/links/..%2F..%2Fauth%2Ftoken');
  });

  it('F-285: refuses a template carrying traversal, before the request is sent', async () => {
    networkAnswers(jsonResponse(200, { items: [], nextCursor: null, hasMore: false }));

    const outcome = await attempt(() =>
      apiClient({ method: 'GET', path: '/links/../../auth/token', contract: pageOfIds }),
    );

    expect(fetchCallCount()).toBe(0);
    expect((outcome as Error).message).toBe('apiClient: the GET path is not a route template.');
    // A programming defect, not a runtime condition: nothing retries it, nothing renders it.
    expect(outcome).not.toBeInstanceOf(NetworkError);
    expect(outcome).not.toBeInstanceOf(ContractViolationError);
  });

  it('F-285: refuses a template carrying percent-encoded traversal, before the request is sent', async () => {
    networkAnswers(jsonResponse(200, { items: [], nextCursor: null, hasMore: false }));

    const outcome = await attempt(() =>
      apiClient({ method: 'GET', path: '/links/%2e%2e/%2e%2e/secret', contract: pageOfIds }),
    );

    expect(fetchCallCount()).toBe(0);
    expect((outcome as Error).message).toBe('apiClient: the GET path is not a route template.');
  });

  it("F-285: refuses a param value of '..', which survives encodeURIComponent unchanged", async () => {
    networkAnswers(jsonResponse(200, AN_ID));

    const outcome = await attempt(() =>
      apiClient({ method: 'GET', path: '/links/:id', params: { id: '..' }, contract: idContract }),
    );

    expect(fetchCallCount()).toBe(0);
    expect((outcome as Error).message).toBe(
      "apiClient: a param value for GET /links/:id is empty, '.' or '..'.",
    );
  });

  it('F-285: a ? in a param value cannot inject query parameters', async () => {
    networkAnswers(jsonResponse(200, AN_ID));

    await apiClient({
      method: 'GET',
      path: '/links/:id',
      params: { id: 'x?workspaceId=other' },
      query: { limit: 25 },
      contract: idContract,
    });

    const { url } = sentRequest();
    const normalised = new URL(url, BROWSER_ORIGIN);

    expect(url).toBe('/api/bff/links/x%3FworkspaceId%3Dother?limit=25');
    expect([...normalised.searchParams.keys()]).toEqual(['limit']);
    expect(normalised.searchParams.get('workspaceId')).toBeNull();
  });

  it('F-284: refuses a placeholder with no matching param, before the request is sent', async () => {
    networkAnswers(jsonResponse(200, AN_ID));

    const outcome = await attempt(() =>
      apiClient({ method: 'GET', path: INVITATION_TEMPLATE, contract: idContract }),
    );

    expect(fetchCallCount()).toBe(0);
    expect((outcome as Error).message).toBe(
      'apiClient: params do not match GET /invitations/:token.',
    );
  });

  it('ADR-0029: refuses a path with a credential interpolated into it, naming no path', async () => {
    networkAnswers(new TypeError('Failed to fetch'));

    const outcome = await attempt(() =>
      apiClient({ method: 'GET', path: `/invitations/${INVITATION_TOKEN}`, contract: idContract }),
    );

    expect(fetchCallCount()).toBe(0);
    // The rejection names the method and NOTHING else: at step 1 the path is the value
    // under suspicion, so echoing it is the leak wearing a different hat.
    expect((outcome as Error).message).toBe('apiClient: the GET path is not a route template.');
    expect(errorSurface(outcome)).not.toContain(INVITATION_SECRET);
  });
});

describe('no error apiClient raises carries a caller-supplied value (F-284, ADR-0029)', () => {
  const acceptInvitation = () => ({
    method: 'GET' as const,
    path: INVITATION_TEMPLATE,
    params: { token: INVITATION_TOKEN },
    contract: idContract,
  });

  it('AC-15/F-284: ContractViolationError carries the route template, not the token', async () => {
    networkAnswers(jsonResponse(200, idFailingTheContract()));

    const outcome = await attempt(() => apiClient(acceptInvitation()));

    expect(sentRequest().url).toBe(`/api/bff/invitations/${INVITATION_TOKEN}`);
    expect(outcome).toBeInstanceOf(ContractViolationError);
    expectTemplateOnlySurface(outcome);
  });

  it('AC-15/F-284: NetworkError carries the route template, not the token', async () => {
    // The highest-frequency trigger, and it needs no malformed response: a flaky
    // connection on the one screen that puts a bearer credential in a path.
    networkAnswers(new TypeError('Failed to fetch'));

    const outcome = await attempt(() => apiClient(acceptInvitation()));

    expect(sentRequest().url).toBe(`/api/bff/invitations/${INVITATION_TOKEN}`);
    expect(outcome).toBeInstanceOf(NetworkError);
    expectTemplateOnlySurface(outcome);
  });

  it('AC-15/F-284: RequestAbortedError carries the route template, not the token', async () => {
    const controller = new AbortController();
    // The reason carries no credential: `cause` is caller-constructed and the contract
    // says so explicitly, so a token placed there would prove nothing about the client.
    networkAbortsInFlight(controller, new Error('the invitee navigated away'));

    const outcome = await attempt(() =>
      apiClient({ ...acceptInvitation(), signal: controller.signal }),
    );

    expect(sentRequest().url).toBe(`/api/bff/invitations/${INVITATION_TOKEN}`);
    expect(outcome).toBeInstanceOf(errorClassFromClient('RequestAbortedError'));
    expectTemplateOnlySurface(outcome);
  });
});

describe('a caller-initiated abort is not a transport failure (F-292)', () => {
  it('F-292: an abort with a caller-supplied reason still raises RequestAbortedError', async () => {
    const controller = new AbortController();
    // NOT a DOMException and NOT named 'AbortError'. `abort(reason)` makes fetch reject
    // with the caller's own value, so this is the case a `cause.name` discriminator gets
    // wrong and a `req.signal.aborted` discriminator gets right.
    const reason = { why: 'the user typed another character' };
    networkAbortsInFlight(controller, reason);

    const outcome = await attempt(() => apiClient({ ...listIds(), signal: controller.signal }));

    expect(outcome).toBeInstanceOf(errorClassFromClient('RequestAbortedError'));
    expect(outcome).not.toBeInstanceOf(NetworkError);
    expect((outcome as Error).cause).toBe(reason);
  });

  it('F-292: a retry wrapper keyed on NetworkError does not re-issue an aborted request', async () => {
    const controller = new AbortController();
    networkAbortsInFlight(controller, new DOMException('aborted', 'AbortError'));

    const outcome = await attempt(() =>
      retryOnNetworkError(() => apiClient({ ...listIds(), signal: controller.signal })),
    );

    expect(fetchCallCount()).toBe(1);
    expect(outcome).toBeInstanceOf(errorClassFromClient('RequestAbortedError'));
  });

  it('F-292: an abort while the body is being read raises RequestAbortedError', async () => {
    const controller = new AbortController();
    networkAbortsWhileReadingBody(controller, new DOMException('aborted', 'AbortError'));

    const outcome = await attempt(() => apiClient({ ...listIds(), signal: controller.signal }));

    expect(outcome).toBeInstanceOf(errorClassFromClient('RequestAbortedError'));
    expect(outcome).not.toBeInstanceOf(NetworkError);
  });

  it('F-292: a transport failure on a cancellable request nobody cancelled is a NetworkError', async () => {
    // The falsifier for the three above: a client discriminating on `signal !== undefined`
    // rather than on `signal.aborted` passes them and fails this one.
    const controller = new AbortController();
    networkAnswers(new TypeError('Failed to fetch'));

    const outcome = await attempt(() => apiClient({ ...listIds(), signal: controller.signal }));

    expect(outcome).toBeInstanceOf(NetworkError);
    expect(outcome).not.toBeInstanceOf(errorClassFromClient('RequestAbortedError'));
  });
});

describe('what apiClient hands to fetch (F-290, F-286)', () => {
  it('F-290: a body-carrying request sends the serialised body and its content-type', async () => {
    networkAnswers(jsonResponse(201, AN_ID));

    await apiClient({
      method: 'POST',
      path: '/links',
      body: { slug: 'launch' },
      contract: idContract,
    });

    const { init } = sentRequest();

    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"slug":"launch"}');
    expect(sentHeader(init, 'content-type')).toBe('application/json');
  });

  it('F-290: a GET carries no request body', async () => {
    networkAnswers(jsonResponse(200, { items: [], nextCursor: null, hasMore: false }));

    await apiClient(listIds());

    expect(sentRequest().init.body).toBeUndefined();
  });

  it("F-290: the caller's AbortSignal is handed to fetch, so the request is cancellable", async () => {
    const controller = new AbortController();
    networkAnswers(jsonResponse(200, { items: [], nextCursor: null, hasMore: false }));

    await apiClient({ ...listIds(), signal: controller.signal });

    expect(sentRequest().init.signal).toBe(controller.signal);
  });

  it("F-286: the request is sent with credentials: 'same-origin'", async () => {
    networkAnswers(jsonResponse(200, { items: [], nextCursor: null, hasMore: false }));

    await apiClient(listIds());

    expect(sentRequest().init.credentials).toBe('same-origin');
  });

  it("F-286: the request is sent with redirect: 'error'", async () => {
    // `UPSTREAM_FETCH_REDIRECT = 'manual'` exists so the proxy never follows a 3xx. Under
    // the default `follow`, this function follows it instead, from the victim's browser.
    networkAnswers(jsonResponse(200, { items: [], nextCursor: null, hasMore: false }));

    await apiClient(listIds());

    expect(sentRequest().init.redirect).toBe('error');
  });
});

describe('ApiError carries the fields a screen branches on (F-290, F-289)', () => {
  it('AC-15/F-290: an error envelope reaches ApiError with its code, status and details', async () => {
    networkAnswers(
      jsonResponse(
        409,
        wellFormedEnvelopeWithDetails('slug_taken', 'That short link is taken.', {
          fieldErrors: { slug: ['Already in use.'] },
        }),
      ),
    );

    const outcome = await attempt(() => apiClient(listIds()));

    expect(outcome).toBeInstanceOf(ApiError);
    expect((outcome as ApiError).code).toBe('slug_taken');
    expect((outcome as ApiError).status).toBe(409);
    expect((outcome as ApiError).details).toEqual({ fieldErrors: { slug: ['Already in use.'] } });
    expect((outcome as ApiError).message).toBe('That short link is taken.');
  });

  it('AC-15/F-290: a body matching no envelope becomes internal_error at the transport status', async () => {
    networkAnswers(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const outcome = await attempt(() => apiClient(listIds()));

    // F-289: `status` is the transport status VERBATIM and does not agree with
    // ERROR_CODE_STATUS['internal_error'], which is 500. No caller may assume it does.
    expect((outcome as ApiError).code).toBe('internal_error');
    expect((outcome as ApiError).status).toBe(502);
  });
});

describe('the exports the BFF proxy implementer reads (F-288)', () => {
  it("F-288: 'origin' is exported in the mutating-only allowlist and absent from the unconditional one", () => {
    // The contract names this file as its normative form, so TASK-012 builds the upstream
    // headers from what this file EXPORTS. One allowlist under a docblock enumerating what
    // is deliberately absent reads as complete; every auth mutation then answers 403
    // MISSING_OR_NULL_ORIGIN in production while every direct-to-API test passes. No gate
    // catches it, which is why the export list itself is asserted here.
    expect(exportedFromClient('FORWARDED_REQUEST_HEADERS_MUTATING_ONLY')).toEqual(['origin']);
    // And it stays OUT of the unconditional list: the CSRF check does not run on GET, so a
    // GET would forward an unvalidated attacker-chosen value.
    expect(exportedFromClient('FORWARDED_REQUEST_HEADERS')).not.toContain('origin');
  });

  it('F-288: MUTATING_METHODS names every method the proxy checks Origin on', () => {
    expect(exportedFromClient('MUTATING_METHODS')).toEqual(['POST', 'PATCH', 'PUT', 'DELETE']);
  });

  it('F-288: isMutatingMethod is true for a mutating method and false for GET and HEAD', () => {
    const exported = exportedFromClient('isMutatingMethod');

    if (typeof exported !== 'function') {
      throw new Error('client.ts exports no isMutatingMethod (F-288)');
    }

    const isMutatingMethod = exported as (method: string) => boolean;

    expect(isMutatingMethod('POST')).toBe(true);
    expect(isMutatingMethod('PATCH')).toBe(true);
    expect(isMutatingMethod('PUT')).toBe(true);
    expect(isMutatingMethod('DELETE')).toBe(true);
    expect(isMutatingMethod('GET')).toBe(false);
    expect(isMutatingMethod('HEAD')).toBe(false);
  });
});
