import type { Server } from 'node:http';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ERROR_CODE_STATUS, errorEnvelopeContract, validationDetailsContract, workspaceContract, workspaceListResponseContract } from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { closeDatabase } from '../../src/db/client';
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
} from '../support/auth-fixture';
import { querySql } from '../support/psql';
import { assertAppRoleCannotBypassRls, migrationDsn } from '../support/rls-fixture';

/**
 * STORY-004 — AC-21, AC-22, AC-23, AC-24, end to end. TASK-012, wave 7.
 *
 * Contract: `docs/contracts/workspaces.md` ("Endpoints", "The repository"),
 * `docs/contracts/error-envelope.md` (invariants 1, 4, 5; `ERROR_CODE_STATUS` normative),
 * `docs/contracts/auth-tokens.md`. ADR-0006, ADR-0024, ADR-0025.
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
 */

const EMAIL_A = 'wave7-workspaces-a@example.com';
const EMAIL_B = 'wave7-workspaces-b@example.com';

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
}

/** Sign up, sign in, mint: the token a real BFF would hold, and the tenant behind it. */
async function principalFor(email: string): Promise<Principal> {
  const signedUp = await signUp(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);

  const signedIn = await signIn(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);

  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  const token = (minted.body as { token?: unknown }).token;
  expect(typeof token).toBe('string');

  const tid = jwtClaims(token as string).tid;
  expect(typeof tid).toBe('string');

  return { token: token as string, tenantId: tid as string };
}

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
    // Five client fields and no `tenantId` (docs/contracts/workspaces.md, "Endpoints").
    expect(Object.keys(created.body as object).sort()).toEqual(['archivedAt', 'createdAt', 'id', 'name', 'updatedAt']);

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

    const rename = await api(`/api/workspaces/${acme.id}`, { method: 'PATCH', token: second.token, body: { name: 'Taken' } });
    const archive = await api(`/api/workspaces/${acme.id}/archive`, { method: 'POST', token: second.token });

    // Invariant 5: cross-tenant is 404 `not_found`, never 403, and the body carries no id.
    expect(rename.status, rename.raw).toBe(ERROR_CODE_STATUS.not_found);
    expectEnvelope(rename, 'not_found');
    expect(rename.raw).not.toContain(acme.id);
    expect(archive.status, archive.raw).toBe(ERROR_CODE_STATUS.not_found);
    expectEnvelope(archive, 'not_found');
    expect(archive.raw).not.toContain(acme.id);

    const ownersView = workspaceListResponseContract.parse((await api('/api/workspaces?includeArchived=true', { token: first.token })).body);
    expect(ownersView.items.map((item) => [item.id, item.name, item.archivedAt])).toEqual([[acme.id, 'Acme', null]]);
    expect(workspaceCountFor(second.tenantId)).toBe(0);
  });

  it('a malformed id and a never-issued id are the same 404 not_found as another tenant\'s id', async () => {
    const principal = await principalFor(EMAIL_A);

    const malformedRename = await api(`/api/workspaces/${NOT_A_UUID}`, { method: 'PATCH', token: principal.token, body: { name: 'x' } });
    const malformedArchive = await api(`/api/workspaces/${NOT_A_UUID}/archive`, { method: 'POST', token: principal.token });
    const missingRename = await api(`/api/workspaces/${NEVER_ISSUED}`, { method: 'PATCH', token: principal.token, body: { name: 'x' } });
    const missingArchive = await api(`/api/workspaces/${NEVER_ISSUED}/archive`, { method: 'POST', token: principal.token });

    for (const attempt of [malformedRename, malformedArchive, missingRename, missingArchive]) {
      expect(attempt.status, attempt.raw).toBe(ERROR_CODE_STATUS.not_found);
      expectEnvelope(attempt, 'not_found');
    }

    // Indistinguishable: the same body for a malformed id and a well-formed miss.
    expect(malformedRename.body).toEqual(missingRename.body);
    expect(malformedArchive.body).toEqual(missingArchive.body);
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
