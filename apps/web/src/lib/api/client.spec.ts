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
 * Contract: docs/contracts/web-api-client.md ("Response handling", ordered and
 * normative) and docs/contracts/error-envelope.md.
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
// `util.inspect` is what `console.error(err)` calls and what pino's `err` serialiser walks.
// It is the channel ADR-0029's follow-up section names as the one that must be MEASURED, and
// the one the round-1 clearance (`JSON.stringify({...e})`, `Object.keys`,
// `getOwnPropertyNames`) was blind to, because `cause` is non-enumerable. See F-310 below.
import { inspect } from 'node:util';

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
      "apiClient: a param value for GET /links/:id is empty, '.', '..' or cannot be percent-encoded.",
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

  it('F-292/F-310: an abort while the body is being read raises RequestAbortedError carrying the signal reason', async () => {
    const controller = new AbortController();
    const reason = new DOMException('aborted', 'AbortError');
    networkAbortsWhileReadingBody(controller, reason);

    const outcome = await attempt(() => apiClient({ ...listIds(), signal: controller.signal }));

    expect(outcome).toBeInstanceOf(errorClassFromClient('RequestAbortedError'));
    expect(outcome).not.toBeInstanceOf(NetworkError);
    // F-335. The READ leg has its own abort branch, and until this line the only test
    // reaching it asserted the class alone — so a branch reading the caught rejection
    // instead of the signal survived the whole suite. The two readings genuinely differ
    // here, which the round-3 note got wrong: `networkAbortsWhileReadingBody` errors the
    // stream with `new Error('socket closed')` while `abort(reason)` carries this
    // DOMException, and `response.text()` rejects with the STREAM error. Measured, not
    // reasoned: `caught === streamErr` is true and `caught === signal.reason` is false.
    //
    // Identity, not a redacted-surface check. `toBe` is strictly stronger than any
    // `deepErrorSurface` assertion could be — if `cause` IS the object the caller handed
    // `abort()`, nothing from the platform rejection is reachable through it at all — and
    // it does not inherit `util.inspect`'s blind spots (F-339).
    expect((outcome as Error).cause).toBe(reason);
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

  it('F-288/ADR-0038: MUTATING_METHODS lists the four mutating methods this design uses', () => {
    // Retitled 2026-08-11 (F-337). It read "names every method the proxy checks Origin on",
    // which ADR-0038 made false: the constant is DESCRIPTIVE, `isMutatingMethod` does not
    // read it, and OPTIONS is checked without appearing here. What the assertion pins is
    // unchanged — the exported list TASK-012's implementer reads — but a reader who took the
    // old title at face value would rebuild the four-item allowlist as the predicate, which
    // is F-233's 403 with every test green. The definition is asserted at 'F-305:
    // isMutatingMethod is true for OPTIONS' and 'NON_MUTATING_METHODS ... names GET and HEAD'.
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

/* ==========================================================================================
 * REWORK, round 2 (2026-08-11). F-306, F-307.
 * ==========================================================================================
 *
 * Everything above this line is unchanged. Two findings, one shape each:
 *
 * F-306 (major, contract) — path construction step 2 compares the placeholder COUNT plus
 * `Object.hasOwn` instead of the placeholder SET web-api-client.md:93-95 specifies, so a
 * template that REPEATS a placeholder lets an unrelated extra key satisfy the count. The
 * failure is not fail-safe: one param's value is substituted into a segment that means
 * something else, and the value the caller actually supplied for that segment is dropped.
 * Filed independently by the reviewer and, as its own F-309, by the security auditor.
 *
 * F-307 (minor, behavior) — `appendQuery` omits `undefined` values (web-api-client.md:100-101)
 * and no test passes one, so the guard can be deleted with all 31 tests still green. The
 * behaviour is correct today; what is missing is the assertion that keeps it correct.
 *
 * The convention from round 1 is carried: `fetch` is the only thing stubbed, and every
 * assertion that names a HARM is written BEFORE the assertion that names the message, so a
 * fix that stops the wrong URL being built without rejecting the call still fails.
 */

/**
 * Every URL the client handed `fetch`, in order. `sentRequest()` refuses any call count but
 * one; this exists to assert a rejected request left NOTHING behind, and to put the URL that
 * WAS built into the failure output when it did not.
 */
function urlsHandedToFetch(): string[] {
  return vi.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input));
}

describe('params must match the template, as a SET (F-306)', () => {
  it('F-306: refuses a repeated placeholder whose extra param key satisfies the count check', async () => {
    // `DELETE /api/members/:id/workspace/:workspaceId` is a real endpoint in the design, and
    // `:id` copied into both segments is the typo it invites.
    networkAnswers(jsonResponse(200, AN_ID));

    const outcome = await attempt(() =>
      apiClient({
        method: 'DELETE',
        path: '/members/:id/workspace/:id',
        params: { id: 'm1', workspaceId: 'w9' },
        contract: idContract,
      }),
    );

    // The URL assertion comes FIRST and names the harmful shape, exactly as the round-1
    // purity tests do. The member id is substituted into the WORKSPACE segment and `w9` is
    // dropped without a word, so this ships a DELETE aimed at workspace `m1` from a call
    // site that looks correct. A fix that merely stopped carrying the extra key would build
    // the same wrong URL and would fail here rather than on the message below.
    expect(urlsHandedToFetch()).toEqual([]);
    expect((outcome as Error).message).toBe(
      'apiClient: params do not match DELETE /members/:id/workspace/:id.',
    );
  });

  it('F-306: refuses a param key matching no placeholder when a repeat inflates the count', async () => {
    // The minimal shape of the same hole, and the reason the guard exists at all: the
    // caller supplied a value for a name the template does not carry, and neither the URL
    // nor any error says so.
    networkAnswers(jsonResponse(200, AN_ID));

    const outcome = await attempt(() =>
      apiClient({
        method: 'GET',
        path: '/a/:x/b/:x',
        params: { x: 'v', totallyIgnored: 'w' },
        contract: idContract,
      }),
    );

    expect(urlsHandedToFetch()).toEqual([]);
    expect((outcome as Error).message).toBe('apiClient: params do not match GET /a/:x/b/:x.');
  });

  it('F-306: refuses a repeated placeholder even when params carry exactly its one key', async () => {
    // GREEN before the fix, and it has to stay green after it. The cheapest fix for the two
    // tests above is to compare `new Set(placeholders)` against the key set, which ACCEPTS
    // this call and builds '/api/bff/a/v/v' — one supplied value silently expanded into two
    // segments. F-306's required change is explicit that a duplicated placeholder is
    // rejected "regardless of what params carries", and the shipped client already rejects
    // this one on the count; nothing here may make it start passing.
    networkAnswers(jsonResponse(200, AN_ID));

    const outcome = await attempt(() =>
      apiClient({ method: 'GET', path: '/a/:x/:x', params: { x: 'v' }, contract: idContract }),
    );

    expect(urlsHandedToFetch()).toEqual([]);
    expect((outcome as Error).message).toBe('apiClient: params do not match GET /a/:x/:x.');
  });
});

describe('the query string apiClient builds (F-307)', () => {
  it('F-307: omits a query value that is undefined and keeps the ones that are not', async () => {
    // An optional cursor left unset is the ordinary shape for this, and without the omission
    // branch the client sends the literal string `cursor=undefined` to the API.
    networkAnswers(jsonResponse(200, { items: [], nextCursor: null, hasMore: false }));

    await apiClient({ ...listIds(), query: { cursor: undefined, limit: 25 } });

    expect(sentRequest().url).toBe('/api/bff/links?limit=25');
  });

  it('F-307: sends no query string at all when every query value is undefined', async () => {
    // The boundary of the same rule: omit them all and there is no query string to append,
    // not an empty one. Beyond F-307's required change by one test, and cheap.
    networkAnswers(jsonResponse(200, { items: [], nextCursor: null, hasMore: false }));

    await apiClient({ ...listIds(), query: { cursor: undefined } });

    expect(sentRequest().url).toBe('/api/bff/links');
  });
});

/* ==========================================================================================
 * REWORK, round 3 (2026-08-11). F-305, F-310, F-311, F-312, F-314.
 * ==========================================================================================
 *
 * Everything above this line is unchanged except ONE literal: the expected message in
 * "F-285: refuses a param value of '..'" moved with the constant F-314 rewrote. The
 * assertion is the same assertion against the same path; only the normative text changed.
 *
 * F-305 and F-311 were open when round 2 was written. The ruling landed 2026-08-11
 * (`TASK-008-contract-cluster-return.md`), so this block exercises the method spellings that
 * DISCRIMINATE between the two readings, and the round-2 note recording the hold came out
 * when the ruling landed, as the ruling's own text says it should (F-337). The six original
 * assertions in "F-288: isMutatingMethod is true for a mutating method and false for GET and
 * HEAD" are untouched and stay green under the new predicate.
 *
 * CLOSE-OUT PASS (2026-08-11, F-335 and F-337) touched two things ABOVE this line, which is
 * the exception to the first paragraph: "F-292/F-310: an abort while the body is being read"
 * gained a `cause` assertion for a branch nothing reached, and the MUTATING_METHODS test was
 * retitled to what it pins. Both are annotated in place. No assertion was removed or weakened.
 *
 * Five rulings, and what each one costs a test:
 *
 * F-305 — mutating means anything that is not GET or HEAD. The PREDICATE is the definition;
 * `MUTATING_METHODS` becomes descriptive and `isMutatingMethod` no longer reads it. OPTIONS
 * is mutating, and `isMutatingMethod('OPTIONS') === true` is the ONLY assertion that
 * separates the two readings — which is exactly why round 2 could not tell them apart.
 *
 * F-311 — the predicate uppercases its own input and defaults to mutating, i.e. fails
 * CLOSED. Measured reachability: `new Request(u, { method: 'post' }).method` normalises to
 * `POST`, but `{ method: 'patch' }` stays lowercase, because PATCH is absent from the Fetch
 * spec's normalise list — and PATCH is one of the four methods `ApiRequest.method` allows.
 *
 * F-310 — `NetworkError` and `ContractViolationError` carry NO `cause`. `RequestAbortedError`
 * carries `{ cause: req.signal.reason }`, read off the SIGNAL, which also closes the
 * abort/transport race. The assertion is on the PROPERTY: `cause` is non-enumerable, so
 * `JSON.stringify({...e})`, `Object.keys` and `getOwnPropertyNames` all came back clean in
 * round 1 while `util.inspect` printed the credential. `errorSurface()` above is blind to it
 * BY CONSTRUCTION; `deepErrorSurface()` below is the one that sees.
 *
 * F-312 / F-314 — a value `encodeURIComponent` cannot encode leaves step 3 by the same exit
 * as the other unusable values, and the message widens to name that fourth condition. F-312
 * shipped in round 2 as production code with no covering test; the implementer disclosed it
 * rather than leaving it, and this is where it closes.
 *
 * F-313 is upheld and needs nothing: the shipped three-clause guard at step 2 IS the ruling,
 * and "F-306: refuses a repeated placeholder even when params carry exactly its one key"
 * stays exactly as written.
 */

/** A lone high surrogate. `encodeURIComponent` raises `URIError: URI malformed` on it. */
const LONE_SURROGATE = '\uD800';

/**
 * The rejection Node's `fetch` hands the `catch` — it carries the RESOLVED URL in its own
 * message, and therefore the credential the route template kept out of `message`, `path`,
 * the spread and the stack. This is the value ADR-0029 measured arriving in a log body as
 * `[cause]: [TypeError: Failed to parse URL from /api/bff/invitations/<full token>`. A
 * browser-shaped `TypeError('Failed to fetch')` carries no URL, which is why the leak needs
 * a Node runtime and why the fixture is shaped like Node's and not like the browser's.
 */
function urlBearingPlatformRejection(): TypeError {
  return new TypeError(`Failed to parse URL from /api/bff/invitations/${INVITATION_TOKEN}`);
}

/**
 * What `console.error(err)` prints and what pino's `err` serialiser walks, which is the
 * whole point: it follows `cause` even though `cause` is non-enumerable, so it is the only
 * surface in this file that can observe F-310 at all. `errorSurface()` above cannot, and
 * that blindness is the mechanism by which round 1 cleared a claim that was false.
 */
function deepErrorSurface(error: unknown): string {
  return inspect(error, { depth: 5 });
}

/** The transport dies mid-body with nothing aborted. The read leg of step 6. */
function networkFailsWhileReadingBody(rejection: Error): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(streamController) {
            streamController.error(rejection);
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
}

/**
 * The race the tie-breaking rule already covers: the signal aborts and the transport fails
 * in the SAME tick, so `fetch` rejects with a platform value that is NOT `signal.reason`.
 * `networkAbortsInFlight` above cannot show this, because it rejects with the reason itself
 * — which is why reading the rejection and reading the signal look identical there.
 */
function networkAbortsAndAlsoFails(
  controller: AbortController,
  reason: unknown,
  platformRejection: Error,
): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    controller.abort(reason);

    return Promise.reject(platformRejection);
  });
}

/** The one call site in this design that puts a bearer credential in a path. */
function acceptInvitationRequest() {
  return {
    method: 'GET' as const,
    path: INVITATION_TEMPLATE,
    params: { token: INVITATION_TOKEN },
    contract: idContract,
  };
}

describe('a param value that cannot be percent-encoded (F-312, F-314)', () => {
  it('F-312: refuses a param value encodeURIComponent cannot encode, before the request is sent', async () => {
    // `encodeURIComponent('\uD800')` throws `URIError: URI malformed`. Without the guard the
    // URIError leaves step 3 by a fifth exit the contract does not enumerate: it is not one
    // of the four ApiRequest failure classes, no caller can name it, and it is raised by a
    // built-in the caller never called. F-312 shipped with no covering test.
    networkAnswers(jsonResponse(200, AN_ID));

    const outcome = await attempt(() =>
      apiClient({
        method: 'GET',
        path: '/links/:id',
        params: { id: LONE_SURROGATE },
        contract: idContract,
      }),
    );

    // Harm first, as in every path-construction test above: nothing reached the network.
    expect(urlsHandedToFetch()).toEqual([]);
    // F-314. The message names the condition that actually occurred. The pre-amendment text
    // named three conditions, NONE of which had happened, sending a developer who checked
    // all three away from the cause.
    expect((outcome as Error).message).toBe(
      "apiClient: a param value for GET /links/:id is empty, '.', '..' or cannot be percent-encoded.",
    );
    // ADR-0029: the value that could not be encoded is caller-supplied by definition, so it
    // is not chained on and not named.
    expect((outcome as Error).cause).toBeUndefined();
  });
});

describe('which methods the proxy treats as mutating (F-305, F-311)', () => {
  function isMutatingMethod(): (method: string) => boolean {
    const exported = exportedFromClient('isMutatingMethod');

    if (typeof exported !== 'function') {
      throw new Error('client.ts exports no isMutatingMethod (F-288)');
    }

    return exported as (method: string) => boolean;
  }

  it('F-305: isMutatingMethod is true for OPTIONS', () => {
    // THE discriminating assertion. Under the four-item allowlist OPTIONS is non-mutating;
    // under "anything that is not GET or HEAD" it is mutating. Nothing else in this file
    // tells the two readings apart, which is why the same document answered the question
    // both ways for three days and why round 2 could not close it.
    //
    // The asymmetry is what decided it: a method wrongly classified NON-mutating loses its
    // `Origin` and gets better-auth's 403 MISSING_OR_NULL_ORIGIN in production while every
    // test that speaks to the API directly passes (F-233). A method wrongly classified
    // mutating gets a CSRF check that has already pinned `Origin` to the deployment origin.
    // Silent-and-expensive against loud-and-harmless.
    expect(isMutatingMethod()('OPTIONS')).toBe(true);
  });

  it('F-311: isMutatingMethod uppercases its own input and defaults to mutating', () => {
    const predicate = isMutatingMethod();

    // Reachable, not hypothetical: `new Request(u, { method: 'post' }).method` normalises to
    // `POST`, but `{ method: 'patch' }` stays lowercase, because PATCH is absent from the
    // Fetch spec's normalise list. PATCH is one of the four methods ApiRequest.method allows.
    expect(predicate('patch')).toBe(true);
    expect(predicate('PoSt')).toBe(true);
    // Fails CLOSED. An unrecognised spelling gets the CSRF check rather than skipping it.
    expect(predicate('')).toBe(true);
    // The falsifier for the three above: a predicate that returned `true` for everything
    // would satisfy them and fail these. Uppercasing has to make GET and HEAD reachable from
    // their lowercase spellings too, not just make the answer `true` more often.
    expect(predicate('get')).toBe(false);
    expect(predicate('head')).toBe(false);
  });

  it('F-305: NON_MUTATING_METHODS is exported and names GET and HEAD', () => {
    // Same shape and same reason as the three F-288 export pins above: web-api-client.md
    // names THIS FILE as its normative form, so the proxy implementer reads the exports and
    // not the contract. The predicate is a denylist now, so this is the list it denies from.
    expect(exportedFromClient('NON_MUTATING_METHODS')).toEqual(['GET', 'HEAD']);
  });
});

describe('cause carries nothing this module chose (F-310, ADR-0029)', () => {
  it('F-310: NetworkError on the send leg carries no cause', async () => {
    networkAnswers(urlBearingPlatformRejection());

    const outcome = await attempt(() => apiClient(acceptInvitationRequest()));

    // Harm first. This is the assertion round 1 could not make, because `errorSurface()`
    // spreads and `cause` is non-enumerable. `console.error(err)` and pino both print this.
    expect(deepErrorSurface(outcome)).not.toContain(INVITATION_SECRET);
    expect(outcome).toBeInstanceOf(NetworkError);
    // On the PROPERTY, never on the spread: the spread reports clean either way, and that is
    // precisely how the defect survived a clearance in round 1.
    expect((outcome as Error).cause).toBeUndefined();
  });

  it('F-310: NetworkError on the read leg carries no cause', async () => {
    // The headers arrived and the body did not. Still transport, still step 6, and the
    // rejection a stream error hands the catch is a platform value on the same footing.
    networkFailsWhileReadingBody(urlBearingPlatformRejection());

    const outcome = await attempt(() => apiClient(acceptInvitationRequest()));

    expect(deepErrorSurface(outcome)).not.toContain(INVITATION_SECRET);
    expect(outcome).toBeInstanceOf(NetworkError);
    expect((outcome as Error).cause).toBeUndefined();
  });

  it('F-310: ContractViolationError carries no cause when the body fails the contract', async () => {
    networkAnswers(jsonResponse(200, idFailingTheContract()));

    const outcome = await attempt(() => apiClient(acceptInvitationRequest()));

    expect(outcome).toBeInstanceOf(ContractViolationError);
    // Nothing zod produced is chained here. `issues` is the channel for what validation
    // reported, and it is the only one.
    expect((outcome as Error).cause).toBeUndefined();
  });

  it('F-310: ContractViolationError carries no cause when a 2xx body is not JSON at all', async () => {
    // The `JSON.parse` arm, whose swallowed SyntaxError is an open round-1 minor. Chaining
    // it is the obvious-looking close for that minor and is exactly the re-add F-310 forbids.
    networkAnswers(
      new Response('<html>upstream ate it</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const outcome = await attempt(() => apiClient(acceptInvitationRequest()));

    expect(outcome).toBeInstanceOf(ContractViolationError);
    expect((outcome as Error).cause).toBeUndefined();
  });

  it('F-310: an abort racing a transport failure carries the signal reason, not the rejection', async () => {
    // The tie-breaking rule already says this raises RequestAbortedError. What it did NOT
    // say is where `cause` comes from, and on THIS race the two answers differ: the caught
    // rejection is the platform's URL-bearing one and `signal.reason` is the caller's.
    // Every other abort test in this file rejects WITH `signal.reason`, so reading the
    // rejection and reading the signal are indistinguishable there. Here they are not.
    const controller = new AbortController();
    const reason = { why: 'the invitee navigated away' };
    networkAbortsAndAlsoFails(controller, reason, urlBearingPlatformRejection());

    const outcome = await attempt(() =>
      apiClient({ ...acceptInvitationRequest(), signal: controller.signal }),
    );

    expect(deepErrorSurface(outcome)).not.toContain(INVITATION_SECRET);
    expect(outcome).toBeInstanceOf(errorClassFromClient('RequestAbortedError'));
    expect(outcome).not.toBeInstanceOf(NetworkError);
    // Read off the signal. The caller constructed this value, holds it, and can read it back
    // off its own AbortSignal, which is why it is the one carve-out ADR-0029 keeps.
    expect((outcome as Error).cause).toBe(reason);
  });
});

// ===========================================================================
// TASK-007 (identity-membership wave 4): the three materialised F-291 deferrals.
// mapBetterAuthError, buildUpstreamUrl, serverApiClient.
// ===========================================================================
import {
  ApiError as ApiErrorClass,
  buildUpstreamUrl,
  mapBetterAuthError,
} from './client';

describe('mapBetterAuthError maps Better Auth native bodies (F-289, F-027, auth-tokens.md)', () => {
  it('maps a wrong password (401 INVALID_EMAIL_OR_PASSWORD) to unauthenticated, message surfaced', () => {
    const error = mapBetterAuthError(401, {
      message: 'Invalid email or password',
      code: 'INVALID_EMAIL_OR_PASSWORD',
    });

    expect(error).toBeInstanceOf(ApiErrorClass);
    expect(error.code).toBe('unauthenticated');
    expect(error.status).toBe(401);
    expect(error.message).toBe('Invalid email or password');
  });

  it('maps the 400 validation shapes to validation_failed', () => {
    for (const code of ['VALIDATION_ERROR', 'PASSWORD_TOO_SHORT', 'PASSWORD_TOO_LONG']) {
      expect(mapBetterAuthError(400, { message: 'x', code }).code).toBe('validation_failed');
    }
  });

  it('F-289: decides the 422 USER_ALREADY_EXISTS code as validation_failed, status preserved at 422', () => {
    const error = mapBetterAuthError(422, {
      message: 'User already exists. Use another email.',
      code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
    });

    expect(error.code).toBe('validation_failed');
    expect(error.status).toBe(422);
    expect(error.message).toBe('User already exists. Use another email.');
  });

  it('maps the origin errors to internal_error without surfacing their message', () => {
    const error = mapBetterAuthError(403, { message: 'Missing or null Origin', code: 'MISSING_OR_NULL_ORIGIN' });

    expect(error.code).toBe('internal_error');
    expect(error.status).toBe(403);
    expect(error.message).not.toContain('Origin');
  });

  it('F-027: a 429 with retryAfterSeconds in the body and no code becomes rate_limited', () => {
    const error = mapBetterAuthError(429, { retryAfterSeconds: 42 });

    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(42);
  });

  it('a 429 prefers the Retry-After header over the body field, and ignores a non-integer header', () => {
    expect(mapBetterAuthError(429, { retryAfterSeconds: 42 }, '7').retryAfterSeconds).toBe(7);
    expect(mapBetterAuthError(429, { retryAfterSeconds: 42 }, 'Wed, 21 Oct 2026 07:28:00 GMT').retryAfterSeconds).toBe(42);
    expect(mapBetterAuthError(429, {}, null).retryAfterSeconds).toBeUndefined();
  });

  it('an unrecognised body is internal_error at the original status', () => {
    expect(mapBetterAuthError(500, '<html>').code).toBe('internal_error');
    expect(mapBetterAuthError(418, { code: 'SOMETHING_NEW' }).code).toBe('internal_error');
  });
});

describe('buildUpstreamUrl (F-008): the proxy upstream construction', () => {
  const API = 'http://api.internal:3001/api';

  it('builds an on-origin URL under /api from clean segments', () => {
    const url = buildUpstreamUrl(['auth', 'token'], new URLSearchParams(), API);

    expect(url?.href).toBe('http://api.internal:3001/api/auth/token');
  });

  it('rejects a traversal or empty or slash-bearing segment', () => {
    expect(buildUpstreamUrl(['..', 'health'], new URLSearchParams(), API)).toBeNull();
    expect(buildUpstreamUrl([''], new URLSearchParams(), API)).toBeNull();
    expect(buildUpstreamUrl(['a/b'], new URLSearchParams(), API)).toBeNull();
  });

  it('rejects a segment carrying a scheme-ish colon or a backslash', () => {
    expect(buildUpstreamUrl(['a:b'], new URLSearchParams(), API)).toBeNull();
    expect(buildUpstreamUrl(['a\\b'], new URLSearchParams(), API)).toBeNull();
  });

  it('rebuilds the query from parsed params', () => {
    const url = buildUpstreamUrl(['links'], new URLSearchParams({ page: '2', q: 'a b' }), API);

    expect(url?.searchParams.get('page')).toBe('2');
    expect(url?.searchParams.get('q')).toBe('a b');
  });
});

describe('serverApiClient (server components, one hop to the API)', () => {
  const A_JWT = 'header.eyJzdWIiOiJ1MSJ9.sig';

  function mockCookies(value: string | undefined): void {
    vi.doMock('next/headers', () => ({
      cookies: () =>
        Promise.resolve({
          get: (name: string) => (name === 'sk_at' && value !== undefined ? { value } : undefined),
        }),
    }));
  }

  afterEach(() => {
    vi.doUnmock('next/headers');
    vi.doUnmock('next/navigation');
    vi.resetModules();
    delete process.env.API_BASE_URL;
  });

  it('attaches Authorization: Bearer <sk_at> and calls the API base directly', async () => {
    process.env.API_BASE_URL = 'http://api.internal:3001/api';
    mockCookies(A_JWT);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(AN_ID), { status: 200 }));
    const { serverApiClient } = await import('./client');

    await serverApiClient({ method: 'GET', path: '/links/:id', params: { id: AN_ID }, contract: idContract });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`http://api.internal:3001/api/links/${AN_ID}`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${A_JWT}`);
    expect(init?.redirect).toBe('manual');
  });

  it('redirects on a 401 token_expired because it cannot set cookies during render (invariant 5)', async () => {
    process.env.API_BASE_URL = 'http://api.internal:3001/api';
    mockCookies(A_JWT);
    const redirect = vi.fn((url: string) => {
      throw new Error(`redirect:${url}`);
    });
    vi.doMock('next/navigation', () => ({ redirect }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'token_expired', message: 'expired' }), { status: 401 }),
    );
    const { serverApiClient, SERVER_COMPONENT_REFRESH_PATH } = await import('./client');

    await expect(serverApiClient({ method: 'GET', path: '/links', contract: pageOfIds })).rejects.toThrow('redirect:');
    expect(redirect).toHaveBeenCalledWith(SERVER_COMPONENT_REFRESH_PATH);
  });
});

// ===========================================================================
// TASK-1b-12 (invitations wave 2): the 429 normalisation `apiClient` deferred (W5-01, D-16)
// and the four invitation codes the signup hook can answer with (D-18).
// ===========================================================================
import { ERROR_CODE_STATUS } from '@shortkit/contracts';

describe('apiClient normalises a Nest 429 into ApiError.retryAfterSeconds (W5-01, D-16, web-api-client.md step 4)', () => {
  it('reads delta-seconds off the Retry-After header of a rate_limited envelope', async () => {
    networkAnswers(
      new Response(JSON.stringify(wellFormedEnvelope('rate_limited', 'Too many requests.')), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '17' },
      }),
    );

    const outcome = await attempt(() => apiClient(listIds()));

    expect(outcome).toBeInstanceOf(ApiError);
    expect((outcome as ApiError).code).toBe('rate_limited');
    expect((outcome as ApiError).status).toBe(429);
    expect((outcome as ApiError).retryAfterSeconds).toBe(17);
  });

  it('falls back to a numeric retryAfterSeconds body field when the header is absent (F-027)', async () => {
    networkAnswers(jsonResponse(429, { code: 'rate_limited', message: 'Too many requests.', retryAfterSeconds: 9 }));

    const outcome = await attempt(() => apiClient(listIds()));

    expect((outcome as ApiError).code).toBe('rate_limited');
    expect((outcome as ApiError).retryAfterSeconds).toBe(9);
  });

  it('prefers the header over the body field, and ignores an HTTP-date header', async () => {
    networkAnswers(
      new Response(JSON.stringify({ code: 'rate_limited', message: 'x', retryAfterSeconds: 9 }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '3' },
      }),
    );
    expect((await attempt(() => apiClient(listIds())) as ApiError).retryAfterSeconds).toBe(3);

    networkAnswers(
      new Response(JSON.stringify({ code: 'rate_limited', message: 'x', retryAfterSeconds: 9 }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      }),
    );
    expect((await attempt(() => apiClient(listIds())) as ApiError).retryAfterSeconds).toBe(9);
  });

  it('a 429 whose body is no envelope is still rate_limited, with the header value', async () => {
    networkAnswers(
      new Response('Too Many Requests', {
        status: 429,
        headers: { 'content-type': 'text/plain', 'retry-after': '5' },
      }),
    );

    const outcome = await attempt(() => apiClient(listIds()));

    expect((outcome as ApiError).code).toBe('rate_limited');
    expect((outcome as ApiError).status).toBe(429);
    expect((outcome as ApiError).retryAfterSeconds).toBe(5);
  });

  it('a non-429 error ignores a stray Retry-After header', async () => {
    networkAnswers(
      new Response(JSON.stringify(wellFormedEnvelope('not_found', 'No.')), {
        status: 404,
        headers: { 'content-type': 'application/json', 'retry-after': '5' },
      }),
    );

    expect((await attempt(() => apiClient(listIds())) as ApiError).retryAfterSeconds).toBeUndefined();
  });
});

describe('mapBetterAuthError maps the invitation codes the signup hooks answer with (D-18, auth-tokens.md)', () => {
  it.each([
    ['INVITATION_NOT_FOUND', 'not_found'],
    ['INVITATION_EXPIRED', 'invitation_expired'],
    ['INVITATION_REVOKED', 'invitation_revoked'],
    ['INVITATION_ALREADY_ACCEPTED', 'invitation_already_accepted'],
  ] as const)('%s -> %s at ERROR_CODE_STATUS, transport status preserved', (native, code) => {
    const status = ERROR_CODE_STATUS[code];
    const error = mapBetterAuthError(status, { code: native, message: 'fixed' });

    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });

  it('INVITATION_LOOKUP_FAILED is internal_error at 500 and surfaces no message', () => {
    const error = mapBetterAuthError(500, { code: 'INVITATION_LOOKUP_FAILED', message: 'lookup failed: <internal>' });

    expect(error.code).toBe('internal_error');
    expect(error.status).toBe(500);
    expect(error.message).not.toContain('<internal>');
  });

  it('never surfaces the native invitation message: the screen renders its own copy per code', () => {
    // The hook's messages are fixed strings (F-216), but the web copy is keyed by code
    // (InvitationStateMessage) so the two cannot drift, and nothing the hook says is echoed.
    const error = mapBetterAuthError(410, { code: 'INVITATION_EXPIRED', message: 'The invitation has expired.' });

    expect(error.message).not.toBe('The invitation has expired.');
  });
});
