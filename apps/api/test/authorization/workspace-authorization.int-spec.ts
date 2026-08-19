import type { Server } from 'node:http';

import { Controller, Get, HttpCode, Post, Req, RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TENANT_ROLE, WORKSPACE_ROLE, workspaceContract } from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { REQUEST_CONTEXT_KEY } from '../../src/auth/auth.guard';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthorizationModule } from '../../src/common/authorization/authorization.module';
import { RequireTenantRole, RequireWorkspaceRole } from '../../src/common/authorization/roles';
import { WorkspaceAuthorizationInterceptor } from '../../src/common/authorization/workspace-authorization.interceptor';
import { ApiExceptionFilter } from '../../src/common/errors/exception-filter';
import { closeDatabase } from '../../src/db/client';
import { MembershipRepository } from '../../src/memberships/membership.repository';
import { TenantContextMissingError } from '../../src/tenancy/tenant-context';
import type { RequestContext } from '../../src/tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../../src/workspaces/workspace-not-found.error';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  authServerEnv,
  clearSignupState,
  jwtClaims,
  mintToken,
  signIn,
  signUp,
  usersFor,
} from '../support/auth-fixture';
import { execSql, querySql } from '../support/psql';
import { assertAppRoleCannotBypassRls, migrationDsn } from '../support/rls-fixture';

/**
 * STORY-1b-04 — AC-1b-19, AC-1b-20, AC-1b-21 on a probe, against a live database. TASK-1b-05,
 * wave 2.
 *
 * Contract: `docs/contracts/workspace-authorization.md` (Form A; "Status rules"; "What the
 * implementer must guarantee"), `docs/contracts/tenant-context.md` ("Authorization moves into
 * the handler", rule 3), `docs/contracts/error-envelope.md` (invariants 5, 6). ADR-0062, D-05.
 *
 * ============================================================================
 * THE SAME TWO-PROCESS SHAPE AS `test/workspaces/workspaces.int-spec.ts`, PLUS A PROBE
 * CONTROLLER CARRYING THE DECORATORS (written before 1b-06 decorated the real routes; kept
 * because it exercises minima and a no-transaction chain the real routes cannot).
 * ============================================================================
 *
 * The child booted by `api-server.ts` signs users up, signs them in and mints real tokens
 * against a real `/api/auth/jwks`. The application under test is built from `AppModule` in
 * this process — the real guard, the real three interceptors in the ruled order, the real
 * filter, the real `MembershipRepository` and `TenantMembershipRepository`, nothing
 * overridden — with a probe controller beside it whose routes carry `@RequireWorkspaceRole` /
 * `@RequireTenantRole`. Workspaces are created through the real `POST /api/workspaces`, which
 * also shows the third interceptor leaves an undecorated route alone; `memberships` rows are
 * seeded through the migrator under the tenant's flag, because no route grants one yet.
 *
 * WHAT ONLY THIS TIER CAN SHOW. That the membership lookup runs under `app.tenant_id` and the
 * policy: tenant B's owner, with a real token for B, naming tenant A's workspace id, gets the
 * same 404 body as an id nobody issued — the row is invisible, not refused. That a
 * `memberships` row updated directly applies on the caller's very next request (no cache).
 * And AC-1b-20's shape: an application whose interceptor chain lacks the tenant transaction
 * answers 500 from `TenantContextMissingError`, thrown by the repository before any statement
 * is issued.
 */

const EMAIL_A = 'wave2-authz-a@example.com';
const EMAIL_B = 'wave2-authz-b@example.com';

const NEVER_ISSUED = '00000000-0000-4000-8000-000000000000';

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

let app: INestApplication | undefined;
let baseUrl: string;

/** AC-1b-20's application: guard, filter, the authorization interceptor — and NO tenant transaction. */
let noTransactionApp: INestApplication | undefined;
let noTransactionBaseUrl: string;

/** What a probe handler saw of its `RequestContext`. */
interface ContextReading {
  readonly workspaceId?: string;
  readonly workspaceRole?: string;
  readonly tenantRole?: string;
  readonly userId: string;
}

function readContext(request: Record<PropertyKey, unknown>): ContextReading {
  const ctx = request[REQUEST_CONTEXT_KEY] as RequestContext;

  return { workspaceId: ctx.workspaceId, workspaceRole: ctx.workspaceRole, tenantRole: ctx.tenantRole, userId: ctx.userId };
}

@Controller('authz-probe')
class AuthorizationProbeController {
  @Get('workspaces/:workspaceId')
  @RequireWorkspaceRole(WORKSPACE_ROLE.viewer)
  read(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    return readContext(request);
  }

  @Post('workspaces/:workspaceId/write')
  @HttpCode(200)
  @RequireWorkspaceRole(WORKSPACE_ROLE.member)
  write(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    return readContext(request);
  }

  @Post('workspaces/:workspaceId/archive')
  @HttpCode(200)
  @RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)
  archive(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    return readContext(request);
  }

  @Post('tenant-owner')
  @HttpCode(200)
  @RequireTenantRole(TENANT_ROLE.owner)
  tenantOwner(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    return readContext(request);
  }

  @Post('tenant-admin')
  @HttpCode(200)
  @RequireTenantRole(TENANT_ROLE.admin)
  tenantAdmin(@Req() request: Record<PropertyKey, unknown>): ContextReading {
    return readContext(request);
  }
}

/** The AC-1b-20 probe: the same decorator, in an application with no tenant transaction. */
@Controller('no-transaction-probe')
class NoTransactionProbeController {
  @Get('workspaces/:workspaceId')
  @RequireWorkspaceRole(WORKSPACE_ROLE.viewer)
  read(): string {
    return 'never';
  }
}

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

interface ProbeOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly token?: string;
  readonly body?: unknown;
}

async function request(origin: string, path: string, options: ProbeOptions = {}): Promise<Probe> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
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

  return { status: response.status, body, raw };
}

function api(path: string, options: ProbeOptions = {}): Promise<Probe> {
  return request(baseUrl, path, options);
}

interface Principal {
  readonly token: string;
  readonly tenantId: string;
  readonly userId: string;
}

/** Sign up, sign in, mint: the token a real BFF would hold, the tenant behind it, the user. */
async function principalFor(email: string): Promise<Principal> {
  const signedUp = await signUp(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);

  const signedIn = await signIn(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);

  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  const token = (minted.body as { token?: unknown }).token;
  expect(typeof token).toBe('string');

  const claims = jwtClaims(token as string);
  expect(typeof claims.tid).toBe('string');
  expect(typeof claims.sub).toBe('string');

  const [user] = usersFor(email);
  expect(user, `signup wrote no user row for ${email}`).toBeDefined();
  expect(user.id).toBe(claims.sub);

  return { token: token as string, tenantId: claims.tid as string, userId: claims.sub as string };
}

/** Through the real route: the third interceptor is in the chain and leaves it alone. */
async function createWorkspace(principal: Principal, name: string): Promise<string> {
  const created = await api('/api/workspaces', { method: 'POST', token: principal.token, body: { name } });

  expect(created.status, created.raw).toBe(201);

  return workspaceContract.parse(created.body).id;
}

/**
 * Seeds a `memberships` row through the migrator under the tenant's flag: FORCE ROW LEVEL
 * SECURITY subjects the owner to the policy too, and the composite key needs the workspace
 * to be that tenant's. Since TASK-1b-06 `POST /api/workspaces` writes the creator's
 * `workspace_admin` row itself, so for the creator this is an UPSERT that sets the role the
 * test wants (`ON CONFLICT (workspace_id, user_id) DO UPDATE` — a fixture statement through
 * the migrator, not the app's path; D-12's `DO NOTHING` rule is about the accept path).
 */
function seedMembership(tenantId: string, workspaceId: string, userId: string, role: string): void {
  execSql(
    migrationDsn(),
    `INSERT INTO memberships (tenant_id, workspace_id, user_id, role)
     VALUES (:'tenant_id'::uuid, :'workspace_id'::uuid, :'user_id', :'role'::workspace_role)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    { tenantId, variables: { tenant_id: tenantId, workspace_id: workspaceId, user_id: userId, role } },
  );
}

function setMembershipRole(tenantId: string, workspaceId: string, userId: string, role: string): void {
  execSql(
    migrationDsn(),
    `UPDATE memberships SET role = :'role'::workspace_role
      WHERE tenant_id = :'tenant_id'::uuid AND workspace_id = :'workspace_id'::uuid AND user_id = :'user_id'`,
    { tenantId, variables: { tenant_id: tenantId, workspace_id: workspaceId, user_id: userId, role } },
  );
}

function deleteMembership(tenantId: string, workspaceId: string, userId: string): void {
  execSql(
    migrationDsn(),
    `DELETE FROM memberships
      WHERE tenant_id = :'tenant_id'::uuid AND workspace_id = :'workspace_id'::uuid AND user_id = :'user_id'`,
    {
      tenantId,
      variables: { tenant_id: tenantId, workspace_id: workspaceId, user_id: userId },
      flags: { 'app.privileged_erase': tenantId },
    },
  );
}

function setTenantRole(tenantId: string, userId: string, role: string): void {
  execSql(
    migrationDsn(),
    `UPDATE tenant_memberships SET role = :'role'::tenant_role
      WHERE tenant_id = :'tenant_id'::uuid AND user_id = :'user_id'`,
    { tenantId, variables: { tenant_id: tenantId, user_id: userId, role } },
  );
}

/** How many `memberships` rows a tenant owns, read through the owner with that tenant's flag. */
function membershipCountFor(tenantId: string): number {
  const [row] = querySql<{ n: number }>(
    migrationDsn(),
    `select count(*)::int as n from memberships where tenant_id = :'tenant_id'::uuid`,
    { tenantId, variables: { tenant_id: tenantId } },
  );

  return row?.n ?? -1;
}

const NOT_FOUND_BODY = new WorkspaceNotFoundError().toEnvelope();

function expectNotFound(probe: Probe): void {
  expect(probe.status, probe.raw).toBe(404);
  expect(probe.body).toEqual(NOT_FOUND_BODY);
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
      controllers: [AuthorizationProbeController],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // The same prefix and exclusion `main.ts` sets (ADR-0006): `/api/workspaces` is the real
    // path, and the probe sits under `/api/authz-probe`.
    app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    // The in-process server never closes an idle keep-alive socket while `psql` spawns block
    // the loop (`request-tenant-binding.int-spec.ts`, observed there). `0` disables the timeout.
    (app.getHttpServer() as Server).keepAliveTimeout = 0;

    // AC-1b-20's application: `AuthModule` (the guard and what it injects), the filter, and
    // the authorization interceptor as the ONLY interceptor — no `TenantTransactionInterceptor`.
    const noTransactionRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [NoTransactionProbeController],
      providers: [
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: APP_INTERCEPTOR, useClass: WorkspaceAuthorizationInterceptor },
      ],
    }).compile();

    noTransactionApp = noTransactionRef.createNestApplication({ logger: false });
    noTransactionApp.setGlobalPrefix('api');
    await noTransactionApp.listen(0, '127.0.0.1');
    noTransactionBaseUrl = await noTransactionApp.getUrl();
    (noTransactionApp.getHttpServer() as Server).keepAliveTimeout = 0;
  }

  // Both addresses in one call: `clearSignupState` empties `user` for every address, so two
  // calls would strand the second address's tenant. Workspaces and memberships cascade with
  // the tenant.
  clearSignupState(EMAIL_A, EMAIL_B);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await noTransactionApp?.close();
  await closeDatabase();
  vi.unstubAllEnvs();
  clearSignupState(EMAIL_A, EMAIL_B);
  await server?.stop();
});

describe('AC-1b-19: rank enforcement on a real membership row', () => {
  it('workspace_admin passes read, write and archive; member passes read and write, is 403 on archive; viewer reads and is 403 on every write', async () => {
    const a = await principalFor(EMAIL_A);
    const asAdmin = await createWorkspace(a, 'Admin here');
    const asMember = await createWorkspace(a, 'Member here');
    const asViewer = await createWorkspace(a, 'Viewer here');
    seedMembership(a.tenantId, asAdmin, a.userId, 'workspace_admin');
    seedMembership(a.tenantId, asMember, a.userId, 'member');
    seedMembership(a.tenantId, asViewer, a.userId, 'viewer');

    const table: ReadonlyArray<[string, string, string, number]> = [
      // [workspace, route, expected role on the context, status]
      [asAdmin, 'read', 'workspace_admin', 200],
      [asAdmin, 'write', 'workspace_admin', 200],
      [asAdmin, 'archive', 'workspace_admin', 200],
      [asMember, 'read', 'member', 200],
      [asMember, 'write', 'member', 200],
      [asMember, 'archive', 'member', 403],
      [asViewer, 'read', 'viewer', 200],
      [asViewer, 'write', 'viewer', 403],
      [asViewer, 'archive', 'viewer', 403],
    ];

    for (const [workspaceId, route, role, status] of table) {
      const path = route === 'read' ? `/api/authz-probe/workspaces/${workspaceId}` : `/api/authz-probe/workspaces/${workspaceId}/${route}`;
      const result = await api(path, { method: route === 'read' ? 'GET' : 'POST', token: a.token });

      expect(result.status, `${route} as ${role}: ${result.raw}`).toBe(status);
      if (status === 200) {
        expect(result.body).toEqual({ workspaceId, workspaceRole: role, userId: a.userId });
      } else {
        expect(result.body).toEqual({ code: 'insufficient_workspace_role', message: expect.any(String) });
      }
    }
  });

  it('no membership in a same-tenant workspace is 404 not_found with the same body as an id nobody issued and as a malformed id', async () => {
    const a = await principalFor(EMAIL_A);
    const unjoined = await createWorkspace(a, 'Not a member');
    // The creator's own row (TASK-1b-06 writes it) is removed: this test is about NO membership.
    deleteMembership(a.tenantId, unjoined, a.userId);

    for (const path of [
      `/api/authz-probe/workspaces/${unjoined}`,
      `/api/authz-probe/workspaces/${unjoined}/write`,
      `/api/authz-probe/workspaces/${NEVER_ISSUED}`,
      '/api/authz-probe/workspaces/not-a-uuid',
    ]) {
      const method = path.endsWith('/write') ? 'POST' : 'GET';
      expectNotFound(await api(path, { method, token: a.token }));
    }
  });
});

describe('the lookup runs under the tenant policy', () => {
  it('a member of tenant B with a token for B cannot reach tenant A’s workspace: 404, the same body as a nonexistent id, and no row of A is visible to it', async () => {
    const a = await principalFor(EMAIL_A);
    const b = await principalFor(EMAIL_B);
    expect(b.tenantId).not.toBe(a.tenantId);

    const workspaceOfA = await createWorkspace(a, 'A’s workspace');
    seedMembership(a.tenantId, workspaceOfA, a.userId, 'workspace_admin');
    // A can reach it — the row is real.
    expect((await api(`/api/authz-probe/workspaces/${workspaceOfA}`, { token: a.token })).status).toBe(200);

    // B, on every minimum, on the read and on the writes.
    for (const path of [
      `/api/authz-probe/workspaces/${workspaceOfA}`,
      `/api/authz-probe/workspaces/${workspaceOfA}/write`,
      `/api/authz-probe/workspaces/${workspaceOfA}/archive`,
    ]) {
      const method = path.endsWith(`/${workspaceOfA}`) ? 'GET' : 'POST';
      expectNotFound(await api(path, { method, token: b.token }));
    }

    // Byte-equal to what B gets for an id nobody issued: existence is not disclosed.
    const nonexistent = await api(`/api/authz-probe/workspaces/${NEVER_ISSUED}`, { token: b.token });
    expectNotFound(nonexistent);

    // A's row is still A's, and B's tenant holds none.
    expect(membershipCountFor(a.tenantId)).toBe(1);
    expect(membershipCountFor(b.tenantId)).toBe(0);
  });

  it('AC-1b-21: a memberships row updated directly applies on the caller’s next request — and a deleted one is 404 at once', async () => {
    const a = await principalFor(EMAIL_A);
    const workspaceId = await createWorkspace(a, 'Promoted later');
    seedMembership(a.tenantId, workspaceId, a.userId, 'member');

    const archive = `/api/authz-probe/workspaces/${workspaceId}/archive`;
    expect((await api(archive, { method: 'POST', token: a.token })).status).toBe(403);

    setMembershipRole(a.tenantId, workspaceId, a.userId, 'workspace_admin');
    const promoted = await api(archive, { method: 'POST', token: a.token });
    expect(promoted.status, promoted.raw).toBe(200);
    expect((promoted.body as ContextReading).workspaceRole).toBe('workspace_admin');

    setMembershipRole(a.tenantId, workspaceId, a.userId, 'viewer');
    expect((await api(archive, { method: 'POST', token: a.token })).status).toBe(403);
    expect((await api(`/api/authz-probe/workspaces/${workspaceId}`, { token: a.token })).status).toBe(200);

    deleteMembership(a.tenantId, workspaceId, a.userId);
    expectNotFound(await api(`/api/authz-probe/workspaces/${workspaceId}`, { token: a.token }));
  });
});

describe('RequireTenantRole reads tenant_memberships inside the transaction', () => {
  it('the signup owner passes owner and admin routes; demoted directly to admin they pass admin only; as member neither; restored, both again', async () => {
    const a = await principalFor(EMAIL_A);

    const owner = await api('/api/authz-probe/tenant-owner', { method: 'POST', token: a.token });
    expect(owner.status, owner.raw).toBe(200);
    expect(owner.body).toEqual({ tenantRole: 'owner', userId: a.userId });
    expect((await api('/api/authz-probe/tenant-admin', { method: 'POST', token: a.token })).status).toBe(200);

    setTenantRole(a.tenantId, a.userId, 'admin');
    const asAdmin = await api('/api/authz-probe/tenant-owner', { method: 'POST', token: a.token });
    expect(asAdmin.status, asAdmin.raw).toBe(403);
    expect(asAdmin.body).toEqual({ code: 'insufficient_tenant_role', message: expect.any(String) });
    expect((await api('/api/authz-probe/tenant-admin', { method: 'POST', token: a.token })).status).toBe(200);

    // Invariant 4: a tenant member — what an invitee holds — passes no tenant check.
    setTenantRole(a.tenantId, a.userId, 'member');
    for (const path of ['/api/authz-probe/tenant-owner', '/api/authz-probe/tenant-admin']) {
      const refused = await api(path, { method: 'POST', token: a.token });
      expect(refused.status, refused.raw).toBe(403);
      expect((refused.body as { code: string }).code).toBe('insufficient_tenant_role');
    }

    setTenantRole(a.tenantId, a.userId, 'owner');
    expect((await api('/api/authz-probe/tenant-owner', { method: 'POST', token: a.token })).status).toBe(200);
  });
});

describe('AC-1b-20: no tenant transaction, no pass', () => {
  it('a decorated route in an application whose chain lacks the tenant interceptor answers 500, and the repository threw TenantContextMissingError before any statement', async () => {
    const a = await principalFor(EMAIL_A);
    const workspaceId = await createWorkspace(a, 'Unreachable without a transaction');
    seedMembership(a.tenantId, workspaceId, a.userId, 'workspace_admin');
    // The same token reaches the same row through the shipped chain — the row and the
    // membership are real; what the other application lacks is the transaction.
    expect((await api(`/api/authz-probe/workspaces/${workspaceId}`, { token: a.token })).status).toBe(200);

    const roleFor = vi.spyOn(MembershipRepository.prototype, 'roleFor');
    try {
      const result = await request(noTransactionBaseUrl, `/api/no-transaction-probe/workspaces/${workspaceId}`, {
        token: a.token,
      });

      expect(result.status, result.raw).toBe(500);
      expect((result.body as { code: string }).code).toBe('internal_error');
      // The lookup was attempted (the guard passed, the interceptor engaged) and it threw the
      // context error — which `tenantDb()` raises before drizzle compiles a statement, so no
      // row was read. Never a pass: the handler answers 'never' and the client saw a 500.
      expect(roleFor).toHaveBeenCalledTimes(1);
      const [outcome] = roleFor.mock.results;
      expect(outcome?.type).toBe('return');
      await expect(outcome?.value as Promise<unknown>).rejects.toBeInstanceOf(TenantContextMissingError);
    } finally {
      roleFor.mockRestore();
    }
  });
});

describe('the shipped workspace routes through the same chain', () => {
  it('create, list, rename answer through the third interceptor: the creator holds the one membership row (TASK-1b-06) and rename passes on it', async () => {
    const a = await principalFor(EMAIL_A);
    const workspaceId = await createWorkspace(a, 'Untouched');

    const listed = await api('/api/workspaces', { token: a.token });
    expect(listed.status, listed.raw).toBe(200);
    expect((listed.body as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([workspaceId]);

    // No membership seeded here: since TASK-1b-06 the create route writes the creator's
    // `workspace_admin` row itself, and the (now decorated) rename passes on that row.
    const renamed = await api(`/api/workspaces/${workspaceId}`, { method: 'PATCH', token: a.token, body: { name: 'Still untouched' } });
    expect(renamed.status, renamed.raw).toBe(200);
    expect(membershipCountFor(a.tenantId)).toBe(1);
  });
});
