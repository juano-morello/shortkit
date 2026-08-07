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
