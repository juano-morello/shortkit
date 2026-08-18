import { Body, Controller, Get, HttpCode, Inject, Injectable, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JSONWebKeySet, JWTPayload } from 'jose';
import { TENANT_ROLE, WORKSPACE_ROLE } from '@shortkit/contracts';
import type { TenantRole, WorkspaceRole } from '@shortkit/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../app.module';
import { JWKS_KEY_SET_SOURCE, REQUEST_CONTEXT_KEY, REVOCATION_STORE } from '../../auth/auth.guard';
import { InMemoryRevocationStore } from '../../auth/revocation-store';
import type * as DbClient from '../../db/client';
import { MembershipRepository } from '../../memberships/membership.repository';
import { TenantMembershipRepository } from '../../memberships/tenant-membership.repository';
import { logger } from '../../observability/logger';
import { NoTenantTransaction, Public, tenantDb } from '../../tenancy/tenant-context';
import type { RequestContext } from '../../tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../../workspaces/workspace-not-found.error';
import { currentActor } from './actor-context';
import { AuthorizationModule } from './authorization.module';
import { RequireTenantRole, RequireWorkspaceRole } from './roles';
import { WorkspaceAuthorizer } from './workspace-authorizer';

/**
 * STORY-1b-04 — AC-1b-19, AC-1b-20 and AC-1b-21 semantics on a probe, in process. TASK-1b-05,
 * wave 2.
 *
 * Contract: `docs/contracts/workspace-authorization.md` (Form A: id resolution order, the
 * status table, 404 before 403; "What the implementer must guarantee": inside the tenant
 * transaction, fails closed, never returns pass), `docs/contracts/tenant-context.md`
 * ("Authorization moves into the handler", rules 1 and 3), `docs/contracts/error-envelope.md`
 * (invariants 5, 6). D-05.
 *
 * ============================================================================
 * THE REAL GUARD, THE REAL THREE INTERCEPTORS IN THE RULED ORDER, THE REAL FILTER, THE REAL
 * MODULE GRAPH — A FAKE TRANSACTION UNDER `withTenantTransaction`, AND TWO FAKE REPOSITORIES.
 * ============================================================================
 *
 * The application is compiled from `AppModule` the way `tenant-transaction.interceptor.spec.ts`
 * does it, probe controllers registered BESIDE the module, tokens signed in-test against an
 * overridden key-set source. `databaseTransaction` is faked at the driver as that spec fakes
 * it (`pnpm test` runs with no database), so `withTenantTransaction` opens its store for real
 * and the interceptor under test runs where it will run in production: inside it.
 *
 * The two repositories are overridden with fakes answering from in-memory tables — the SQL
 * they compile is `membership.repository.spec.ts`'s business, and RLS is the integration
 * suite's. EACH FAKE CALLS `tenantDb()` BEFORE IT ANSWERS, so the property this spec is most
 * about survives the substitution: with no active tenant context the lookup THROWS, and the
 * interceptor is never handed a role it could pass on. Every lookup is recorded, so "no
 * membership row was read" is an assertion and not an inference.
 *
 * What the fake cannot show — that Postgres actually hides tenant B's workspace from tenant
 * A's member, that a `memberships` row updated directly applies on the next request — is
 * `test/authorization/workspace-authorization.int-spec.ts`, against a live database.
 */

const { transactions } = vi.hoisted(() => ({ transactions: [] as Array<{ outcome: string }> }));

vi.mock('../../db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof DbClient>();

  return {
    ...actual,
    databaseTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const record = { outcome: 'open' };
      transactions.push(record);
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

const ISSUER = 'http://127.0.0.1:43114';
const TENANT_ID = '3f2a9c1e-7b4d-4e8a-9c6f-1d2e3f4a5b6c';
const SESSION_ID = 'sess_1c9f0b7e2d4a6c8b';

const ADMIN = 'user_admin_0000000001';
const MEMBER = 'user_member_000000001';
const VIEWER = 'user_viewer_000000001';
const OUTSIDER = 'user_outsider_00000001';
const TENANT_MEMBER = 'user_tenantmember_0001';

const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const W2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEVER_ISSUED = '00000000-0000-4000-8000-000000000000';

/** Every lookup either fake answered, in order. */
const lookups: string[] = [];
/** Every request that reached a handler, in order. */
const handlerRuns: string[] = [];

/** The in-memory `memberships` table; mutable, so AC-1b-21's "no cache" is testable here too. */
const workspaceRoles = new Map<string, WorkspaceRole>();
const tenantRoles = new Map<string, TenantRole>();

function seed(): void {
  workspaceRoles.clear();
  workspaceRoles.set(`${W1}:${ADMIN}`, WORKSPACE_ROLE.workspace_admin);
  workspaceRoles.set(`${W1}:${MEMBER}`, WORKSPACE_ROLE.member);
  workspaceRoles.set(`${W1}:${VIEWER}`, WORKSPACE_ROLE.viewer);
  workspaceRoles.set(`${W2}:${OUTSIDER}`, WORKSPACE_ROLE.workspace_admin);
  tenantRoles.clear();
  tenantRoles.set(ADMIN, TENANT_ROLE.owner);
  tenantRoles.set(MEMBER, TENANT_ROLE.member);
  tenantRoles.set(VIEWER, TENANT_ROLE.member);
  tenantRoles.set(OUTSIDER, TENANT_ROLE.member);
  tenantRoles.set(TENANT_MEMBER, TENANT_ROLE.admin);
}

const fakeMemberships = {
  roleFor: (workspaceId: string, userId: string): Promise<WorkspaceRole | null> => {
    tenantDb(); // throws TenantContextMissingError outside a transaction — the real repository's floor
    lookups.push(`workspace:${workspaceId}:${userId}`);
    return Promise.resolve(workspaceRoles.get(`${workspaceId}:${userId}`) ?? null);
  },
};

const fakeTenantMemberships = {
  roleFor: (userId: string): Promise<TenantRole | null> => {
    tenantDb();
    lookups.push(`tenant:${userId}`);
    return Promise.resolve(tenantRoles.get(userId) ?? null);
  },
};

/** What a decorated handler saw of its `RequestContext` and of the ambient actor. */
interface ContextReading {
  readonly workspaceId?: string;
  readonly workspaceRole?: string;
  readonly tenantRole?: string;
  readonly actorUserId?: string;
  readonly actorThrew?: string;
}

function readContext(request: Record<PropertyKey, unknown>): ContextReading {
  const ctx = request[REQUEST_CONTEXT_KEY] as RequestContext;
  let actorUserId: string | undefined;
  let actorThrew: string | undefined;
  try {
    actorUserId = currentActor().userId;
  } catch (error) {
    actorThrew = error instanceof Error ? error.name : String(error);
  }

  return {
    workspaceId: ctx.workspaceId,
    workspaceRole: ctx.workspaceRole,
    tenantRole: ctx.tenantRole,
    actorUserId,
    actorThrew,
  };
}

/** Deletes the guard's context, as `tenant-transaction.interceptor.spec.ts` does. */
@Injectable()
class StripContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Record<PropertyKey, unknown>>();
    delete request[REQUEST_CONTEXT_KEY];
    return true;
  }
}

@Controller('api/authz-probe')
class AuthorizationProbeController {
  constructor(@Inject(WorkspaceAuthorizer) private readonly authorizer: WorkspaceAuthorizer) {}

  /** Undecorated: untouched, no lookup. */
  @Get('plain')
  plain(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    handlerRuns.push('plain');
    return readContext(request);
  }

  /** Form A on the path param, read minimum. */
  @Get('workspaces/:workspaceId')
  @RequireWorkspaceRole(WORKSPACE_ROLE.viewer)
  readWorkspace(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    handlerRuns.push('read');
    return readContext(request);
  }

  /** Form A on the path param, write minimum. */
  @Patch('workspaces/:workspaceId')
  @RequireWorkspaceRole(WORKSPACE_ROLE.member)
  writeWorkspace(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    handlerRuns.push('write');
    return readContext(request);
  }

  /** Form A on the path param, admin minimum. */
  @Post('workspaces/:workspaceId/archive')
  @HttpCode(200)
  @RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)
  archiveWorkspace(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    handlerRuns.push('archive');
    return readContext(request);
  }

  /** Form A with the id in the body (then the query): the resolution order. */
  @Post('by-body')
  @HttpCode(200)
  @RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)
  byBody(@Req() request: Record<PropertyKey, unknown>, @Body() _body: unknown): ContextReading {
    handlerRuns.push('by-body');
    return readContext(request);
  }

  @Get('by-query')
  @RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)
  byQuery(@Req() request: Record<PropertyKey, unknown>, @Query('workspaceId') _id: unknown): ContextReading {
    handlerRuns.push('by-query');
    return readContext(request);
  }

  /** Form A at tenant level. */
  @Post('tenant-admin')
  @HttpCode(200)
  @RequireTenantRole(TENANT_ROLE.admin)
  tenantAdmin(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    handlerRuns.push('tenant-admin');
    return readContext(request);
  }

  @Post('tenant-owner')
  @HttpCode(200)
  @RequireTenantRole(TENANT_ROLE.owner)
  tenantOwner(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    handlerRuns.push('tenant-owner');
    return readContext(request);
  }

  /** Both keys on one route: 404 before 403 across them. */
  @Post('workspaces/:workspaceId/both')
  @HttpCode(200)
  @RequireWorkspaceRole(WORKSPACE_ROLE.viewer)
  @RequireTenantRole(TENANT_ROLE.owner)
  both(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    handlerRuns.push('both');
    return readContext(request);
  }

  /** Form B: the handler calls the authorizer itself. */
  @Post('form-b/:workspaceId')
  @HttpCode(200)
  async formB(@Req() request: Record<PropertyKey, unknown>): Promise<ContextReading> {
    handlerRuns.push('form-b');
    const params = request.params as { workspaceId: string };
    await this.authorizer.assert(params.workspaceId, WORKSPACE_ROLE.workspace_admin);
    return readContext(request);
  }

  /** The forbidden combination (tenant-context.md rule 1). */
  @Get('misconfigured/:workspaceId')
  @NoTenantTransaction('interceptor spec: the forbidden combination, on purpose')
  @RequireWorkspaceRole(WORKSPACE_ROLE.viewer)
  misconfigured(): string {
    handlerRuns.push('misconfigured');
    return 'never';
  }

  /** The other forbidden combination. */
  @Get('public-decorated/:workspaceId')
  @Public('interceptor spec: the forbidden combination, on purpose')
  @RequireWorkspaceRole(WORKSPACE_ROLE.viewer)
  publicDecorated(): string {
    handlerRuns.push('public-decorated');
    return 'never';
  }

  /** `@Public()` alone: untouched, no context, no lookup. */
  @Get('public')
  @Public('interceptor spec: an undecorated public route is left alone')
  publicPlain(): string {
    handlerRuns.push('public');
    return 'ok';
  }

  @Get('context-stripped/:workspaceId')
  @RequireWorkspaceRole(WORKSPACE_ROLE.viewer)
  @UseGuards(StripContextGuard)
  contextStripped(): string {
    handlerRuns.push('context-stripped');
    return 'never';
  }
}

/** A class-level decorator covers every handler. */
@Controller('api/authz-probe-class')
@RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)
class ClassDecoratedProbeController {
  @Get(':workspaceId')
  read(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    handlerRuns.push('class-read');
    return readContext(request);
  }
}

let signingKey: CryptoKey;
let keySet: JSONWebKeySet;
let app: INestApplication;
let baseUrl: string;

async function tokenFor(userId: string): Promise<string> {
  const payload: JWTPayload = { sub: userId, tid: TENANT_ID, email: `${userId}@example.com`, ev: true, jti: SESSION_ID };

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

interface ProbeOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly as?: string;
  readonly body?: unknown;
}

async function probe(path: string, options: ProbeOptions = {}): Promise<Probe> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.as === undefined ? {} : { authorization: `Bearer ${await tokenFor(options.as)}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
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

  return { status: response.status, body, raw };
}

const NOT_FOUND_BODY = new WorkspaceNotFoundError().toEnvelope();

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  signingKey = pair.privateKey;
  keySet = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'test-key' }] };

  vi.stubEnv('BETTER_AUTH_URL', ISSUER);
  vi.stubEnv('GIT_COMMIT_SHA', '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b');

  const moduleRef = await Test.createTestingModule({
    // `AuthorizationModule` a second time, for the Form B probe's constructor: `AppModule`
    // imports it too, and Nest resolves both to the one module instance.
    imports: [AppModule, AuthorizationModule],
    controllers: [AuthorizationProbeController, ClassDecoratedProbeController],
    providers: [StripContextGuard],
  })
    .overrideProvider(JWKS_KEY_SET_SOURCE)
    .useValue(() => Promise.resolve(keySet))
    .overrideProvider(REVOCATION_STORE)
    .useValue(new InMemoryRevocationStore())
    .overrideProvider(MembershipRepository)
    .useValue(fakeMemberships)
    .overrideProvider(TenantMembershipRepository)
    .useValue(fakeTenantMemberships)
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

beforeEach(() => {
  seed();
  transactions.length = 0;
  lookups.length = 0;
  handlerRuns.length = 0;
  // The filter records every 500, the guard may warn, the request-log line is per request;
  // none is under test here.
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

describe('Form A over HTTP: rank enforcement (AC-1b-19)', () => {
  it('a workspace_admin passes read, write and archive; the context carries the id and role and the actor is ambient', async () => {
    for (const [method, path, run] of [
      ['GET', `/api/authz-probe/workspaces/${W1}`, 'read'],
      ['PATCH', `/api/authz-probe/workspaces/${W1}`, 'write'],
      ['POST', `/api/authz-probe/workspaces/${W1}/archive`, 'archive'],
    ] as const) {
      const result = await probe(path, { method, as: ADMIN });

      expect(result.status, result.raw).toBe(200);
      expect(result.body).toEqual({ workspaceId: W1, workspaceRole: 'workspace_admin', actorUserId: ADMIN });
      expect(handlerRuns.at(-1)).toBe(run);
    }
    expect(lookups).toEqual(Array(3).fill(`workspace:${W1}:${ADMIN}`));
    // One transaction per request, and each committed with the check inside it.
    expect(transactions).toEqual([{ outcome: 'committed' }, { outcome: 'committed' }, { outcome: 'committed' }]);
  });

  it('a member reads and writes but cannot archive: 403 insufficient_workspace_role, the handler never runs, the transaction rolls back', async () => {
    expect((await probe(`/api/authz-probe/workspaces/${W1}`, { as: MEMBER })).status).toBe(200);
    expect((await probe(`/api/authz-probe/workspaces/${W1}`, { method: 'PATCH', as: MEMBER })).status).toBe(200);

    const refused = await probe(`/api/authz-probe/workspaces/${W1}/archive`, { method: 'POST', as: MEMBER });

    expect(refused.status, refused.raw).toBe(403);
    expect(refused.body).toEqual({ code: 'insufficient_workspace_role', message: expect.any(String) });
    expect(handlerRuns).toEqual(['read', 'write']);
    expect(transactions.at(-1)).toEqual({ outcome: 'rolled back' });
  });

  it('invariant 2: a viewer reads (200) and is refused every write with 403 insufficient_workspace_role', async () => {
    const read = await probe(`/api/authz-probe/workspaces/${W1}`, { as: VIEWER });
    expect(read.status, read.raw).toBe(200);
    expect(read.body).toEqual({ workspaceId: W1, workspaceRole: 'viewer', actorUserId: VIEWER });

    for (const [method, path] of [
      ['PATCH', `/api/authz-probe/workspaces/${W1}`],
      ['POST', `/api/authz-probe/workspaces/${W1}/archive`],
    ] as const) {
      const refused = await probe(path, { method, as: VIEWER });
      expect(refused.status, refused.raw).toBe(403);
      expect((refused.body as { code: string }).code).toBe('insufficient_workspace_role');
    }
    expect(handlerRuns).toEqual(['read']);
  });

  it('AC-1b-21: a role changed in the table applies to the very next request — nothing is cached', async () => {
    expect((await probe(`/api/authz-probe/workspaces/${W1}/archive`, { method: 'POST', as: MEMBER })).status).toBe(403);

    workspaceRoles.set(`${W1}:${MEMBER}`, WORKSPACE_ROLE.workspace_admin);
    expect((await probe(`/api/authz-probe/workspaces/${W1}/archive`, { method: 'POST', as: MEMBER })).status).toBe(200);

    workspaceRoles.delete(`${W1}:${MEMBER}`);
    expect((await probe(`/api/authz-probe/workspaces/${W1}`, { as: MEMBER })).status).toBe(404);

    expect(lookups).toHaveLength(3);
  });
});

describe('Form A over HTTP: no membership is 404, and 404 comes before 403', () => {
  it('a user with no membership in the workspace gets 404 not_found with EXACTLY the workspaces 404 body, on read and on write', async () => {
    for (const [method, path] of [
      ['GET', `/api/authz-probe/workspaces/${W1}`],
      ['PATCH', `/api/authz-probe/workspaces/${W1}`],
      ['POST', `/api/authz-probe/workspaces/${W1}/archive`],
    ] as const) {
      const refused = await probe(path, { method, as: OUTSIDER });
      expect(refused.status, refused.raw).toBe(404);
      expect(refused.body).toEqual(NOT_FOUND_BODY);
    }
    expect(handlerRuns).toEqual([]);
  });

  it('an id no membership names, and a malformed id, both answer the same 404 body — the malformed one without a lookup', async () => {
    const unknown = await probe(`/api/authz-probe/workspaces/${NEVER_ISSUED}`, { as: ADMIN });
    expect(unknown.status, unknown.raw).toBe(404);
    expect(unknown.body).toEqual(NOT_FOUND_BODY);
    expect(lookups).toEqual([`workspace:${NEVER_ISSUED}:${ADMIN}`]);

    // The fake looks a non-uuid up (the real repository answers null before Postgres); the
    // interceptor's answer is the same 404 either way.
    const malformed = await probe('/api/authz-probe/workspaces/not-a-uuid', { as: ADMIN });
    expect(malformed.status, malformed.raw).toBe(404);
    expect(malformed.body).toEqual(NOT_FOUND_BODY);
    expect(handlerRuns).toEqual([]);
  });

  it('a route carrying both keys: a non-member of the workspace is 404 even though their tenant role is also too low', async () => {
    // TENANT_MEMBER is a tenant admin (below the owner minimum) with no membership in W1.
    const result = await probe(`/api/authz-probe/workspaces/${W1}/both`, { method: 'POST', as: TENANT_MEMBER });

    expect(result.status, result.raw).toBe(404);
    expect(result.body).toEqual(NOT_FOUND_BODY);
  });

  it('a route carrying both keys: a workspace member below the tenant minimum is 403 insufficient_tenant_role, and a passing owner sees both roles on the context', async () => {
    const member = await probe(`/api/authz-probe/workspaces/${W1}/both`, { method: 'POST', as: MEMBER });
    expect(member.status, member.raw).toBe(403);
    expect((member.body as { code: string }).code).toBe('insufficient_tenant_role');

    const owner = await probe(`/api/authz-probe/workspaces/${W1}/both`, { method: 'POST', as: ADMIN });
    expect(owner.status, owner.raw).toBe(200);
    expect(owner.body).toEqual({ workspaceId: W1, workspaceRole: 'workspace_admin', tenantRole: 'owner', actorUserId: ADMIN });
  });
});

describe('Form A over HTTP: where the workspace id comes from', () => {
  it('body.workspaceId is read when there is no path param, and query.workspaceId after that', async () => {
    const byBody = await probe('/api/authz-probe/by-body', { method: 'POST', as: ADMIN, body: { workspaceId: W1 } });
    expect(byBody.status, byBody.raw).toBe(200);
    expect(byBody.body).toEqual({ workspaceId: W1, workspaceRole: 'workspace_admin', actorUserId: ADMIN });

    const byQuery = await probe(`/api/authz-probe/by-query?workspaceId=${W1}`, { as: ADMIN });
    expect(byQuery.status, byQuery.raw).toBe(200);
    expect(byQuery.body).toEqual({ workspaceId: W1, workspaceRole: 'workspace_admin', actorUserId: ADMIN });
  });

  it('body before query: with both present the body wins', async () => {
    const result = await probe(`/api/authz-probe/by-body?workspaceId=${W1}`, {
      method: 'POST',
      as: ADMIN,
      body: { workspaceId: W2 },
    });

    // ADMIN has no membership in W2, so the body's id is what was looked up: 404.
    expect(result.status, result.raw).toBe(404);
    expect(lookups).toEqual([`workspace:${W2}:${ADMIN}`]);
  });

  it('no id anywhere is 400 workspace_id_required, before any lookup; a non-string carrier counts as absent', async () => {
    const none = await probe('/api/authz-probe/by-body', { method: 'POST', as: ADMIN, body: {} });
    expect(none.status, none.raw).toBe(400);
    expect(none.body).toEqual({ code: 'workspace_id_required', message: expect.any(String) });

    const number = await probe('/api/authz-probe/by-body', { method: 'POST', as: ADMIN, body: { workspaceId: 42 } });
    expect(number.status, number.raw).toBe(400);

    const repeated = await probe(`/api/authz-probe/by-query?workspaceId=${W1}&workspaceId=${W2}`, { as: ADMIN });
    expect(repeated.status, repeated.raw).toBe(400);

    expect(lookups).toEqual([]);
    expect(handlerRuns).toEqual([]);
  });
});

describe('RequireTenantRole over HTTP', () => {
  it('a tenant owner passes admin and owner routes; a tenant admin passes admin and is refused owner with 403 insufficient_tenant_role', async () => {
    expect((await probe('/api/authz-probe/tenant-admin', { method: 'POST', as: ADMIN })).status).toBe(200);
    const asOwner = await probe('/api/authz-probe/tenant-owner', { method: 'POST', as: ADMIN });
    expect(asOwner.status, asOwner.raw).toBe(200);
    expect(asOwner.body).toEqual({ tenantRole: 'owner', actorUserId: ADMIN });

    expect((await probe('/api/authz-probe/tenant-admin', { method: 'POST', as: TENANT_MEMBER })).status).toBe(200);
    const refused = await probe('/api/authz-probe/tenant-owner', { method: 'POST', as: TENANT_MEMBER });
    expect(refused.status, refused.raw).toBe(403);
    expect(refused.body).toEqual({ code: 'insufficient_tenant_role', message: expect.any(String) });
    expect(lookups).toEqual([`tenant:${ADMIN}`, `tenant:${ADMIN}`, `tenant:${TENANT_MEMBER}`, `tenant:${TENANT_MEMBER}`]);
  });

  it('a tenant member (an invitee) is refused both with 403 insufficient_tenant_role — invariant 4', async () => {
    for (const path of ['/api/authz-probe/tenant-admin', '/api/authz-probe/tenant-owner']) {
      const refused = await probe(path, { method: 'POST', as: MEMBER });
      expect(refused.status, refused.raw).toBe(403);
      expect((refused.body as { code: string }).code).toBe('insufficient_tenant_role');
    }
    expect(handlerRuns).toEqual([]);
  });

  it('a caller with no tenant_memberships row in the tenant is 404 not_found (error-envelope invariant 6)', async () => {
    tenantRoles.delete(MEMBER);

    const refused = await probe('/api/authz-probe/tenant-admin', { method: 'POST', as: MEMBER });

    expect(refused.status, refused.raw).toBe(404);
    expect((refused.body as { code: string }).code).toBe('not_found');
  });

  it('a tenant-only route resolves no workspace id: no 400 for a body without one, no workspace lookup', async () => {
    const result = await probe('/api/authz-probe/tenant-admin', { method: 'POST', as: ADMIN, body: {} });

    expect(result.status, result.raw).toBe(200);
    expect(lookups).toEqual([`tenant:${ADMIN}`]);
  });
});

describe('what the interceptor leaves alone', () => {
  it('an undecorated authenticated route: no lookup, nothing set on the context, and the actor is ambient for Form B', async () => {
    const result = await probe('/api/authz-probe/plain', { as: OUTSIDER });

    expect(result.status, result.raw).toBe(200);
    expect(result.body).toEqual({ actorUserId: OUTSIDER });
    expect(lookups).toEqual([]);
    expect(transactions).toEqual([{ outcome: 'committed' }]);
  });

  it('a @Public() route: no header, no context, no lookup, no transaction', async () => {
    const result = await probe('/api/authz-probe/public');

    expect(result.status, result.raw).toBe(200);
    expect(result.raw).toBe('ok');
    expect(lookups).toEqual([]);
    expect(transactions).toEqual([]);
  });

  it('a class-level @RequireWorkspaceRole covers every handler on the controller', async () => {
    const admin = await probe(`/api/authz-probe-class/${W1}`, { as: ADMIN });
    expect(admin.status, admin.raw).toBe(200);
    expect(admin.body).toEqual({ workspaceId: W1, workspaceRole: 'workspace_admin', actorUserId: ADMIN });

    const member = await probe(`/api/authz-probe-class/${W1}`, { as: MEMBER });
    expect(member.status, member.raw).toBe(403);
    expect((member.body as { code: string }).code).toBe('insufficient_workspace_role');
  });
});

describe('Form B over HTTP', () => {
  it('a handler calling authorizer.assert passes for the admin and is refused for a member and for a non-member, inside the request transaction', async () => {
    const admin = await probe(`/api/authz-probe/form-b/${W1}`, { method: 'POST', as: ADMIN });
    expect(admin.status, admin.raw).toBe(200);
    // Form B sets nothing on the context; the actor is who the guard said.
    expect(admin.body).toEqual({ actorUserId: ADMIN });

    const member = await probe(`/api/authz-probe/form-b/${W1}`, { method: 'POST', as: MEMBER });
    expect(member.status, member.raw).toBe(403);
    expect((member.body as { code: string }).code).toBe('insufficient_workspace_role');

    const outsider = await probe(`/api/authz-probe/form-b/${W1}`, { method: 'POST', as: OUTSIDER });
    expect(outsider.status, outsider.raw).toBe(404);
    expect(outsider.body).toEqual(NOT_FOUND_BODY);

    expect(handlerRuns).toEqual(['form-b', 'form-b', 'form-b']);
    expect(transactions.map((t) => t.outcome)).toEqual(['committed', 'rolled back', 'rolled back']);
  });
});

describe('fails closed (AC-1b-20, tenant-context.md rules 1 and 3)', () => {
  it('a decorated @NoTenantTransaction() route is a 500 at the first request, no lookup, the handler never runs', async () => {
    const result = await probe(`/api/authz-probe/misconfigured/${W1}`, { as: ADMIN });

    expect(result.status, result.raw).toBe(500);
    expect((result.body as { code: string }).code).toBe('internal_error');
    expect(lookups).toEqual([]);
    expect(handlerRuns).toEqual([]);
    expect(transactions).toEqual([]);
  });

  it('a decorated @Public() route is a 500 at the first request, with or without a token', async () => {
    for (const as of [undefined, ADMIN]) {
      const result = await probe(`/api/authz-probe/public-decorated/${W1}`, { as });
      expect(result.status, result.raw).toBe(500);
    }
    expect(lookups).toEqual([]);
    expect(handlerRuns).toEqual([]);
  });

  it('a decorated route reached with NO RequestContext is refused by the tenant interceptor (401) before this one looks anything up', async () => {
    const result = await probe(`/api/authz-probe/context-stripped/${W1}`, { as: ADMIN });

    expect(result.status, result.raw).toBe(401);
    expect(lookups).toEqual([]);
    expect(handlerRuns).toEqual([]);
  });

  it('a request the guard refuses never reaches a lookup', async () => {
    const result = await probe(`/api/authz-probe/workspaces/${W1}`);

    expect(result.status, result.raw).toBe(401);
    expect(lookups).toEqual([]);
  });
});
