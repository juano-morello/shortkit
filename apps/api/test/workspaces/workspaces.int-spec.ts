import type { Server } from 'node:http';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ERROR_CODE_STATUS, errorEnvelopeContract, validationDetailsContract, workspaceContract, workspaceListResponseContract } from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { closeDatabase } from '../../src/db/client';
import { WorkspaceNotFoundError } from '../../src/workspaces/workspace-not-found.error';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  authServerEnv,
  clearSignupState,
  eraseTenant,
  jwtClaims,
  membershipsFor,
  mintToken,
  signIn,
  signUp,
  usersFor,
} from '../support/auth-fixture';
import { execSql, querySql } from '../support/psql';
import { assertAppRoleCannotBypassRls, migrationDsn } from '../support/rls-fixture';

/**
 * STORY-004 — AC-21, AC-22, AC-23, AC-24, end to end. TASK-012, wave 7.
 * STORY-1b-04 — AC-1b-17, AC-1b-18, AC-1b-19 (and AC-1b-21 repeated cheaply) on the SHIPPED
 * routes. TASK-1b-06, wave 3 of 1b: the creator's membership, the membership-filtered list,
 * `GET /api/workspaces/:workspaceId`, `workspace_admin` on the writes, `workspaceRole` on
 * the wire.
 *
 * Contract: `docs/contracts/workspaces.md` ("Endpoints", "The repository"),
 * `docs/contracts/error-envelope.md` (invariants 1, 4, 5; `ERROR_CODE_STATUS` normative),
 * `docs/contracts/workspace-authorization.md` ("Minimum role per surface", "Status rules"),
 * `docs/contracts/auth-tokens.md`. ADR-0006, ADR-0024, ADR-0025, ADR-0062; D-07, D-10.
 *
 * ============================================================================
 * THE SAME TWO-PROCESS SHAPE AS `test/tenancy/request-tenant-binding.int-spec.ts`, WITH NO
 * PROBE: THE ROUTES UNDER TEST ARE THE REAL ONES IN `AppModule`.
 * ============================================================================
 *
 * The child booted by `api-server.ts` is the only place a real sign-in can happen and a real
 * token can be minted against a real `/api/auth/jwks`. The application under test is built
 * from `AppModule` IN THIS PROCESS — the real `APP_GUARD`, the real `APP_INTERCEPTOR`, the
 * real filter, the real `WorkspacesModule`, nothing overridden — with `BETTER_AUTH_URL`
 * pointed at the child so the guard verifies the child's token against the child's key set,
 * and with the same `/api` global prefix `main.ts` sets, so the paths asserted here are the
 * paths a client uses. One test at the end also drives the CHILD's own `/api/workspaces`,
 * so "the module is registered in the composition root that ships" is asserted rather than
 * assumed.
 *
 * Every row this suite creates lands under the tenant a signup created; `clearSignupState`
 * erases those tenants and the workspaces cascade with them (`ON DELETE CASCADE`), which is
 * how each test starts from an empty tenant without touching the table by hand. The count
 * AC-24 needs is read through the migrator with the tenant flag set: FORCE ROW LEVEL
 * SECURITY subjects the owner to the policy too.
 *
 * A SECOND USER IN THE SAME TENANT (AC-1b-18/19). Signup gives every address its own
 * tenant, and 1b's routes have no add-member endpoint, so the second user is MOVED: signed
 * up as `EMAIL_B`, their own tenant erased (which cascades their `tenant_memberships` row),
 * a `member` row inserted under A's tenant through the migrator, and only then signed in
 * and minted — the token's `tid` is read from the membership at mint time, so it names A.
 * Their workspace roles are seeded directly, the way `workspace-authorization.int-spec.ts`
 * seeds them, because granting one is the invitation flow's and not this card's.
 *
 * ONE PAIR OF ADDRESSES PER TEST, numbered. The child API runs the shipped auth surface, and
 * since TASK-1b-09 that surface charges an email-keyed sign-in bucket (5 per 15 minutes,
 * `rate-limit.md`) that a file signing one address in once per test would exhaust by its
 * sixth test. Numbering the pair per test keeps every address under the limit without
 * touching the bucket, and `clearSignupState` runs on the current pair before each test —
 * which also self-heals a run killed before `afterAll` (the same numbered pair is cleared
 * before it is signed up again).
 */

const ADDRESS_STEM = 'wave3-workspaces';
let testNumber = 0;
let EMAIL_A = '';
let EMAIL_B = '';

function addressesFor(n: number): [string, string] {
  return [`${ADDRESS_STEM}-a-${String(n)}@example.com`, `${ADDRESS_STEM}-b-${String(n)}@example.com`];
}

const NOT_A_UUID = 'not-a-uuid';
const NEVER_ISSUED = '00000000-0000-4000-8000-000000000000';

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

let app: INestApplication | undefined;
let baseUrl: string;

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

interface ProbeOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly token?: string;
  /** JSON-encoded when an object; sent verbatim when a string, for a malformed body. */
  readonly body?: unknown;
}

async function request(origin: string, path: string, options: ProbeOptions = {}): Promise<Probe> {
  const payload =
    options.body === undefined
      ? undefined
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);

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

/** Against the in-process application. */
function api(path: string, options: ProbeOptions = {}): Promise<Probe> {
  return request(baseUrl, path, options);
}

interface Principal {
  readonly token: string;
  readonly tenantId: string;
  readonly userId: string;
}

/** Sign in and mint for an address already signed up: the token, its tenant, its user. */
async function signInAndMint(email: string): Promise<Principal> {
  const signedIn = await signIn(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);

  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  const token = (minted.body as { token?: unknown }).token;
  expect(typeof token).toBe('string');

  const claims = jwtClaims(token as string);
  expect(typeof claims.tid).toBe('string');
  expect(typeof claims.sub).toBe('string');

  return { token: token as string, tenantId: claims.tid as string, userId: claims.sub as string };
}

/** Sign up, sign in, mint: the token a real BFF would hold, and the tenant behind it. */
async function principalFor(email: string): Promise<Principal> {
  const signedUp = await signUp(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);

  return signInAndMint(email);
}

/**
 * A second real user IN `tenantId`, holding tenant role `member` (what an invitee holds,
 * Amendment A-8) and no workspace membership: signed up under their own tenant, moved
 * before the mint (see the header). `EMAIL_B`'s own tenant is erased here rather than
 * stranded — `clearSignupState` finds tenants only through membership rows.
 */
async function tenantMemberFor(email: string, tenantId: string): Promise<Principal> {
  const signedUp = await signUp(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);
  const [user] = usersFor(email);
  expect(user, `signup wrote no user row for ${email}`).toBeDefined();

  const [own] = membershipsFor(user.id);
  expect(own, `signup wrote no tenant membership for ${email}`).toBeDefined();
  expect(own.tenantId).not.toBe(tenantId);
  eraseTenant(own.tenantId);
  execSql(
    migrationDsn(),
    `INSERT INTO tenant_memberships (tenant_id, user_id, role)
     VALUES (:'tenant_id'::uuid, :'user_id', 'member'::tenant_role)`,
    { tenantId, variables: { tenant_id: tenantId, user_id: user.id } },
  );

  const moved = await signInAndMint(email);
  expect(moved.tenantId).toBe(tenantId);
  expect(moved.userId).toBe(user.id);

  return moved;
}

/** Seeds a `memberships` row through the migrator under the tenant's flag (as 05's spec does). */
function seedMembership(tenantId: string, workspaceId: string, userId: string, role: string): void {
  execSql(
    migrationDsn(),
    `INSERT INTO memberships (tenant_id, workspace_id, user_id, role)
     VALUES (:'tenant_id'::uuid, :'workspace_id'::uuid, :'user_id', :'role'::workspace_role)`,
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

/** The `memberships` rows of one workspace, read through the owner with the tenant's flag. */
function membershipsOf(tenantId: string, workspaceId: string): Array<{ userId: string; role: string }> {
  return querySql<{ userId: string; role: string }>(
    migrationDsn(),
    `select user_id as "userId", role::text as role from memberships
      where tenant_id = :'tenant_id'::uuid and workspace_id = :'workspace_id'::uuid order by created_at`,
    { tenantId, variables: { tenant_id: tenantId, workspace_id: workspaceId } },
  );
}

/** The name a workspace row carries right now, read through the owner with the tenant's flag. */
function nameOf(tenantId: string, workspaceId: string): string | undefined {
  const [row] = querySql<{ name: string }>(
    migrationDsn(),
    `select name from workspaces where tenant_id = :'tenant_id'::uuid and id = :'workspace_id'::uuid`,
    { tenantId, variables: { tenant_id: tenantId, workspace_id: workspaceId } },
  );

  return row?.name;
}

const CLIENT_KEYS = ['archivedAt', 'createdAt', 'id', 'name', 'updatedAt', 'workspaceRole'];
const NOT_FOUND_BODY = new WorkspaceNotFoundError().toEnvelope();

/** How many `workspaces` rows a tenant owns, read through the owner with that tenant's flag. */
function workspaceCountFor(tenantId: string): number {
  const [row] = querySql<{ n: number }>(
    migrationDsn(),
    `select count(*)::int as n from workspaces where tenant_id = :'tenant_id'::uuid`,
    { tenantId, variables: { tenant_id: tenantId } },
  );

  return row?.n ?? -1;
}

/** Creates a workspace as `principal` and returns the parsed body, asserting the 201. */
async function createWorkspace(principal: Principal, name: string): Promise<{ id: string; name: string }> {
  const created = await api('/api/workspaces', { method: 'POST', token: principal.token, body: { name } });

  expect(created.status, created.raw).toBe(201);
  expect(workspaceContract.safeParse(created.body).success, created.raw).toBe(true);

  return created.body as { id: string; name: string };
}

function expectEnvelope(probe: Probe, code: string): void {
  expect(errorEnvelopeContract.safeParse(probe.body).success, probe.raw).toBe(true);
  expect((probe.body as { code: string }).code).toBe(code);
}

function fieldErrorsOf(probe: Probe): Record<string, string[]> {
  const details = (probe.body as { details?: unknown }).details;
  const parsed = validationDetailsContract.safeParse(details);

  expect(parsed.success, probe.raw).toBe(true);

  return parsed.success ? parsed.data.fieldErrors : {};
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // The same prefix and exclusion `main.ts` sets (ADR-0006), so the paths asserted below
    // are the ones a client uses and not a test-only spelling.
    app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();

    // The in-process server never closes an idle keep-alive socket: `psql` spawns in
    // `beforeEach` block the loop past Node's default 5 s idle timeout, and the pooled socket
    // is torn down as the next request is written (`request-tenant-binding.int-spec.ts`,
    // observed there). `0` disables the idle timeout; `app.close()` still closes the sockets.
    (app.getHttpServer() as Server).keepAliveTimeout = 0;
  }

  testNumber += 1;
  [EMAIL_A, EMAIL_B] = addressesFor(testNumber);
  // Both addresses in one call: `clearSignupState` empties `user` for every address, so two
  // calls would strand the second address's tenant (see the fixture's docblock).
  clearSignupState(EMAIL_A, EMAIL_B);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeDatabase();
  vi.unstubAllEnvs();
  clearSignupState(EMAIL_A, EMAIL_B);
  await server?.stop();
});

describe('AC-21: create, then list', () => {
  it('a signed-in operator with no workspaces creates Acme: 201 with id and name, and the list holds exactly it', async () => {
    const principal = await principalFor(EMAIL_A);

    const listedBefore = await api('/api/workspaces', { token: principal.token });
    expect(listedBefore.status, listedBefore.raw).toBe(200);
    expect(listedBefore.body).toEqual({ items: [] });

    const created = await api('/api/workspaces', { method: 'POST', token: principal.token, body: { name: 'Acme' } });

    expect(created.status, created.raw).toBe(201);
    const workspace = workspaceContract.parse(created.body);
    expect(workspace.name).toBe('Acme');
    expect(workspace.archivedAt).toBeNull();
    // Six client fields and no `tenantId` (docs/contracts/workspaces.md, "Endpoints").
    expect(Object.keys(created.body as object).sort()).toEqual(CLIENT_KEYS);
    expect(workspace.workspaceRole).toBe('workspace_admin');

    const listed = await api('/api/workspaces', { token: principal.token });

    expect(listed.status, listed.raw).toBe(200);
    const list = workspaceListResponseContract.parse(listed.body);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toEqual(workspace);
    expect(workspaceCountFor(principal.tenantId)).toBe(1);
  });

  it('the name is stored trimmed', async () => {
    const principal = await principalFor(EMAIL_A);

    const created = await api('/api/workspaces', { method: 'POST', token: principal.token, body: { name: '  Acme  ' } });

    expect(created.status, created.raw).toBe(201);
    expect((created.body as { name: string }).name).toBe('Acme');
  });
});

describe('AC-22: rename', () => {
  it('renaming to Acme Group answers 200, the list shows Acme Group, and the id is unchanged', async () => {
    const principal = await principalFor(EMAIL_A);
    const acme = await createWorkspace(principal, 'Acme');

    const renamed = await api(`/api/workspaces/${acme.id}`, { method: 'PATCH', token: principal.token, body: { name: 'Acme Group' } });

    expect(renamed.status, renamed.raw).toBe(200);
    const workspace = workspaceContract.parse(renamed.body);
    expect(workspace.id).toBe(acme.id);
    expect(workspace.name).toBe('Acme Group');

    const listed = await api('/api/workspaces', { token: principal.token });
    const list = workspaceListResponseContract.parse(listed.body);
    expect(list.items.map((item) => [item.id, item.name])).toEqual([[acme.id, 'Acme Group']]);
  });

  it('an archived workspace can still be renamed (route policy, docs/contracts/workspaces.md)', async () => {
    const principal = await principalFor(EMAIL_A);
    const acme = await createWorkspace(principal, 'Acme');
    const archived = await api(`/api/workspaces/${acme.id}/archive`, { method: 'POST', token: principal.token });
    expect(archived.status, archived.raw).toBe(200);

    const renamed = await api(`/api/workspaces/${acme.id}`, { method: 'PATCH', token: principal.token, body: { name: 'Acme, retired' } });

    expect(renamed.status, renamed.raw).toBe(200);
    const workspace = workspaceContract.parse(renamed.body);
    expect(workspace.name).toBe('Acme, retired');
    expect(workspace.archivedAt).not.toBeNull();
  });
});

describe('AC-23: archive', () => {
  it('archiving answers 200; the default list excludes it; includeArchived=true includes it with archivedAt set', async () => {
    const principal = await principalFor(EMAIL_A);
    const acme = await createWorkspace(principal, 'Acme');
    const kept = await createWorkspace(principal, 'Kept');

    const archived = await api(`/api/workspaces/${acme.id}/archive`, { method: 'POST', token: principal.token });

    expect(archived.status, archived.raw).toBe(200);
    const workspace = workspaceContract.parse(archived.body);
    expect(workspace.id).toBe(acme.id);
    expect(workspace.archivedAt).toEqual(expect.any(String));

    const defaultList = workspaceListResponseContract.parse((await api('/api/workspaces', { token: principal.token })).body);
    expect(defaultList.items.map((item) => item.id)).toEqual([kept.id]);

    const explicitlyActive = workspaceListResponseContract.parse(
      (await api('/api/workspaces?includeArchived=false', { token: principal.token })).body,
    );
    expect(explicitlyActive.items.map((item) => item.id)).toEqual([kept.id]);

    const withArchived = workspaceListResponseContract.parse(
      (await api('/api/workspaces?includeArchived=true', { token: principal.token })).body,
    );
    expect(withArchived.items.map((item) => [item.id, item.archivedAt])).toEqual([
      [acme.id, workspace.archivedAt],
      [kept.id, null],
    ]);
  });

  it('archive is idempotent: a second call answers 200 with the first archival\'s timestamp', async () => {
    const principal = await principalFor(EMAIL_A);
    const acme = await createWorkspace(principal, 'Acme');

    const first = await api(`/api/workspaces/${acme.id}/archive`, { method: 'POST', token: principal.token });
    const second = await api(`/api/workspaces/${acme.id}/archive`, { method: 'POST', token: principal.token });

    expect(first.status, first.raw).toBe(200);
    expect(second.status, second.raw).toBe(200);
    expect((second.body as { archivedAt: string }).archivedAt).toBe((first.body as { archivedAt: string }).archivedAt);
  });
});

describe('AC-24: an invalid name', () => {
  it.each([
    ['an empty name', ''],
    ['a whitespace-only name', '   '],
    ['a 101-character name', 'a'.repeat(101)],
  ])('%s: the validation status, an envelope-shaped body, details under name, and no row created', async (_label, name) => {
    const principal = await principalFor(EMAIL_A);

    const refused = await api('/api/workspaces', { method: 'POST', token: principal.token, body: { name } });

    expect(refused.status, refused.raw).toBe(ERROR_CODE_STATUS.validation_failed);
    expectEnvelope(refused, 'validation_failed');
    expect(fieldErrorsOf(refused).name?.length ?? 0).toBeGreaterThan(0);
    expect(workspaceCountFor(principal.tenantId)).toBe(0);
  });

  it('a body with no name keys the issue under name and creates no row', async () => {
    const principal = await principalFor(EMAIL_A);

    const refused = await api('/api/workspaces', { method: 'POST', token: principal.token, body: {} });

    expect(refused.status, refused.raw).toBe(ERROR_CODE_STATUS.validation_failed);
    expectEnvelope(refused, 'validation_failed');
    expect(fieldErrorsOf(refused).name?.length ?? 0).toBeGreaterThan(0);
    expect(workspaceCountFor(principal.tenantId)).toBe(0);
  });

  it('rename applies the same rule: a 101-character name is refused under name and the row keeps its name', async () => {
    const principal = await principalFor(EMAIL_A);
    const acme = await createWorkspace(principal, 'Acme');

    const refused = await api(`/api/workspaces/${acme.id}`, { method: 'PATCH', token: principal.token, body: { name: 'a'.repeat(101) } });

    expect(refused.status, refused.raw).toBe(ERROR_CODE_STATUS.validation_failed);
    expectEnvelope(refused, 'validation_failed');
    expect(fieldErrorsOf(refused).name?.length ?? 0).toBeGreaterThan(0);

    const listed = workspaceListResponseContract.parse((await api('/api/workspaces', { token: principal.token })).body);
    expect(listed.items.map((item) => item.name)).toEqual(['Acme']);
  });

  it('a body that is not JSON is refused with the envelope, the issue under _form, and no row created', async () => {
    const principal = await principalFor(EMAIL_A);

    const refused = await api('/api/workspaces', { method: 'POST', token: principal.token, body: '{"name": "Acme"' });

    expect(refused.status, refused.raw).toBe(ERROR_CODE_STATUS.validation_failed);
    expectEnvelope(refused, 'validation_failed');
    expect(fieldErrorsOf(refused)._form?.length ?? 0).toBeGreaterThan(0);
    expect(workspaceCountFor(principal.tenantId)).toBe(0);
  });

  it('includeArchived=maybe is 400 validation_failed keyed under includeArchived', async () => {
    const principal = await principalFor(EMAIL_A);

    const refused = await api('/api/workspaces?includeArchived=maybe', { token: principal.token });

    expect(refused.status, refused.raw).toBe(ERROR_CODE_STATUS.validation_failed);
    expectEnvelope(refused, 'validation_failed');
    expect(fieldErrorsOf(refused).includeArchived?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('authentication and tenancy', () => {
  it('no Authorization header: 401 unauthenticated on every route, and nothing is written', async () => {
    const principal = await principalFor(EMAIL_A);
    const acme = await createWorkspace(principal, 'Acme');

    const attempts = await Promise.all([
      api('/api/workspaces', { method: 'POST', body: { name: 'Stranger' } }),
      api('/api/workspaces'),
      api(`/api/workspaces/${acme.id}`),
      api(`/api/workspaces/${acme.id}`, { method: 'PATCH', body: { name: 'Stranger' } }),
      api(`/api/workspaces/${acme.id}/archive`, { method: 'POST' }),
    ]);

    for (const attempt of attempts) {
      expect(attempt.status, attempt.raw).toBe(ERROR_CODE_STATUS.unauthenticated);
      expectEnvelope(attempt, 'unauthenticated');
    }

    const listed = workspaceListResponseContract.parse((await api('/api/workspaces?includeArchived=true', { token: principal.token })).body);
    expect(listed.items.map((item) => [item.id, item.name, item.archivedAt])).toEqual([[acme.id, 'Acme', null]]);
    expect(workspaceCountFor(principal.tenantId)).toBe(1);
  });

  it("a second tenant sees an empty list, and gets 404 not_found on the first tenant's id for rename and archive; the row is untouched", async () => {
    const first = await principalFor(EMAIL_A);
    const acme = await createWorkspace(first, 'Acme');
    const second = await principalFor(EMAIL_B);
    expect(second.tenantId).not.toBe(first.tenantId);

    const theirList = await api('/api/workspaces?includeArchived=true', { token: second.token });
    expect(theirList.status, theirList.raw).toBe(200);
    expect(theirList.body).toEqual({ items: [] });

    const get = await api(`/api/workspaces/${acme.id}`, { token: second.token });
    const rename = await api(`/api/workspaces/${acme.id}`, { method: 'PATCH', token: second.token, body: { name: 'Taken' } });
    const archive = await api(`/api/workspaces/${acme.id}/archive`, { method: 'POST', token: second.token });

    // Invariant 5: cross-tenant is 404 `not_found`, never 403, and the body carries no id.
    for (const attempt of [get, rename, archive]) {
      expect(attempt.status, attempt.raw).toBe(ERROR_CODE_STATUS.not_found);
      expectEnvelope(attempt, 'not_found');
      expect(attempt.raw).not.toContain(acme.id);
      expect(attempt.body).toEqual(NOT_FOUND_BODY);
    }

    const ownersView = workspaceListResponseContract.parse((await api('/api/workspaces?includeArchived=true', { token: first.token })).body);
    expect(ownersView.items.map((item) => [item.id, item.name, item.archivedAt])).toEqual([[acme.id, 'Acme', null]]);
    expect(workspaceCountFor(second.tenantId)).toBe(0);
  });

  it('a malformed id and a never-issued id are the same 404 not_found as another tenant\'s id — byte-equal to the repository\'s WorkspaceNotFoundError (the oracle rule)', async () => {
    const principal = await principalFor(EMAIL_A);

    const malformedGet = await api(`/api/workspaces/${NOT_A_UUID}`, { token: principal.token });
    const malformedRename = await api(`/api/workspaces/${NOT_A_UUID}`, { method: 'PATCH', token: principal.token, body: { name: 'x' } });
    const malformedArchive = await api(`/api/workspaces/${NOT_A_UUID}/archive`, { method: 'POST', token: principal.token });
    const missingGet = await api(`/api/workspaces/${NEVER_ISSUED}`, { token: principal.token });
    const missingRename = await api(`/api/workspaces/${NEVER_ISSUED}`, { method: 'PATCH', token: principal.token, body: { name: 'x' } });
    const missingArchive = await api(`/api/workspaces/${NEVER_ISSUED}/archive`, { method: 'POST', token: principal.token });

    for (const attempt of [malformedGet, malformedRename, malformedArchive, missingGet, missingRename, missingArchive]) {
      expect(attempt.status, attempt.raw).toBe(ERROR_CODE_STATUS.not_found);
      expectEnvelope(attempt, 'not_found');
      // The interceptor's 404 (no membership: a non-uuid never reaches Postgres, a never-issued
      // id has no row) is the body the repository gives a missing row.
      expect(attempt.body).toEqual(NOT_FOUND_BODY);
    }

    // Indistinguishable, byte for byte: the same body for a malformed id and a well-formed miss.
    expect(malformedGet.raw).toBe(missingGet.raw);
    expect(malformedRename.raw).toBe(missingRename.raw);
    expect(malformedArchive.raw).toBe(missingArchive.raw);
  });
});

describe('AC-1b-17: the creator becomes workspace_admin; a tenant member cannot create', () => {
  it('POST as the signup owner: 201 with workspaceRole workspace_admin, and exactly one memberships row — the creator, workspace_admin — committed with the workspace', async () => {
    const owner = await principalFor(EMAIL_A);

    const created = await api('/api/workspaces', { method: 'POST', token: owner.token, body: { name: 'Acme' } });

    expect(created.status, created.raw).toBe(201);
    const workspace = workspaceContract.parse(created.body);
    expect(workspace.workspaceRole).toBe('workspace_admin');
    expect(membershipsOf(owner.tenantId, workspace.id)).toEqual([{ userId: owner.userId, role: 'workspace_admin' }]);
    expect(workspaceCountFor(owner.tenantId)).toBe(1);

    // And the membership is what lets the creator reach the row on every route.
    expect((await api(`/api/workspaces/${workspace.id}`, { token: owner.token })).status).toBe(200);
  });

  it('POST as a tenant member (an invitee\'s tenant role): 403 insufficient_tenant_role, no workspace and no membership written', async () => {
    const owner = await principalFor(EMAIL_A);
    const member = await tenantMemberFor(EMAIL_B, owner.tenantId);

    const refused = await api('/api/workspaces', { method: 'POST', token: member.token, body: { name: 'Not mine to make' } });

    expect(refused.status, refused.raw).toBe(ERROR_CODE_STATUS.insufficient_tenant_role);
    expectEnvelope(refused, 'insufficient_tenant_role');
    expect(workspaceCountFor(owner.tenantId)).toBe(0);
  });
});

describe('AC-1b-18: the list and the read by id are membership-filtered', () => {
  it('a member of W1 only lists exactly [W1] with workspaceRole member; GET W1 is 200 with the same role; GET W2 (same tenant, no membership) is 404 with the nonexistent-id body', async () => {
    const owner = await principalFor(EMAIL_A);
    const w1 = await createWorkspace(owner, 'W1');
    const w2 = await createWorkspace(owner, 'W2');
    const member = await tenantMemberFor(EMAIL_B, owner.tenantId);
    seedMembership(owner.tenantId, w1.id, member.userId, 'member');

    // The owner, who created both, sees both as admin.
    const ownersList = workspaceListResponseContract.parse((await api('/api/workspaces', { token: owner.token })).body);
    expect(ownersList.items.map((item) => [item.id, item.workspaceRole])).toEqual([[w1.id, 'workspace_admin'], [w2.id, 'workspace_admin']]);

    // The member sees W1 and only W1, with their own role — not the owner's.
    const membersList = await api('/api/workspaces?includeArchived=true', { token: member.token });
    expect(membersList.status, membersList.raw).toBe(200);
    const list = workspaceListResponseContract.parse(membersList.body);
    expect(list.items.map((item) => [item.id, item.name, item.workspaceRole])).toEqual([[w1.id, 'W1', 'member']]);
    expect(Object.keys(list.items[0] ?? {}).sort()).toEqual(CLIENT_KEYS);

    const readW1 = await api(`/api/workspaces/${w1.id}`, { token: member.token });
    expect(readW1.status, readW1.raw).toBe(200);
    expect(workspaceContract.parse(readW1.body)).toEqual({ ...list.items[0] });

    const readW2 = await api(`/api/workspaces/${w2.id}`, { token: member.token });
    const readNever = await api(`/api/workspaces/${NEVER_ISSUED}`, { token: member.token });
    expect(readW2.status, readW2.raw).toBe(ERROR_CODE_STATUS.not_found);
    expect(readW2.raw).toBe(readNever.raw);
    expect(readW2.body).toEqual(NOT_FOUND_BODY);
    expect(readW2.raw).not.toContain(w2.id);
  });

  it('a same-tenant user with no memberships lists { items: [] } — not a refusal — while the owner still sees their workspaces', async () => {
    const owner = await principalFor(EMAIL_A);
    const acme = await createWorkspace(owner, 'Acme');
    const stranger = await tenantMemberFor(EMAIL_B, owner.tenantId);

    const theirs = await api('/api/workspaces?includeArchived=true', { token: stranger.token });
    expect(theirs.status, theirs.raw).toBe(200);
    expect(theirs.body).toEqual({ items: [] });

    const ownersView = workspaceListResponseContract.parse((await api('/api/workspaces', { token: owner.token })).body);
    expect(ownersView.items.map((item) => item.id)).toEqual([acme.id]);
  });

  it('there is no implicit tenant-owner bypass: the owner loses sight of a workspace whose membership row is gone, and gets 404 on it', async () => {
    const owner = await principalFor(EMAIL_A);
    const acme = await createWorkspace(owner, 'Acme');
    const kept = await createWorkspace(owner, 'Kept');
    execSql(
      migrationDsn(),
      `DELETE FROM memberships WHERE tenant_id = :'tenant_id'::uuid AND workspace_id = :'workspace_id'::uuid`,
      {
        tenantId: owner.tenantId,
        variables: { tenant_id: owner.tenantId, workspace_id: acme.id },
        flags: { 'app.privileged_erase': owner.tenantId },
      },
    );

    const listed = workspaceListResponseContract.parse((await api('/api/workspaces?includeArchived=true', { token: owner.token })).body);
    expect(listed.items.map((item) => item.id)).toEqual([kept.id]);
    expect((await api(`/api/workspaces/${acme.id}`, { token: owner.token })).body).toEqual(NOT_FOUND_BODY);
    expect((await api(`/api/workspaces/${acme.id}`, { method: 'PATCH', token: owner.token, body: { name: 'x' } })).body).toEqual(NOT_FOUND_BODY);
    // The row is still there — invisible, not gone (docs/contracts/workspaces.md, the pre-1b volume note).
    expect(workspaceCountFor(owner.tenantId)).toBe(2);
  });
});

describe('AC-1b-19: workspace_admin on the writes, any membership on the reads', () => {
  it('member on W1: 403 insufficient_workspace_role on rename and archive, the row unchanged; promoted to workspace_admin directly, the next request succeeds (AC-1b-21)', async () => {
    const owner = await principalFor(EMAIL_A);
    const w1 = await createWorkspace(owner, 'W1');
    const member = await tenantMemberFor(EMAIL_B, owner.tenantId);
    seedMembership(owner.tenantId, w1.id, member.userId, 'member');

    const rename = await api(`/api/workspaces/${w1.id}`, { method: 'PATCH', token: member.token, body: { name: 'Taken over' } });
    const archive = await api(`/api/workspaces/${w1.id}/archive`, { method: 'POST', token: member.token });

    for (const refused of [rename, archive]) {
      expect(refused.status, refused.raw).toBe(ERROR_CODE_STATUS.insufficient_workspace_role);
      expectEnvelope(refused, 'insufficient_workspace_role');
    }
    expect(nameOf(owner.tenantId, w1.id)).toBe('W1');
    const stillActive = workspaceContract.parse((await api(`/api/workspaces/${w1.id}`, { token: owner.token })).body);
    expect(stillActive.archivedAt).toBeNull();

    // AC-1b-21: the role changed in the table applies to the very next request — no cache.
    setMembershipRole(owner.tenantId, w1.id, member.userId, 'workspace_admin');
    const renamed = await api(`/api/workspaces/${w1.id}`, { method: 'PATCH', token: member.token, body: { name: 'Shared now' } });
    expect(renamed.status, renamed.raw).toBe(200);
    expect(workspaceContract.parse(renamed.body)).toMatchObject({ id: w1.id, name: 'Shared now', workspaceRole: 'workspace_admin' });
  });

  it('viewer on W1, seeded directly: every write is 403 insufficient_workspace_role and GET is 200 with workspaceRole viewer', async () => {
    const owner = await principalFor(EMAIL_A);
    const w1 = await createWorkspace(owner, 'W1');
    const viewer = await tenantMemberFor(EMAIL_B, owner.tenantId);
    seedMembership(owner.tenantId, w1.id, viewer.userId, 'viewer');

    const rename = await api(`/api/workspaces/${w1.id}`, { method: 'PATCH', token: viewer.token, body: { name: 'Nope' } });
    const archive = await api(`/api/workspaces/${w1.id}/archive`, { method: 'POST', token: viewer.token });
    for (const refused of [rename, archive]) {
      expect(refused.status, refused.raw).toBe(ERROR_CODE_STATUS.insufficient_workspace_role);
      expectEnvelope(refused, 'insufficient_workspace_role');
    }

    const read = await api(`/api/workspaces/${w1.id}`, { token: viewer.token });
    expect(read.status, read.raw).toBe(200);
    expect(workspaceContract.parse(read.body)).toMatchObject({ id: w1.id, name: 'W1', workspaceRole: 'viewer' });

    const listed = workspaceListResponseContract.parse((await api('/api/workspaces', { token: viewer.token })).body);
    expect(listed.items.map((item) => [item.id, item.workspaceRole])).toEqual([[w1.id, 'viewer']]);
  });

  it('the creator, workspace_admin: rename and archive are 200 and carry workspaceRole workspace_admin', async () => {
    const owner = await principalFor(EMAIL_A);
    const acme = await createWorkspace(owner, 'Acme');

    const renamed = await api(`/api/workspaces/${acme.id}`, { method: 'PATCH', token: owner.token, body: { name: 'Acme Group' } });
    expect(renamed.status, renamed.raw).toBe(200);
    expect(workspaceContract.parse(renamed.body)).toMatchObject({ id: acme.id, name: 'Acme Group', workspaceRole: 'workspace_admin' });

    const archived = await api(`/api/workspaces/${acme.id}/archive`, { method: 'POST', token: owner.token });
    expect(archived.status, archived.raw).toBe(200);
    expect(workspaceContract.parse(archived.body)).toMatchObject({ id: acme.id, workspaceRole: 'workspace_admin' });
    expect((archived.body as { archivedAt: unknown }).archivedAt).toEqual(expect.any(String));
  });
});

describe('the shipped composition root', () => {
  it('the child API — main.ts, the real prefix — serves the same routes: create then list through it', async () => {
    const principal = await principalFor(EMAIL_A);

    const created = await request(server.baseUrl, '/api/workspaces', { method: 'POST', token: principal.token, body: { name: 'Acme' } });

    expect(created.status, `${created.raw}\n${server.output()}`).toBe(201);
    const workspace = workspaceContract.parse(created.body);

    const listed = await request(server.baseUrl, '/api/workspaces', { token: principal.token });

    expect(listed.status, listed.raw).toBe(200);
    expect(workspaceListResponseContract.parse(listed.body).items).toEqual([workspace]);
  });
});
