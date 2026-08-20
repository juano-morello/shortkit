import { Controller, Get, Req, SetMetadata } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JSONWebKeySet, JWTPayload } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app.module';
import { logger } from '../observability/logger';
import { NoTenantTransaction, PUBLIC_ROUTE_METADATA } from '../tenancy/tenant-context';
import type { RequestContext } from '../tenancy/tenant-context';
import { JWKS_KEY_SET_SOURCE, REQUEST_CONTEXT_KEY, REVOCATION_STORE } from './auth.guard';
import { InMemoryRevocationStore, RevocationStoreUnavailableError } from './revocation-store';
import type { RevocationStore } from './revocation-store';

/**
 * STORY-002 — AC-10, AC-11, AC-12, AC-13, over a real HTTP round trip. TASK-005, wave 4.
 *
 * Contract: `docs/contracts/auth-tokens.md` ("Verification, performed by `AuthGuard`",
 * "Invariants a caller may rely on" 3 and 4), `docs/contracts/error-envelope.md` (the 401
 * body), `docs/contracts/revocation-store.md` ("What the caller may assume": skip-open on a
 * rejecting `isRevoked`). ADR-0013, ADR-0012, ADR-0053, ADR-0024.
 *
 * ============================================================================
 * THE REAL GUARD, THE REAL FILTER, THE REAL MODULE GRAPH — AND A PROBE ROUTE BESIDE IT.
 * ============================================================================
 *
 * The application is compiled from `AppModule`, the way `health.spec.ts` and
 * `exception-filter.spec.ts` do it, so the guard under test is the `APP_GUARD` `AuthModule`
 * registers and the 401 body is what `ApiExceptionFilter` writes. There is no business route
 * in the graph yet (TASK-006 and item 1b bring the first), so the probe controller below is
 * registered BESIDE the module, exactly as `exception-filter.spec.ts` registers its own: it is
 * a fixture, not a route, and the global guard answers for it as it will for every later one.
 *
 * Two providers are overridden and nothing else: the key-set source, so tokens can be signed
 * here with a pair the process never fetches; and the revocation store, so a rejecting port
 * can be handed to the guard — the shipped `InMemoryRevocationStore` cannot reject and the
 * skip-open branch is otherwise unreachable (`revocation-store.md`, "The read site must").
 *
 * The end-to-end half — a token minted by a real sign-in against a real `/api/auth/jwks` —
 * is `test/auth/auth-guard.int-spec.ts`.
 */

const ISSUER = 'http://127.0.0.1:43112';
const TENANT_ID = '3f2a9c1e-7b4d-4e8a-9c6f-1d2e3f4a5b6c';
const USER_ID = 'user_7d3e2f1a0b9c8d7e';
const SESSION_ID = 'sess_1c9f0b7e2d4a6c8b';

/** Every request that reached a handler, in order — AC-10's "the handler is never entered". */
const handlerRuns: string[] = [];

@Controller('api/guard-probe')
class GuardProbeController {
  /**
   * `@NoTenantTransaction` since TASK-006 (wave 5): the guard is what is under test here, and
   * this tier has no database. Without the marker the global `TenantTransactionInterceptor`
   * would open a real tenant transaction around this handler and 500 on the missing pool.
   * The guard still runs in full for this route — that is exactly what the marker means.
   */
  @Get('private')
  @NoTenantTransaction('guard spec: the guard alone is under test, and this tier has no database')
  privateRoute(@Req() request: Record<PropertyKey, unknown>): RequestContext | null {
    handlerRuns.push('private');
    return (request[REQUEST_CONTEXT_KEY] as RequestContext | undefined) ?? null;
  }

  /**
   * What `@Public('…')` will write once TASK-006 implements it: the guard reads the key, not
   * the decorator, so the metadata is set directly here.
   */
  @Get('public')
  @SetMetadata(PUBLIC_ROUTE_METADATA, 'guard spec: the anonymous branch')
  publicRoute(@Req() request: Record<PropertyKey, unknown>): { context: RequestContext | null } {
    handlerRuns.push('public');
    return { context: (request[REQUEST_CONTEXT_KEY] as RequestContext | undefined) ?? null };
  }
}

@Controller('api/guard-probe-class-public')
@SetMetadata(PUBLIC_ROUTE_METADATA, 'guard spec: the class-level branch')
class ClassPublicProbeController {
  @Get()
  read(): { ok: true } {
    handlerRuns.push('class-public');
    return { ok: true };
  }
}

let signingKey: CryptoKey;
let strangerKey: CryptoKey;
let keySet: JSONWebKeySet;
let keySetSource: () => Promise<JSONWebKeySet>;

/** The revocation store the guard reads; swapped per test through this indirection. */
let store: RevocationStore;

let app: INestApplication;
let baseUrl: string;

function claims(overrides: JWTPayload = {}): JWTPayload {
  return { sub: USER_ID, tid: TENANT_ID, email: 'operator@example.com', ev: true, jti: SESSION_ID, ...overrides };
}

async function sign(payload: JWTPayload, options: { key?: CryptoKey; expiresIn?: number } = {}): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime(Math.floor(Date.now() / 1000) + (options.expiresIn ?? 300))
    .sign(options.key ?? signingKey);
}

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

async function probe(path: string, headers: Record<string, string> = {}): Promise<Probe> {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, body, raw };
}

const PRIVATE = '/api/guard-probe/private';

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  signingKey = pair.privateKey;
  keySet = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'test-key' }] };
  strangerKey = (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey;
  keySetSource = () => Promise.resolve(keySet);

  vi.stubEnv('BETTER_AUTH_URL', ISSUER);
  // `/health` reads the build SHA per request (`build-commit.ts`) and 500s without one; the
  // assertion below is about the guard letting the probe through, not about the SHA.
  vi.stubEnv('GIT_COMMIT_SHA', '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [GuardProbeController, ClassPublicProbeController],
  })
    .overrideProvider(JWKS_KEY_SET_SOURCE)
    .useValue(() => keySetSource())
    .overrideProvider(REVOCATION_STORE)
    .useValue({
      revoke: (id: string) => store.revoke(id),
      isRevoked: (id: string) => store.isRevoked(id),
    } satisfies RevocationStore)
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

beforeEach(() => {
  store = new InMemoryRevocationStore();
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

describe('AuthGuard over HTTP', () => {
  it('a valid token reaches the handler with a RequestContext built from the claims alone', async () => {
    const token = await sign(claims());

    const result = await probe(PRIVATE, { authorization: `Bearer ${token}` });

    expect(result.status, result.raw).toBe(200);
    // `email` since TASK-1b-05 (D-06): the claim, verbatim, for the mail template.
    expect(result.body).toEqual({ userId: USER_ID, tenantId: TENANT_ID, email: 'operator@example.com', emailVerified: true });
    expect(handlerRuns).toEqual(['private']);
  });

  it('AC-10: no Authorization header is 401 unauthenticated and the handler never runs', async () => {
    const result = await probe(PRIVATE);

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'unauthenticated', message: expect.any(String) });
    expect(handlerRuns).toEqual([]);
  });

  it('AC-10: a non-bearer or empty Authorization header is 401 unauthenticated', async () => {
    for (const authorization of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Token abc', '']) {
      const result = await probe(PRIVATE, { authorization });
      expect({ authorization, status: result.status, code: (result.body as { code?: unknown }).code }).toEqual({
        authorization,
        status: 401,
        code: 'unauthenticated',
      });
    }
    expect(handlerRuns).toEqual([]);
  });

  it('AC-11: a token signed by a key the JWKS does not carry is 401 unauthenticated', async () => {
    const result = await probe(PRIVATE, { authorization: `Bearer ${await sign(claims(), { key: strangerKey })}` });

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'unauthenticated', message: expect.any(String) });
    expect(handlerRuns).toEqual([]);
  });

  it('AC-11: a tampered token is 401 unauthenticated', async () => {
    const [header, , signature] = (await sign(claims())).split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims({ ev: true }), iss: ISSUER, aud: ISSUER, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');

    const result = await probe(PRIVATE, { authorization: `Bearer ${header}.${forged}.${signature}` });

    expect(result.status, result.raw).toBe(401);
    expect((result.body as { code?: unknown }).code).toBe('unauthenticated');
    expect(handlerRuns).toEqual([]);
  });

  it('AC-12: an expired token is 401 token_expired', async () => {
    const result = await probe(PRIVATE, { authorization: `Bearer ${await sign(claims(), { expiresIn: -10 })}` });

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'token_expired', message: expect.any(String) });
    expect(handlerRuns).toEqual([]);
  });

  it('AC-13: an absent, empty or non-uuid tid is 401 unauthenticated, not 500', async () => {
    for (const tid of [undefined, '', 'tenant-1', '3f2a9c1e-7b4d-4e8a-9c6f']) {
      const result = await probe(PRIVATE, { authorization: `Bearer ${await sign(claims({ tid }))}` });
      expect({ tid, status: result.status, body: result.body }).toEqual({
        tid,
        status: 401,
        body: { code: 'unauthenticated', message: expect.any(String) },
      });
    }
    expect(handlerRuns).toEqual([]);
  });

  it('AC-13: an upper-cased tid reaches the handler in canonical lower case', async () => {
    const result = await probe(PRIVATE, { authorization: `Bearer ${await sign(claims({ tid: TENANT_ID.toUpperCase() }))}` });

    expect(result.status, result.raw).toBe(200);
    expect((result.body as RequestContext).tenantId).toBe(TENANT_ID);
  });

  it('a revoked jti is 401 unauthenticated', async () => {
    await store.revoke(SESSION_ID);

    const result = await probe(PRIVATE, { authorization: `Bearer ${await sign(claims())}` });

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'unauthenticated', message: expect.any(String) });
    expect(handlerRuns).toEqual([]);
  });

  it('a revocation store that cannot answer skips open and logs the degradation (ADR-0012)', async () => {
    store = {
      revoke: () => Promise.resolve(),
      isRevoked: () => Promise.reject(new RevocationStoreUnavailableError('store is down')),
    };

    const result = await probe(PRIVATE, { authorization: `Bearer ${await sign(claims())}` });

    expect(result.status, result.raw).toBe(200);
    expect(handlerRuns).toEqual(['private']);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'auth_revocation_degraded' }), expect.any(String));
  });

  it('a public handler runs with no header, and no RequestContext is populated', async () => {
    const result = await probe('/api/guard-probe/public');

    expect(result.status, result.raw).toBe(200);
    expect(result.body).toEqual({ context: null });
    expect(handlerRuns).toEqual(['public']);
  });

  it('a public handler ignores a bad token rather than refusing it', async () => {
    const result = await probe('/api/guard-probe/public', { authorization: 'Bearer not-a-token' });

    expect(result.status, result.raw).toBe(200);
  });

  it('class-level public metadata exempts every handler on the controller', async () => {
    const result = await probe('/api/guard-probe-class-public');

    expect(result.status, result.raw).toBe(200);
    expect(handlerRuns).toEqual(['class-public']);
  });

  it('GET /health stays reachable with no header', async () => {
    const result = await probe('/health');

    expect(result.status, result.raw).toBe(200);
    expect((result.body as { status?: unknown }).status).toBe('ok');
  });

  it('a JWKS source that cannot answer and has nothing cached is a 500, not a 401', async () => {
    // "Could not verify" is not "verified as bad" (F-245's rule). A 401 here would send the
    // BFF to re-login, whose fresh token fails the same way, and the loop has no exit.
    keySetSource = () => Promise.reject(new Error('ECONNREFUSED'));
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    try {
      const result = await probe(PRIVATE, { authorization: `Bearer ${await sign(claims())}` });

      expect(result.status, result.raw).toBe(500);
      expect((result.body as { code?: unknown }).code).toBe('internal_error');
      expect(handlerRuns).toEqual([]);
    } finally {
      keySetSource = () => Promise.resolve(keySet);
    }
  });

  it('never writes the token, the header or a claim into a log line', async () => {
    const warn = vi.mocked(logger.warn);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    store = {
      revoke: () => Promise.resolve(),
      isRevoked: () => Promise.reject(new RevocationStoreUnavailableError('store is down')),
    };

    const token = await sign(claims({ email: 'leak-probe@example.com' }));
    await probe(PRIVATE, { authorization: `Bearer ${token}` });
    await probe(PRIVATE, { authorization: `Bearer ${await sign(claims({ tid: 'LEAKED-TID' }))}` });
    await probe(PRIVATE, { authorization: `Bearer ${await sign(claims(), { expiresIn: -10 })}` });

    const lines = [...warn.mock.calls, ...error.mock.calls, ...info.mock.calls].map((call) => JSON.stringify(call));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain('leak-probe');
      expect(line).not.toContain('LEAKED-TID');
      expect(line).not.toContain(USER_ID);
      expect(line).not.toContain(SESSION_ID);
    }
  });
});
