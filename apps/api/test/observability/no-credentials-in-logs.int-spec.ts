import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LOGGABLE_FIELDS, REDACT_CENSOR } from '../../src/observability/logger';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  authServerEnv,
  clearSignupState,
  jwtClaims,
  mintToken,
  sessionTokenCookie,
  signIn,
  signUp,
} from '../support/auth-fixture';

/**
 * STORY-006 — AC-33, AC-34, AC-35: SC-5, measured on the bytes the process wrote. TASK-016,
 * wave 8.
 *
 * Contract: `docs/contracts/logging-and-headers.md` ("Required fields", "What may never appear
 * in a log line", "A field reaches a line only if it is named"). ADR-0028, ADR-0013 (the auth
 * mount is outside the Nest graph), ADR-0052 / ADR-0060 (Better Auth's logger is bound to
 * pino at `warn`). Enforces GC-9.
 *
 * ============================================================================
 * THE WHOLE PROCESS'S OUTPUT, DURING A REAL SIGNUP, SIGN-IN, MINT AND WORKSPACE FLOW.
 * ============================================================================
 *
 * `api-server.ts` boots `dist/main.js` as a child and captures its stdout AND stderr into
 * one string. That is the capture AC-33 needs and the one an in-process `AppModule` cannot
 * give: Better Auth is mounted on Express outside the Nest module graph (ADR-0013), so no
 * Nest interceptor sees `/api/auth/*`, and a suite that scanned only the lines an interceptor
 * produced would report a clean result for the surface it could not see. Every request here
 * — the auth ones and the workspace ones — goes to the CHILD, and every assertion is over
 * `server.output()`.
 *
 * NON-VACUITY FIRST (F-295, the reason `foundation`'s SC-1 closed untestable). Nothing in
 * `apps/api/src` wrote a per-request line before TASK-016, and "no credential in zero lines"
 * is true of any process. So the first assertion is that the request path EMITTED lines — a
 * non-zero count, on the workspace routes, with the tenant of the signup on them — and only
 * then that the email address, the password, the session token and the JWT are absent from
 * every byte the process wrote.
 *
 * `LOG_LEVEL` is pinned to `info` in the child's environment: it is the level the deployed
 * image runs at (no `LOG_LEVEL` in the `Dockerfile`) and the level the request line is
 * written at. Left to inherit, a developer shell exporting `LOG_LEVEL=error` would silence
 * the request lines and the non-vacuity assertion would fail for a reason unrelated to the
 * code — correctly, but confusingly.
 *
 * WHAT IS SCANNED FOR, AND WHY EACH IS A SUBSTRING RATHER THAN A FIELD. A password, a session
 * token and a JWT are not fields — they are bytes that can sit inside `msg`, inside
 * `err_message`, inside `err_stack`, inside a censored container's stringified `toJSON`
 * (F-265). So the scan is `String.includes` over the whole captured output, and for the two
 * tokens it also looks for the pieces a serialiser might have split them into: the cookie
 * value URL-decoded and its token half before the `.`, and each of the JWT's three base64url
 * segments on its own.
 */

const EMAIL = 'wave8-no-credentials-in-logs@example.com';

/**
 * A malformed JSON body whose FIRST bytes are the password: the placement V8 quotes into
 * `SyntaxError.message` (`Unexpected token 'q', "quilted-ha"...`), which Nest forwards into
 * `BadRequestException(err.message)`, which the filter's framework-400 arm logs — through
 * `errorLogFields`, so the message never reaches the line. `framework-400-request-body.spec.ts`
 * measured that arm against `/api/anything`; AC-35 asks for it against this initiative's
 * routes with the initiative's credential.
 */
const MALFORMED_BODY_LEADING_WITH_THE_PASSWORD = `${POLICY_COMPLIANT_PASSWORD}=1&other=2`;

/**
 * The filter's context string for the framework-400 arm and the interceptor's `msg`,
 * hand-copied rather than imported: an expected value read out of the module under test
 * agrees with it whatever it says.
 */
const FRAMEWORK_400_CONTEXT = 'framework exception with a 400 status';
const REQUEST_COMPLETED = 'request completed';

/** The three fields `errorLogFields` builds, and an error line may carry no fourth. */
const ERROR_LOG_FIELDS = new Set(['err_name', 'err_message', 'err_stack']);

/** pino's own keys on every line: `base` is `{ service, env }`, plus `level` and `time`. */
const PINO_OWN_KEYS = new Set(['level', 'time', 'service', 'env']);

/** The one key `formatters.log` leaves to `serializers.err` (`logger.ts`, the partition). */
const ERROR_KEY = 'err';

/**
 * THE TWO WRITERS THAT ARE NOT PINO, MEASURED ON THIS RUN AND BOTH ALREADY ON RECORD. Every
 * other line the process writes is one JSON record from the shared instance; these two are
 * unstructured, ANSI-coloured, and reach the capture on their own:
 *
 *   - Nest's own bootstrap logger (`[Nest] <pid>  - <date>  LOG [InstanceLoader] …`), fourteen
 *     lines at boot. ADR-0028 "What this ADR does not decide" and `eslint.config.mjs` both
 *     name it as the question a later `app.useLogger(…)` answers; not this TASK's.
 *   - Better Auth's PACKAGE-LEVEL logger on its `onError` path (`api/index.mjs:199`,
 *     `log?.error(e.message)`), which ADR-0052's F-216 amendment records as the one exception
 *     to "exactly one censoring mechanism": the bound `log` hook is not consulted and
 *     `disableColors` does not apply. Measured here for a malformed body on the auth mount:
 *     `ERROR [Better Auth]: Invalid JSON in request body`, on stderr, coloured — a FIXED
 *     string, so nothing leaks, and the byte scan above covers it regardless.
 *
 * Anything non-JSON that is neither of these fails the suite: a third unstructured writer
 * would be a new F-278.
 */
const NEST_BOOTSTRAP_LINE = /^\[Nest\] \d+\s+- /;
const BETTER_AUTH_PACKAGE_LOGGER_LINE = /\[Better Auth\]:/;
/* eslint-disable-next-line no-control-regex -- the ANSI escape prefix those two writers use */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

/** How long the child gets to flush the last request's line into the parent's capture. */
const CAPTURE_SETTLE_MS = 5_000;

interface EmittedLine {
  readonly raw: string;
  readonly record: Record<string, unknown>;
}

interface Probe {
  readonly status: number;
  readonly raw: string;
  readonly body: unknown;
}

/** Everything the flow produced that an assertion needs, so each `it` reads and never re-runs it. */
interface FlowArtefacts {
  readonly tenantId: string;
  readonly token: string;
  readonly sessionCookieValue: string;
  readonly workspaceId: string;
  readonly statuses: Readonly<Record<string, number>>;
  readonly output: string;
}

let serverBoot: Promise<ApiServer>;
let server: ApiServer;
let flow: Promise<FlowArtefacts> | undefined;
let artefacts: FlowArtefacts;

async function request(
  path: string,
  options: {
    readonly method?: 'GET' | 'POST' | 'PATCH';
    readonly token?: string;
    /** JSON-encoded when an object; sent verbatim (as `application/json`) when a string. */
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<Probe> {
  const payload =
    options.body === undefined
      ? undefined
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);

  const response = await fetch(`${server.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(payload === undefined ? {} : { body: payload }),
  });
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, raw, body };
}

function emittedLines(output: string): EmittedLine[] {
  return output
    .split('\n')
    .filter((line) => line !== '')
    .map((raw) => {
      try {
        return { raw, record: JSON.parse(raw) as Record<string, unknown> };
      } catch {
        // Kept, with an empty record, so the byte scan still covers it and the "every line is
        // JSON" assertion names it.
        return { raw, record: {} };
      }
    });
}

function requestLines(output: string): EmittedLine[] {
  return emittedLines(output).filter((line) => line.record.msg === REQUEST_COMPLETED);
}

/**
 * The child writes fd 1 synchronously, but the parent reads the pipe asynchronously and the
 * client can hold a response before the server's `'finish'` listener has run, so the capture
 * is polled to a count rather than read the instant the last response arrives. Bounded.
 */
async function untilCaptured(condition: (output: string) => boolean, what: string): Promise<string> {
  const deadline = Date.now() + CAPTURE_SETTLE_MS;

  for (;;) {
    const output = server.output();

    if (condition(output)) {
      return output;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}. The child's output was:\n${output}`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The whole run: signup, sign-in, mint, then every workspace route the API serves, then the
 * three shapes that carry the credential somewhere other than the sign-in body. Statuses are
 * asserted here so a flow that did not actually happen cannot make the scan below vacuous.
 */
async function runFlow(): Promise<FlowArtefacts> {
  const statuses: Record<string, number> = {};

  const signedUp = await signUp(server, EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);
  statuses.signUp = signedUp.status;

  const signedIn = await signIn(server, EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);
  statuses.signIn = signedIn.status;

  const sessionCookie = sessionTokenCookie(signedIn);
  expect(sessionCookie, signedIn.setCookie.join('\n')).toBeDefined();
  const sessionCookieValue = sessionCookie?.value ?? '';
  expect(sessionCookieValue.length).toBeGreaterThan(16);

  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  statuses.mint = minted.status;
  const token = (minted.body as { token?: unknown }).token;
  expect(typeof token).toBe('string');
  const jwt = token as string;
  expect(jwt.split('.')).toHaveLength(3);
  const tenantId = jwtClaims(jwt).tid;
  expect(typeof tenantId).toBe('string');

  // The first request path: create, list, rename, archive, list — the four routes
  // `workspaces.md` names, against the child's own `/api/workspaces`.
  const listedBefore = await request('/api/workspaces', { token: jwt });
  expect(listedBefore.status, listedBefore.raw).toBe(200);
  statuses.listBefore = listedBefore.status;

  const created = await request('/api/workspaces', { method: 'POST', token: jwt, body: { name: 'Acme' } });
  expect(created.status, created.raw).toBe(201);
  statuses.create = created.status;
  const workspaceId = (created.body as { id: string }).id;

  const renamed = await request(`/api/workspaces/${workspaceId}`, { method: 'PATCH', token: jwt, body: { name: 'Acme Group' } });
  expect(renamed.status, renamed.raw).toBe(200);
  statuses.rename = renamed.status;

  const archived = await request(`/api/workspaces/${workspaceId}/archive`, { method: 'POST', token: jwt });
  expect(archived.status, archived.raw).toBe(200);
  statuses.archive = archived.status;

  const listedAfter = await request('/api/workspaces', { token: jwt });
  expect(listedAfter.status, listedAfter.raw).toBe(200);
  statuses.listAfter = listedAfter.status;

  // The password in a WRONG FIELD of a well-formed body on an authenticated route: whatever
  // the schema does with an unknown key, the request line and any error line must not carry
  // it. `createWorkspaceRequestContract` decides between 201 (key stripped) and 400 (refused);
  // both go through the interceptor, so a line is emitted either way.
  const wrongField = await request('/api/workspaces', {
    method: 'POST',
    token: jwt,
    body: { name: 'Acme Two', password: POLICY_COMPLIANT_PASSWORD },
  });
  expect([201, 400], wrongField.raw).toContain(wrongField.status);
  statuses.wrongField = wrongField.status;

  // AC-35: a malformed body LEADING with the password, on an authenticated route. body-parser
  // raises before routing, Nest maps it to `BadRequestException(err.message)` with the first
  // ten bytes quoted, and the filter's framework-400 arm logs it through `errorLogFields`.
  const malformed = await request('/api/workspaces', {
    method: 'POST',
    token: jwt,
    body: MALFORMED_BODY_LEADING_WITH_THE_PASSWORD,
  });
  expect(malformed.status, malformed.raw).toBe(400);
  statuses.malformedOnWorkspaces = malformed.status;

  // The same malformed body on the AUTH surface itself, outside the Nest graph. Whatever
  // Better Auth answers, whatever it logs through the bound pino hook (ADR-0052) or through
  // its package-level `onError` logger (the F-216 exception), lands in the same capture.
  const malformedOnAuth = await request('/api/auth/sign-in/email', {
    method: 'POST',
    body: MALFORMED_BODY_LEADING_WITH_THE_PASSWORD,
    headers: { origin: server.baseUrl },
  });
  expect(malformedOnAuth.status, malformedOnAuth.raw).toBeGreaterThanOrEqual(400);
  expect(malformedOnAuth.status, malformedOnAuth.raw).toBeLessThan(500);
  statuses.malformedOnAuth = malformedOnAuth.status;

  // A guard refusal, for coverage of the byte scan: the header carries the JWT of a stranger
  // shape (the session cookie value), and the 401's filter path must not echo it.
  const refused = await request('/api/workspaces', { token: sessionCookieValue });
  expect(refused.status, refused.raw).toBe(401);
  statuses.refused = refused.status;

  // Six requests went through the interceptor (two lists, create, rename, archive, the
  // wrong-field create); the malformed bodies, the auth calls and the 401 do not, by
  // construction — see the interceptor's header. Wait for all six and for the AC-35 line.
  const output = await untilCaptured(
    (captured) =>
      requestLines(captured).length >= 6 &&
      emittedLines(captured).some((line) => line.record.msg === FRAMEWORK_400_CONTEXT),
    'six request-log lines and the framework-400 error line',
  );

  return { tenantId: tenantId as string, token: jwt, sessionCookieValue, workspaceId, statuses, output };
}

beforeAll(() => {
  serverBoot = startApiServer({
    env: (baseUrl) => ({ ...authServerEnv(baseUrl), LOG_LEVEL: 'info' }),
  });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;

  if (flow === undefined) {
    clearSignupState(EMAIL);
    flow = runFlow();
  }

  artefacts = await flow;
}, 180_000);

afterAll(async () => {
  await server?.stop();
  clearSignupState(EMAIL);
});

/** ADR-0028 over one parsed line: every key is named, pino's own, the `err` seam, or censored. */
function keysNeitherNamedNorCensored(record: Record<string, unknown>, path = ''): string[] {
  const offending: string[] = [];

  for (const [key, value] of Object.entries(record)) {
    const at = `${path}${key}`;

    if (PINO_OWN_KEYS.has(key) && path === '') {
      continue;
    }

    if (key === ERROR_KEY && path === '' && typeof value === 'object' && value !== null) {
      // The serialiser's output: `errorLogFields`' three names and no fourth.
      for (const inner of Object.keys(value)) {
        if (!ERROR_LOG_FIELDS.has(inner)) {
          offending.push(`${at}.${inner}`);
        }
      }
      continue;
    }

    if (LOGGABLE_FIELDS.has(key)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        offending.push(...keysNeitherNamedNorCensored(value as Record<string, unknown>, `${at}.`));
      }
      continue;
    }

    if (value !== REDACT_CENSOR) {
      offending.push(at);
    }
  }

  return offending;
}

describe('AC-33: the request path emits lines, and no credential is among their bytes', () => {
  it('non-vacuity: the child wrote request-log lines for the workspace routes, at info, with the signup’s tenant on them', () => {
    const lines = requestLines(artefacts.output);

    // The count clause F-295 refuses to do without: zero lines would make everything below
    // true of an empty process.
    expect(lines.length, artefacts.output).toBeGreaterThanOrEqual(6);

    const routes = lines.map((line) => line.record.route);
    expect(routes).toContain('/api/workspaces');
    // `:workspaceId` since TASK-1b-06 (D-07): the log-safe pattern, never a concrete id.
    expect(routes).toContain('/api/workspaces/:workspaceId');
    expect(routes).toContain('/api/workspaces/:workspaceId/archive');

    for (const line of lines) {
      expect(line.record.level, line.raw).toBe('info');
      expect(line.record.tenant_id, line.raw).toBe(artefacts.tenantId);
      expect(typeof line.record.request_id, line.raw).toBe('string');
      expect(typeof line.record.duration_ms, line.raw).toBe('number');
      expect([200, 201, 400], line.raw).toContain(line.record.status);
      // The pattern, never the concrete path: the workspace id is on no `route`.
      expect(String(line.record.route)).not.toContain(artefacts.workspaceId);
    }

    // The flow was real: every status is what the routes promise.
    expect(artefacts.statuses).toMatchObject({
      signUp: 200,
      signIn: 200,
      mint: 200,
      listBefore: 200,
      create: 201,
      rename: 200,
      archive: 200,
      listAfter: 200,
      malformedOnWorkspaces: 400,
      refused: 401,
    });
  });

  it('the email address appears zero times in every byte the process wrote', () => {
    expect(EMAIL.length).toBeGreaterThan(0);
    expect(artefacts.output).not.toContain(EMAIL);
    expect(artefacts.output.toLowerCase()).not.toContain(EMAIL.toLowerCase());
    expect(artefacts.output).not.toContain(encodeURIComponent(EMAIL));
    // The local part alone, in case an aggregator-shaped line carried it split from the domain.
    expect(artefacts.output).not.toContain(EMAIL.split('@')[0]);
  });

  it('the password appears zero times — not in a field, not in msg, not inside err_message or err_stack', () => {
    expect(POLICY_COMPLIANT_PASSWORD.length).toBeGreaterThan(0);
    expect(artefacts.output).not.toContain(POLICY_COMPLIANT_PASSWORD);
    // The fragment V8 quotes into a parse message is the first ten bytes of the body, which
    // for the AC-35 body is the start of the password.
    expect(artefacts.output).not.toContain(POLICY_COMPLIANT_PASSWORD.slice(0, 10));
  });

  it('the session token appears zero times: the cookie value, its URL-decoded form, and its token half', () => {
    const value = artefacts.sessionCookieValue;
    expect(value.length).toBeGreaterThan(16);

    const decoded = decodeURIComponent(value);
    const tokenHalf = decoded.split('.')[0];
    expect(tokenHalf.length).toBeGreaterThan(16);

    expect(artefacts.output).not.toContain(value);
    expect(artefacts.output).not.toContain(decoded);
    expect(artefacts.output).not.toContain(tokenHalf);
  });

  it('the JWT appears zero times, whole and as each of its three segments', () => {
    const segments = artefacts.token.split('.');
    expect(segments).toHaveLength(3);

    expect(artefacts.output).not.toContain(artefacts.token);
    for (const segment of segments) {
      expect(segment.length).toBeGreaterThan(8);
      expect(artefacts.output).not.toContain(segment);
    }
  });
});

describe('AC-34: every field on every line is named in LOGGABLE_FIELDS or renders as [redacted]', () => {
  it('every line the process wrote is one JSON record, save the two non-pino writers already on record', () => {
    const notJson = emittedLines(artefacts.output)
      .filter((line) => Object.keys(line.record).length === 0)
      .map((line) => line.raw.replace(ANSI_ESCAPE, ''));

    const unexplained = notJson.filter(
      (line) => !NEST_BOOTSTRAP_LINE.test(line) && !BETTER_AUTH_PACKAGE_LOGGER_LINE.test(line),
    );

    expect(unexplained).toEqual([]);

    // The F-216 path, when it fires, says its fixed string and nothing of the body.
    for (const line of notJson.filter((candidate) => BETTER_AUTH_PACKAGE_LOGGER_LINE.test(candidate))) {
      expect(line).not.toContain(POLICY_COMPLIANT_PASSWORD);
      expect(line).not.toContain(POLICY_COMPLIANT_PASSWORD.slice(0, 10));
    }
  });

  it('no key on any line carries a value under a name the allowlist does not hold', () => {
    const lines = emittedLines(artefacts.output);
    expect(lines.length).toBeGreaterThan(0);

    const offending = lines.flatMap((line) =>
      keysNeitherNamedNorCensored(line.record).map((key) => `${key} on ${line.raw}`),
    );

    expect(offending).toEqual([]);
  });

  it('the request lines carry exactly the five required fields beside msg and pino’s own keys', () => {
    for (const line of requestLines(artefacts.output)) {
      expect(Object.keys(line.record).sort(), line.raw).toEqual(
        ['duration_ms', 'env', 'level', 'msg', 'request_id', 'route', 'service', 'status', 'tenant_id', 'time'].sort(),
      );
    }
  });
});

describe('AC-35: an error carrying the request body is logged as the policy fields and nothing of the body', () => {
  it('the framework-400 line for the malformed body carries only errorLogFields output beside request_id and msg', () => {
    const lines = emittedLines(artefacts.output).filter((line) => line.record.msg === FRAMEWORK_400_CONTEXT);

    // Exactly the one the malformed POST to `/api/workspaces` produced. The auth mount's
    // malformed body is Better Auth's to answer and does not reach the filter.
    expect(lines.map((line) => line.raw)).toHaveLength(1);
    const line = lines[0];

    const fieldsBeyondTheEnvelope = Object.keys(line.record).filter(
      (key) => !PINO_OWN_KEYS.has(key) && key !== 'msg' && key !== 'request_id',
    );
    for (const key of fieldsBeyondTheEnvelope) {
      expect(ERROR_LOG_FIELDS.has(key), `unexpected field ${key} on ${line.raw}`).toBe(true);
    }
    expect(line.record.err_name).toBe('BadRequestException');
    // The message is withheld on this arm (`includeMessage` is `isDomainError(...)`), and it is
    // the field that would carry the quoted body bytes.
    expect(line.record).not.toHaveProperty('err_message');
    expect(typeof line.record.err_stack).toBe('string');
    expect(line.raw).not.toContain(POLICY_COMPLIANT_PASSWORD);
    expect(line.raw).not.toContain(POLICY_COMPLIANT_PASSWORD.slice(0, 10));
    expect(line.raw).not.toContain(MALFORMED_BODY_LEADING_WITH_THE_PASSWORD);
  });

  it('whatever Better Auth logged for the malformed body on its own mount carries the fixed code and no body bytes', () => {
    const betterAuthLines = emittedLines(artefacts.output).filter((line) => line.record.code === 'better_auth');

    // ADR-0060: `warn` and above only, and no `warn` site in 1.6.26 interpolates a value. Zero
    // lines is the expected shape; the assertion is over whatever did arrive.
    for (const line of betterAuthLines) {
      expect(Object.keys(line.record).sort(), line.raw).toEqual(['code', 'env', 'level', 'msg', 'service', 'time']);
      expect(line.raw).not.toContain(POLICY_COMPLIANT_PASSWORD);
    }
  });
});
