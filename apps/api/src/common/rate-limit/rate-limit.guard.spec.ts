import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
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
import { PUBLIC_IP_LIMIT, PUBLIC_IP_WINDOW_S, RATE_LIMIT_MAX_WRITES, RATE_LIMIT_WINDOW_S } from './rate-limit.types';

/**
 * STORY-1b-08 — AC-1b-37, AC-1b-38 and AC-1b-40's substance (an authenticated request never
 * charges the IP bucket), over a real HTTP round trip. TASK-1b-07, wave 1 of item 1b; the
 * tenant-keyed write bucket added by debt sweep D1 (2026-08-19) is tested here too, against
 * the same real graph — the unit tier carries the 120-limit assertions because the limit is
 * not env-tunable, and the integration tier re-runs `public-ip-bucket.int-spec.ts` unchanged.
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

  /** An authenticated GET: never charged (`rate-limit.md`, "Scope": authenticated GETs stay unlimited). */
  @Get('private')
  @NoTenantTransaction('rate-limit spec: the authenticated GET branch, and this tier has no database')
  privateGet(): { ok: true } {
    handlerRuns.push('private-get');
    return { ok: true };
  }

  /** ADR-0038: PATCH is mutating and charges the same tenant bucket as POST. */
  @Patch('private')
  @HttpCode(200)
  @NoTenantTransaction('rate-limit spec: PATCH charges the tenant bucket, and this tier has no database')
  privatePatch(): { ok: true } {
    handlerRuns.push('private-patch');
    return { ok: true };
  }

  /** ADR-0038: DELETE is mutating and charges the same tenant bucket as POST. */
  @Delete('private')
  @HttpCode(200)
  @NoTenantTransaction('rate-limit spec: DELETE charges the tenant bucket, and this tier has no database')
  privateDelete(): { ok: true } {
    handlerRuns.push('private-delete');
    return { ok: true };
  }
}

/**
 * An authenticated mutating route OUTSIDE the `/api` prefix. The unit tier sets no global
 * prefix, so this stands in for the routes `main.ts` registers outside it: the guard's path
 * test must leave them uncharged on the tenant branch exactly as on the public branch.
 */
@Controller('unprefixed-probe')
class UnprefixedProbeController {
  @Post('write')
  @HttpCode(200)
  @NoTenantTransaction('rate-limit spec: a mutating route outside /api, and this tier has no database')
  write(): { ok: true } {
    handlerRuns.push('unprefixed-write');
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

type ProbeMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function probe(
  method: ProbeMethod,
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
  method: ProbeMethod,
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
const UNPREFIXED = '/unprefixed-probe/write';
const HEALTH = '/health';

/** A bearer for `tenantId`, so each tenant-bucket test names its own tenant like the IP tests name their own address. */
async function mintBearer(tenantId: string): Promise<string> {
  return `Bearer ${await new SignJWT({ sub: USER_ID, tid: tenantId, email: 'operator@example.com', ev: true, jti: SESSION_ID })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(signingKey)}`;
}

/**
 * Pins `Date` (and only `Date`) to the start of the current tenant window, so a long burst
 * cannot straddle a fixed-window boundary and flake — the pattern the null-principal test
 * set. The caller owns the `finally { vi.useRealTimers(); }`.
 */
function freezeAtTenantWindowStart(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  const windowMs = RATE_LIMIT_WINDOW_S * 1000;
  vi.setSystemTime(Math.floor(Date.now() / windowMs) * windowMs);
}

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
    controllers: [RateLimitProbeController, UnprefixedProbeController],
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

describe('the authenticated branch and the IP bucket stay disjoint (AC-1b-40\'s substance)', () => {
  it('an authenticated route is untouched by an exhausted public bucket for the same address', async () => {
    await burst(PUBLIC_IP_LIMIT + 1, 'POST', PUBLIC, { [TRUSTED_HEADER]: '203.0.113.60' });

    const authenticated = await burst(3, 'POST', PRIVATE, { [TRUSTED_HEADER]: '203.0.113.60', authorization: bearer });

    expect(authenticated.map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it('authenticated requests charge no IP bucket: 30 of them leave the address a full public allowance', async () => {
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

describe('the tenant-keyed write bucket (debt sweep D1: 120 mutating requests per tenant per 60 s, process-local; the Redis rebinding stays TASK-051\'s)', () => {
  it('the 121st mutating request from one tenant in a window is 429 rate_limited with Retry-After and an ErrorEnvelope, and the handler never runs for it', async () => {
    freezeAtTenantWindowStart();
    try {
      const tenantBearer = await mintBearer('a1b2c3d4-0001-4a6b-8d0f-1e3a5c7b9d2f');
      const results = await burst(RATE_LIMIT_MAX_WRITES + 1, 'POST', PRIVATE, { authorization: tenantBearer });
      const refused = results[RATE_LIMIT_MAX_WRITES];

      expect({
        admitted: new Set(results.slice(0, RATE_LIMIT_MAX_WRITES).map((r) => r.status)),
        refusedStatus: refused.status,
        handlerRuns: handlerRuns.length,
      }).toEqual({ admitted: new Set([200]), refusedStatus: 429, handlerRuns: RATE_LIMIT_MAX_WRITES });

      const retryAfter = Number(refused.retryAfter);
      expect(
        Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= RATE_LIMIT_WINDOW_S,
        `Retry-After: ${String(refused.retryAfter)}`,
      ).toBe(true);
      expect(errorEnvelopeContract.safeParse(refused.body).success, refused.raw).toBe(true);
      expect(refused.body).toEqual({ code: 'rate_limited', message: expect.any(String) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC-84 over HTTP: a second tenant is unaffected by the first being exhausted', async () => {
    freezeAtTenantWindowStart();
    try {
      const exhausted = await mintBearer('a1b2c3d4-0002-4a6b-8d0f-1e3a5c7b9d2f');
      const other = await mintBearer('a1b2c3d4-0003-4a6b-8d0f-1e3a5c7b9d2f');
      await burst(RATE_LIMIT_MAX_WRITES + 1, 'POST', PRIVATE, { authorization: exhausted });

      const probe121 = await probe('POST', PRIVATE, { authorization: other });

      expect(probe121.status, probe121.raw).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ADR-0038: PATCH and DELETE charge the same bucket as POST — 118 POSTs, a PATCH and a DELETE exhaust the window and the 121st mutating request refuses', async () => {
    freezeAtTenantWindowStart();
    try {
      const tenantBearer = await mintBearer('a1b2c3d4-0004-4a6b-8d0f-1e3a5c7b9d2f');
      const posts = await burst(RATE_LIMIT_MAX_WRITES - 2, 'POST', PRIVATE, { authorization: tenantBearer });
      const patch = await probe('PATCH', PRIVATE, { authorization: tenantBearer });
      const del = await probe('DELETE', PRIVATE, { authorization: tenantBearer });
      const refused = await probe('POST', PRIVATE, { authorization: tenantBearer });

      expect({
        posts: new Set(posts.map((r) => r.status)),
        patch: patch.status,
        del: del.status,
        refused: refused.status,
      }).toEqual({ posts: new Set([200]), patch: 200, del: 200, refused: 429 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('GETs are never charged: more GETs than the whole write allowance leave the tenant\'s 120 writes intact', async () => {
    freezeAtTenantWindowStart();
    try {
      const tenantBearer = await mintBearer('a1b2c3d4-0005-4a6b-8d0f-1e3a5c7b9d2f');
      const reads = await burst(RATE_LIMIT_MAX_WRITES + 5, 'GET', PRIVATE, { authorization: tenantBearer });
      const writes = await burst(RATE_LIMIT_MAX_WRITES, 'POST', PRIVATE, { authorization: tenantBearer });
      const refused = await probe('POST', PRIVATE, { authorization: tenantBearer });

      expect({
        reads: new Set(reads.map((r) => r.status)),
        writes: new Set(writes.map((r) => r.status)),
        refused: refused.status,
      }).toEqual({ reads: new Set([200]), writes: new Set([200]), refused: 429 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('no double charge: a @Public() POST carrying a bearer charges the IP bucket only, and the tenant\'s write allowance stays whole', async () => {
    freezeAtTenantWindowStart();
    try {
      const tenantBearer = await mintBearer('a1b2c3d4-0006-4a6b-8d0f-1e3a5c7b9d2f');
      // `AuthGuard` returns at step 1 for a @Public() route without reading the token, so
      // these are anonymous to the limiter and the IP bucket is what refuses the 31st.
      const publics = await burst(PUBLIC_IP_LIMIT + 1, 'POST', PUBLIC, {
        [TRUSTED_HEADER]: '203.0.113.70',
        authorization: tenantBearer,
      });
      const writes = await burst(RATE_LIMIT_MAX_WRITES, 'POST', PRIVATE, {
        [TRUSTED_HEADER]: '203.0.113.70',
        authorization: tenantBearer,
      });
      const refused = await probe('POST', PRIVATE, { [TRUSTED_HEADER]: '203.0.113.70', authorization: tenantBearer });

      expect({
        publicStatuses: publics.map((r) => r.status),
        writes: new Set(writes.map((r) => r.status)),
        refused: refused.status,
      }).toEqual({
        publicStatuses: [...Array<number>(PUBLIC_IP_LIMIT).fill(200), 429],
        writes: new Set([200]),
        refused: 429,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a mutating route outside /api is never charged: the path test governs both branches', async () => {
    freezeAtTenantWindowStart();
    try {
      const tenantBearer = await mintBearer('a1b2c3d4-0007-4a6b-8d0f-1e3a5c7b9d2f');
      const outside = await burst(5, 'POST', UNPREFIXED, { authorization: tenantBearer });
      const writes = await burst(RATE_LIMIT_MAX_WRITES, 'POST', PRIVATE, { authorization: tenantBearer });

      expect({
        outside: new Set(outside.map((r) => r.status)),
        writes: new Set(writes.map((r) => r.status)),
      }).toEqual({ outside: new Set([200]), writes: new Set([200]) });
    } finally {
      vi.useRealTimers();
    }
  });
});
