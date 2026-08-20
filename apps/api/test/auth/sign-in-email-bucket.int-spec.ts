/**
 * STORY-1b-08 — AC-1b-39: the email-keyed sign-in bucket, measured against the CHILD. The four
 * integration tests `docs/contracts/rate-limit.md` names under "The email key is normalised,
 * and both failure modes are tested" (F-025, F-228), plus the F-027 body shape and the SC-5
 * scan. TASK-1b-09 (item 1b, wave 3; D-15).
 *
 * Contract: `docs/contracts/rate-limit.md` ("The email bucket runs inside Better Auth, not in
 * Express", "`ctx.body` is unvalidated at hook time", "Response on limit"). ADR-0013 (F-019),
 * ADR-0012, ADR-0040, ADR-0055, F-216.
 *
 * ============================================================================
 * WHY SIX CLIENT IPs, AND WHY THE CHILD DECLARES A TRUSTED HEADER.
 * ============================================================================
 *
 * The hook is the ONLY limiter on this surface that is keyed on the body, and the two ways it
 * fails are silent (F-025): a wrong `ctx.path` literal makes it return on every request, and
 * a key over the raw string mints a fresh allowance per casing. So the six attempts come from
 * six DIFFERENT client addresses under a declared trusted header — `CLIENT_TRUST_BOUNDARY=proxy`
 * and `TRUSTED_CLIENT_IP_HEADER=x-test-client-ip`, the shape `auth-mount.int-spec.ts` uses —
 * so the Express IP bucket (10 per 5 min per IP) sees one attempt per address and CANNOT be
 * the limiter that answers the sixth 429. Whatever refuses the sixth is the email bucket, and
 * the body's `code` and `retryAfterSeconds` are the hook's, not the middleware's.
 *
 * Every request goes to the child (`dist/main.js`): the hook runs inside Better Auth's
 * handler and nothing in-process can reach it (ADR-0013). `startApiServer` boots one child
 * per file, and the limiter's fixed 15-minute window lives in that child, so every test here
 * uses its own address (or addresses) and no window is shared across tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AUTH_RATE_LIMIT_BUCKETS } from '../../src/auth/ports/auth-rate-limit.port';
import { EMAIL_RATE_LIMITED_MESSAGE } from '../../src/auth/email-rate-limit-hook';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  SIGNUP_NAME,
  authServerEnv,
  clearSignupState,
} from '../support/auth-fixture';
import { assertTenantsIsMigrated } from '../support/rls-fixture';

const TRUSTED_HEADER = 'x-test-client-ip';

/** Six documentation-range addresses, one per attempt, so no IP bucket can fire. */
const SIX_IPS = ['203.0.113.21', '203.0.113.22', '203.0.113.23', '203.0.113.24', '203.0.113.25', '203.0.113.26'] as const;

const LIMIT = AUTH_RATE_LIMIT_BUCKETS.signInPerEmail.limit;
const WINDOW_SECONDS = AUTH_RATE_LIMIT_BUCKETS.signInPerEmail.windowSeconds;

/** Never registered: every attempt is a 401 that costs the email bucket one. */
const SIX_IPS_EMAIL = 'wave3-email-bucket-six-ips@example.test';
const CASE_VARIED_EMAIL = 'Wave3-Email-Bucket-Case@Example.test';
/** Registered below, so "a different address succeeds" is a real 200 and not a 401 that merely is not 429. */
const OTHER_EMAIL = 'wave3-email-bucket-other@example.test';
const UNCHARGED_EMAIL = 'wave3-email-bucket-uncharged@example.test';
const NUMBER_PROBE_EMAIL = 'wave3-email-bucket-number@example.test';

/** Registered; signed in successfully many times — the failed-attempts rule's subject. */
const SUCCESSES_EMAIL = 'wave3-email-bucket-successes@example.test';
/** Registered; five wrong passwords, then the right one. */
const LOCKED_EMAIL = 'wave3-email-bucket-locked@example.test';

const ADDRESSES = [SIX_IPS_EMAIL, CASE_VARIED_EMAIL, OTHER_EMAIL, UNCHARGED_EMAIL, NUMBER_PROBE_EMAIL, SUCCESSES_EMAIL, LOCKED_EMAIL] as const;

/**
 * Six spellings of one address, all of which `normaliseEmailForKey` folds to one key. The
 * first five differ in case only and are each a 401 from the endpoint; the SIXTH is padded
 * with whitespace, which Better Auth's own validation would answer 400 — but the hook charges
 * BEFORE validation, so it is the sixth attempt on the one key and is refused 429 first. That
 * ordering is what makes the trim half of the normalisation observable at all.
 */
function caseForms(email: string): readonly string[] {
  return [
    email,
    email.toLowerCase(),
    email.toUpperCase(),
    email.replace(/^./, (c) => c.toLowerCase()).replace(/@.*/, (domain) => domain.toUpperCase()),
    email.replace(/@.*/, (domain) => domain.toLowerCase()).replace(/^[^@]*/, (local) => local.toUpperCase()),
    ` ${email.toLowerCase()} `,
  ];
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly raw: string;
}

/** The environment for the child: the fixture's, plus the declared trust boundary. */
function bucketEnv(baseUrl: string): Record<string, string> {
  return {
    ...authServerEnv(baseUrl),
    CLIENT_TRUST_BOUNDARY: 'proxy',
    TRUSTED_CLIENT_IP_HEADER: TRUSTED_HEADER,
  };
}

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

/**
 * A request to the auth surface with headers of the caller's choosing. `fetch`, because it
 * sends any header that is not on the forbidden list, and `x-test-client-ip` is not.
 */
async function authFetch(
  path: string,
  options: { readonly headers?: Record<string, string>; readonly body?: unknown },
): Promise<RawResponse> {
  const response = await fetch(`${server.baseUrl}/api/auth${path}`, {
    method: 'POST',
    headers: {
      origin: server.baseUrl,
      'content-type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify(options.body),
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

/** One sign-in attempt from `ip`, with whatever `email` value the test wants on the body. */
async function signInFrom(ip: string, email: unknown, password: string = POLICY_COMPLIANT_PASSWORD): Promise<RawResponse> {
  return authFetch('/sign-in/email', { headers: { [TRUSTED_HEADER]: ip }, body: { email, password } });
}

async function signUpFrom(ip: string, email: string): Promise<RawResponse> {
  return authFetch('/sign-up/email', {
    headers: { [TRUSTED_HEADER]: ip },
    body: { email, password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME },
  });
}

/** `{ status, code, retryAfterSeconds, message }` off a refusal, for one-assertion checks. */
function shape(response: RawResponse): { status: number; code: unknown; retryAfterSeconds: unknown; message: unknown } {
  const body = response.body as { code?: unknown; retryAfterSeconds?: unknown; message?: unknown };

  return { status: response.status, code: body.code, retryAfterSeconds: body.retryAfterSeconds, message: body.message };
}

beforeAll(() => {
  serverBoot = startApiServer({ env: bucketEnv });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;
  assertTenantsIsMigrated();
  clearSignupState(...ADDRESSES);
}, 180_000);

afterAll(async () => {
  clearSignupState(...ADDRESSES);
  await server?.stop();
});

describe('the email-keyed sign-in bucket (rate-limit.md, AC-1b-39)', () => {
  it('six attempts for one address from six client IPs: the first five are 401, the sixth is 429 rate_limited with retryAfterSeconds in the body — so ctx.path really is /sign-in/email (F-025 b)', async () => {
    const statuses: number[] = [];
    let sixth: RawResponse | undefined;

    for (const ip of SIX_IPS) {
      const response = await signInFrom(ip, SIX_IPS_EMAIL);
      statuses.push(response.status);
      sixth = response;
    }

    expect(LIMIT).toBe(5);
    expect(WINDOW_SECONDS).toBe(900);

    const refused = shape(sixth as RawResponse);
    expect({
      first: statuses.slice(0, LIMIT),
      sixth: refused.status,
      code: refused.code,
      message: refused.message,
      retryAfterBounded: typeof refused.retryAfterSeconds === 'number' && refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= WINDOW_SECONDS,
    }).toEqual({
      first: [401, 401, 401, 401, 401],
      sixth: 429,
      code: 'rate_limited',
      message: EMAIL_RATE_LIMITED_MESSAGE,
      retryAfterBounded: true,
    });
  });

  it('F-027: the 429 carries Retry-After as a header too, equal to the body field (best effort, measured here so its absence would be a change)', async () => {
    let refused: RawResponse | undefined;

    for (const ip of SIX_IPS) {
      refused = await signInFrom(ip, `six-header-${SIX_IPS_EMAIL}`);
    }

    const body = refused?.body as { retryAfterSeconds?: unknown } | undefined;
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers['retry-after'])).toBe(body?.retryAfterSeconds);
  });

  it('the same six attempts with the address case-varied and whitespace-padded on each still 429 on the sixth (F-025 a: one normalised key)', async () => {
    const forms = caseForms(CASE_VARIED_EMAIL);
    expect(new Set(forms).size).toBe(SIX_IPS.length); // six distinct spellings
    const statuses: number[] = [];

    for (const [index, ip] of SIX_IPS.entries()) {
      statuses.push((await signInFrom(ip, forms[index])).status);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('a DIFFERENT address from the same six IPs succeeds, so the bucket is keyed on the address rather than firing globally', async () => {
    // Exhaust one address first, from the six IPs.
    for (const ip of SIX_IPS) {
      await signInFrom(ip, `six-global-${SIX_IPS_EMAIL}`);
    }

    // A registered account, so its sign-in is a real 200 and not merely "not 429".
    const signedUp = await signUpFrom(SIX_IPS[0], OTHER_EMAIL);
    expect(signedUp.status, signedUp.raw).toBe(200);

    const other = await signInFrom(SIX_IPS[1], OTHER_EMAIL);
    expect(other.status, other.raw).toBe(200);
  });

  it('F-228: an object-typed email is the endpoint’s 400, never a 500, and is NOT charged — five legitimate attempts for that address still follow before the sixth is 429', async () => {
    const malformed = await signInFrom(SIX_IPS[0], { ne: null });
    expect({ status: malformed.status, code: (malformed.body as { code?: unknown }).code }).toEqual({
      status: 400,
      code: 'VALIDATION_ERROR',
    });

    // If the malformed attempt had been charged under a sentinel or under `String(object)`,
    // it could not have counted against THIS address anyway — so the assertion that proves
    // "uncharged" is that a real address's allowance is still the full five afterwards, and
    // that nothing 500'd along the way.
    const statuses: number[] = [];
    for (const ip of SIX_IPS) {
      statuses.push((await signInFrom(ip, UNCHARGED_EMAIL)).status);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('F-228: a number-typed email, a null email, a missing email and no body at all are each the endpoint’s 400, never a 500', async () => {
    const outcomes = await Promise.all([
      signInFrom(SIX_IPS[0], 12345),
      signInFrom(SIX_IPS[1], null),
      authFetch('/sign-in/email', { headers: { [TRUSTED_HEADER]: SIX_IPS[2] }, body: { password: POLICY_COMPLIANT_PASSWORD } }),
      fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin: server.baseUrl, [TRUSTED_HEADER]: SIX_IPS[3] },
      }).then(async (response) => ({ status: response.status, raw: await response.text() })),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([400, 400, 400, 400]);
    // And a legitimate attempt for an unrelated address right after is admitted (nothing was
    // aborted mid-registry: the invitation hook and the endpoint still ran).
    const after = await signInFrom(SIX_IPS[4], NUMBER_PROBE_EMAIL);
    expect(after.status).toBe(401);
  });

  it('the bucket counts FAILED attempts: six successful sign-ins for one registered address are all 200 (a success releases its charge — architect ruling 2026-08-18)', async () => {
    const signedUp = await signUpFrom(SIX_IPS[0], SUCCESSES_EMAIL);
    expect(signedUp.status, signedUp.raw).toBe(200);

    const statuses: number[] = [];
    for (const ip of SIX_IPS) {
      statuses.push((await signInFrom(ip, SUCCESSES_EMAIL)).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);

    // And the releases floored at zero rather than banking credit: after those six
    // successes exactly FIVE failures are still admitted, and the sixth failure is refused.
    const failures: number[] = [];
    for (const ip of SIX_IPS) {
      failures.push((await signInFrom(ip, SUCCESSES_EMAIL, 'not-the-password-0')).status);
    }
    expect(failures).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('five failures lock the address for the window: the sixth attempt is 429 even with the RIGHT password (the DoS cost rate-limit.md accepts)', async () => {
    const signedUp = await signUpFrom(SIX_IPS[0], LOCKED_EMAIL);
    expect(signedUp.status, signedUp.raw).toBe(200);

    const failures: number[] = [];
    for (const ip of SIX_IPS.slice(0, LIMIT)) {
      failures.push((await signInFrom(ip, LOCKED_EMAIL, 'not-the-password-1')).status);
    }
    expect(failures).toEqual([401, 401, 401, 401, 401]);

    const correct = await signInFrom(SIX_IPS[5], LOCKED_EMAIL);
    expect(shape(correct)).toMatchObject({ status: 429, code: 'rate_limited', message: EMAIL_RATE_LIMITED_MESSAGE });
    // No session was issued for the refused attempt.
    expect(correct.headers['set-cookie'] ?? '').not.toContain('session_token=');
  });

  it('SC-5 / F-216: the child’s captured output names none of the addresses this file signed in as', () => {
    const output = server.output();

    expect(output.length).toBeGreaterThan(0);
    for (const address of ADDRESSES) {
      expect(output.toLowerCase()).not.toContain(address.toLowerCase());
    }
  });
});
