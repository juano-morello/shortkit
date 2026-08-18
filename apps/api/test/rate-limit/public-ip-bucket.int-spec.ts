import type { Server } from 'node:http';

import { Controller, HttpCode, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { errorEnvelopeContract } from '@shortkit/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { PUBLIC_IP_LIMIT, PUBLIC_IP_WINDOW_S } from '../../src/common/rate-limit/rate-limit.types';
import { closeDatabase } from '../../src/db/client';
import { Public, withTenantTransaction } from '../../src/tenancy/tenant-context';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import { authServerEnv } from '../support/auth-fixture';

/**
 * STORY-1b-08 — AC-1b-37 and AC-1b-38 against a live database and a real boot. TASK-1b-07,
 * wave 1 of item 1b.
 *
 * Contract: `docs/contracts/rate-limit.md` ("Scope", "Response on limit", "What the
 * implementer must guarantee": a refused request opens no transaction; `GET /health` is
 * unlimited), `docs/contracts/trusted-client-address.md`. ADR-0012, ADR-0040.
 *
 * ============================================================================
 * TWO PROCESSES, AS `request-tenant-binding.int-spec.ts`: THE PROBE HERE, `/health` THERE.
 * ============================================================================
 *
 * No `@Public()` business route exists yet — the invitation lookup is wave 3 — so the route
 * under the bucket is a probe registered BESIDE `AppModule` in this process, with the real
 * `APP_GUARD`s, the real filter and the real port binding, nothing overridden. What the probe
 * DOES is what F-018 is about: it opens a tenant transaction from inside the handler, exactly
 * as the lookup will from a token's routing prefix, and it counts. A refused request must
 * leave that count where it was.
 *
 * `GET /health` is asserted against the CHILD process `api-server.ts` boots, because the
 * exemption is by path — outside the `/api` prefix `main.ts` sets — and only the child has
 * that prefix; an application compiled from `AppModule` in-process has no global prefix and
 * would prove the exemption for the wrong reason. The child is booted with the trusted header
 * declared, the way `auth-mount.int-spec.ts` boots its server.
 *
 * `rate-limit.guard.spec.ts` carries the finer AC coverage (GET on a public route, one bucket
 * per address across routes, the authenticated branch, the once-per-minute warn) over the
 * same shape without a database; this suite is the half that needs one.
 */

const TRUSTED_HEADER = 'x-test-client-ip';

/** A tenant id for the probe's transaction. `SET LOCAL` needs no row behind it; `select 1` touches no table. */
const PROBE_TENANT_ID = '9b1d3f5a-2c4e-4a6b-8d0f-1e3a5c7b9d2f';

/** Every request that reached the probe handler, in order. */
const handlerRuns: string[] = [];

/** How many tenant transactions the probe opened. AC-1b-37: unchanged by a refused request. */
let transactionsOpened = 0;

@Controller('api/rate-limit-probe')
class PublicBucketProbeController {
  /** The invitation lookup's shape: `@Public()`, `POST`, a tenant transaction opened from the handler. */
  @Post('lookup')
  @HttpCode(200)
  @Public('rate-limit suite: the route F-018 protects, opening a tenant transaction from the handler')
  async lookup(): Promise<{ ok: true }> {
    handlerRuns.push('lookup');

    await withTenantTransaction(PROBE_TENANT_ID, async (db) => {
      transactionsOpened += 1;
      await db.execute(sql`select 1`);
    });

    return { ok: true };
  }
}

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

let app: INestApplication | undefined;
let probeBaseUrl: string;

interface Probe {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body: unknown;
  readonly raw: string;
}

async function request(url: string, method: 'GET' | 'POST', headers: Record<string, string> = {}): Promise<Probe> {
  const response = await fetch(url, { method, headers });
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, retryAfter: response.headers.get('retry-after'), body, raw };
}

async function burst(n: number, url: string, method: 'GET' | 'POST', headers: Record<string, string> = {}): Promise<Probe[]> {
  const results: Probe[] = [];
  for (let i = 0; i < n; i += 1) {
    results.push(await request(url, method, headers));
  }
  return results;
}

function lookupUrl(): string {
  return `${probeBaseUrl}/api/rate-limit-probe/lookup`;
}

/** The child's environment: the fixture's, plus the declared trust boundary, as `auth-mount.int-spec.ts` does. */
function childEnv(baseUrl: string): Record<string, string> {
  return { ...authServerEnv(baseUrl), CLIENT_TRUST_BOUNDARY: 'proxy', TRUSTED_CLIENT_IP_HEADER: TRUSTED_HEADER };
}

beforeAll(() => {
  serverBoot = startApiServer({ env: childEnv });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;

  if (app === undefined) {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [PublicBucketProbeController],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    probeBaseUrl = await app.getUrl();
    // See `request-tenant-binding.int-spec.ts`: the idle keep-alive timer would otherwise
    // close a pooled socket under a probe.
    (app.getHttpServer() as Server).keepAliveTimeout = 0;
  }

  handlerRuns.length = 0;
  transactionsOpened = 0;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeDatabase();
  vi.unstubAllEnvs();
  await server?.stop();
});

describe('with a trusted client header declared (AC-1b-37)', () => {
  beforeEach(() => {
    vi.stubEnv('CLIENT_TRUST_BOUNDARY', 'proxy');
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', TRUSTED_HEADER);
  });

  it('the 31st POST from one address is 429 rate_limited with Retry-After and an ErrorEnvelope, and it opened no transaction; a second address is unaffected', async () => {
    const results = await burst(PUBLIC_IP_LIMIT + 1, lookupUrl(), 'POST', { [TRUSTED_HEADER]: '203.0.113.7' });
    const refused = results[PUBLIC_IP_LIMIT];
    // Read before the second address runs the handler once more.
    const runsAfterRefusal = handlerRuns.length;
    const transactionsAfterRefusal = transactionsOpened;
    const other = await request(lookupUrl(), 'POST', { [TRUSTED_HEADER]: '203.0.113.8' });

    const retryAfter = Number(refused.retryAfter);

    expect({
      admitted: new Set(results.slice(0, PUBLIC_IP_LIMIT).map((r) => r.status)),
      refusedStatus: refused.status,
      retryAfterInWindow: Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= PUBLIC_IP_WINDOW_S,
      envelope: errorEnvelopeContract.safeParse(refused.body).success,
      code: (refused.body as { code?: unknown }).code,
      handlerRuns: runsAfterRefusal,
      transactionsOpened: transactionsAfterRefusal,
      otherAddress: other.status,
    }).toEqual({
      admitted: new Set([200]),
      refusedStatus: 429,
      retryAfterInWindow: true,
      envelope: true,
      code: 'rate_limited',
      handlerRuns: PUBLIC_IP_LIMIT,
      transactionsOpened: PUBLIC_IP_LIMIT,
      otherAddress: 200,
    });
  });

  it('the prefix test follows Express routing: /API/rate-limit-probe/lookup is charged to the same bucket and refuses on the 31st', async () => {
    const results = await burst(PUBLIC_IP_LIMIT + 1, lookupUrl().replace('/api/', '/API/'), 'POST', { [TRUSTED_HEADER]: '203.0.113.10' });

    expect({
      statuses: [...new Set(results.slice(0, PUBLIC_IP_LIMIT).map((r) => r.status)), results[PUBLIC_IP_LIMIT].status],
      handlerRuns: handlerRuns.length,
    }).toEqual({ statuses: [200, 429], handlerRuns: PUBLIC_IP_LIMIT });
  });

  it('GET /health on the booted process is never limited: 31 probes from one address are all 200, because the route is outside /api', async () => {
    const probes = await burst(PUBLIC_IP_LIMIT + 1, `${server.baseUrl}/health`, 'GET', { [TRUSTED_HEADER]: '203.0.113.9' });

    expect(new Set(probes.map((r) => r.status)), server.output()).toEqual(new Set([200]));
  });
});

describe('the pre-auth mount under a case-varied path (adjacent to F-018, measured not assumed)', () => {
  it('/API/auth/... reaches the Express IP buckets: the mount and the middlewares share one case-insensitive matcher, so a case-varied auth path is still limited', async () => {
    // `server.all('/api/auth/{*splat}', authBodyCap, authRateLimit, toNodeHandler(auth))` in
    // main.ts. Express matches the mount case-insensitively, exactly as it matches the guard's
    // routes, so `/API/auth/sign-in/email` is charged before Better Auth sees it. What Better
    // Auth answers for the case-varied path is recorded alongside, and the index of the first
    // 429 says which bucket charged it: `bucketFor` compares the path exactly, so a
    // case-varied sign-in path is charged as "other" (60/min) rather than sign-in (10/5 min).
    const results = await burst(61, `${server.baseUrl}/API/auth/sign-in/email`, 'POST', {
      [TRUSTED_HEADER]: '203.0.113.11',
      'content-type': 'application/json',
    });
    const firstRefused = results.findIndex((r) => r.status === 429);

    expect({ firstStatus: results[0].status, firstRefused }, server.output()).toEqual({ firstStatus: 404, firstRefused: 60 });
  });
});

describe('with no trusted client header declared (AC-1b-38, ADR-0040)', () => {
  beforeEach(() => {
    vi.stubEnv('CLIENT_TRUST_BOUNDARY', undefined);
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', undefined);
  });

  it('31 POSTs from one address are all admitted: the bucket does not run and every handler ran', async () => {
    const results = await burst(PUBLIC_IP_LIMIT + 1, lookupUrl(), 'POST', { [TRUSTED_HEADER]: '203.0.113.17' });

    expect({
      statuses: new Set(results.map((r) => r.status)),
      handlerRuns: handlerRuns.length,
      transactionsOpened,
    }).toEqual({ statuses: new Set([200]), handlerRuns: PUBLIC_IP_LIMIT + 1, transactionsOpened: PUBLIC_IP_LIMIT + 1 });
  });
});
