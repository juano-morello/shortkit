import { request as httpRequest } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  SIGNUP_NAME,
  authServerEnv,
  clearSignupState,
  signUp,
  usersFor,
} from '../support/auth-fixture';
import { assertTenantsIsMigrated } from '../support/rls-fixture';

/**
 * STORY-001 — AC-6, AC-7, AC-9. TASK-004, wave 3.
 *
 * Contract: `docs/contracts/rate-limit.md` (the auth surface's limiter, the 32 KiB cap, the
 * 429 shape, the two boot assertions), `docs/contracts/trusted-client-address.md` (the
 * declared header, the boot assertion, what `null` means), `docs/contracts/logging-and-headers.md`
 * invariant 4 (helmet on every response). ADR-0013, ADR-0040, ADR-0050.
 *
 * ============================================================================
 * THIS BOOTS THE COMPOSITION ROOT, BECAUSE EVERYTHING HERE IS A PROPERTY OF `main.ts`.
 * ============================================================================
 *
 * The mount is one Express registration ahead of every body parser; the cap and the limiter
 * are middleware on that registration; the boot assertions are calls in `bootstrap()`. None
 * of it exists in an application compiled from `AppModule`, so `api-server.ts` builds the
 * bundle and runs it on a real socket, exactly as the platform would (its docblock has the
 * whole argument, and the `beforeAll` / `beforeEach` shape below is its prescription for a
 * boot refusal failing the file rather than skipping it).
 *
 * ============================================================================
 * THE SERVER UNDER TEST DECLARES A TRUSTED HEADER. THE WAVE-2 SUITES DO NOT.
 * ============================================================================
 *
 * `authServerEnv()` sets no `CLIENT_TRUST_BOUNDARY` and no `TRUSTED_CLIENT_IP_HEADER`, which
 * is the compose stack's state and the one under which no IP-keyed bucket binds (ADR-0040).
 * This suite adds both — `proxy` and `x-test-client-ip`, the names the contract writes for
 * the integration tier — so the buckets are exercisable at all. Requests that send no
 * `x-test-client-ip` resolve `null` and are unaffected, which is what lets AC-6 and AC-7 share
 * the process with the rate-limit tests; requests that do send it are keyed on the address
 * they name, and every test below names its own so the fixed windows do not interfere.
 *
 * AC-9's positive clause — both boundaries unset boots and serves — is asserted on a SECOND
 * boot with none of the four variables set, rather than inferred from the wave-2 suites that
 * happen to boot that way. The refusals are their own boots too, each expected to fail.
 */

/** The account AC-6 is stated over. */
const SIGNUP_EMAIL = 'wave3-mount@example.com';

/** AC-6 at the boundary: a body of exactly 32 768 bytes. */
const BOUNDARY_EMAIL = 'wave3-boundary@example.com';

/** AC-7's would-be account. It must never exist. */
const OVERSIZED_EMAIL = 'wave3-oversized@example.com';

/** The chunked-overflow account. It must never exist either. */
const CHUNKED_EMAIL = 'wave3-chunked@example.com';

/** The sign-up bucket's four addresses: three admitted, the fourth refused. */
const BUCKET_EMAILS = [
  'wave3-bucket-1@example.com',
  'wave3-bucket-2@example.com',
  'wave3-bucket-3@example.com',
  'wave3-bucket-4@example.com',
] as const;

/** A fourth sign-up from a DIFFERENT address, so the buckets are shown to be per key. */
const OTHER_KEY_EMAIL = 'wave3-bucket-other@example.com';

/** Never registered. Sign-ins for it are 401s that cost the sign-in bucket one each. */
const UNREGISTERED_EMAIL = 'wave3-never-registered@example.com';

const ADDRESSES = [SIGNUP_EMAIL, BOUNDARY_EMAIL, OVERSIZED_EMAIL, CHUNKED_EMAIL, ...BUCKET_EMAILS, OTHER_KEY_EMAIL] as const;

/** ADR-0013's cap, in bytes. */
const AUTH_BODY_CAP = 32 * 1024;

const TRUSTED_HEADER = 'x-test-client-ip';

/** Distinct documentation-range addresses, one per keyed test. */
const IP = {
  signIn: '203.0.113.11',
  signUp: '203.0.113.12',
  signUpOther: '203.0.113.13',
} as const;

/** The environment for the server under test: the fixture's, plus the declared trust boundary. */
function mountEnv(baseUrl: string): Record<string, string> {
  return {
    ...authServerEnv(baseUrl),
    CLIENT_TRUST_BOUNDARY: 'proxy',
    TRUSTED_CLIENT_IP_HEADER: TRUSTED_HEADER,
  };
}

/** `authServerEnv()` without one variable, for the boots that must refuse or must boot without it. */
function envWithout(baseUrl: string, ...names: readonly string[]): Record<string, string> {
  const env = { ...authServerEnv(baseUrl) };
  for (const name of names) {
    delete env[name];
  }
  return env;
}

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
  readonly raw: string;
}

/**
 * A request to the auth surface with headers of the caller's choosing. `fetch`, because it
 * sends any header that is not on the forbidden list, and `x-test-client-ip` is not.
 */
async function authFetch(
  method: 'GET' | 'POST',
  path: string,
  options: { readonly headers?: Record<string, string>; readonly body?: unknown } = {},
): Promise<RawResponse> {
  const response = await fetch(`${server.baseUrl}/api/auth${path}`, {
    method,
    headers: {
      origin: server.baseUrl,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const raw = await response.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, headers: Object.fromEntries(response.headers), body, raw };
}

interface RawOutcome {
  readonly response?: RawResponse;
  readonly error?: string;
}

/**
 * A raw `node:http` request, for the two shapes `fetch` cannot produce: a `Content-Length`
 * the caller sets, and a chunked body with none. `chunked` writes the payload in 1 KiB
 * pieces so a cap is crossed mid-stream.
 */
async function rawAuthRequest(options: {
  readonly path: string;
  readonly payload: Buffer;
  readonly chunked?: boolean;
}): Promise<RawOutcome> {
  const target = new URL(`${server.baseUrl}/api/auth${options.path}`);
  const chunked = options.chunked ?? false;

  return new Promise<RawOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: RawOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        // A fresh connection per request. Node's default agent keeps sockets alive, and the
        // fixture's `beforeEach` (a psql per address, through docker) outlasts the server's
        // 5 s keep-alive timeout — so a socket kept from the previous test is one the server
        // has already closed, and the next write on it races the FIN into an ECONNRESET.
        // Measured: AC-7 answered `undefined` after the boundary test and 413 in isolation.
        agent: false,
        headers: {
          origin: server.baseUrl,
          'content-type': 'application/json',
          ...(chunked
            ? { 'transfer-encoding': 'chunked' }
            : { 'content-length': String(options.payload.length) }),
        },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (raw += chunk));
        response.on('end', () => {
          let body: unknown = raw;
          try {
            body = JSON.parse(raw) as unknown;
          } catch {
            /* left as the raw text */
          }
          settle({ response: { status: response.statusCode ?? 0, headers: response.headers, body, raw } });
        });
        response.on('error', (error) => settle({ error: error.message }));
      },
    );

    request.on('error', (error: NodeJS.ErrnoException) => settle({ error: error.code ?? error.message }));
    request.on('close', () => settle({ error: 'closed with no response' }));

    if (chunked) {
      for (let offset = 0; offset < options.payload.length; offset += 1024) {
        request.write(options.payload.subarray(offset, offset + 1024));
      }
    } else {
      request.write(options.payload);
    }
    request.end();
  });
}

/** A signup body for `email`, padded with an unknown field to exactly `bytes` bytes. */
function paddedSignup(email: string, bytes: number): Buffer {
  const withoutPad = JSON.stringify({ email, password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME, pad: '' });
  const pad = 'p'.repeat(bytes - Buffer.byteLength(withoutPad));
  const payload = Buffer.from(JSON.stringify({ email, password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME, pad }));

  expect(payload.length, 'the padded body must be exactly the requested size').toBe(bytes);

  return payload;
}

beforeAll(() => {
  // Kicked off without awaiting and awaited again in `beforeEach`; `api-server.ts`'s docblock
  // explains why a rejection awaited only here would read as "N skipped" beside a green
  // summary.
  serverBoot = startApiServer({ env: mountEnv });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

/**
 * The state AC-6 and AC-7 are stated over, restored before every test that writes or must
 * not write a row. Inside the two describes that touch the tables rather than at file level,
 * because each pass costs a `psql` per address through docker and the boot-refusal tests
 * below write nothing.
 */
function clearMountState(): void {
  assertTenantsIsMigrated();
  clearSignupState(...ADDRESSES);
}

describe('the mount (ADR-0013)', () => {
  beforeEach(clearMountState, 180_000);

  it('AC-6: a JSON body reaches Better Auth with its fields intact and the signup succeeds', async () => {
    // "No earlier body parser consumed the stream", in its observable form. `name` is asserted
    // as well as `email` because it is the field the fixture chooses and nothing derives: a
    // body that arrived truncated or empty could not produce it.
    const response = await signUp(server, SIGNUP_EMAIL, POLICY_COMPLIANT_PASSWORD);
    const body = response.body as { user?: { email?: unknown; name?: unknown } };

    expect({
      status: response.status,
      email: body.user?.email,
      name: body.user?.name,
      rows: usersFor(SIGNUP_EMAIL).length,
    }).toEqual({ status: 200, email: SIGNUP_EMAIL, name: SIGNUP_NAME, rows: 1 });
  });

  it('AC-6 at the boundary: a body of exactly 32768 bytes is admitted and the signup succeeds', async () => {
    // AC-7 says "greater than 32768", so the boundary belongs to the accepted path — and the
    // accepted path is where "does not consume the stream" is measured, at the largest body
    // Better Auth will ever be handed by this mount.
    const outcome = await rawAuthRequest({
      path: '/sign-up/email',
      payload: paddedSignup(BOUNDARY_EMAIL, AUTH_BODY_CAP),
    });

    expect({ status: outcome.response?.status, rows: usersFor(BOUNDARY_EMAIL).length }).toEqual({
      status: 200,
      rows: 1,
    });
  });

  it('AC-7: a Content-Length greater than 32768 answers 413 and creates no user row', async () => {
    const outcome = await rawAuthRequest({
      path: '/sign-up/email',
      payload: paddedSignup(OVERSIZED_EMAIL, AUTH_BODY_CAP + 1),
    });

    expect({
      status: outcome.response?.status,
      error: outcome.error,
      rows: usersFor(OVERSIZED_EMAIL).length,
    }).toEqual({ status: 413, error: undefined, rows: 0 });
  });

  it('ADR-0013: a chunked body that crosses the cap is cut with no response, and creates no user row', async () => {
    // No `Content-Length` to refuse on, so the bytes are counted as they pass and the socket
    // is destroyed. The client sees a reset rather than a 413 — the accepted cost ADR-0013
    // records — and Better Auth never receives a complete body to act on.
    const outcome = await rawAuthRequest({
      path: '/sign-up/email',
      payload: paddedSignup(CHUNKED_EMAIL, AUTH_BODY_CAP * 4),
      chunked: true,
    });

    expect({
      answered: outcome.response !== undefined,
      failed: outcome.error !== undefined,
      rows: usersFor(CHUNKED_EMAIL).length,
    }).toEqual({ answered: false, failed: true, rows: 0 });
  });

  it('logging-and-headers.md invariant 4: helmet covers the mount', async () => {
    // helmet is registered on the app before the mount, so a response written by Better Auth
    // — outside the Nest graph — still carries the contract's headers. `DENY` is the one
    // value the contract sets against helmet's default, so it is the one asserted by value.
    const response = await authFetch('GET', '/ok');

    expect({
      status: response.status,
      frame: response.headers['x-frame-options'],
      nosniff: response.headers['x-content-type-options'],
      hsts: typeof response.headers['strict-transport-security'],
    }).toEqual({ status: 200, frame: 'DENY', nosniff: 'nosniff', hsts: 'string' });
  });
});

describe('the IP-keyed buckets (rate-limit.md)', () => {
  beforeEach(clearMountState, 180_000);

  it('sign-in: the eleventh attempt from one address inside the window answers 429 with Retry-After and the contract’s body', async () => {
    // Ten per five minutes, IP-keyed. The address is unregistered, so each attempt is a 401
    // that costs the bucket one and creates nothing; the eleventh is refused BEFORE Better
    // Auth sees it. The body carries `retryAfterSeconds` as well as the header because this
    // surface is mounted outside Nest and `apiClient` normalises both (F-027).
    const statuses: number[] = [];
    let refused: RawResponse | undefined;

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await authFetch('POST', '/sign-in/email', {
        headers: { [TRUSTED_HEADER]: IP.signIn },
        body: { email: UNREGISTERED_EMAIL, password: POLICY_COMPLIANT_PASSWORD },
      });
      statuses.push(response.status);
      refused = response;
    }

    const body = refused?.body as { code?: unknown; retryAfterSeconds?: unknown } | undefined;
    const retryAfter = Number(refused?.headers['retry-after']);

    expect({
      first: statuses.slice(0, 10).every((status) => status !== 429),
      eleventh: statuses[10],
      code: body?.code,
      retryAfterHeaderBounded: retryAfter >= 1 && retryAfter <= 300,
      retryAfterBodyMatchesHeader: body?.retryAfterSeconds === retryAfter,
    }).toEqual({
      first: true,
      eleventh: 429,
      code: 'rate_limited',
      retryAfterHeaderBounded: true,
      retryAfterBodyMatchesHeader: true,
    });
  });

  it('sign-up: three per hour per address, the fourth answers 429 and writes no row, and another address is unaffected', async () => {
    const admitted: number[] = [];
    for (const email of BUCKET_EMAILS.slice(0, 3)) {
      const response = await authFetch('POST', '/sign-up/email', {
        headers: { [TRUSTED_HEADER]: IP.signUp },
        body: { email, password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME },
      });
      admitted.push(response.status);
    }

    const fourth = await authFetch('POST', '/sign-up/email', {
      headers: { [TRUSTED_HEADER]: IP.signUp },
      body: { email: BUCKET_EMAILS[3], password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME },
    });

    const otherKey = await authFetch('POST', '/sign-up/email', {
      headers: { [TRUSTED_HEADER]: IP.signUpOther },
      body: { email: OTHER_KEY_EMAIL, password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME },
    });

    expect({
      admitted,
      fourth: fourth.status,
      fourthRows: usersFor(BUCKET_EMAILS[3]).length,
      otherKey: otherKey.status,
    }).toEqual({ admitted: [200, 200, 200], fourth: 429, fourthRows: 0, otherKey: 200 });
  });

  it('ADR-0040: with no principal the bucket does not run — no header, and X-Forwarded-For alone, are never limited', async () => {
    // Eleven attempts each way, one more than the sign-in limit. A limiter that keyed on a
    // sentinel, the empty string or the peer address would refuse the eleventh; one that read
    // `X-Forwarded-For` would refuse it too. Neither may.
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const bare = await authFetch('POST', '/sign-in/email', {
        body: { email: UNREGISTERED_EMAIL, password: POLICY_COMPLIANT_PASSWORD },
      });
      const forwarded = await authFetch('POST', '/sign-in/email', {
        headers: { 'x-forwarded-for': '203.0.113.99' },
        body: { email: UNREGISTERED_EMAIL, password: POLICY_COMPLIANT_PASSWORD },
      });
      statuses.push(bare.status, forwarded.status);
    }

    expect({ requests: statuses.length, limited: statuses.filter((status) => status === 429).length }).toEqual({
      requests: 22,
      limited: 0,
    });
  });
});

describe('the trust-boundary boot assertions (AC-9)', () => {
  // Each of these builds and boots its own child, so each gets a budget of its own. A refusal
  // is quick — the assertions run before any connection is opened — but the build in front of
  // it is not free.
  const BOOT_TIMEOUT_MS = 90_000;

  it(
    'both boundaries unset — and no secret, no header — boots and serves',
    async () => {
      // `docker compose up` must boot `api` with none of the four variables set: that is the
      // case F-380 and F-385 were filed on, and the image it runs carries
      // `ENV NODE_ENV=production`. Asserted on a boot rather than inferred from the wave-2
      // suites, which set `BFF_PROXY_SECRET` and would not notice a `NODE_ENV` gate on it.
      const bare = await startApiServer({ env: (baseUrl) => envWithout(baseUrl, 'BFF_PROXY_SECRET') });

      try {
        const response = await fetch(`${bare.baseUrl}/api/auth/ok`);

        expect(response.status).toBe(200);
      } finally {
        await bare.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it.each([
    ['CLIENT_TRUST_BOUNDARY holds an unrecognised value', { CLIENT_TRUST_BOUNDARY: 'Proxy', TRUSTED_CLIENT_IP_HEADER: TRUSTED_HEADER }, /"boot_precondition":"client_trust_boundary".*CLIENT_TRUST_BOUNDARY must be/],
    ['CLIENT_TRUST_BOUNDARY is proxy and no header is declared', { CLIENT_TRUST_BOUNDARY: 'proxy' }, /"boot_precondition":"client_trust_boundary".*TRUSTED_CLIENT_IP_HEADER is not set/],
    ['CLIENT_TRUST_BOUNDARY is proxy and the header is a forwarding header', { CLIENT_TRUST_BOUNDARY: 'proxy', TRUSTED_CLIENT_IP_HEADER: 'x-forwarded-for' }, /"boot_precondition":"client_trust_boundary".*may not name a forwarding header/],
    ['BFF_TRUST_BOUNDARY holds an unrecognised value', { BFF_TRUST_BOUNDARY: 'Bff' }, /"boot_precondition":"bff_trust_boundary".*BFF_TRUST_BOUNDARY must be/],
  ])(
    'AC-9: boot refuses when %s',
    async (_case, override, expected) => {
      // The refusal crosses the process boundary as ONE labelled pino line — `boot_precondition`
      // naming the boundary and `err_message` naming the rule — which is what the F-210 dynamic
      // import protects. `startApiServer` puts the child's whole output in its rejection.
      await expect(
        startApiServer({ env: (baseUrl) => ({ ...authServerEnv(baseUrl), ...override }) }),
      ).rejects.toThrow(expected);
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'AC-9: boot refuses when BFF_TRUST_BOUNDARY is bff and BFF_PROXY_SECRET is unset',
    async () => {
      await expect(
        startApiServer({
          env: (baseUrl) => ({ ...envWithout(baseUrl, 'BFF_PROXY_SECRET'), BFF_TRUST_BOUNDARY: 'bff' }),
        }),
      ).rejects.toThrow(/"boot_precondition":"bff_trust_boundary".*BFF_PROXY_SECRET is not set/);
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'ADR-0050: boot refuses when DATABASE_AUTH_URL connects as the application role',
    async () => {
      // The one misconfiguration the role split most needs to catch: a fallback — or a
      // copy-paste — that puts `shortkit_app` behind `DATABASE_AUTH_URL`. As that role the
      // auth-direction query finds `tenants` and `tenant_memberships` reachable, which is a
      // verdict rather than a reachability failure, so it refuses at once and names the third
      // precondition rather than spending the retry budget.
      await expect(
        startApiServer({
          env: (baseUrl) => ({ ...authServerEnv(baseUrl), DATABASE_AUTH_URL: authServerEnv(baseUrl).DATABASE_URL }),
        }),
      ).rejects.toThrow(/"boot_precondition":"auth_role_separation".*DATABASE_AUTH_URL connects as/);
    },
    BOOT_TIMEOUT_MS,
  );
});
