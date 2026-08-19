import type { Server } from 'node:http';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import type { PoolClient } from 'pg';
import {
  clickEventContract,
  errorEnvelopeContract,
  paginated,
  validationDetailsContract,
} from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTransaction, SEED_TRANSACTIONS } from '../../scripts/seed.mts';
import { AppModule } from '../../src/app.module';
import { ClickEventReaderRepository } from '../../src/clicks/click-event.reader';
import { ClickEventWriterRepository } from '../../src/clicks/click-event.writer';
import { ClicksController } from '../../src/clicks/clicks.controller';
import { ClicksService } from '../../src/clicks/clicks.service';
import { closeDatabase } from '../../src/db/client';
import { PLATFORM_TENANT_ID, SYSTEM_DEFAULT_DOMAIN_ID } from '../../src/db/platform';
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
import { execSql, querySql } from '../support/psql';
import { appDsn, assertAppRoleCannotBypassRls, migrationDsn } from '../support/rls-fixture';

/**
 * AC-2-39 end to end on the shipped route, and the AC-60-style enumeration over the clicks
 * module's tenant-facing surface. TASK-2-09, wave 4.
 *
 * Contract: `docs/contracts/click-events.md` (invariants 5 and 6), `workspace-authorization.md`
 * ("Minimum role per surface", Form B, "Status rules"), `error-envelope.md` (invariants 1,
 * 5), `pagination`. D-2-12, D-2-19.
 *
 * THE TWO-PROCESS SHAPE `links.int-spec.ts` USES, for the reason its header gives: the child
 * booted by `api-server.ts` is where a real sign-in happens and a real token is minted
 * against a real `/api/auth/jwks`; the application under test is built from `AppModule` IN
 * THIS PROCESS, with every real guard, interceptor and filter, and no provider overridden.
 *
 * THE CLICK ROWS ARE PLANTED WITH SQL RATHER THAN DRIVEN THROUGH THE REDIRECT. What this
 * file is about is the READ: the role, the order, the window, the cursor and the wire shape.
 * `click-emission.int-spec.ts` owns the write, and driving the redirect here would make each
 * assertion wait on a flush window for timestamps it then could not control.
 */

const ADDRESS_STEM = 'wave4-clicks';
let testNumber = 0;
let EMAIL_A = '';
let EMAIL_B = '';

function addressesFor(n: number): [string, string] {
  return [`${ADDRESS_STEM}-a-${String(n)}@example.com`, `${ADDRESS_STEM}-b-${String(n)}@example.com`];
}

const NEVER_ISSUED = '00000000-0000-4000-8000-000000000000';
const DESTINATION = 'https://example.test/clicked';

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

let app: INestApplication | undefined;
let baseUrl: string;

/* ========================================================================== *
 * HTTP
 * ========================================================================== */

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

interface ProbeOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly token?: string;
  readonly body?: unknown;
}

async function api(path: string, options: ProbeOptions = {}): Promise<Probe> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);

  const response = await fetch(`${baseUrl}${path}`, {
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

/** The flattened field errors of a 400, in the shape `validationDetailsContract` fixes. */
function fieldErrorsOf(probe: Probe): Record<string, string[]> {
  const parsed = validationDetailsContract.safeParse((probe.body as { details?: unknown }).details);

  expect(parsed.success, probe.raw).toBe(true);

  return parsed.success ? parsed.data.fieldErrors : {};
}

interface Principal {
  readonly token: string;
  readonly tenantId: string;
  readonly userId: string;
}

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

  return { token: token as string, tenantId: claims.tid as string, userId: claims.sub as string };
}

async function operatorWithLink(email: string): Promise<{
  principal: Principal;
  workspaceId: string;
  linkId: string;
}> {
  const principal = await principalFor(email);

  const created = await api('/api/workspaces', {
    method: 'POST',
    token: principal.token,
    body: { name: 'Acme' },
  });
  expect(created.status, created.raw).toBe(201);
  const workspaceId = (created.body as { id: string }).id;

  const link = await api('/api/links', {
    method: 'POST',
    token: principal.token,
    body: { workspaceId, destinationUrl: DESTINATION },
  });
  expect(link.status, link.raw).toBe(201);

  return { principal, workspaceId, linkId: (link.body as { id: string }).id };
}

/* ========================================================================== *
 * SQL fixtures.
 * ========================================================================== */

/** One click, at a chosen instant. `id` has no database default (ADR-0010), so it is drawn here. */
function plantClick(tenantId: string, linkId: string, offset: string, userAgent: string | null): void {
  execSql(
    migrationDsn(),
    `INSERT INTO click_events (id, tenant_id, link_id, domain_id, occurred_at, ip_hash, user_agent)
     VALUES (gen_random_uuid(), :'tenant'::uuid, :'link'::uuid, :'domain'::uuid,
             now() - :'offset'::interval, :'hash', ${userAgent === null ? 'NULL' : ":'agent'"})`,
    {
      tenantId,
      variables: {
        tenant: tenantId,
        link: linkId,
        domain: SYSTEM_DEFAULT_DOMAIN_ID,
        offset,
        hash: 'aaaaaaaaaaaaaaaaaaaaaa',
        agent: userAgent ?? '',
      },
    },
  );
}

function clickCountFor(tenantId: string): number {
  const [row] = querySql<{ n: number }>(
    migrationDsn(),
    `select count(*)::int as n from click_events where tenant_id = :'tenant'::uuid`,
    { tenantId, variables: { tenant: tenantId } },
  );

  return row?.n ?? -1;
}

/** Takes the caller out of one workspace while leaving them in the tenant and in another. */
function dropMembership(tenantId: string, workspaceId: string, userId: string): void {
  execSql(
    migrationDsn(),
    `DELETE FROM memberships
      WHERE tenant_id = :'tenant'::uuid AND workspace_id = :'workspace'::uuid AND user_id = :'user'`,
    { tenantId, variables: { tenant: tenantId, workspace: workspaceId, user: userId } },
  );
}

function setMembershipRole(tenantId: string, workspaceId: string, userId: string, role: string): void {
  execSql(
    migrationDsn(),
    `UPDATE memberships SET role = :'role'::workspace_role
      WHERE tenant_id = :'tenant'::uuid AND workspace_id = :'workspace'::uuid AND user_id = :'user'`,
    { tenantId, variables: { tenant: tenantId, workspace: workspaceId, user: userId, role } },
  );
}

/* ========================================================================== *
 * The platform seed, through the shipped units (F-236, ADR-0063).
 * ========================================================================== */

function platformTransaction() {
  const found = SEED_TRANSACTIONS.find((transaction) => transaction.tenantId === PLATFORM_TENANT_ID);

  if (found === undefined) {
    throw new Error('scripts/seed.mts has no platform transaction; no link can be created.');
  }

  return found;
}

async function seedPlatform(): Promise<void> {
  const pool = new pg.Pool({ connectionString: appDsn() });

  try {
    const client: PoolClient = await pool.connect();

    try {
      await runTransaction(client, platformTransaction(), new Map());
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function dropPlatformRows(): void {
  execSql(migrationDsn(), `DELETE FROM tenants WHERE id = :'tenant'::uuid;`, {
    tenantId: PLATFORM_TENANT_ID,
    flags: { 'app.privileged_erase': PLATFORM_TENANT_ID },
    variables: { tenant: PLATFORM_TENANT_ID },
  });
}

/** 32 bytes of base64url. This suite never hashes anything: the child only mints tokens. */
const CLICK_KEY = 'FIXTURE-click-ip-hash-key-not-a-real-value0';

beforeAll(async () => {
  assertAppRoleCannotBypassRls();
  await seedPlatform();
  // `CLICK_IP_HASH_KEY` IS PASSED EXPLICITLY, and it is not optional decoration: from
  // TASK-2-09 the API refuses to boot without it (D-2-17), so a child spawned with only
  // `authServerEnv` exits 1 wherever the runner's environment does not already carry the
  // variable. CI's integration job sets it at the job level; this file does not depend on
  // that.
  serverBoot = startApiServer({
    env: (baseUrl) => ({ ...authServerEnv(baseUrl), CLICK_IP_HASH_KEY: CLICK_KEY }),
  });
  serverBoot.catch(() => undefined);
}, 120_000);

beforeEach(async () => {
  server = await serverBoot;

  if (app === undefined) {
    vi.stubEnv('BETTER_AUTH_URL', server.baseUrl);
    vi.stubEnv('CLICK_IP_HASH_KEY', CLICK_KEY);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    (app.getHttpServer() as Server).keepAliveTimeout = 0;
  }

  testNumber += 1;
  [EMAIL_A, EMAIL_B] = addressesFor(testNumber);
  clearSignupState(EMAIL_A, EMAIL_B);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeDatabase();
  vi.unstubAllEnvs();
  clearSignupState(EMAIL_A, EMAIL_B);
  dropPlatformRows();
  await server?.stop();
});

/* ========================================================================== *
 * AC-2-39: the read, its role, its order, its window and its wire shape.
 * ========================================================================== */

describe('AC-2-39: GET /api/links/:linkId/clicks', () => {
  it('answers a viewer with Paginated<ClickEvent>, newest first', async () => {
    const { principal, workspaceId, linkId } = await operatorWithLink(EMAIL_A);

    plantClick(principal.tenantId, linkId, '2 hours', 'oldest');
    plantClick(principal.tenantId, linkId, '1 hour', 'middle');
    plantClick(principal.tenantId, linkId, '1 minute', null);

    // `viewer` IS THE MINIMUM, so the strongest form of the assertion is the caller who has
    // exactly that and nothing more.
    setMembershipRole(principal.tenantId, workspaceId, principal.userId, 'viewer');

    const read = await api(`/api/links/${linkId}/clicks`, { token: principal.token });

    expect(read.status, read.raw).toBe(200);
    const page = paginated(clickEventContract).parse(read.body);

    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.userAgent)).toEqual([null, 'middle', 'oldest']);
    expect(page.items.every((item) => item.linkId === linkId)).toBe(true);
  });

  /**
   * D-2-19, GC-R. The column exists and is what makes a visitor countable without being
   * identifiable; it never leaves the database. Asserted on the RAW BODY, because a schema
   * parse strips unknown keys and would go green on a response that carried it.
   */
  it('carries no ipHash, and no tenant or domain id either, on the wire', async () => {
    const { principal, linkId } = await operatorWithLink(EMAIL_A);

    plantClick(principal.tenantId, linkId, '1 minute', 'agent');

    const read = await api(`/api/links/${linkId}/clicks`, { token: principal.token });

    expect(read.status, read.raw).toBe(200);
    expect(read.raw).not.toContain('ipHash');
    expect(read.raw).not.toContain('ip_hash');
    expect(read.raw).not.toContain('aaaaaaaaaaaaaaaaaaaaaa');
    expect(read.raw).not.toContain(principal.tenantId);
    expect(read.raw).not.toContain(SYSTEM_DEFAULT_DOMAIN_ID);
  });

  it('filters on `from` and `to`, and an inverted range is an empty page rather than an error', async () => {
    const { principal, linkId } = await operatorWithLink(EMAIL_A);

    plantClick(principal.tenantId, linkId, '3 hours', 'oldest');
    plantClick(principal.tenantId, linkId, '1 minute', 'newest');

    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const since = await api(`/api/links/${linkId}/clicks?from=${encodeURIComponent(cutoff)}`, {
      token: principal.token,
    });
    const until = await api(`/api/links/${linkId}/clicks?to=${encodeURIComponent(cutoff)}`, {
      token: principal.token,
    });
    const inverted = await api(
      `/api/links/${linkId}/clicks?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(cutoff)}`,
      { token: principal.token },
    );

    expect(since.status, since.raw).toBe(200);
    expect(paginated(clickEventContract).parse(since.body).items.map((item) => item.userAgent)).toEqual([
      'newest',
    ]);
    expect(paginated(clickEventContract).parse(until.body).items.map((item) => item.userAgent)).toEqual([
      'oldest',
    ]);
    expect(paginated(clickEventContract).parse(inverted.body).items).toEqual([]);
  });

  it('pages with a cursor that returns the rest, and repeats nothing', async () => {
    const { principal, linkId } = await operatorWithLink(EMAIL_A);

    for (const minutes of [4, 3, 2, 1]) {
      plantClick(principal.tenantId, linkId, `${String(minutes)} minutes`, `agent-${String(minutes)}`);
    }

    const first = await api(`/api/links/${linkId}/clicks?limit=2`, { token: principal.token });
    const firstPage = paginated(clickEventContract).parse(first.body);

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();

    const next = await api(
      `/api/links/${linkId}/clicks?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      { token: principal.token },
    );
    const secondPage = paginated(clickEventContract).parse(next.body);

    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.items.map((item) => item.userAgent)).toEqual(['agent-3', 'agent-4']);

    const seen = new Set([...firstPage.items, ...secondPage.items].map((item) => item.id));
    expect(seen.size).toBe(4);
  });

  it('answers 400 validation_failed for a cursor this endpoint did not issue', async () => {
    const { principal, linkId } = await operatorWithLink(EMAIL_A);

    const refused = await api(`/api/links/${linkId}/clicks?cursor=not-a-cursor`, {
      token: principal.token,
    });

    expect(refused.status, refused.raw).toBe(400);
    expect(errorEnvelopeContract.safeParse(refused.body).success, refused.raw).toBe(true);
    expect((refused.body as { code: string }).code).toBe('validation_failed');
    expect(fieldErrorsOf(refused).cursor).toHaveLength(1);
  });

  /**
   * ============================================================================
   * TWO TIMESTAMPS JAVASCRIPT ACCEPTS AND POSTGRES REFUSES, BOTH ONE PARAMETER FROM A 500.
   * ============================================================================
   *
   * `z.string().datetime()` admits year 0000 and `new Date()` admits an extended year, and
   * both reach the reader as a `timestamptz` parameter that raises 22008 from inside the
   * query. Nothing on a read path catches a driver error, so each was a 500 with the generic
   * body on a value any viewer could send. Both entry points are bounded now
   * (`click-instant.ts`), and each refusal is keyed on the field that carried the value.
   */
  it('answers 400, not 500, for a timestamp Postgres cannot hold', async () => {
    const { principal, linkId } = await operatorWithLink(EMAIL_A);

    const yearZero = await api(
      `/api/links/${linkId}/clicks?from=${encodeURIComponent('0000-01-01T00:00:00.000Z')}`,
      { token: principal.token },
    );

    expect(yearZero.status, yearZero.raw).toBe(400);
    expect((yearZero.body as { code: string }).code).toBe('validation_failed');
    expect(fieldErrorsOf(yearZero).from).toHaveLength(1);

    const farFuture = await api(
      `/api/links/${linkId}/clicks?to=${encodeURIComponent('+275760-09-13T00:00:00.000Z')}`,
      { token: principal.token },
    );

    // zod's own `datetime()` refuses the extended-year FORM, so this one is a 400 before it
    // reaches the bound. The assertion is the status, not which layer answered.
    expect(farFuture.status, farFuture.raw).toBe(400);
    expect((farFuture.body as { code: string }).code).toBe('validation_failed');
  });

  it('answers 400, not 500, for a FORGED cursor carrying such a timestamp', async () => {
    const { principal, linkId } = await operatorWithLink(EMAIL_A);

    const forged = (timestamp: string): string =>
      Buffer.from(`${timestamp}|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, 'utf8').toString('base64url');

    for (const timestamp of ['+275760-09-13T00:00:00.000Z', '0000-01-01T00:00:00.000Z']) {
      const refused = await api(
        `/api/links/${linkId}/clicks?cursor=${encodeURIComponent(forged(timestamp))}`,
        { token: principal.token },
      );

      expect(refused.status, `${timestamp}: ${refused.raw}`).toBe(400);
      expect((refused.body as { code: string }).code).toBe('validation_failed');
      expect(fieldErrorsOf(refused).cursor).toHaveLength(1);
    }
  });

  it('answers 400 validation_failed for an unparseable `from`', async () => {
    const { principal, linkId } = await operatorWithLink(EMAIL_A);

    const refused = await api(`/api/links/${linkId}/clicks?from=yesterday`, {
      token: principal.token,
    });

    expect(refused.status, refused.raw).toBe(400);
    expect((refused.body as { code: string }).code).toBe('validation_failed');
  });

  /**
   * AC-2-6's rule on this route: another tenant's link id, an id nobody issued and a non-uuid
   * are ONE 404, with no existence disclosure and no change in the database (envelope
   * invariant 5). The 404 is the LINK repository's, reached before any role is read.
   */
  it('answers 404 for another tenant\'s link, an unissued id and a malformed one alike', async () => {
    const { principal, linkId } = await operatorWithLink(EMAIL_A);
    plantClick(principal.tenantId, linkId, '1 minute', 'agent');

    const intruder = await principalFor(EMAIL_B);

    const crossTenant = await api(`/api/links/${linkId}/clicks`, { token: intruder.token });
    const unissued = await api(`/api/links/${NEVER_ISSUED}/clicks`, { token: intruder.token });
    const malformed = await api('/api/links/not-a-uuid/clicks', { token: intruder.token });

    for (const probe of [crossTenant, unissued, malformed]) {
      expect(probe.status, probe.raw).toBe(404);
      expect(errorEnvelopeContract.safeParse(probe.body).success, probe.raw).toBe(true);
      expect((probe.body as { code: string }).code).toBe('not_found');
    }

    // The three answers are byte-identical, so nothing distinguishes a real link from an
    // imagined one.
    expect(new Set([crossTenant.raw, unissued.raw, malformed.raw]).size).toBe(1);
    // And the row is still there, unread by the intruder and untouched.
    expect(clickCountFor(principal.tenantId)).toBe(1);
    expect(clickCountFor(intruder.tenantId)).toBe(0);
  });

  /**
   * ============================================================================
   * THE SECOND 404: A LINK IN A WORKSPACE THE CALLER IS NOT IN, INSIDE THEIR OWN TENANT.
   * ============================================================================
   *
   * Form B answers this from the AUTHORIZER rather than from the repository, so its body is
   * `WorkspaceAccessNotFoundError`'s and not `LinkNotFoundError`'s: two 404s with different
   * messages, which distinguishes "no such link" from "a link you cannot see" for a caller
   * inside the tenant. That difference is the links routes' (`GET /api/links/:linkId` gives
   * the same pair, from the same two lines of `LinksService.load`), so what this route owes
   * is not a body of its own invention but the SAME answer the link route gives for the same
   * request. Asserted as parity, so a fix on either side cannot drift the other.
   */
  it('answers a link in another workspace of the same tenant exactly as GET /api/links/:linkId does', async () => {
    const { principal, workspaceId, linkId } = await operatorWithLink(EMAIL_A);

    // A second workspace in the SAME tenant, then out of the first one: same tenant, same
    // token, no membership in the workspace that owns the link.
    const second = await api('/api/workspaces', {
      method: 'POST',
      token: principal.token,
      body: { name: 'Other' },
    });
    expect(second.status, second.raw).toBe(201);
    dropMembership(principal.tenantId, workspaceId, principal.userId);

    const link = await api(`/api/links/${linkId}`, { token: principal.token });
    const clicks = await api(`/api/links/${linkId}/clicks`, { token: principal.token });

    expect(link.status, link.raw).toBe(404);
    expect(clicks.status, clicks.raw).toBe(404);
    expect(clicks.raw).toBe(link.raw);
  });

  it('answers 401 with no token at all', async () => {
    const { linkId } = await operatorWithLink(EMAIL_A);

    const anonymous = await api(`/api/links/${linkId}/clicks`);

    expect(anonymous.status, anonymous.raw).toBe(401);
  });
});

/* ========================================================================== *
 * The AC-60-style enumeration: what this module offers a tenant, and nothing else.
 * ========================================================================== */

describe('AC-2-39: the clicks module\'s tenant-facing surface is a writer and a reader, and neither mutates', () => {
  /** Own prototype methods, constructor excluded: what an instance actually offers. */
  function methodsOf(target: new (...args: never[]) => unknown): string[] {
    return Object.getOwnPropertyNames(target.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
  }

  it('the writer offers exactly `append`, and the reader exactly `query`', () => {
    expect(methodsOf(ClickEventWriterRepository)).toEqual(['append']);
    expect(methodsOf(ClickEventReaderRepository)).toEqual(['query']);
  });

  /**
   * Append-only is enforced by the ABSENCE OF METHODS rather than by a database trigger,
   * which `click-events.md` states explicitly (a row-level immutability trigger would block
   * `privilegedTenantEraser`, item 4's single non-tenant-facing mutation surface). So the
   * absence is what a test has to assert.
   */
  it('no class in the module offers an update, a delete or an upsert, under any spelling', () => {
    const forbidden = /update|delete|remove|destroy|patch|upsert|save|truncate|purge|erase/i;

    for (const target of [
      ClickEventWriterRepository,
      ClickEventReaderRepository,
      ClicksService,
      ClicksController,
    ]) {
      for (const method of methodsOf(target as never)) {
        expect(method, `${target.name}.${method}`).not.toMatch(forbidden);
      }
    }
  });

  it('the controller declares one handler, and it is a GET on :linkId/clicks', () => {
    const handlers = methodsOf(ClicksController);

    expect(handlers).toEqual(['list']);
    expect(Reflect.getMetadata('method', ClicksController.prototype.list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata('path', ClicksController.prototype.list)).toBe(':linkId/clicks');
  });

  it('and the writes a client might try are routed nowhere: POST, PATCH and DELETE all 404', async () => {
    const { principal, linkId } = await operatorWithLink(EMAIL_A);
    plantClick(principal.tenantId, linkId, '1 minute', 'agent');

    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const attempt = await api(`/api/links/${linkId}/clicks`, {
        method,
        token: principal.token,
        body: method === 'DELETE' ? undefined : {},
      });

      expect(attempt.status, `${method}: ${attempt.raw}`).toBe(404);
    }

    expect(clickCountFor(principal.tenantId)).toBe(1);
  });
});
