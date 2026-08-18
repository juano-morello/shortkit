import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { errorEnvelopeContract } from '@shortkit/contracts';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JSONWebKeySet } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../app.module';
import { JWKS_KEY_SET_SOURCE } from '../../auth/auth.guard';
import { logger } from '../../observability/logger';
import { NoTenantTransaction, Public } from '../../tenancy/tenant-context';
import { TRUSTED_CLIENT_IP_HEADER_ENV, TRUSTED_CLIENT_IP_UNRESOLVED_COUNTER } from '../net/trusted-client-address';
import { PUBLIC_IP_LIMIT, PUBLIC_IP_WINDOW_S } from './rate-limit.types';

/**
 * STORY-1b-08 — AC-1b-37, AC-1b-38 and AC-1b-40's "the authenticated branch charges no
 * bucket", over a real HTTP round trip. TASK-1b-07, wave 1 of item 1b.
 *
 * Contract: `docs/contracts/rate-limit.md` ("Scope": `@Public()` routes under `/api`, client
 * IP, all methods including `GET`, 30 per 60 s; "Response on limit"; "What the implementer
 * must guarantee"), `docs/contracts/trusted-client-address.md` ("What a `null` principal
 * means to each bucket", "Signal"), `docs/contracts/error-envelope.md` (the 429 body).
 * ADR-0012, ADR-0040.
 *
 * ============================================================================
 * THE REAL GUARD, THE REAL FILTER, THE REAL MODULE GRAPH — AND PROBE ROUTES BESIDE IT.
 * ============================================================================
 *
 * The application is compiled from `AppModule` the way `auth.guard.spec.ts` does it, so the
 * guard under test is the `APP_GUARD` `RateLimitModule` registers, running AFTER the
 * `AuthGuard` `AuthModule` registers, and the 429 body is what `ApiExceptionFilter` writes
 * from the `DomainError` the guard throws. No `@Public()` business route exists in the graph
 * yet (the invitation lookup is wave 3), so the probe controller below is registered BESIDE
 * the module, as a fixture: the global guard answers for it as it will for every later one.
 * That is also why THIS SUITE CARRIES THE AC COVERAGE: the child process the integration
 * tier boots has no `@Public()` route under `/api` to hit until wave 3, and
 * `test/rate-limit/public-ip-bucket.int-spec.ts` repeats the same shape in-process against
 * a live database only to show a refusal opens no transaction.
 *
 * One provider is overridden and nothing else: the key-set source, so a token for the
 * authenticated probe can be signed here with a pair the process never fetches. The port is
 * NOT overridden — the bucket under test is the `LocalRateLimiter` the module binds.
 *
 * Every test names its own documentation-range address, so the fixed windows do not
 * interfere between tests and no test depends on where in a window the clock sits.
 */

const ISSUER = 'http://127.0.0.1:43113';
const TENANT_ID = '3f2a9c1e-7b4d-4e8a-9c6f-1d2e3f4a5b6c';
const USER_ID = 'user_7d3e2f1a0b9c8d7e';
const SESSION_ID = 'sess_1c9f0b7e2d4a6c8b';

/** The name the integration tier declares too (`rate-limit.md`, "What the implementer must guarantee"). */
const TRUSTED_HEADER = 'x-test-client-ip';

/** Every request that reached a probe handler, in order. */
const handlerRuns: string[] = [];

@Controller('api/rate-limit-probe')
class RateLimitProbeController {
  /** The shape of the invitation lookup: a `@Public()` POST that would open a tenant transaction. */
  @Post('public')
  @HttpCode(200)
  @Public('rate-limit spec: the anonymous branch, POST')
  publicPost(): { ok: true } {
    handlerRuns.push('public-post');
    return { ok: true };
  }

  /** `GET` on a `@Public()` route is limited too (`rate-limit.md`, "Scope"). */
  @Get('public')
  @Public('rate-limit spec: the anonymous branch, GET')
  publicGet(): { ok: true } {
    handlerRuns.push('public-get');
    return { ok: true };
  }

  /**
   * An authenticated route. `@NoTenantTransaction` because this tier has no database and the
   * interceptor would otherwise open a real tenant transaction around the handler; the two
   * guards still run in full for it — that is exactly what the marker means.
   */
  @Post('private')
  @HttpCode(200)
  @NoTenantTransaction('rate-limit spec: the authenticated branch is under test, and this tier has no database')
  privatePost(): { ok: true } {
    handlerRuns.push('private-post');
    return { ok: true };
  }
}

let signingKey: CryptoKey;
let keySet: JSONWebKeySet;
let bearer: string;

let app: INestApplication;
let baseUrl: string;

interface Probe {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body: unknown;
  readonly raw: string;
}

async function probe(
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string> = {},
): Promise<Probe> {
  const response = await fetch(`${baseUrl}${path}`, { method, headers });
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, retryAfter: response.headers.get('retry-after'), body, raw };
}

/** `n` requests in a row, and their statuses. */
async function burst(
  n: number,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string> = {},
): Promise<Probe[]> {
  const results: Probe[] = [];
  for (let i = 0; i < n; i += 1) {
    results.push(await probe(method, path, headers));
  }
  return results;
}

const PUBLIC = '/api/rate-limit-probe/public';
const PRIVATE = '/api/rate-limit-probe/private';
const HEALTH = '/health';

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  signingKey = pair.privateKey;
  keySet = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'test-key' }] };
  bearer = `Bearer ${await new SignJWT({ sub: USER_ID, tid: TENANT_ID, email: 'operator@example.com', ev: true, jti: SESSION_ID })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(signingKey)}`;

  vi.stubEnv('BETTER_AUTH_URL', ISSUER);
  // `/health` reads the build SHA per request and 500s without one; the assertion below is
  // about the limiter leaving the probe alone, not about the SHA.
  vi.stubEnv('GIT_COMMIT_SHA', '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [RateLimitProbeController],
  })
    .overrideProvider(JWKS_KEY_SET_SOURCE)
    .useValue(() => Promise.resolve(keySet))
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

beforeEach(() => {
  // The environment `auth-mount.int-spec.ts` declares for the integration tier: a trusted
  // header, so the IP bucket binds at all (ADR-0040). Read per request, so a test may unset it.
  vi.stubEnv('CLIENT_TRUST_BOUNDARY', 'proxy');
  vi.stubEnv(TRUSTED_CLIENT_IP_HEADER_ENV, TRUSTED_HEADER);
  handlerRuns.length = 0;
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

describe('the @Public() per-IP bucket over HTTP (AC-1b-37)', () => {
  it('the 31st POST from one address in a window is 429 rate_limited with Retry-After and an ErrorEnvelope, and the handler never runs for it', async () => {
    const results = await burst(PUBLIC_IP_LIMIT + 1, 'POST', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.7' });
    const refused = results[PUBLIC_IP_LIMIT];

    expect({
      admitted: results.slice(0, PUBLIC_IP_LIMIT).map((r) => r.status),
      refusedStatus: refused.status,
      handlerRuns: handlerRuns.length,
    }).toEqual({ admitted: Array<number>(PUBLIC_IP_LIMIT).fill(200), refusedStatus: 429, handlerRuns: PUBLIC_IP_LIMIT });

    // Retry-After is delta-seconds, at least 1 and never past the window (`rate-limit.md`,
    // "Response on limit"); the body is the envelope the filter writes for the code.
    const retryAfter = Number(refused.retryAfter);
    expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= PUBLIC_IP_WINDOW_S, `Retry-After: ${String(refused.retryAfter)}`).toBe(true);
    expect(errorEnvelopeContract.safeParse(refused.body).success, refused.raw).toBe(true);
    expect(refused.body).toEqual({ code: 'rate_limited', message: expect.any(String) });
  });

  it('a second address is unaffected by the first being exhausted', async () => {
    await burst(PUBLIC_IP_LIMIT + 1, 'POST', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.20' });

    const other = await probe('POST', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.21' });

    expect(other.status, other.raw).toBe(200);
  });

  it('GET on a @Public() route is limited too — every method, because a public GET opens a tenant transaction as a POST does', async () => {
    const results = await burst(PUBLIC_IP_LIMIT + 1, 'GET', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.30' });

    expect(results.map((r) => r.status)).toEqual([...Array<number>(PUBLIC_IP_LIMIT).fill(200), 429]);
  });

  it('GET and POST on public routes share one bucket per address: the key is the address, not the route', async () => {
    const posts = await burst(PUBLIC_IP_LIMIT, 'POST', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.31' });
    const get = await probe('GET', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.31' });

    expect({ posts: new Set(posts.map((r) => r.status)), get: get.status }).toEqual({ posts: new Set([200]), get: 429 });
  });

  it('the prefix test is case-insensitive, as Express routing is: /API/... and /Api/... are charged like /api/... and the 31st refuses', async () => {
    // Express 5 routes `/API/x` to the handler at `/api/x` and leaves `req.path` as sent.
    // A case-sensitive prefix test would let a caller escape the bucket by varying case.
    const upper = await burst(PUBLIC_IP_LIMIT, 'POST', PUBLIC.toUpperCase(), { [TRUSTED_HEADER]: '203.0.113.32' });
    const mixed = await probe('POST', PUBLIC.replace('/api/', '/Api/'), { [TRUSTED_HEADER]: '203.0.113.32' });

    expect({ upper: new Set(upper.map((r) => r.status)), mixed: mixed.status, handlerRuns: handlerRuns.length }).toEqual({
      upper: new Set([200]),
      mixed: 429,
      handlerRuns: PUBLIC_IP_LIMIT,
    });
  });

  it('GET /health is never limited, even under a declared principal that is exhausted elsewhere: it is outside /api', async () => {
    await burst(PUBLIC_IP_LIMIT + 1, 'POST', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.40' });

    const probes = await burst(PUBLIC_IP_LIMIT + 1, 'GET', HEALTH, { [TRUSTED_HEADER]: '203.0.113.40' });

    expect(new Set(probes.map((r) => r.status))).toEqual(new Set([200]));
  });
});

describe('a null principal (AC-1b-38, ADR-0040)', () => {
  it('with no header declared, 31 requests from one address are never 429 and nothing is warned: the bucket does not run', async () => {
    vi.stubEnv(TRUSTED_CLIENT_IP_HEADER_ENV, undefined);
    vi.stubEnv('CLIENT_TRUST_BOUNDARY', undefined);

    const results = await burst(PUBLIC_IP_LIMIT + 1, 'POST', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.50' });

    expect({
      statuses: new Set(results.map((r) => r.status)),
      handlerRuns: handlerRuns.length,
      warned: vi.mocked(logger.warn).mock.calls.length,
    }).toEqual({ statuses: new Set([200]), handlerRuns: PUBLIC_IP_LIMIT + 1, warned: 0 });
  });

  it('with a header declared and a request that carries none, the request proceeds and the unresolved counter is warned once per minute, naming neither header nor value', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 120_000);
      const first = await burst(3, 'POST', PUBLIC);
      vi.setSystemTime(Date.now() + 60_001);
      const later = await probe('POST', PUBLIC);

      const lines = vi.mocked(logger.warn).mock.calls.map((call) => JSON.stringify(call));

      expect({
        statuses: new Set([...first, later].map((r) => r.status)),
        warned: lines.length,
        namesTheCounter: lines.every((line) => line.includes(TRUSTED_CLIENT_IP_UNRESOLVED_COUNTER)),
        leaksTheHeaderName: lines.some((line) => line.includes(TRUSTED_HEADER)),
      }).toEqual({ statuses: new Set([200]), warned: 2, namesTheCounter: true, leaksTheHeaderName: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the authenticated branch (AC-1b-40: a documented no-op, TASK-051 owns the tenant bucket)', () => {
  it('an authenticated route is untouched by an exhausted public bucket for the same address', async () => {
    await burst(PUBLIC_IP_LIMIT + 1, 'POST', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.60' });

    const authenticated = await burst(3, 'POST', PRIVATE, { [TRUSTED_HEADER]: '203.0.113.60', authorization: bearer });

    expect(authenticated.map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it('authenticated requests charge nothing: 30 of them leave the address a full public allowance', async () => {
    const authenticated = await burst(PUBLIC_IP_LIMIT, 'POST', PRIVATE, { [TRUSTED_HEADER]: '203.0.113.61', authorization: bearer });
    const publicAfter = await burst(PUBLIC_IP_LIMIT, 'POST', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.61' });

    expect({
      authenticated: new Set(authenticated.map((r) => r.status)),
      publicAfter: new Set(publicAfter.map((r) => r.status)),
    }).toEqual({ authenticated: new Set([200]), publicAfter: new Set([200]) });
  });

  it('an unauthenticated request to a guarded route is 401 from AuthGuard, which runs first; the limiter is not what answers', async () => {
    const result = await probe('POST', PRIVATE, { [TRUSTED_HEADER]: '203.0.113.62' });

    expect({ status: result.status, code: (result.body as { code?: unknown }).code }).toEqual({ status: 401, code: 'unauthenticated' });
  });
});
