import type { Server } from 'node:http';
import { randomFillSync, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import type { PoolClient } from 'pg';
import {
  errorEnvelopeContract,
  linkContract,
  paginated,
  SLUG_ALPHABET,
  validateSlug,
  validationDetailsContract,
} from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTransaction, SEED_TRANSACTIONS } from '../../scripts/seed.mts';
import { AppModule } from '../../src/app.module';
import { closeDatabase } from '../../src/db/client';
import { PLATFORM_TENANT_ID, SYSTEM_DEFAULT_DOMAIN_ID } from '../../src/db/platform';
import { RATE_LIMIT_MAX_WRITES } from '../../src/common/rate-limit/rate-limit.types';
import { RANDOM_SOURCE } from '../../src/links/codes/slug-generator';
import type { RandomSource } from '../../src/links/codes/slug-generator';
import {
  clearLinkMutationSubscribers,
  onLinkMutated,
} from '../../src/links/link-mutation.events';
import type { LinkMutation } from '../../src/links/link-mutation.events';
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
 * STORY-2-01 (AC-2-1..9) and STORY-2-02 (AC-2-10, AC-2-12) end to end, on the shipped
 * routes. TASK-2-05, wave 2.
 *
 * Contract: `docs/contracts/slug.md`, `link-mutation-events.md`, `error-envelope.md`
 * (invariants 1, 4, 5, 10), `workspace-authorization.md` ("Minimum role per surface",
 * "Status rules"), `rate-limit.md` ("Limits"). ADR-0007, ADR-0024, ADR-0063; D-2-08,
 * D-2-12, D-2-19.
 *
 * ============================================================================
 * THE TWO-PROCESS SHAPE `test/workspaces/workspaces.int-spec.ts` ESTABLISHED.
 * ============================================================================
 *
 * The child booted by `api-server.ts` is the only place a real sign-in happens and a real
 * token is minted against a real `/api/auth/jwks`. The application under test is built from
 * `AppModule` IN THIS PROCESS (the real guards, the real interceptors, the real filter,
 * the real `LinksModule`) with `BETTER_AUTH_URL` pointed at the child, and with the same
 * `/api` prefix `main.ts` sets.
 *
 * ONE PROVIDER IS OVERRIDDEN AND IT IS THE ONLY ONE: `RANDOM_SOURCE`. That is what makes
 * AC-2-10 deterministic: a scripted source draws a slug that is already taken, on demand,
 * so the savepoint retry is exercised by the real INSERT meeting the real
 * `links_domain_id_slug_unique` rather than by a stubbed error. With nothing scripted the
 * source falls through to `crypto.randomFillSync`, so every other test runs on production
 * entropy.
 *
 * ============================================================================
 * THE PLATFORM SEED RUNS FIRST, THROUGH THE SHIPPED SEED UNITS.
 * ============================================================================
 *
 * `links.domain_id` references the system default `domains` row, which belongs to the
 * PLATFORM tenant and is written by `scripts/seed.mts` and never by a migration, which under
 * FORCE ROW LEVEL SECURITY would insert zero rows and report success (F-236, ADR-0063).
 * Without it every `POST /api/links` answers 23503, so this file seeds it the way the CLI
 * does and erases it afterwards.
 *
 * ONE PAIR OF ADDRESSES PER TEST, numbered, for the reason `workspaces.int-spec.ts` gives:
 * the child runs the shipped email-keyed sign-in bucket and a file reusing one address
 * would exhaust it by its sixth test.
 */

const ADDRESS_STEM = 'wave2-links';
let testNumber = 0;
let EMAIL_A = '';
let EMAIL_B = '';

function addressesFor(n: number): [string, string] {
  return [`${ADDRESS_STEM}-a-${String(n)}@example.com`, `${ADDRESS_STEM}-b-${String(n)}@example.com`];
}

const NEVER_ISSUED = '00000000-0000-4000-8000-000000000000';
const DESTINATION = 'https://example.test/spring?utm=1';

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

let app: INestApplication | undefined;
let baseUrl: string;

/* ========================================================================== *
 * The scripted entropy, and the counter AC-2-10 reads.
 * ========================================================================== */

/** Slugs the generator will draw next, in order. Empty means production entropy. */
let scriptedDraws: string[] = [];
let draws = 0;

/** The bytes that draw `slug` verbatim: every alphabet index is below 57, so `byte % 57` is it. */
function bytesFor(slug: string): number[] {
  return [...slug].map((character) => {
    const index = SLUG_ALPHABET.indexOf(character);

    if (index < 0) {
      throw new Error(`${character} is not in SLUG_ALPHABET, so no byte draws it.`);
    }

    return index;
  });
}

const testRandomSource: RandomSource = {
  bytes(out: Uint8Array): void {
    draws += 1;
    const scripted = scriptedDraws.shift();

    if (scripted === undefined) {
      randomFillSync(out);
      return;
    }

    out.set(bytesFor(scripted));
  },
};

/* ========================================================================== *
 * HTTP
 * ========================================================================== */

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
  readonly headers: Headers;
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

  return { status: response.status, body, raw, headers: response.headers };
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

/** A workspace the principal administers, through the shipped route. */
async function createWorkspace(principal: Principal, name = 'Acme'): Promise<string> {
  const created = await api('/api/workspaces', {
    method: 'POST',
    token: principal.token,
    body: { name },
  });

  expect(created.status, created.raw).toBe(201);

  return (created.body as { id: string }).id;
}

/** Signs up, mints, and opens a workspace: the shape almost every test below starts from. */
async function operatorWithWorkspace(email: string): Promise<{
  principal: Principal;
  workspaceId: string;
}> {
  const principal = await principalFor(email);

  return { principal, workspaceId: await createWorkspace(principal) };
}

async function createLink(
  principal: Principal,
  workspaceId: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const created = await api('/api/links', {
    method: 'POST',
    token: principal.token,
    body: { workspaceId, destinationUrl: DESTINATION, ...body },
  });

  expect(created.status, created.raw).toBe(201);

  return created.body as Record<string, unknown>;
}

function expectEnvelope(probe: Probe, code: string): void {
  expect(errorEnvelopeContract.safeParse(probe.body).success, probe.raw).toBe(true);
  expect((probe.body as { code: string }).code, probe.raw).toBe(code);
}

function fieldErrorsOf(probe: Probe): Record<string, string[]> {
  const parsed = validationDetailsContract.safeParse((probe.body as { details?: unknown }).details);

  expect(parsed.success, probe.raw).toBe(true);

  return parsed.success ? parsed.data.fieldErrors : {};
}

/* ========================================================================== *
 * Slugs are unique per test, because they are unique per DOMAIN and not per tenant.
 * ========================================================================== */

/**
 * `links_domain_id_slug_unique` is `(domain_id, slug)` and every link here lands on the ONE
 * shared system default domain, so a slug this file used in an earlier test collides with
 * the same slug in a later one exactly as two tenants collide in production (AC-2-3: the
 * property under test, not an accident of the fixture). Each test's slugs therefore carry
 * its own number: rows from earlier tests survive the run, because `clearSignupState`
 * erases the pair it is HANDED, which is the pair the test about to run will use.
 */
function tagged(base: string): string {
  return `${base}${String(testNumber)}`;
}

/**
 * The same, for a slug a scripted draw has to be able to produce: exactly
 * `GENERATED_SLUG_LENGTH` characters, all of them in `SLUG_ALPHABET`. Three from the
 * caller, four encoding the test number in base 57.
 */
function taggedDrawable(prefix: string): string {
  let remaining = testNumber;
  let tail = '';

  for (let position = 0; position < 4; position += 1) {
    tail = `${SLUG_ALPHABET[remaining % SLUG_ALPHABET.length]}${tail}`;
    remaining = Math.floor(remaining / SLUG_ALPHABET.length);
  }

  return `${prefix}${tail}`;
}

/* ========================================================================== *
 * SQL fixtures. Every read carries the tenant flag: `links` is FORCE ROW LEVEL
 * SECURITY, so even the owning role reads nothing without it.
 * ========================================================================== */

interface LinkRowShape {
  id: string;
  slug: string;
  destinationUrl: string;
  domainId: string;
  domainTenantId: string;
  workspaceId: string;
}

function linkRowsFor(tenantId: string): LinkRowShape[] {
  return querySql<LinkRowShape>(
    migrationDsn(),
    `select id, slug, destination_url as "destinationUrl", domain_id as "domainId",
            domain_tenant_id as "domainTenantId", workspace_id as "workspaceId"
       from links where tenant_id = :'tenant'::uuid order by created_at desc, id desc`,
    { tenantId, variables: { tenant: tenantId } },
  );
}

function clickCountFor(tenantId: string, linkId: string): number {
  const [row] = querySql<{ n: number }>(
    migrationDsn(),
    `select count(*)::int as n from click_events
      where tenant_id = :'tenant'::uuid and link_id = :'link'::uuid`,
    { tenantId, variables: { tenant: tenantId, link: linkId } },
  );

  return row?.n ?? -1;
}

/** A `domains` row of the caller's OWN tenant, so a second `(domain_id, slug)` namespace exists. */
function plantDomain(tenantId: string, workspaceId: string, id: string, hostname: string): void {
  execSql(
    migrationDsn(),
    `INSERT INTO domains (id, tenant_id, workspace_id, hostname, state, is_system_default)
     VALUES (:'id'::uuid, :'tenant'::uuid, :'workspace'::uuid, :'hostname', 'active', false)`,
    { tenantId, variables: { id, tenant: tenantId, workspace: workspaceId, hostname } },
  );
}

function plantLinkOnDomain(
  tenantId: string,
  workspaceId: string,
  domainId: string,
  slug: string,
): void {
  execSql(
    migrationDsn(),
    `INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
     VALUES (:'tenant'::uuid, :'workspace'::uuid, :'domain'::uuid, :'tenant'::uuid, :'slug', :'destination')`,
    {
      tenantId,
      variables: {
        tenant: tenantId,
        workspace: workspaceId,
        domain: domainId,
        slug,
        destination: 'https://planted.test/x',
      },
    },
  );
}

function plantClick(tenantId: string, linkId: string): void {
  execSql(
    migrationDsn(),
    `INSERT INTO click_events (id, tenant_id, link_id, domain_id, occurred_at, ip_hash, user_agent)
     VALUES (gen_random_uuid(), :'tenant'::uuid, :'link'::uuid, :'domain'::uuid, now(), 'hash', 'agent')`,
    {
      tenantId,
      variables: { tenant: tenantId, link: linkId, domain: SYSTEM_DEFAULT_DOMAIN_ID },
    },
  );
}

function archiveWorkspace(tenantId: string, workspaceId: string): void {
  execSql(
    migrationDsn(),
    `UPDATE workspaces SET archived_at = now()
      WHERE tenant_id = :'tenant'::uuid AND id = :'workspace'::uuid`,
    { tenantId, variables: { tenant: tenantId, workspace: workspaceId } },
  );
}

function setMembershipRole(tenantId: string, workspaceId: string, userId: string, role: string): void {
  execSql(
    migrationDsn(),
    `UPDATE memberships SET role = :'role'::workspace_role
      WHERE tenant_id = :'tenant'::uuid AND workspace_id = :'workspace'::uuid AND user_id = :'user'`,
    {
      tenantId,
      variables: { tenant: tenantId, workspace: workspaceId, user: userId, role },
    },
  );
}

/* ========================================================================== *
 * The platform seed, through the shipped units.
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

/** The platform rows, removed through the migrator. `domains` and every link cascade with them. */
function dropPlatformRows(): void {
  execSql(migrationDsn(), `DELETE FROM tenants WHERE id = :'tenant'::uuid;`, {
    tenantId: PLATFORM_TENANT_ID,
    flags: { 'app.privileged_erase': PLATFORM_TENANT_ID },
    variables: { tenant: PLATFORM_TENANT_ID },
  });
}

beforeAll(async () => {
  assertAppRoleCannotBypassRls();
  await seedPlatform();
  serverBoot = startApiServer({ env: authServerEnv });
  serverBoot.catch(() => undefined);
}, 120_000);

beforeEach(async () => {
  server = await serverBoot;

  if (app === undefined) {
    vi.stubEnv('BETTER_AUTH_URL', server.baseUrl);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The ONE override in this file. See the header.
      .overrideProvider(RANDOM_SOURCE)
      .useValue(testRandomSource)
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    (app.getHttpServer() as Server).keepAliveTimeout = 0;
  }

  scriptedDraws = [];
  draws = 0;
  clearLinkMutationSubscribers();

  testNumber += 1;
  [EMAIL_A, EMAIL_B] = addressesFor(testNumber);
  clearSignupState(EMAIL_A, EMAIL_B);
}, 180_000);

afterAll(async () => {
  clearLinkMutationSubscribers();
  await app?.close();
  await closeDatabase();
  vi.unstubAllEnvs();
  clearSignupState(EMAIL_A, EMAIL_B);
  dropPlatformRows();
  await server?.stop();
});

describe('AC-2-1: a member creates a link with a generated slug', () => {
  it('answers 201 with a linkContract body on the system default domain, and the row stores the parsed href', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);

    const created = await api('/api/links', {
      method: 'POST',
      token: principal.token,
      // Mixed-case host and no path: `destinationUrlContract` stores `u.href`, so what the
      // row holds is the canonical form and not what was pasted (D-2-08).
      body: { workspaceId, destinationUrl: 'HTTPS://Example.TEST' },
    });

    expect(created.status, created.raw).toBe(201);
    const link = linkContract.parse(created.body);

    expect(link.slug).toHaveLength(7);
    expect([...link.slug].every((character) => SLUG_ALPHABET.includes(character)), link.slug).toBe(true);
    expect(validateSlug(link.slug)).toEqual({ ok: true, slug: link.slug });
    expect(link.hostname).toBe('localhost');
    expect(link.domainId).toBe(SYSTEM_DEFAULT_DOMAIN_ID);
    expect(link.expiresAt).toBeNull();
    expect(link.activatesAt).toBeNull();
    expect(link.workspaceId).toBe(workspaceId);

    const rows = linkRowsFor(principal.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe(link.slug);
    expect(rows[0].destinationUrl).toBe('https://example.test/');
    // ADR-0063: the pair, both columns, on every insert. The check constraint admits the
    // platform default and the row's own tenant and nothing else.
    expect(rows[0].domainId).toBe(SYSTEM_DEFAULT_DOMAIN_ID);
    expect(rows[0].domainTenantId).toBe(PLATFORM_TENANT_ID);
  });
});

describe('AC-2-2: a supplied slug is judged by validateSlug, in its fixed order', () => {
  it('each violation answers 400 validation_failed with the violation itself under `slug`', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);

    const cases: Array<[string, string]> = [
      ['', 'too_short'],
      ['a'.repeat(65), 'too_long'],
      ['spring sale', 'invalid_characters'],
      ['-spring', 'leading_or_trailing_separator'],
      ['spring-', 'leading_or_trailing_separator'],
      ['admin', 'reserved'],
      // Case-insensitive, so the brand list cannot be walked around with a capital.
      ['Admin', 'reserved'],
    ];

    for (const [slug, violation] of cases) {
      const refused = await api('/api/links', {
        method: 'POST',
        token: principal.token,
        body: { workspaceId, destinationUrl: DESTINATION, slug },
      });

      expect(refused.status, `${slug}: ${refused.raw}`).toBe(400);
      expectEnvelope(refused, 'validation_failed');
      expect(fieldErrorsOf(refused).slug, slug).toEqual([violation]);
    }

    expect(linkRowsFor(principal.tenantId)).toHaveLength(0);
  });

  it('a valid custom slug is stored verbatim and case-sensitively', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);

    const link = linkContract.parse(await createLink(principal, workspaceId, { slug: tagged('Spring-Sale_2026') }));

    expect(link.slug).toBe(tagged('Spring-Sale_2026'));
    expect(linkRowsFor(principal.tenantId)[0].slug).toBe(tagged('Spring-Sale_2026'));
  });
});

describe('AC-2-3: uniqueness is (domain_id, slug), never global', () => {
  it('a slug another tenant holds on the shared system default domain is 409 slug_taken, fixed message, no details', async () => {
    const b = await operatorWithWorkspace(EMAIL_B);
    await createLink(b.principal, b.workspaceId, { slug: taggedDrawable('tkn') });

    const a = await operatorWithWorkspace(EMAIL_A);
    const refused = await api('/api/links', {
      method: 'POST',
      token: a.principal.token,
      body: { workspaceId: a.workspaceId, destinationUrl: DESTINATION, slug: taggedDrawable('tkn') },
    });

    expect(refused.status, refused.raw).toBe(409);
    expectEnvelope(refused, 'slug_taken');
    // Invariant 10's bound: one bit, no identity. A `details` shape would invite more.
    expect((refused.body as { details?: unknown }).details).toBeUndefined();
    expect(linkRowsFor(a.principal.tenantId)).toHaveLength(0);
  });

  it('the same slug on a DIFFERENT domain is admitted: the index is per domain, not per platform', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);
    // Fresh id AND fresh hostname per run: `domains_hostname_owned_unique` is a partial
    // unique index over the active states, so a fixed pair would collide with its own
    // leftovers the moment a run ends before its cleanup.
    const plantedDomain = randomUUID();

    plantDomain(principal.tenantId, workspaceId, plantedDomain, `planted-${plantedDomain.slice(0, 8)}.test`);
    plantLinkOnDomain(principal.tenantId, workspaceId, plantedDomain, tagged('sharedX'));

    const link = linkContract.parse(await createLink(principal, workspaceId, { slug: tagged('sharedX') }));

    expect(link.domainId).toBe(SYSTEM_DEFAULT_DOMAIN_ID);
    expect(linkRowsFor(principal.tenantId).filter((row) => row.slug === tagged('sharedX'))).toHaveLength(2);
  });
});

describe('AC-2-4: the destination is parsed on the way in (D-2-08, the F-006 class)', () => {
  it('refuses javascript:, data:, ftp, a non-URL and an over-long one, and writes no row', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);

    const refusals = [
      'javascript:alert(1)',
      // The WHATWG parser strips the newline before it reads the scheme; a regex would not.
      'java\nscript:alert(1)',
      'data:text/html,x',
      'ftp://example.test/x',
      'not a url',
      `https://example.test/${'a'.repeat(2049)}`,
    ];

    for (const destinationUrl of refusals) {
      const refused = await api('/api/links', {
        method: 'POST',
        token: principal.token,
        body: { workspaceId, destinationUrl },
      });

      expect(refused.status, `${destinationUrl}: ${refused.raw}`).toBe(400);
      expectEnvelope(refused, 'validation_failed');
      expect(Object.keys(fieldErrorsOf(refused)), destinationUrl).toEqual(['destinationUrl']);
    }

    expect(linkRowsFor(principal.tenantId)).toHaveLength(0);

    // A shortener's targets are other people's URLs and plenty are still plain HTTP.
    const accepted = linkContract.parse(
      await createLink(principal, workspaceId, { destinationUrl: 'http://plain.example' }),
    );
    expect(accepted.destinationUrl).toBe('http://plain.example/');
  });
});

describe('AC-2-5: roles, listing, and a non-member', () => {
  it('a viewer reads the paginated list newest-first with a working cursor, and is refused every write', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);

    const first = linkContract.parse(await createLink(principal, workspaceId, { slug: tagged('firstAB') }));
    const second = linkContract.parse(await createLink(principal, workspaceId, { slug: tagged('secondA') }));
    const third = linkContract.parse(await createLink(principal, workspaceId, { slug: tagged('thirdAB') }));

    // The creator's own membership is demoted rather than a second user invited: granting a
    // role is the invitation flow's, and this file is about links.
    setMembershipRole(principal.tenantId, workspaceId, principal.userId, 'viewer');

    const listed = await api(`/api/links?workspaceId=${workspaceId}&limit=2`, {
      token: principal.token,
    });

    expect(listed.status, listed.raw).toBe(200);
    const page = paginated(linkContract).parse(listed.body);
    expect(page.items.map((item) => item.id)).toEqual([third.id, second.id]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();

    const next = await api(
      `/api/links?workspaceId=${workspaceId}&limit=2&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
      { token: principal.token },
    );
    const secondPage = paginated(linkContract).parse(next.body);
    expect(secondPage.items.map((item) => item.id)).toEqual([first.id]);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextCursor).toBeNull();

    // AC-104's rule, with no per-endpoint code: rank 10 never succeeds at a write.
    for (const attempt of [
      api('/api/links', {
        method: 'POST',
        token: principal.token,
        body: { workspaceId, destinationUrl: DESTINATION },
      }),
      api(`/api/links/${third.id}`, { method: 'PATCH', token: principal.token, body: { slug: tagged('nopeABC') } }),
      api(`/api/links/${third.id}`, { method: 'DELETE', token: principal.token }),
    ]) {
      const refused = await attempt;
      expect(refused.status, refused.raw).toBe(403);
      expectEnvelope(refused, 'insufficient_workspace_role');
    }

    // The read is still 200 for the same caller (AC-104's other half).
    expect((await api(`/api/links/${third.id}`, { token: principal.token })).status).toBe(200);
  });

  it('a caller with no membership in the workspace gets 404 on the list and on the create', async () => {
    const a = await operatorWithWorkspace(EMAIL_A);
    const b = await principalFor(EMAIL_B);

    const listed = await api(`/api/links?workspaceId=${a.workspaceId}`, { token: b.token });
    expect(listed.status, listed.raw).toBe(404);
    expectEnvelope(listed, 'not_found');

    const created = await api('/api/links', {
      method: 'POST',
      token: b.token,
      body: { workspaceId: a.workspaceId, destinationUrl: DESTINATION },
    });
    expect(created.status, created.raw).toBe(404);
    expectEnvelope(created, 'not_found');
  });
});

describe('AC-2-6: another tenant is 404 on every by-id route, with nothing disclosed', () => {
  it('GET, PATCH and DELETE answer 404 and the row is untouched, the same answer an id nobody issued gets', async () => {
    const b = await operatorWithWorkspace(EMAIL_B);
    const target = linkContract.parse(await createLink(b.principal, b.workspaceId, { slug: tagged('targetX') }));

    const a = await principalFor(EMAIL_A);

    const probes = [
      await api(`/api/links/${target.id}`, { token: a.token }),
      await api(`/api/links/${target.id}`, { method: 'PATCH', token: a.token, body: { slug: tagged('stolenX') } }),
      await api(`/api/links/${target.id}`, { method: 'DELETE', token: a.token }),
      await api(`/api/links/${NEVER_ISSUED}`, { token: a.token }),
      await api('/api/links/not-a-uuid', { token: a.token }),
    ];

    for (const probe of probes) {
      expect(probe.status, probe.raw).toBe(404);
      expectEnvelope(probe, 'not_found');
    }

    // Byte-equal bodies: the shape of the 404 cannot say which of the five happened.
    expect(new Set(probes.map((probe) => probe.raw)).size).toBe(1);

    const rows = linkRowsFor(b.principal.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe(tagged('targetX'));
  });
});

describe('AC-2-7: patch, the no-op patch, and the hard delete', () => {
  it('patches each field, answers 200, and a patch that changes nothing still fires with before deep-equal to after', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);
    const created = linkContract.parse(await createLink(principal, workspaceId, { slug: tagged('patchAB') }));

    const mutations: LinkMutation[] = [];
    onLinkMutated({
      name: 'spy',
      phase: 'after-commit',
      handle: (mutation) => {
        mutations.push(mutation);
        return Promise.resolve();
      },
    });

    const patched = await api(`/api/links/${created.id}`, {
      method: 'PATCH',
      token: principal.token,
      body: {
        slug: tagged('patchCD'),
        destinationUrl: 'https://example.test/moved',
        expiresAt: '2099-01-01T00:00:00.000Z',
        activatesAt: '2098-01-01T00:00:00.000Z',
      },
    });

    expect(patched.status, patched.raw).toBe(200);
    const after = linkContract.parse(patched.body);
    expect(after.slug).toBe(tagged('patchCD'));
    expect(after.destinationUrl).toBe('https://example.test/moved');
    expect(after.expiresAt).toBe('2099-01-01T00:00:00.000Z');
    expect(after.activatesAt).toBe('2098-01-01T00:00:00.000Z');

    const empty = await api(`/api/links/${created.id}`, {
      method: 'PATCH',
      token: principal.token,
      body: {},
    });
    expect(empty.status, empty.raw).toBe(200);

    expect(mutations.map((mutation) => mutation.action)).toEqual(['updated', 'updated']);
    const [first, second] = mutations;
    expect(first.before?.slug).toBe(tagged('patchAB'));
    expect(first.after?.slug).toBe(tagged('patchCD'));
    expect(first.after?.hostname).toBe('localhost');
    expect(first.actorId).toBe(principal.userId);
    expect(first.tenantId).toBe(principal.tenantId);
    // The no-op still fires, and both images are the same link (the firing rule, AC-2-7).
    expect(second.before).toEqual(second.after);
  });

  it('DELETE answers 200 with the row it removed, and the link’s click_events rows cascade away', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);
    const created = linkContract.parse(await createLink(principal, workspaceId, { slug: tagged('goingXY') }));

    plantClick(principal.tenantId, created.id);
    expect(clickCountFor(principal.tenantId, created.id)).toBe(1);

    const mutations: LinkMutation[] = [];
    onLinkMutated({
      name: 'spy',
      phase: 'after-commit',
      handle: (mutation) => {
        mutations.push(mutation);
        return Promise.resolve();
      },
    });

    const removed = await api(`/api/links/${created.id}`, { method: 'DELETE', token: principal.token });

    expect(removed.status, removed.raw).toBe(200);
    expect(linkContract.parse(removed.body).id).toBe(created.id);
    expect(linkRowsFor(principal.tenantId)).toHaveLength(0);
    expect(clickCountFor(principal.tenantId, created.id)).toBe(0);

    expect(mutations).toHaveLength(1);
    expect(mutations[0].action).toBe('deleted');
    expect(mutations[0].before?.slug).toBe(tagged('goingXY'));
    expect(mutations[0].after).toBeNull();

    // A second delete is the same 404 an id nobody issued gets.
    const again = await api(`/api/links/${created.id}`, { method: 'DELETE', token: principal.token });
    expect(again.status, again.raw).toBe(404);
  });

  it('an activation at or after the expiry is refused against the PRE-IMAGE, not only within one body', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);
    const created = linkContract.parse(
      await createLink(principal, workspaceId, {
        slug: tagged('windowA'),
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    );

    // `activatesAt` alone: the schema sees one body and cannot compare it to the stored
    // `expires_at`, which is why the route does (link.ts says so in as many words).
    const refused = await api(`/api/links/${created.id}`, {
      method: 'PATCH',
      token: principal.token,
      body: { activatesAt: '2099-06-01T00:00:00.000Z' },
    });

    expect(refused.status, refused.raw).toBe(400);
    expectEnvelope(refused, 'validation_failed');
    expect(Object.keys(fieldErrorsOf(refused))).toEqual(['activatesAt']);
  });
});

describe('AC-2-8: an archived workspace gates management', () => {
  it('refuses a create and an edit with 400, leaves the existing row in place, and still allows the delete', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);
    const created = linkContract.parse(await createLink(principal, workspaceId, { slug: tagged('archivA') }));

    archiveWorkspace(principal.tenantId, workspaceId);

    const refusedCreate = await api('/api/links', {
      method: 'POST',
      token: principal.token,
      body: { workspaceId, destinationUrl: DESTINATION },
    });
    expect(refusedCreate.status, refusedCreate.raw).toBe(400);
    expectEnvelope(refusedCreate, 'validation_failed');
    expect(Object.keys(fieldErrorsOf(refusedCreate))).toEqual(['workspaceId']);

    const refusedEdit = await api(`/api/links/${created.id}`, {
      method: 'PATCH',
      token: principal.token,
      body: { destinationUrl: 'https://example.test/other' },
    });
    expect(refusedEdit.status, refusedEdit.raw).toBe(400);
    expectEnvelope(refusedEdit, 'validation_failed');

    // The link is untouched and still readable: archiving gates management, and the
    // redirect keeps serving it (AC-2-8's second half, proven on the redirect by 2-06).
    const rows = linkRowsFor(principal.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].destinationUrl).toBe(DESTINATION);

    // Delete stays open, deliberately: refusing it would strand a serving link with no
    // management path at all (see `links.service.ts`).
    const removed = await api(`/api/links/${created.id}`, { method: 'DELETE', token: principal.token });
    expect(removed.status, removed.raw).toBe(200);
  });
});

describe('AC-2-9: the tenant write bucket charges a link mutation', () => {
  it('a create consumes one of the 120, the 121st mutating request is 429 with Retry-After, and GETs are never charged', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);

    // The workspace create already spent one of the tenant's writes, so this leaves the
    // create below as the LAST admitted one. Each cheap request is a 404 the guard charged
    // for anyway: the bucket is charged before the handler decides anything.
    for (let request = 0; request < RATE_LIMIT_MAX_WRITES - 2; request += 1) {
      const probe = await api(`/api/links/${NEVER_ISSUED}`, { method: 'DELETE', token: principal.token });
      expect(probe.status, probe.raw).toBe(404);
    }

    // The 120th, and a real one: if a create were not charged, the next would be admitted.
    await createLink(principal, workspaceId, { slug: tagged('budgetA') });

    const refused = await api('/api/links', {
      method: 'POST',
      token: principal.token,
      body: { workspaceId, destinationUrl: DESTINATION },
    });
    expect(refused.status, refused.raw).toBe(429);
    expectEnvelope(refused, 'rate_limited');
    expect(refused.headers.get('retry-after')).not.toBeNull();

    // Authenticated GETs are never charged, so the read still answers with the bucket empty.
    const listed = await api(`/api/links?workspaceId=${workspaceId}`, { token: principal.token });
    expect(listed.status, listed.raw).toBe(200);
  }, 120_000);
});

describe('AC-2-10: the savepoint retry, on a scripted source', () => {
  it('two forced collisions produce three INSERT attempts and a 201 carrying the third slug', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);

    await createLink(principal, workspaceId, { slug: taggedDrawable('tkn') });

    // Two draws of a slug that is already taken, then a free one. Each attempt is a real
    // INSERT meeting the real unique index; without `SAVEPOINT slug_try` the second would
    // answer `current transaction is aborted` and the request would 500.
    draws = 0;
    scriptedDraws = [taggedDrawable('tkn'), taggedDrawable('tkn'), taggedDrawable('frs')];

    const created = await api('/api/links', {
      method: 'POST',
      token: principal.token,
      body: { workspaceId, destinationUrl: DESTINATION },
    });

    expect(created.status, created.raw).toBe(201);
    expect(linkContract.parse(created.body).slug).toBe(taggedDrawable('frs'));
    expect(draws).toBe(3);
    expect(created.raw).not.toContain('aborted');
    expect(scriptedDraws).toHaveLength(0);
  });

  it('SLUG_GENERATION_MAX_ATTEMPTS collisions answer 500 slug_generation_exhausted, and no row is written', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);

    await createLink(principal, workspaceId, { slug: taggedDrawable('tkn') });

    draws = 0;
    scriptedDraws = [taggedDrawable('tkn'), taggedDrawable('tkn'), taggedDrawable('tkn'), taggedDrawable('tkn'), taggedDrawable('tkn')];

    const refused = await api('/api/links', {
      method: 'POST',
      token: principal.token,
      body: { workspaceId, destinationUrl: DESTINATION },
    });

    expect(refused.status, refused.raw).toBe(500);
    expectEnvelope(refused, 'slug_generation_exhausted');
    expect(draws).toBe(5);
    expect(linkRowsFor(principal.tenantId)).toHaveLength(1);
  });

  it('a supplied slug is never redrawn: one attempt, then 409', async () => {
    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);

    await createLink(principal, workspaceId, { slug: taggedDrawable('tkn') });

    draws = 0;
    const refused = await api('/api/links', {
      method: 'POST',
      token: principal.token,
      body: { workspaceId, destinationUrl: DESTINATION, slug: taggedDrawable('tkn') },
    });

    expect(refused.status, refused.raw).toBe(409);
    expectEnvelope(refused, 'slug_taken');
    // The generator was never asked: an operator's code is not something to redraw.
    expect(draws).toBe(0);
  });
});

describe('AC-2-12: the collision catch reads the accessors, never the caught value', () => {
  it('no file under src/links reads `.code` or `.message` off a caught driver error', () => {
    const linksDir = fileURLToPath(new URL('../../src/links/', import.meta.url));
    const files = readdirSync(linksDir, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      entry.endsWith('.ts'),
    );

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(`${linksDir}${file}`, 'utf8');
      const code = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');

      // F-120: inside `withTenantTransaction` the caught value is drizzle's wrapper, whose
      // `.code` is `undefined` and whose `.message` carries every bound parameter, the
      // destination URL among them. Both facts are read through `db/client.ts`'s accessors.
      expect(code, `${file} reads .code off a caught value`).not.toMatch(/\berror\s*\.\s*code\b/);
      expect(code, `${file} reads .message off a caught value`).not.toMatch(
        /\berror\s*\.\s*message\b/,
      );
      expect(code, `${file} reads .code off a caught value`).not.toMatch(/\bcaught\s*\.\s*(code|message)\b/);
    }
  });
});

describe('link-mutation-events.md: one mutation per successful operation, both phases', () => {
  it('a create fires `created` once, with the live handle in phase one and null after commit', async () => {
    const seen: Array<{ phase: string; action: string; hasDb: boolean }> = [];

    onLinkMutated({
      name: 'audit',
      phase: 'in-transaction',
      handle: (mutation, db) => {
        seen.push({ phase: 'in-transaction', action: mutation.action, hasDb: db !== null });
        return Promise.resolve();
      },
    });
    onLinkMutated({
      name: 'cache',
      phase: 'after-commit',
      handle: (mutation, db) => {
        seen.push({ phase: 'after-commit', action: mutation.action, hasDb: db !== null });
        return Promise.resolve();
      },
    });

    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);
    await createLink(principal, workspaceId, { slug: tagged('eventsA') });

    expect(seen).toEqual([
      { phase: 'in-transaction', action: 'created', hasDb: true },
      { phase: 'after-commit', action: 'created', hasDb: false },
    ]);
  });

  it('an in-transaction subscriber that throws rolls the whole mutation back; a failed operation fires nothing after commit', async () => {
    const afterCommit = vi.fn().mockResolvedValue(undefined);

    onLinkMutated({
      name: 'audit',
      phase: 'in-transaction',
      handle: () => Promise.reject(new Error('audit insert refused')),
    });
    onLinkMutated({ name: 'cache', phase: 'after-commit', handle: afterCommit });

    const { principal, workspaceId } = await operatorWithWorkspace(EMAIL_A);

    const created = await api('/api/links', {
      method: 'POST',
      token: principal.token,
      body: { workspaceId, destinationUrl: DESTINATION, slug: tagged('rollbaX') },
    });

    expect(created.status, created.raw).toBe(500);
    expectEnvelope(created, 'internal_error');
    // The INSERT committed nothing: that is what "a throw here rolls the mutation back"
    // means, and it is why the audit writer runs in this phase (invariant 4).
    expect(linkRowsFor(principal.tenantId)).toHaveLength(0);
    expect(afterCommit).not.toHaveBeenCalled();
  });
});
