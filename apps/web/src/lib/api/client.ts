/**
 * Contract: docs/contracts/web-api-client.md
 * ADR: adr-0014-web-session-handling.md, adr-0005, adr-0013, adr-0029, adr-0038
 * Produced by: TASK-008
 * Consumed by: TASK-012, 015, 019, 022, 026, 028, 041, 044, 047, 050, 052, 055, 057
 *
 * NO SCREEN CALLS fetch() DIRECTLY. Every request goes through one of these two.
 *
 * Amended 2026-08-10 (F-284, F-285, F-286, F-287, F-288, F-292; ADR-0029): route templates
 * replace the raw `path`, abort is its own error class, the request is sent with explicit
 * `credentials` and `redirect`, and the proxy sets its own Cache-Control.
 *
 * Amended 2026-08-11 (F-305, F-310, F-311, F-313, F-314; ADR-0029 amended, ADR-0038):
 * no error carries a `cause` but RequestAbortedError, a template may not repeat a
 * placeholder, `isMutatingMethod` is a denylist that uppercases, and
 * `invalidParamValueMessage` names the condition F-312 gave it.
 *
 * Amended 2026-08-17 (TASK-007, identity-membership wave 4): `serverApiClient`,
 * `mapBetterAuthError` and `buildUpstreamUrl` are MATERIALISED: the three F-291 deferrals
 * are done, their consumers (the BFF proxy route and the auth surface) now exist. The 422
 * code question (F-289) is decided in `mapBetterAuthError`'s docblock.
 *
 * Amended 2026-08-18 (TASK-1b-12, invitations wave 2; D-16, D-18): `apiClient` and
 * `serverApiClient` normalise a 429 into `ApiError.retryAfterSeconds` (W5-01 closed;
 * `interpretResponse` reads `Retry-After`, then the body field), and `BETTER_AUTH_CODE_MAP`
 * gains the five invitation codes the signup hooks answer with. The token-in-params example
 * above is retired: the token travels in a BODY (GC-K).
 */
import { isErrorEnvelope } from '@shortkit/contracts';
import type { z } from 'zod';
import type { ErrorCode } from '@shortkit/contracts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * ============================================================================
 * ADR-0029. A CREDENTIAL IS NEVER CONSTRUCTIBLE INTO AN ERROR STRING.
 * ============================================================================
 *
 * `path` is a ROUTE TEMPLATE and a string literal in the source. Caller-supplied values
 * go in `params` and reach the URL and the wire. They reach NO ERROR THIS MODULE RAISES:
 * not a message, not an own enumerable property, not `cause`, not the message of a
 * validation failure that rejects them.
 *
 * Corrected 2026-08-11 (F-310). This said "the URL, the wire, and NOTHING ELSE" and that
 * was measurably false: under Node's fetch the platform rejection handed to `{ cause }`
 * carries the RESOLVED URL in its own message, and util.inspect prints it, which is what
 * console.error(err) calls and what pino's err serialiser walks. The check that cleared
 * the old claim (the spread, Object.keys, JSON.stringify) cannot see `cause`, because
 * `cause` is non-enumerable. See "cause is a channel, and it is closed" in the contract.
 *
 *   apiClient({ method: 'PATCH', path: '/workspaces/:id',
 *               params: { id }, body, contract: workspaceContract })
 *
 * NEVER `path: `/workspaces/${id}``. And the invitation capability token
 * (<tenantId>.<43-char base64url secret>, a bearer credential whose own contract says it
 * is "never stored, never logged, and never returned by any read") is NOT a `params`
 * value either (item 1b, D-03/GC-K): the routes that take it are `POST /invitations/lookup`
 * and `POST /invitations/accept` with `{ token }` in the BODY, so it reaches no URL at all.
 * (An earlier revision of this docblock showed `GET /invitations/:token` with the token in
 * `params`; that route was never built and the example is retired.) Every default sink
 * downstream (unhandled rejection, Next error overlay, any telemetry SDK added later)
 * prints `message` and own properties with no code written to make it happen.
 */
export interface ApiRequest<TRes, TBody = unknown> {
  method: HttpMethod;
  /** Route template. Literal segments lowercase kebab; values are `:name` placeholders. */
  path: string;
  /**
   * Exactly one entry per placeholder in `path`. No extras, no omissions, and no template
   * that repeats a placeholder name: there is no key that could fill it twice, and
   * `/members/:id/workspace/:id` is the typo the real endpoint invites (F-306, F-313).
   */
  params?: Record<string, string | number>;
  /** The response IS validated against this. A mismatch throws ContractViolationError. */
  contract: z.ZodType<TRes>;
  body?: TBody;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

/**
 * A literal segment, or a `:name` placeholder. Nothing else.
 *
 * This is a backstop, not the guarantee: the RULE is what forbids interpolation. It does
 * reject the invitation token deterministically, on the `.` separator, which is not in
 * the literal-segment alphabet and cannot be. It also rejects `..`, `%2e%2e`, `?`, `#`,
 * `\`, `:` inside a literal, and the empty segment, which is the browser-leg mirror of
 * the segment rejection buildUpstreamUrl performs on the Fly leg (F-008, F-285).
 *
 * The bounds are there so a placeholder name cannot itself become a carrier.
 */
export const ROUTE_TEMPLATE_PATTERN =
  /^(?:\/(?:[a-z0-9][a-z0-9-]{0,63}|:[a-zA-Z][a-zA-Z0-9]{0,29}))+$/;

/**
 * Used ONLY to assert the built URL is still under BFF_PATH_PREFIX after WHATWG
 * normalisation. `.invalid` is reserved (RFC 2606) and never resolves; the request is
 * sent with the relative string, not with this.
 */
export const ROUTE_ASSERTION_BASE = 'https://route-assertion.invalid';

/**
 * Message builders. THEY INTERPOLATE `method` AND `path` AND NOTHING ELSE (ADR-0029):
 * `method` is a closed union of four literals, and `path` is a source literal that has
 * passed ROUTE_TEMPLATE_PATTERN by the time every builder but `invalidRouteMessage` runs.
 *
 * `invalidRouteMessage` names NO path: at that point the path is the value under
 * suspicion, and a rejection that echoes what it rejected is the leak wearing a different
 * hat. `invalidParamValueMessage` names no value, for the same reason and always.
 *
 * `invalidParamValueMessage`'s text widened 2026-08-11 (F-314). It read "is empty, '.' or
 * '..'" while F-312 had given step 3 a fourth condition, so a lone surrogate was rejected
 * with a sentence naming three conditions none of which had occurred. One message for
 * step 3, four conditions, no fifth constant: the value is unusable either way.
 *
 * Reached only through CLIENT_MESSAGES, which exists so a spec can assert the exact text
 * without copying the literals. No screen calls them.
 */
const contractViolationMessage = (m: HttpMethod, p: string): string =>
  `Response from ${m} ${p} did not match its contract.`;
const networkSendMessage = (m: HttpMethod, p: string): string =>
  `Request to ${m} ${p} could not be sent.`;
const networkReadMessage = (m: HttpMethod, p: string): string =>
  `Response from ${m} ${p} could not be read.`;
const requestAbortedMessage = (m: HttpMethod, p: string): string =>
  `Request to ${m} ${p} was aborted by the caller.`;
const invalidRouteMessage = (m: HttpMethod): string =>
  `apiClient: the ${m} path is not a route template.`;
const unresolvedParamsMessage = (m: HttpMethod, p: string): string =>
  `apiClient: params do not match ${m} ${p}.`;
const invalidParamValueMessage = (m: HttpMethod, p: string): string =>
  `apiClient: a param value for ${m} ${p} is empty, '.', '..' or cannot be percent-encoded.`;

/** For specs. The client builds its own messages; no screen calls these. */
export const CLIENT_MESSAGES = {
  contractViolation: contractViolationMessage,
  networkSend: networkSendMessage,
  networkRead: networkReadMessage,
  requestAborted: requestAbortedMessage,
  invalidRoute: invalidRouteMessage,
  unresolvedParams: unresolvedParamsMessage,
  invalidParamValue: invalidParamValueMessage,
} as const;

export class ApiError extends Error {
  readonly code: ErrorCode;
  /**
   * The TRANSPORT status, verbatim. INDEPENDENT of `code`: step 5 pairs `internal_error`
   * with the original status, and Better Auth's 422 has no row in ERROR_CODE_STATUS at
   * all. Never assume ERROR_CODE_STATUS[code] === status (F-289).
   */
  readonly status: number;
  readonly details?: unknown;
  /**
   * Present when code === 'rate_limited'. From the Retry-After header, falling back to
   * a `retryAfterSeconds` field in the body (F-027): /api/auth/* is mounted outside
   * Nest, so the email rate limiter's 429 carries the value in the body. Normalising
   * both here is what lets TASK-052's central rendering work on the login screen.
   */
  readonly retryAfterSeconds?: number;

  constructor(_init: {
    code: ErrorCode;
    status: number;
    message: string;
    details?: unknown;
    retryAfterSeconds?: number;
  }) {
    super(_init.message);
    this.name = 'ApiError';
    this.code = _init.code;
    this.status = _init.status;
    this.details = _init.details;
    this.retryAfterSeconds = _init.retryAfterSeconds;
  }
}

/**
 * AC-15: raised instead of returning malformed data.
 *
 * IT TAKES NO ErrorOptions, so it cannot be given a `cause` (F-310). That is deliberate
 * and it is the only mechanical enforcement available: no gate compares this file to the
 * design stub, and no test that asserts a clean `message` can see a `cause`, because
 * `cause` is non-enumerable. Adding the parameter back is the defect, not the fix.
 */
export class ContractViolationError extends Error {
  /** The ROUTE TEMPLATE. Never a resolved path, never a param value (ADR-0029). */
  readonly path: string;
  readonly issues: z.ZodIssue[];

  constructor(method: HttpMethod, path: string, issues: z.ZodIssue[]) {
    super(contractViolationMessage(method, path));
    this.name = 'ContractViolationError';
    this.path = path;
    this.issues = issues;
  }
}

/**
 * A transport failure, on the send leg or the body-read leg.
 *
 * IT TAKES NO ErrorOptions (F-310). Under Node's fetch the rejection this class used to
 * be handed carries the RESOLVED URL in its own message, so chaining it put the
 * credential back into anything that calls util.inspect: console.error(err), pino's err
 * serialiser. The platform detail is gone with it, deliberately: a browser reports DNS,
 * TLS, CORS and offline all as TypeError('Failed to fetch') anyway, and the leg where the
 * detail was worth having is the leg that leaked.
 */
export class NetworkError extends Error {
  /** The ROUTE TEMPLATE. */
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = 'NetworkError';
    this.path = path;
  }
}

/**
 * F-292. A cancellation the CALLER initiated through `req.signal`.
 *
 * It does NOT extend NetworkError. A screen that aborts on each keystroke must not render
 * a network-failure state for its own cancellation, and a retry wrapper keyed on
 * NetworkError must not re-issue a request the caller deliberately cancelled.
 *
 * THE ONLY CLASS IN THIS MODULE THAT CARRIES A `cause`, and its `cause` is
 * `signal.reason`, read off `req.signal`, NEVER taken from the caught rejection.
 * Amended 2026-08-11 (F-310): it used to be "the platform rejection or signal.reason",
 * and the platform-rejection half is the leak. An abort racing a genuine transport
 * failure hands the catch a platform rejection, and under Node that one carries the
 * resolved URL; reading the signal makes `cause` caller-owned in every case, which is the
 * same tie-breaking rule as the discriminator itself.
 *
 * `signal.reason` is CALLER-SUPPLIED and sits outside ADR-0029's guarantee for `message`
 * and `path`. A CALLER MUST NOT PASS A CREDENTIAL TO abort(reason); a telemetry sink that
 * serialises this `cause` serialises a value the caller chose.
 */
export class RequestAbortedError extends Error {
  /** The ROUTE TEMPLATE. */
  readonly path: string;

  /** `options.cause` is `req.signal.reason` and nothing else (F-310). */
  constructor(method: HttpMethod, path: string, options?: ErrorOptions) {
    super(requestAbortedMessage(method, path), options);
    this.name = 'RequestAbortedError';
    this.path = path;
  }
}

/**
 * The same-origin prefix every browser request is sent under. `apiClient` names no origin
 * and reads no base URL: the browser calls THIS app, which forwards to Fly.
 *
 * `NEXT_PUBLIC_API_BASE_URL` is deliberately not read here. web-api-client.md: "it is not
 * used for anything authenticated. Authenticated traffic uses the same-origin `/api/bff`
 * path or the server-only `API_BASE_URL`." Reading it would also be the F-174 trap the
 * TASK card warns about, one step earlier.
 */
export const BFF_PATH_PREFIX = '/api/bff';

/**
 * The message an `ApiError` carries when the API answered with something that is not an
 * `ErrorEnvelope` (response handling step 5), so there is no server-supplied message to
 * show. Same text as the API's own `INTERNAL_ERROR_MESSAGE`, which lives in
 * `apps/api/src/common/errors/domain-error.ts` and is not importable from here.
 */
const UNEXPECTED_RESPONSE_MESSAGE = 'The request could not be completed.';

/** The `:name` segments of a route template, without the ':'. */
function placeholdersOf(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
}

/** Query values that are `undefined` are omitted, not sent as the string "undefined". */
function appendQuery(url: string, query: ApiRequest<unknown>['query']): string {
  if (query === undefined) {
    return url;
  }

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }

  const serialised = search.toString();

  return serialised === '' ? url : `${url}?${serialised}`;
}

/**
 * Request path construction, ORDERED AND NORMATIVE (web-api-client.md). Throws a plain
 * Error on every rejection: these are programming defects, no request was made, and none
 * of the four ApiRequest failure classes applies.
 *
 *   1. ROUTE_TEMPLATE_PATTERN.test(path) === false -> invalidRouteMessage(method)
 *   2. placeholder set !== Object.keys(params ?? {}) -> unresolvedParamsMessage.
 *      A template that REPEATS a placeholder is rejected outright, whatever params
 *      carries (F-306, F-313). Compared as sets ALONE, `/a/:x/:x` with `{ x }` would pass
 *      and one supplied value would be expanded into two segments; counting instead of
 *      comparing sets was the opposite hole, where `/members/:id/workspace/:id` with
 *      `{ id, workspaceId }` matched on length and sent a DELETE to workspace `id` with
 *      `workspaceId` silently dropped. Both holes are closed and neither reopens without
 *      the other: keep all three clauses.
 *   3. encodeURIComponent(String(value)) is '' or '.' or '..' -> invalidParamValueMessage
 *      ('..' survives encodeURIComponent because dot is unreserved; the browser then
 *      normalises it away and escapes the prefix. THIS is the check that stops F-285.)
 *      A value encodeURIComponent cannot encode at all (a lone surrogate, which throws
 *      URIError) rejects with the same message rather than leaving by a fifth exit
 *      (F-312). The URIError is NOT chained onto it: the value that threw is
 *      caller-supplied and ADR-0029 keeps those off the error.
 *   4. substitute the ENCODED values into the template
 *   5. BFF_PATH_PREFIX + resolved, then the query from URLSearchParams
 *   6. assert new URL(url, ROUTE_ASSERTION_BASE).pathname starts with BFF_PATH_PREFIX + '/'
 *      <- unreachable given 1 and 3, and NOT redundant with them: it is what makes any
 *         future change to them safe. Same role as step 3 of buildUpstreamUrl.
 */
export function buildRequestUrl<TRes>(req: ApiRequest<TRes>): string {
  const { method, path } = req;

  // 1.
  if (!ROUTE_TEMPLATE_PATTERN.test(path)) {
    throw new Error(invalidRouteMessage(method));
  }

  // 2.
  const params = req.params ?? {};
  const placeholders = placeholdersOf(path);
  const distinct = new Set(placeholders);
  const supplied = Object.keys(params);

  if (
    distinct.size !== placeholders.length ||
    distinct.size !== supplied.length ||
    !supplied.every((name) => distinct.has(name))
  ) {
    throw new Error(unresolvedParamsMessage(method, path));
  }

  // 3.
  const encoded: Record<string, string> = {};

  for (const name of placeholders) {
    let value: string;

    try {
      value = encodeURIComponent(String(params[name]));
    } catch {
      // F-312. `encodeURIComponent` throws URIError on a lone surrogate, which would leave
      // step 3 by a fifth exit the contract does not enumerate. It is an unusable param
      // value, so it rejects like the other unusable ones. The cause is dropped rather than
      // chained: it is a value the CALLER supplied and ADR-0029 keeps those off the error.
      throw new Error(invalidParamValueMessage(method, path));
    }

    if (value === '' || value === '.' || value === '..') {
      throw new Error(invalidParamValueMessage(method, path));
    }

    encoded[name] = value;
  }

  // 4.
  const resolved = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? encoded[segment.slice(1)] : segment))
    .join('/');

  // 5.
  const url = appendQuery(`${BFF_PATH_PREFIX}${resolved}`, req.query);

  // 6.
  if (!new URL(url, ROUTE_ASSERTION_BASE).pathname.startsWith(`${BFF_PATH_PREFIX}/`)) {
    throw new Error(invalidRouteMessage(method));
  }

  return url;
}

/**
 * F-286. `credentials` and `redirect` are set EXPLICITLY on every request rather than left
 * to whatever the runtime defaults to.
 *
 * `credentials: 'same-origin'` states the rule the whole design rests on: the session
 * cookies are httpOnly on the Vercel origin and go nowhere else. `include` would attach
 * them to a cross-origin request, and leaving the field unset makes that a property of the
 * runtime rather than of this file.
 *
 * `redirect: 'error'` because the default is `follow`, and following a 3xx from the
 * victim's browser is the same hazard UPSTREAM_FETCH_REDIRECT = 'manual' refuses one hop
 * later. Every response this client expects is terminal; a redirect from /api/bff is a
 * defect, so it fails rather than being chased.
 */
function requestInit<TRes>(req: ApiRequest<TRes>): RequestInit {
  const base: RequestInit = {
    method: req.method,
    signal: req.signal,
    credentials: 'same-origin',
    redirect: 'error',
  };

  if (req.body === undefined) {
    return base;
  }

  return {
    ...base,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req.body),
  };
}

/**
 * Response handling steps 2 and 5. A body the shared envelope contract accepts becomes an
 * `ApiError` carrying the API's own `code`, `status` and `details`; anything else (Better
 * Auth's native shape, an HTML page from an interposed proxy, an empty body) becomes an
 * `ApiError` with `internal_error` and the original status.
 *
 * Neither is a `ContractViolationError`. AC-15 reserves that for a response the caller was
 * told to expect data in; an error the API deliberately returned is not malformed data.
 */
function toApiError(status: number, raw: string, retryAfterHeader: string | null): ApiError {
  const body = tryParseJson(raw);

  // Step 4 (TASK-1b-12; W5-01 closed, D-16). A 429 carries `retryAfterSeconds`: the
  // `Retry-After` header first (the Nest guard, the Express limiters, and the BFF's
  // re-emission for `/api/auth/*`), the numeric `retryAfterSeconds` body field second (the
  // Better Auth email bucket, F-027). Same rule and same helpers as `mapBetterAuthError`, so
  // the two legs cannot disagree. A 429 with NO envelope is still `rate_limited`, not step
  // 5's `internal_error`: the status alone is unambiguous (`ERROR_CODE_STATUS` pairs no
  // other code with 429), and a screen branching on the code needs it.
  const retryAfterSeconds =
    status === 429 ? (retryAfterFromHeader(retryAfterHeader) ?? retryAfterFromBody(body)) : undefined;

  if (isErrorEnvelope(body)) {
    return new ApiError({
      code: body.code,
      status,
      message: body.message,
      details: body.details,
      retryAfterSeconds,
    });
  }

  return new ApiError({
    code: status === 429 ? 'rate_limited' : 'internal_error',
    status,
    message: UNEXPECTED_RESPONSE_MESSAGE,
    retryAfterSeconds,
  });
}

/** `undefined` for a body that is not JSON. Only ever fed to a schema that rejects it. */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Browser-side. Targets the SAME-ORIGIN BFF proxy at /api/bff/<path>, which attaches
 * the Bearer JWT from the httpOnly `sk_at` cookie.
 * The browser never talks to Fly and never holds a token (TASK-012's constraint).
 *
 * Token refresh happens inside the proxy and is invisible here: a screen never sees
 * `token_expired`.
 * 429 handling and Retry-After are applied here, centrally (`toApiError`, step 4; done by
 * TASK-1b-12 after TASK-052 left the initiative). Form state survives: this throws, it
 * never resets, navigates or clears an input.
 *
 * Response handling follows web-api-client.md in its stated order. AC-15 turns on the
 * four-way split it produces, and every one of them is distinguishable by class:
 *   2xx failing contract.safeParse   -> ContractViolationError
 *   an error the API returned        -> ApiError
 *   a transport failure              -> NetworkError
 *   req.signal aborted               -> RequestAbortedError   (F-292; NOT a NetworkError)
 *
 * The abort discriminator is `req.signal?.aborted`, NOT `cause.name === 'AbortError'`:
 * abort(reason) makes fetch reject with signal.reason, which has no guaranteed `name`.
 *
 * BOTH catch blocks discard the caught rejection (F-310). The abort branch reads
 * `req.signal.reason`; the transport branch passes nothing:
 *
 *   } catch {
 *     if (req.signal?.aborted === true) {
 *       throw new RequestAbortedError(req.method, req.path, { cause: req.signal.reason });
 *     }
 *     throw new NetworkError(networkSendMessage(req.method, req.path), req.path);
 *   }
 *
 * `req.signal?.aborted === true` already narrows `req.signal` to defined, so no non-null
 * assertion is needed and none belongs here. The binding is dropped from `catch` because
 * nothing reads it; `catch (cause)` would fail lint as an unused variable.
 *
 * 429/`Retry-After` normalisation (step 4) IS implemented, in `toApiError`, since
 * TASK-1b-12 (W5-01, D-16): a 429 arrives as an `ApiError` with `code: 'rate_limited'` and
 * `retryAfterSeconds` from the header, or from the body field when the header is absent.
 */
export async function apiClient<TRes>(req: ApiRequest<TRes>): Promise<TRes> {
  const url = buildRequestUrl(req);

  let response: Response;

  try {
    response = await fetch(url, requestInit(req));
  } catch {
    // Step 7 before step 6: a cancellation the caller asked for is not a failure, and the
    // tie goes to the signal. `cause` is read off the SIGNAL, never off the rejection
    // (F-310): on this exact race the rejection is the platform's URL-bearing one.
    if (req.signal?.aborted === true) {
      throw new RequestAbortedError(req.method, req.path, { cause: req.signal.reason });
    }

    // Step 6. `fetch` rejects only on a transport failure; an HTTP error status resolves.
    throw new NetworkError(networkSendMessage(req.method, req.path), req.path);
  }

  let raw: string;

  try {
    raw = await response.text();
  } catch {
    if (req.signal?.aborted === true) {
      throw new RequestAbortedError(req.method, req.path, { cause: req.signal.reason });
    }

    // The response headers arrived and the body did not. Still transport, still step 6.
    throw new NetworkError(networkReadMessage(req.method, req.path), req.path);
  }

  return interpretResponse(req, response.status, response.ok, raw, response.headers.get('retry-after'));
}

/**
 * Response-handling steps 1, 2 and 5, ordered and normative (web-api-client.md), shared by
 * `apiClient` (browser leg) and `serverApiClient` (server leg) so the four-way AC-15 split
 * is one implementation. The transport/abort steps (6, 7) stay at each caller, because they
 * key on that caller's own `fetch` rejection.
 */
function interpretResponse<TRes>(
  req: ApiRequest<TRes>,
  status: number,
  ok: boolean,
  raw: string,
  retryAfterHeader: string | null,
): TRes {
  if (!ok) {
    throw toApiError(status, raw, retryAfterHeader);
  }

  let body: unknown;

  try {
    body = JSON.parse(raw);
  } catch {
    // Ruled 2026-08-06 (TASK-008.md): a 2xx carrying something unparseable as JSON is a
    // CONTRACT VIOLATION, not a transport error. AC-15 makes no exception for a body that
    // fails earlier than `safeParse`, and a caller retrying on `NetworkError` would
    // otherwise retry an HTML error page that can never become data. `issues` is empty
    // because validation never ran; there is nothing zod reported to carry.
    throw new ContractViolationError(req.method, req.path, []);
  }

  const result = req.contract.safeParse(body);

  if (!result.success) {
    throw new ContractViolationError(req.method, req.path, result.error.issues);
  }

  // Step 1's guarantee, and invariant 1: what this resolves with validated against
  // `contract`. The parse OUTPUT is returned, never the input.
  return result.data;
}

/**
 * MATERIALISED by TASK-007 (was DEFERRED under the F-291 ruling until wave 4).
 *
 * Server components. Reads `sk_at` via next/headers `cookies()` and calls the API DIRECTLY
 * at `API_BASE_URL` with `Authorization: Bearer <sk_at>`: one hop, not two, because a
 * server component is already inside the Vercel function and does not need the proxy
 * (web-api-client.md topology). The response is handled by the SAME ordered steps as
 * `apiClient` (`interpretResponse`), so AC-15's four-way split holds identically.
 *
 * IT CANNOT SET COOKIES DURING RENDER (invariant 5): `cookies().set()` throws outside an
 * action/route-handler phase. So on a 401 `token_expired` it does NOT refresh in place; it
 * throws a `redirect` to a route handler that refreshes `sk_at` from `sk_rt` and bounces
 * back: `app/api/bff/session/refresh/route.ts` (TASK-007), reached through
 * `SERVER_COMPONENT_REFRESH_PATH`. No `returnTo` is passed: a server component has no
 * reliable view of the URL being rendered (no middleware sets one, and `Referer` names the
 * PREVIOUS page), so the bounce lands on that route's default, `/`. A protected page that
 * wants to return to itself can catch the redirect and re-issue it with `?returnTo=`.
 *
 * `next/headers` and `next/navigation` are imported DYNAMICALLY so this server path never
 * enters a client bundle that only wanted `apiClient`.
 *
 * It sends NO `Origin`, so it must never be used for a POST to `/api/auth/*` (a server-side
 * mutation at the auth surface 403s, F-233); sign-in/up/out go through the proxy route.
 */
export async function serverApiClient<TRes>(req: ApiRequest<TRes>): Promise<TRes> {
  // Reuse the browser-leg construction and its normative rejections, then swap the
  // same-origin BFF prefix for the server-only API base. `buildRequestUrl` throws the same
  // plain Errors on an invalid template/params, before any request is made.
  const apiPath = buildRequestUrl(req).slice(BFF_PATH_PREFIX.length);
  const base = serverApiBaseUrl();

  const { cookies } = await import('next/headers');
  const store = await cookies();
  const accessToken = store.get('sk_at')?.value;

  const headers: Record<string, string> = {};

  if (accessToken !== undefined && accessToken !== '') {
    headers.authorization = `Bearer ${accessToken}`;
  }

  if (req.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  let response: Response;

  try {
    response = await fetch(`${base}${apiPath}`, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: req.signal,
      redirect: 'manual',
    });
  } catch {
    if (req.signal?.aborted === true) {
      throw new RequestAbortedError(req.method, req.path, { cause: req.signal.reason });
    }

    throw new NetworkError(networkSendMessage(req.method, req.path), req.path);
  }

  let raw: string;

  try {
    raw = await response.text();
  } catch {
    if (req.signal?.aborted === true) {
      throw new RequestAbortedError(req.method, req.path, { cause: req.signal.reason });
    }

    throw new NetworkError(networkReadMessage(req.method, req.path), req.path);
  }

  // Invariant 5: a token_expired cannot be refreshed in render. Bounce to the route handler.
  if (response.status === 401 && isTokenExpired(raw)) {
    const { redirect } = await import('next/navigation');
    redirect(SERVER_COMPONENT_REFRESH_PATH);
  }

  return interpretResponse(req, response.status, response.ok, raw, response.headers.get('retry-after'));
}

/**
 * The refresh-and-bounce route handler `serverApiClient` redirects to on `token_expired`:
 * `app/api/bff/session/refresh/route.ts` (TASK-007). It accepts an optional same-origin
 * relative `?returnTo=`; absent, it bounces to `/`. Invariant 5.
 */
export const SERVER_COMPONENT_REFRESH_PATH = '/api/bff/session/refresh';

/** `true` when a 401 body is a `token_expired` envelope (the code the BFF/serverClient branches on). */
function isTokenExpired(raw: string): boolean {
  const body = tryParseJson(raw);

  return isErrorEnvelope(body) && body.code === 'token_expired';
}

function serverApiBaseUrl(): string {
  const value = process.env.API_BASE_URL;

  if (value === undefined || value.trim() === '') {
    throw new Error('API_BASE_URL is not set. serverApiClient reaches the API through it (ADR-0014).');
  }

  return value;
}

/**
 * MATERIALISED by TASK-007 (was DEFERRED under the F-291 ruling until wave 4). Its consumer
 * is the BFF proxy route, this same TASK: the route maps Better Auth's native error bodies
 * through this so the browser sees an `ErrorEnvelope`-shaped `ApiError` with a real `code`,
 * not the generic `internal_error` step 5 would otherwise produce for a wrong password.
 *
 * Better Auth's `/api/auth/*` mount sits outside Nest (ADR-0013), so no Nest filter shapes
 * its errors: every body is `{ message, code }` and NOT `ErrorEnvelope`. The eight probed
 * shapes are in auth-tokens.md ("Error bodies, verbatim from 1.6.26"), and a 429 from the
 * email rate limiter carries the seconds in a `retryAfterSeconds` BODY field with no
 * `code: "rate_limited"` (F-027): an unmapped 429 renders as the generic error and the
 * sign-in screen shows the wrong thing.
 *
 * ----------------------------------------------------------------------------
 * THE 422 CODE, DECIDED HERE (F-289; error-envelope.md "Open: the code Better Auth's 422
 * carries"). USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL maps to the EXISTING code
 * `validation_failed`, with the transport status preserved as 422.
 * ----------------------------------------------------------------------------
 *
 * Why an existing code and not a new one: `ERROR_CODES` is append-only and a code's status
 * is then permanent (errors.ts), no `/api` route would emit a new code (the registry has
 * never held a web-only code), and a code that means "this email already has an account" is
 * an account-enumeration disclosure that must justify itself, which, since ADR-0061 made a
 * duplicate signup answer 200 exactly like a fresh one, has NO caller on the primary path
 * to justify. The 422 is now a legacy/sign-in-adjacent shape only. `validation_failed`
 * reads slightly wrong (the request was well-formed; the conflict is with stored state),
 * and that is the accepted cost of adding nothing permanent to the registry.
 * `ApiError.status` is independent of `code` (F-289), so `{ code: 'validation_failed',
 * status: 422 }` is expressible with no registry change.
 *
 * The origin errors (MISSING_OR_NULL_ORIGIN, INVALID_ORIGIN) map to `internal_error`: they
 * mean the proxy or its `WEB_APP_ORIGINS` config is wrong, never that the operator did
 * something, so they are not surfaced as a user-actionable message.
 */
export function mapBetterAuthError(status: number, body: unknown, retryAfterHeader?: string | null): ApiError {
  const native = betterAuthBody(body);

  // 429: `Retry-After` header first, `retryAfterSeconds` body field as the fallback (F-027,
  // rate-limit.md). The Express limiters set the header; the Better Auth email hook does not.
  if (status === 429) {
    return new ApiError({
      code: 'rate_limited',
      status,
      message: native.message ?? UNEXPECTED_RESPONSE_MESSAGE,
      retryAfterSeconds: retryAfterFromHeader(retryAfterHeader) ?? retryAfterFromBody(body),
    });
  }

  const mapped = native.code === undefined ? undefined : BETTER_AUTH_CODE_MAP[native.code];

  if (mapped === undefined) {
    // An unrecognised shape (an HTML page from an interposed proxy, an empty body, a code
    // this table does not name) is internal_error at the original status (step 5).
    return new ApiError({ code: 'internal_error', status, message: UNEXPECTED_RESPONSE_MESSAGE });
  }

  // A message is surfaced only for the codes a user can act on; the others carry the
  // generic message so an operator/config fault is not rendered as their mistake.
  const message =
    BETTER_AUTH_MESSAGE_SURFACED.has(native.code as string) && native.message !== undefined
      ? native.message
      : UNEXPECTED_RESPONSE_MESSAGE;

  return new ApiError({ code: mapped, status, message });
}

/** The eight probed Better Auth codes (auth-tokens.md) mapped onto our registry. */
const BETTER_AUTH_CODE_MAP: Record<string, ErrorCode> = {
  VALIDATION_ERROR: 'validation_failed',
  PASSWORD_TOO_SHORT: 'validation_failed',
  PASSWORD_TOO_LONG: 'validation_failed',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'validation_failed',
  INVALID_EMAIL_OR_PASSWORD: 'unauthenticated',
  MISSING_OR_NULL_ORIGIN: 'internal_error',
  INVALID_ORIGIN: 'internal_error',
  // The token-mint refusal for an account with no tenant membership (auth.config.ts,
  // ADR-0055). A 403 the user cannot fix by retrying; not surfaced as their message.
  NO_TENANT_MEMBERSHIP: 'internal_error',
  // Item 1b (TASK-1b-12; D-18, auth-tokens.md). The signup `hooks.before` invitation
  // validation answers these when a signup carries an `invitationToken`; the statuses the
  // hook sends are `ERROR_CODE_STATUS[mapped]` (404, 410, 410, 409) and are preserved as
  // the transport status here. Their messages are fixed strings (F-216) but are NOT
  // surfaced: the accept page renders its own copy per code (`InvitationStateMessage`),
  // so the wire text and the screen text cannot drift, and the same code from a Nest
  // route (`POST /api/invitations/lookup`) renders the same sentence.
  INVITATION_NOT_FOUND: 'not_found',
  INVITATION_EXPIRED: 'invitation_expired',
  INVITATION_REVOKED: 'invitation_revoked',
  INVITATION_ALREADY_ACCEPTED: 'invitation_already_accepted',
  // The hook could not complete the lookup (a database fault). Nothing the user can act on.
  INVITATION_LOOKUP_FAILED: 'internal_error',
};

/** Native codes whose message is safe and useful to show a signed-out visitor. */
const BETTER_AUTH_MESSAGE_SURFACED = new Set<string>([
  'VALIDATION_ERROR',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  'INVALID_EMAIL_OR_PASSWORD',
]);

/** Reads `{ message?, code? }` off an unknown Better Auth body without trusting its shape. */
function betterAuthBody(body: unknown): { message?: string; code?: string } {
  if (typeof body !== 'object' || body === null) {
    return {};
  }

  const candidate = body as { message?: unknown; code?: unknown };

  return {
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
    code: typeof candidate.code === 'string' ? candidate.code : undefined,
  };
}

/** The `retryAfterSeconds` body field, when it is a finite non-negative number (F-027). */
function retryAfterFromBody(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const value = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds;

  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The `Retry-After` HEADER as delta-seconds, when present and a non-negative integer.
 * The HTTP-date form is not parsed: neither limiter in this design emits it, and a date
 * would need a clock this module deliberately does not read.
 */
function retryAfterFromHeader(header: string | null | undefined): number | undefined {
  if (header === undefined || header === null) {
    return undefined;
  }

  const trimmed = header.trim();

  if (!/^\d{1,10}$/.test(trimmed)) {
    return undefined;
  }

  return Number(trimmed);
}

/**
 * ============================================================================
 * BFF proxy upstream URL. F-008. Used by app/api/bff/[...path]/route.ts.
 * ============================================================================
 *
 * MATERIALISED by TASK-007 (was DEFERRED under the F-291 ruling until wave 4). The proxy
 * route `app/api/bff/[...path]/route.ts` calls it.
 *
 * NEVER `${API_BASE_URL}/api/${path}` and NEVER `new URL(path, API_BASE_URL)`.
 *
 * Next.js DECODES route params, so `%2e%2e%2f` arrives as `../` and escapes the /api
 * prefix. And a path beginning `//evil.example/` resolves PROTOCOL-RELATIVE under
 * new URL(), which would attach `Authorization: Bearer <sk_at>` (a live tenant
 * credential) to an attacker-chosen origin, from a same-origin request the victim's
 * browser makes.
 *
 *   1. reject any decoded segment that is '', '.', '..', or contains / \ :
 *   2. encodeURIComponent each segment and join
 *   3. assert upstream.origin === new URL(API_BASE_URL).origin   <- load-bearing
 *   4. rebuild the query from parsed searchParams, never concatenate
 *
 * Returns null when the path is rejected; the route handler then answers 400.
 */
export function buildUpstreamUrl(
  segments: string[],
  searchParams: URLSearchParams,
  apiBaseUrl: string,
): URL | null {
  let base: URL;

  try {
    base = new URL(apiBaseUrl);
  } catch {
    return null;
  }

  // 1. Reject any unsafe segment AFTER Next.js has decoded it: the form traversal arrives in.
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return null;
    }

    if (/[/\\:]/.test(segment)) {
      return null;
    }
  }

  // 2. Re-encode and join. Never interpolate the raw catch-all. The absolute `/api/...`
  //    path replaces `base`'s path, so `API_BASE_URL`'s own `/api` suffix is not doubled.
  const upstream = new URL(`/api/${segments.map(encodeURIComponent).join('/')}`, base);

  // 3. The load-bearing assertion: a protocol-relative or otherwise off-origin path cannot
  //    carry the Bearer credential somewhere else (invariant 6).
  if (upstream.origin !== base.origin) {
    return null;
  }

  // 4. Rebuild the query from the parsed params, never concatenated.
  upstream.search = '';

  for (const [key, value] of searchParams) {
    upstream.searchParams.append(key, value);
  }

  return upstream;
}

/** `redirect: 'manual'`. An upstream 3xx is returned to the caller, never followed. */
export const UPSTREAM_FETCH_REDIRECT = 'manual' as const;

/**
 * Allowlists, not denylists. `cookie` upstream and `set-cookie` downstream are absent.
 * Inbound `x-shortkit-*` headers are NEVER forwarded: the proxy sets both of its own
 * afresh on every request (below).
 *
 * THIS IS NOT THE WHOLE REQUEST-HEADER SET. Read it together with
 * FORWARDED_REQUEST_HEADERS_MUTATING_ONLY below. Building `upstreamHeaders` from this
 * constant alone answers 403 MISSING_OR_NULL_ORIGIN to every signup, sign-in and
 * sign-out in production, while every test that speaks to the API directly passes
 * (F-233, F-288).
 */
export const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'x-request-id'] as const;

/**
 * F-287. `cache-control` is ABSENT on purpose: the proxy does not forward upstream's
 * value, it sets PROXY_RESPONSE_CACHE_CONTROL on every response instead.
 */
export const RETURNED_RESPONSE_HEADERS = ['content-type', 'retry-after', 'x-request-id'] as const;

/**
 * F-287. Written on EVERY response the proxy returns, whatever the upstream said.
 *
 * Without it an API response carrying `no-store` for tenant data reached the browser with
 * no cache directive at all and the decision fell to browser heuristics on a 200 GET:
 * another tenant's links, members or domains readable out of the HTTP cache by anyone
 * with later access to the browser profile. Allowlisting upstream's header instead would
 * make that depend on every present and future /api route setting one header, enforced by
 * nothing; setting it here fails closed.
 *
 * Cost accepted: nothing through /api/bff/* can ever be cached by the browser. Changing
 * that means amending web-api-client.md, not special-casing a call site.
 */
export const PROXY_RESPONSE_CACHE_CONTROL = 'no-store' as const;

/**
 * ============================================================================
 * F-233. `Origin` on mutating requests, and why dropping it breaks all of auth.
 * ============================================================================
 *
 * better-auth@1.6.26 answers 403 {"code":"MISSING_OR_NULL_ORIGIN"} to a state-changing
 * request to /api/auth/* carrying no Origin, and a server-side fetch sends none. Without
 * this header every signup, sign-in and sign-out through the proxy returns 403 in
 * production while every test that speaks to the API directly passes.
 *
 * Forward the INBOUND value VERBATIM. Never synthesise it, never default it. The CSRF
 * check has already required it to equal the deployment origin, so the value that reaches
 * the API is that origin or the request never left Vercel.
 *
 * Mutating methods ONLY. The CSRF check does not run on GET, so a GET would forward an
 * unvalidated attacker-chosen value; and Better Auth skips the origin check on GET
 * anyway (dist/api/middlewares/origin-check.mjs:43), so GET /api/auth/token and
 * /get-session need none. WHICH methods those are is isMutatingMethod's answer and
 * nothing else's (ADR-0038):
 *
 *   if (isMutatingMethod(request.method)) {
 *     upstreamHeaders.set('origin', request.headers.get('origin')!);
 *   }
 *
 * F-288: these exports are NOT optional and are not deferred with the proxy route
 * above. web-api-client.md names this file as its normative form, so the proxy implementer
 * reads THIS, not the contract. A file that offers one allowlist under a docblock
 * enumerating what is deliberately absent tells that reader the set is complete.
 *
 * API side: trustedOrigins from WEB_APP_ORIGINS. See auth-tokens.md.
 */
export const FORWARDED_REQUEST_HEADERS_MUTATING_ONLY = ['origin'] as const;

/**
 * The only two methods the proxy neither CSRF-checks nor forwards `Origin` on. Added
 * 2026-08-11 (ADR-0038). This is the definition; everything else is mutating.
 */
export const NON_MUTATING_METHODS = ['GET', 'HEAD'] as const;

/**
 * The mutating methods THIS DESIGN USES. Ruled 2026-08-11 (ADR-0038, F-305):
 * DESCRIPTIVE, NOT THE DEFINITION. isMutatingMethod does not read it. Adding a method
 * here changes no behaviour and leaving one out changes no behaviour, which is the whole
 * point: the four-item allowlist used to BE the predicate, and a method missing from it
 * lost its Origin and got F-233's 403 in production with every test green.
 *
 * PUT is listed and `ApiRequest.method` does not offer it: no PUT /api/* endpoint exists
 * today, and the proxy is a public HTTP surface that can be sent one regardless.
 */
export const MUTATING_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;

/**
 * True when the proxy must require `Origin` to equal the deployment origin (403
 * otherwise) and then forward it upstream. Ruled 2026-08-11 (ADR-0038; F-305, F-311).
 *
 * A DENYLIST THAT FAILS CLOSED. Anything that is not GET or HEAD is mutating, including
 * OPTIONS, including a method this design does not use, including a garbage token. The
 * two failure directions are not symmetric: a method wrongly called non-mutating loses
 * its Origin and 403s in production with every test green (F-233), while a method wrongly
 * called mutating gets the CSRF check, which has already pinned the header to the
 * deployment origin. Silent-and-expensive versus loud-and-harmless.
 *
 * IT UPPERCASES ITS OWN INPUT, and that is not defensive padding:
 * `new Request(u, { method: 'post' }).method` normalises to 'POST', but
 * `new Request(u, { method: 'patch' }).method` STAYS 'patch', because PATCH is absent
 * from the Fetch spec's normalise list, and PATCH is one of the four methods
 * `ApiRequest.method` allows. Normalising HERE and not at the call site is the point: a
 * docblock telling TASK-012 to uppercase first is a rule enforced by nobody (F-288).
 * The proxy passes `request.method` straight in.
 */
export function isMutatingMethod(method: string): boolean {
  return !(NON_MUTATING_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * ============================================================================
 * F-035. The client address the proxy forwards, and where it comes from.
 * ============================================================================
 *
 * The proxy adds, on every upstream request WHEN `BFF_PROXY_SECRET` IS SET, and neither
 * header when it is unset, which is the local compose stack's state (TASK-009):
 *   BFF_CLIENT_IP_HEADER:  the browser's address, read from VERCEL_CLIENT_IP_HEADER
 *   BFF_PROXY_AUTH_HEADER: process.env.BFF_PROXY_SECRET (server-only, optional; the
 *                          API-side match is TASK-004's; NEVER logged; see
 *                          logging-and-headers.md F-032 for the API-side mirror)
 *
 * VERCEL_CLIENT_IP_HEADER is read WHOLE. Vercel sets it to the connecting client's
 * public address and overwrites inbound forwarding headers (non-Enterprise), so a
 * client cannot spoof it, and unlike x-forwarded-for it is not rewritten by a proxy
 * stacked on top of Vercel.
 *
 * NEVER x-forwarded-for.split(',')[0]: the leftmost entry of a multi-valued list is
 * the construct F-009 forbids, moved one hop upstream. If the header is absent (local
 * next dev), OMIT BFF_CLIENT_IP_HEADER entirely; the API then falls back to the header
 * TRUSTED_CLIENT_IP_HEADER declares, or to no principal where none is declared (F-320,
 * ADR-0040, trusted-client-address.md). And when BFF_PROXY_SECRET is unset on THIS side,
 * forward NEITHER header (the API would count the pair as a mismatch).
 *
 * ANY proxy placed in front of Vercel (Cloudflare, a corporate gateway, an Enterprise
 * trusted-proxy config) invalidates this assumption and requires revisiting
 * web-api-client.md, not just DNS.
 *
 * API-side resolution: apps/api/src/auth/resolve-rate-limit-principal.ts (F-031).
 */
export const VERCEL_CLIENT_IP_HEADER = 'x-vercel-forwarded-for';
export const BFF_CLIENT_IP_HEADER = 'x-shortkit-client-ip';
export const BFF_PROXY_AUTH_HEADER = 'x-shortkit-proxy-auth';
