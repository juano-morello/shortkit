import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { Controller, Get, Query } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { DomainError } from '../../src/common/errors/domain-error';
import { closeDatabase } from '../../src/db/client';
import {
  Public,
  TenantContextMissingError,
  currentTenantId,
  tenantDb,
} from '../../src/tenancy/tenant-context';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  authServerEnv,
  clearSignupState,
  jwtClaims,
  membershipsFor,
  mintToken,
  signIn,
  signUp,
  usersFor,
} from '../support/auth-fixture';
import { querySql } from '../support/psql';
import {
  RLS_FIXTURE_TABLE,
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
} from '../support/rls-fixture';

/**
 * STORY-002 — AC-14 end to end, and AC-15's "no tenant transaction is opened" half against
 * the database. TASK-006, wave 5.
 *
 * Contract: `docs/contracts/tenant-context.md` ("SQL issued by `withTenantTransaction`",
 * "What the implementer must guarantee": `APP_INTERCEPTOR` after `AuthGuard`),
 * `docs/contracts/auth-tokens.md` invariant 1 (`tid` is the tenant). ADR-0002, ADR-0013.
 *
 * ============================================================================
 * THE SAME TWO-PROCESS SHAPE AS `test/auth/auth-guard.int-spec.ts`, ONE LAYER DEEPER.
 * ============================================================================
 *
 * The child booted by `api-server.ts` is the only place a real sign-in can happen and a real
 * token can be minted against a real `/api/auth/jwks`; it still carries no tenant-scoped
 * route. So the guarded route is a probe controller registered beside `AppModule` IN THIS
 * PROCESS — the real `APP_GUARD`, the real `APP_INTERCEPTOR`, the real filter, nothing
 * overridden — with `BETTER_AUTH_URL` pointed at the child so the guard verifies the child's
 * token against the child's key set. What is new against the guard suite is what the probe
 * DOES: it asks Postgres, from inside the handler, which tenant the connection is bound to,
 * and it writes a row through the ambient `tenantDb()` so that commit and rollback are
 * observed as a row that is, or is not, there afterwards.
 *
 * The row goes into `rls_fixture_rows`, the template-shaped tenant-scoped table
 * `test/support/rls-fixture.ts` builds from the production policy builder, under the tenant
 * the signup created — its `tenants` row is what the fixture table's foreign key needs, and
 * `tenant_isolation`'s WITH CHECK is what admits the insert only because the interceptor set
 * the flag to that tenant. The rows are read back through the migrator with the tenant flag
 * set, the way `tenant-context.int-spec.ts` reads its seeded rows: FORCE ROW LEVEL SECURITY
 * subjects the owner to the policy too, and every DSN this suite is given is NOBYPASSRLS.
 *
 * `withTenantTransaction` in this process reaches the database through `DATABASE_URL`, the
 * same pool the child uses; `closeDatabase()` in `afterAll` releases it.
 */

const EMAIL = 'wave5-tenant-binding@example.com';

/** Every request that reached a probe handler, in order. */
const handlerRuns: string[] = [];

interface BindingReading {
  /** `current_setting('app.tenant_id', true)` as the handler's own connection reports it. */
  readonly settingTenantId: string | null;
  /** `currentTenantId()` inside the handler. */
  readonly ambientTenantId: string;
}

interface AmbientReading {
  readonly threw: string | null;
}

@Controller('api/tenant-binding-probe')
class TenantBindingProbeController {
  /** AC-14, the reading half: what a statement inside the handler observes. */
  @Get('read')
  async read(): Promise<BindingReading> {
    handlerRuns.push('read');

    const result = await tenantDb().execute<{ tenant_id: string | null }>(
      sql`select current_setting('app.tenant_id', true) as tenant_id`,
    );

    return { settingTenantId: result.rows[0]?.tenant_id ?? null, ambientTenantId: currentTenantId() };
  }

  /** AC-14, commit: a row written through the ambient handle, and the handler returns. */
  @Get('write')
  async write(@Query('label') label: string): Promise<{ id: string }> {
    handlerRuns.push('write');
    const id = randomUUID();

    await tenantDb().execute(
      sql`insert into ${sql.identifier(RLS_FIXTURE_TABLE)} (id, tenant_id, label)
          values (${id}, ${currentTenantId()}, ${label})`,
    );

    return { id };
  }

  /** AC-14, rollback: the same write, then a throw after it has been issued. */
  @Get('write-then-throw')
  async writeThenThrow(@Query('label') label: string): Promise<never> {
    handlerRuns.push('write-then-throw');

    await tenantDb().execute(
      sql`insert into ${sql.identifier(RLS_FIXTURE_TABLE)} (id, tenant_id, label)
          values (${randomUUID()}, ${currentTenantId()}, ${label})`,
    );

    throw new DomainError('slug_taken', 'deliberate failure after the write');
  }

  /** AC-15: no header, the handler runs, and there is no ambient tenant transaction. */
  @Get('public')
  @Public('tenant-binding suite: AC-15, no transaction is opened for a public route')
  publicRoute(): AmbientReading {
    handlerRuns.push('public');

    try {
      currentTenantId();
      return { threw: null };
    } catch (error) {
      return { threw: error instanceof Error ? error.name : String(error) };
    }
  }
}

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

let app: INestApplication | undefined;
let probeBaseUrl: string;

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

async function probe(path: string, headers: Record<string, string> = {}): Promise<Probe> {
  const response = await fetch(`${probeBaseUrl}/api/tenant-binding-probe${path}`, { headers });
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, body, raw };
}

/** Sign up, sign in, mint: the token a real BFF would hold, and the tenant behind it. */
async function realToken(): Promise<{ token: string; tenantId: string; tid: string }> {
  const signedUp = await signUp(server, EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);

  const signedIn = await signIn(server, EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);

  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  const token = (minted.body as { token?: unknown }).token;
  expect(typeof token).toBe('string');

  const [user] = usersFor(EMAIL);
  expect(user, `signup wrote no user row for ${EMAIL}`).toBeDefined();
  const [membership] = membershipsFor(user.id);
  expect(membership, 'signup wrote no membership row').toBeDefined();

  const tid = jwtClaims(token as string).tid;
  expect(typeof tid).toBe('string');

  return { token: token as string, tenantId: membership.tenantId, tid: tid as string };
}

/** The fixture table's rows for one tenant, read through the owner with that tenant's flag. */
function rowsOwnedBy(tenantId: string): Array<{ label: string }> {
  return querySql<{ label: string }>(
    migrationDsn(),
    `select label from ${RLS_FIXTURE_TABLE} where tenant_id = :'tenant_id'::uuid order by label`,
    { tenantId, variables: { tenant_id: tenantId } },
  );
}

beforeAll(() => {
  assertAppRoleCannotBypassRls();
  serverBoot = startApiServer({ env: authServerEnv });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;

  if (app === undefined) {
    // The guard reads `BETTER_AUTH_URL` per request and the JWKS cache per fetch, so stubbing
    // it once the child's port is known is enough; nothing here read it at import.
    vi.stubEnv('BETTER_AUTH_URL', server.baseUrl);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TenantBindingProbeController],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    probeBaseUrl = await app.getUrl();

    // ==========================================================================
    // THE IN-PROCESS SERVER NEVER CLOSES AN IDLE KEEP-ALIVE SOCKET. OBSERVED, NOT GUESSED.
    // ==========================================================================
    // Every `beforeEach` below blocks the event loop for several seconds in `psql` spawns,
    // longer than Node's default 5 s `keepAliveTimeout`. `fetch` pools the socket the last
    // probe used; the server's idle timer, overdue when the loop unblocks, tears that
    // socket down at the same moment the next probe is written to it, and the probe fails
    // with `SocketError: other side closed` — roughly every other test, measured. Undici
    // drops a `connection: close` request header as a forbidden name, so the fix is on the
    // server: `0` disables the idle timeout (Node docs), and `app.close()` still closes the
    // idle sockets through `server.close()`.
    (app.getHttpServer() as Server).keepAliveTimeout = 0;
  }

  // Order: the signup's tenant is erased first (its fixture rows cascade with it), then the
  // fixture table is rebuilt so a row a previous test left cannot carry into this one.
  clearSignupState(EMAIL);
  createRlsFixture();
  handlerRuns.length = 0;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeDatabase();
  vi.unstubAllEnvs();
  dropRlsFixture();
  clearSignupState(EMAIL);
  await server?.stop();
});

describe('a real token binds the request to its tenant transaction', () => {
  it('AC-14: a statement inside the handler observes app.tenant_id equal to the tid claim, and currentTenantId() returns it', async () => {
    const { token, tenantId, tid } = await realToken();

    const result = await probe('/read', { authorization: `Bearer ${token}` });

    expect(result.status, result.raw).toBe(200);
    expect(handlerRuns).toEqual(['read']);
    // The connection the handler's statement ran on is bound to the claim's tenant, and the
    // claim's tenant is the one the membership row names.
    expect(result.body).toEqual({ settingTenantId: tid, ambientTenantId: tid });
    expect(tid).toBe(tenantId);
  });

  it('AC-14: a row written by the handler is committed when the handler returns', async () => {
    const { token, tenantId } = await realToken();
    expect(rowsOwnedBy(tenantId)).toEqual([]);

    const result = await probe('/write?label=committed-by-the-request', { authorization: `Bearer ${token}` });

    expect(result.status, result.raw).toBe(200);
    // Visible AFTER the response, through a different connection: the transaction the
    // interceptor opened has committed, and it committed under this tenant's id — the
    // policy's WITH CHECK admitted the row for no other reason.
    expect(rowsOwnedBy(tenantId)).toEqual([{ label: 'committed-by-the-request' }]);
  });

  it('AC-14: a row written before the handler throws is rolled back, and the error still reaches the client as its own code', async () => {
    const { token, tenantId } = await realToken();

    const result = await probe('/write-then-throw?label=rolled-back-by-the-request', {
      authorization: `Bearer ${token}`,
    });

    expect(result.status, result.raw).toBe(409);
    expect(result.body).toEqual({ code: 'slug_taken', message: 'deliberate failure after the write' });
    expect(handlerRuns).toEqual(['write-then-throw']);
    // The insert was issued and accepted inside the transaction; the throw rolled it back.
    expect(rowsOwnedBy(tenantId)).toEqual([]);
  });

  it('AC-14: the same route with no Authorization header is 401 and writes nothing', async () => {
    const { tenantId } = await realToken();

    const result = await probe('/write?label=never-written');

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'unauthenticated', message: expect.any(String) });
    expect(handlerRuns).toEqual([]);
    expect(rowsOwnedBy(tenantId)).toEqual([]);
  });

  it('AC-15: a @Public() route runs with no header, is not 401, and has no tenant transaction around it', async () => {
    const result = await probe('/public');

    expect(result.status, result.raw).toBe(200);
    expect(handlerRuns).toEqual(['public']);
    expect(result.body).toEqual({ threw: TenantContextMissingError.name });
  });
});
