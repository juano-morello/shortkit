import { Controller, Get, Injectable, Req, UseGuards } from '@nestjs/common';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JSONWebKeySet, JWTPayload } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app.module';
import { JWKS_KEY_SET_SOURCE, REQUEST_CONTEXT_KEY, REVOCATION_STORE } from '../auth/auth.guard';
import { InMemoryRevocationStore } from '../auth/revocation-store';
import { DomainError } from '../common/errors/domain-error';
import type * as DbClient from '../db/client';
import { logger } from '../observability/logger';
import {
  NoTenantTransaction,
  Public,
  TenantContextMissingError,
  currentTenantId,
  tenantDb,
  withTenantTransaction,
} from './tenant-context';
import type { RequestContext } from './tenant-context';

/**
 * STORY-002 — AC-14 (in process, transaction faked at the driver) and AC-15, over a real
 * HTTP round trip. TASK-006, wave 5.
 *
 * Contract: `docs/contracts/tenant-context.md` ("What the implementer must guarantee":
 * `APP_INTERCEPTOR`, after `AuthGuard`, skips `@Public()` and `@NoTenantTransaction()`;
 * "Routes that open their own transaction"), `docs/contracts/error-envelope.md` (the 401
 * body). ADR-0002, ADR-0024.
 *
 * ============================================================================
 * THE REAL GUARD, THE REAL INTERCEPTOR, THE REAL FILTER, THE REAL MODULE GRAPH — AND A FAKE
 * TRANSACTION UNDER `withTenantTransaction`.
 * ============================================================================
 *
 * The application is compiled from `AppModule` the way `auth.guard.spec.ts` does it, with
 * probe controllers registered BESIDE the module: there is still no business route in the
 * graph, and the global enhancers answer for a probe as they will for every later route.
 * Tokens are signed in-test against an overridden key-set source, exactly as the guard spec
 * does; the revocation store is the shipped in-memory one.
 *
 * ONE THING IS FAKED, AT THE DRIVER, AND IT IS THE ONLY THING. `pnpm test` runs from a clean
 * clone with no database (ADR-0001), so `databaseTransaction` in `db/client.ts` — the function
 * `withTenantTransaction` opens its transaction through — is replaced with one that runs the
 * callback against a handle whose `execute` answers nothing, and RECORDS whether the callback
 * resolved (commit) or threw (rollback). Everything above that line is the shipped code: the
 * three `set_config` statements are issued to the fake, the `AsyncLocalStorage` store, the
 * nesting rules, the settled-context guard and the `afterCommit` loop all run for real.
 * What the fake cannot show — that Postgres actually sees `app.tenant_id` equal to the claim,
 * that a committed row is visible afterwards and a rolled-back one is not — is
 * `test/tenancy/request-tenant-binding.int-spec.ts`, against a live database and a token
 * minted by the real issuer.
 *
 * `vi.mock` is hoisted above the imports, so `tenant-context.ts` binds the fake at its own
 * import; the record lives in `vi.hoisted` for the same reason.
 */

interface RecordedTransaction {
  outcome: 'open' | 'committed' | 'rolled back';
}

const { transactions } = vi.hoisted(() => ({ transactions: [] as RecordedTransaction[] }));

vi.mock('../db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof DbClient>();

  return {
    ...actual,
    databaseTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const record: RecordedTransaction = { outcome: 'open' };
      transactions.push(record);

      // The handle `withTenantTransaction` brands as `TenantDb`. Only `execute` is reached
      // by the shipped code (the three set_config statements) and by the probes below.
      const tx = { execute: () => Promise.resolve([]) };

      try {
        const result = await fn(tx);
        record.outcome = 'committed';
        return result;
      } catch (error) {
        record.outcome = 'rolled back';
        throw error;
      }
    },
  };
});

const ISSUER = 'http://127.0.0.1:43113';
const TENANT_ID = '3f2a9c1e-7b4d-4e8a-9c6f-1d2e3f4a5b6c';
const OTHER_TENANT_ID = '9b8c7d6e-5f4a-4b3c-8d2e-1f0a9b8c7d6e';
const USER_ID = 'user_7d3e2f1a0b9c8d7e';
const SESSION_ID = 'sess_1c9f0b7e2d4a6c8b';

/** Every request that reached a handler, in order. */
const handlerRuns: string[] = [];

/** What a handler saw of the ambient context: the id, or the class of the throw. */
interface ContextReading {
  readonly tenantId?: string;
  readonly hasDb?: boolean;
  readonly threw?: string;
}

function readAmbientContext(): ContextReading {
  try {
    return { tenantId: currentTenantId(), hasDb: typeof tenantDb().execute === 'function' };
  } catch (error) {
    return { threw: error instanceof Error ? error.name : String(error) };
  }
}

/**
 * Deletes the context the real guard wrote, so the interceptor meets a guarded route with
 * no `RequestContext` — the shape of a misconfigured guard chain. A controller-level guard
 * runs AFTER the global `APP_GUARD` and BEFORE any interceptor, which is the only place in
 * the request pipeline this state can be produced without replacing the guard: `APP_GUARD`
 * providers are registered under a generated token, so `overrideGuard(AuthGuard)` does not
 * reach the one `AuthModule` binds.
 */
@Injectable()
class StripContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Record<PropertyKey, unknown>>();
    delete request[REQUEST_CONTEXT_KEY];
    return true;
  }
}

@Controller('api/tenancy-probe')
class TenancyProbeController {
  @Get('private')
  privateRoute(): ContextReading {
    handlerRuns.push('private');
    return readAmbientContext();
  }

  @Get('throws-domain-error')
  throwsDomainError(): never {
    handlerRuns.push('throws-domain-error');
    throw new DomainError('slug_taken', 'The slug is taken.');
  }

  @Get('throws-plain-error')
  throwsPlainError(): never {
    handlerRuns.push('throws-plain-error');
    throw new Error('the handler fell over');
  }

  /**
   * What a repository does under the interceptor: opens its own `withTenantTransaction` for
   * the same tenant, and hands it an `afterCommit` hook. Joins, and the hook fires on the
   * request transaction's COMMIT — before the response is written.
   */
  @Get('nested-same-tenant')
  async nestedSameTenant(): Promise<{ inner: string; outer: string; afterCommitRanBeforeResponse: boolean }> {
    handlerRuns.push('nested-same-tenant');
    let afterCommitRan = false;
    const outer = currentTenantId();
    const inner = await withTenantTransaction(outer, () => Promise.resolve(currentTenantId()), {
      afterCommit: () => {
        afterCommitRan = true;
      },
    });

    // Read at response-construction time — the hook has NOT run yet, and cannot have: the
    // request transaction is still open while this handler is. The client-visible half of
    // the assertion is made on the recorded transaction; see the test.
    return { inner, outer, afterCommitRanBeforeResponse: afterCommitRan };
  }

  @Get('nested-other-tenant')
  async nestedOtherTenant(): Promise<string> {
    handlerRuns.push('nested-other-tenant');
    return withTenantTransaction(OTHER_TENANT_ID, () => Promise.resolve(currentTenantId()));
  }

  @Get('public')
  @Public('interceptor spec: AC-15, the anonymous branch')
  publicRoute(@Req() request: Record<PropertyKey, unknown>): { context: RequestContext | null; ambient: ContextReading } {
    handlerRuns.push('public');
    return {
      context: (request[REQUEST_CONTEXT_KEY] as RequestContext | undefined) ?? null,
      ambient: readAmbientContext(),
    };
  }

  @Get('own-transactions')
  @NoTenantTransaction('interceptor spec: the handler opens its own transactions')
  ownTransactions(@Req() request: Record<PropertyKey, unknown>): { context: RequestContext | null; ambient: ContextReading } {
    handlerRuns.push('own-transactions');
    return {
      context: (request[REQUEST_CONTEXT_KEY] as RequestContext | undefined) ?? null,
      ambient: readAmbientContext(),
    };
  }

  @Get('context-stripped')
  @UseGuards(StripContextGuard)
  contextStripped(): ContextReading {
    handlerRuns.push('context-stripped');
    return readAmbientContext();
  }
}

@Controller('api/tenancy-probe-class-public')
@Public('interceptor spec: the class-level branch')
class ClassPublicProbeController {
  @Get()
  read(): ContextReading {
    handlerRuns.push('class-public');
    return readAmbientContext();
  }
}

let signingKey: CryptoKey;
let keySet: JSONWebKeySet;

let app: INestApplication;
let baseUrl: string;

function claims(overrides: JWTPayload = {}): JWTPayload {
  return { sub: USER_ID, tid: TENANT_ID, email: 'operator@example.com', ev: true, jti: SESSION_ID, ...overrides };
}

async function sign(payload: JWTPayload = claims()): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(signingKey);
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

async function authenticated(path: string): Promise<Probe> {
  return probe(path, { authorization: `Bearer ${await sign()}` });
}

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  signingKey = pair.privateKey;
  keySet = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'test-key' }] };

  vi.stubEnv('BETTER_AUTH_URL', ISSUER);
  // `/health` reads the build SHA per request and 500s without one; the assertion below is
  // about the interceptor skipping the probe, not about the SHA.
  vi.stubEnv('GIT_COMMIT_SHA', '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [TenancyProbeController, ClassPublicProbeController],
    providers: [StripContextGuard],
  })
    .overrideProvider(JWKS_KEY_SET_SOURCE)
    .useValue(() => Promise.resolve(keySet))
    .overrideProvider(REVOCATION_STORE)
    .useValue(new InMemoryRevocationStore())
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

beforeEach(() => {
  transactions.length = 0;
  handlerRuns.length = 0;
  // The filter records every 500 and the guard may warn; neither line is under test here.
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

describe('TenantTransactionInterceptor over HTTP', () => {
  it('AC-14: an authenticated handler runs inside a tenant transaction for the tid claim, which commits when it returns', async () => {
    const result = await authenticated('/api/tenancy-probe/private');

    expect(result.status, result.raw).toBe(200);
    // Both accessors answer inside the handler, and the id is the claim's.
    expect(result.body).toEqual({ tenantId: TENANT_ID, hasDb: true });
    expect(handlerRuns).toEqual(['private']);
    // Exactly one transaction, and it committed before the response reached the client.
    expect(transactions).toEqual([{ outcome: 'committed' }]);
  });

  it('AC-14: the transaction is opened for the CLAIM tenant, not for one carried elsewhere on the request', async () => {
    const result = await probe('/api/tenancy-probe/private', {
      authorization: `Bearer ${await sign(claims({ tid: OTHER_TENANT_ID }))}`,
      'x-tenant-id': TENANT_ID,
    });

    expect(result.status, result.raw).toBe(200);
    expect((result.body as ContextReading).tenantId).toBe(OTHER_TENANT_ID);
  });

  it('AC-14: a handler that throws a DomainError rolls the transaction back and the filter answers its code', async () => {
    const result = await authenticated('/api/tenancy-probe/throws-domain-error');

    expect(result.status, result.raw).toBe(409);
    expect(result.body).toEqual({ code: 'slug_taken', message: 'The slug is taken.' });
    expect(handlerRuns).toEqual(['throws-domain-error']);
    expect(transactions).toEqual([{ outcome: 'rolled back' }]);
  });

  it('AC-14: a handler that throws anything else rolls the transaction back and the filter answers 500', async () => {
    const result = await authenticated('/api/tenancy-probe/throws-plain-error');

    expect(result.status, result.raw).toBe(500);
    expect((result.body as { code?: unknown }).code).toBe('internal_error');
    expect(transactions).toEqual([{ outcome: 'rolled back' }]);
  });

  it('a nested withTenantTransaction for the same tenant JOINS the request transaction, and its afterCommit fires on the request COMMIT', async () => {
    const result = await authenticated('/api/tenancy-probe/nested-same-tenant');

    expect(result.status, result.raw).toBe(200);
    // Inner and outer see the same tenant, ONE transaction was opened (no savepoint, no
    // second connection), and the hook had not run while the handler was still inside it —
    // it belongs to the request transaction's COMMIT, which happened before this response.
    expect(result.body).toEqual({ inner: TENANT_ID, outer: TENANT_ID, afterCommitRanBeforeResponse: false });
    expect(transactions).toEqual([{ outcome: 'committed' }]);
  });

  it('a nested withTenantTransaction for a DIFFERENT tenant throws TenantContextMismatchError, which rolls the request back as a 500', async () => {
    const result = await authenticated('/api/tenancy-probe/nested-other-tenant');

    expect(result.status, result.raw).toBe(500);
    expect((result.body as { code?: unknown }).code).toBe('internal_error');
    expect(handlerRuns).toEqual(['nested-other-tenant']);
    // The mismatch is raised by the nesting rule BEFORE any second transaction opens.
    expect(transactions).toEqual([{ outcome: 'rolled back' }]);
  });

  it('AC-15: a @Public() handler runs with no Authorization header, is not 401, and no tenant transaction is opened', async () => {
    const result = await probe('/api/tenancy-probe/public');

    expect(result.status, result.raw).toBe(200);
    expect(handlerRuns).toEqual(['public']);
    // No context from the guard and no ambient tenant inside the handler: reading it throws
    // `TenantContextMissingError`, which is what a `@Public()` route touching tenant data
    // without a capability-token entry point would meet (ADR-0021).
    expect(result.body).toEqual({ context: null, ambient: { threw: TenantContextMissingError.name } });
    expect(transactions).toEqual([]);
  });

  it('AC-15: a @Public() handler opens no transaction even when a valid token is sent', async () => {
    const result = await authenticated('/api/tenancy-probe/public');

    expect(result.status, result.raw).toBe(200);
    expect(transactions).toEqual([]);
  });

  it('a class-level @Public() exempts every handler on the controller from the interceptor', async () => {
    const result = await probe('/api/tenancy-probe-class-public');

    expect(result.status, result.raw).toBe(200);
    expect(result.body).toEqual({ threw: TenantContextMissingError.name });
    expect(handlerRuns).toEqual(['class-public']);
    expect(transactions).toEqual([]);
  });

  it('a @NoTenantTransaction() handler keeps the guard: no header is 401 and the handler never runs', async () => {
    const result = await probe('/api/tenancy-probe/own-transactions');

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'unauthenticated', message: expect.any(String) });
    expect(handlerRuns).toEqual([]);
    expect(transactions).toEqual([]);
  });

  it('a @NoTenantTransaction() handler runs authenticated, with the RequestContext and NO ambient tenant transaction', async () => {
    const result = await authenticated('/api/tenancy-probe/own-transactions');

    expect(result.status, result.raw).toBe(200);
    expect(result.body).toEqual({
      context: { userId: USER_ID, tenantId: TENANT_ID, email: 'operator@example.com', emailVerified: true },
      ambient: { threw: TenantContextMissingError.name },
    });
    expect(handlerRuns).toEqual(['own-transactions']);
    expect(transactions).toEqual([]);
  });

  it('a guarded route reached with NO RequestContext is refused 401 unauthenticated, never run inside a tenant-less transaction, and never a 500', async () => {
    const result = await authenticated('/api/tenancy-probe/context-stripped');

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'unauthenticated', message: expect.any(String) });
    expect(handlerRuns).toEqual([]);
    expect(transactions).toEqual([]);
  });

  it('GET /health stays reachable with no header and opens no transaction', async () => {
    const result = await probe('/health');

    expect(result.status, result.raw).toBe(200);
    expect((result.body as { status?: unknown }).status).toBe('ok');
    expect(transactions).toEqual([]);
  });

  it('a request refused by the guard opens no transaction', async () => {
    const result = await probe('/api/tenancy-probe/private', { authorization: 'Bearer not-a-token' });

    expect(result.status, result.raw).toBe(401);
    expect(handlerRuns).toEqual([]);
    expect(transactions).toEqual([]);
  });
});
