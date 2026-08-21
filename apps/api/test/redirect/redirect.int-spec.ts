import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { dbQueryCounter } from '../../src/cache/db-query-counter';
import { clearRedirectCache } from '../cache/cold-cache';
import { closeDatabase, databaseTransaction } from '../../src/db/client';
import {
  PLATFORM_TENANT_ID,
  PLATFORM_WORKSPACE_ID,
  SYSTEM_DEFAULT_DOMAIN_ID,
} from '../../src/db/platform';
import { logger } from '../../src/observability/logger';
import { REDIRECT_404_CSP } from '../../src/redirect/not-found-page';
import { REDIRECT_ROUTE_PREFIX_EXCLUSION } from '../../src/redirect/redirect.module';
import { execSql } from '../support/psql';
import {
  TENANT_A,
  TENANT_B,
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
} from '../support/rls-fixture';

/**
 * STORY-2-03 on the Postgres path: AC-2-14 (headers), AC-2-16, AC-2-17, AC-2-18,
 * AC-2-19 (the route-pattern half), AC-2-20, AC-2-26 and AC-2-27. TASK-2-06, wave 3.
 *
 * Contract: `docs/contracts/redirect-resolution.md` (decision order, header table,
 * invariants 1 and 4 to 7), `logging-and-headers.md` ("Two deliberate exceptions on the
 * redirect path"), `branding.md` ("Rendering rules"), `isolation-coverage.md`.
 * ADR-0006, ADR-0009, ADR-0063; D-2-13, D-2-14.
 *
 * ============================================================================
 * THIS WAVE'S REDIRECT READS POSTGRES ON EVERY REQUEST, AND THAT IS CORRECT HERE.
 * ============================================================================
 *
 * The cache arrives in TASK-2-07 (wave 4) in front of the same decision. A reviewer
 * reading this file against SC-11's "a cache hit performs zero Postgres queries" is
 * reading the wrong wave: the ordering is deliberate, so the handler behaves before it is
 * made fast. `dbQueryCounter` is asserted here in the other direction, where a resolution
 * costs exactly four statements and a rejected shape costs none, which is the measurement
 * TASK-2-07 then drives to zero on a hit.
 *
 * AMENDED after item 2's first integration run against a runner. TASK-2-07 landed and this
 * file was not revisited, so with a real Redis bound five assertions here and in
 * `test/clicks/click-emission.int-spec.ts` measured the cache rather than what their names
 * say. They passed locally only because a run with no `REDIS_URL` binds a cache that answers
 * `unavailable` to every read. The premise above is now made true instead of assumed:
 * `beforeEach` clears this run's keys, so each test starts cold. The redirect reads Postgres
 * on every request IN THIS FILE, because this file empties the cache first.
 *
 * ============================================================================
 * HOSTNAMES ARE REAL, NOT HEADERS SOMEONE OVERRODE.
 * ============================================================================
 *
 * The server listens on loopback and every request is an ordinary `node:http` one, so the
 * `Host` header is whatever the connection was opened with. `localhost` is the SEEDED
 * system default domain's hostname (`SYSTEM_DEFAULT_DOMAIN` defaults to it, D-2-02) and
 * `127.0.0.1` is planted as a SECOND active domain owned by tenant B: the shape item 3
 * makes ordinary, available today because a `domains` row does not care how it was
 * created. That second hostname is what turns invariant 5 from a claim into a measurement.
 *
 * `node:http` rather than `fetch` for one more reason: it can send a `Host` a client
 * library would refuse to, which is what the malformed-host and unknown-host cases need.
 */

const PLATFORM_HOSTNAME = 'localhost';
const TENANT_B_HOSTNAME = '127.0.0.1';

const WORKSPACE_A = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const WORKSPACE_B = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
/** Tenant B's own active domain, at `127.0.0.1`. Item 3's shape, planted. */
const DOMAIN_OWNED_BY_B = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
/** Tenant A's domain that never left `pending_verification`. F-003's whole subject. */
const DOMAIN_NOT_ACTIVE = 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4';
const NOT_ACTIVE_HOSTNAME = 'pending.example.test';

/**
 * A destination that Express's own `res.redirect` would NOT return unchanged: `res.location`
 * runs `encodeUrl`, which percent-encodes `|`. `new URL(...).href` keeps it, so this is a
 * value the create path can really store, and "byte-identical" is measurable rather than
 * vacuous (AC-2-14).
 */
const DESTINATION_A = 'https://example.test/spring?utm_source=a|b&x=1';
const DESTINATION_B = 'https://example.test/tenant-b?x=2';

const SHARED_SLUG = 'sharedSlug';
const PLATFORM_SLUG = 'platform1';
const EXPIRED_SLUG = 'expired1';
const SCHEDULED_SLUG = 'later123';
/** Both bounds set, both open. The one link that proves the timestamps are readable. */
const IN_WINDOW_SLUG = 'inwindow';
/**
 * Two links whose stored `destination_url` carries a raw CR and a raw CRLF, planted by SQL
 * and therefore around `destinationUrlContract`. See the describe block at the bottom.
 */
const BARE_CR_SLUG = 'barecr12';
const CRLF_SLUG = 'crlfslug';
/** What a successful response split would put on the wire. It must appear nowhere. */
const INJECTED_HEADER = 'X-Injected';
const ON_INACTIVE_DOMAIN_SLUG = 'pending1';

/** `POOL_MAX` in `db/client.ts`. Holding this many transactions open exhausts the pool. */
const POOL_MAX = 10;

let app: INestApplication | undefined;
let port = 0;

/* ========================================================================== *
 * HTTP, at a level that lets the Host header be anything.
 * ========================================================================== */

interface Probe {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** Name/value pairs as they arrived, so a header the parser folded away is still visible. */
  readonly rawHeaders: readonly string[];
  readonly body: string;
}

async function get(path: string, host: string): Promise<Probe> {
  return new Promise<Probe>((resolve, reject) => {
    const call = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host }, setHost: false },
      (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    call.on('error', reject);
    call.end();
  });
}

/** The default `Host` for the system default domain, port and all: normalisation strips it. */
function onPlatform(path: string): Promise<Probe> {
  return get(path, `${PLATFORM_HOSTNAME}:${String(port)}`);
}

/* ========================================================================== *
 * The log stream, read the way `request-log.interceptor.spec.ts` reads it.
 * ========================================================================== */

interface Line {
  readonly raw: string;
  readonly record: Record<string, unknown>;
}

function pinoStreamOf(instance: object): { write(chunk: string): unknown } {
  const symbol = Object.getOwnPropertySymbols(instance).find(
    (candidate) => candidate.description === 'pino.stream',
  );

  if (symbol === undefined) {
    throw new Error('the pino stream symbol was not found on the shared logger; nothing below could capture a line');
  }

  return (instance as unknown as Record<symbol, { write(chunk: string): unknown }>)[symbol];
}

async function capturingLogs<T>(fn: () => Promise<T>): Promise<{ value: T; lines: Line[]; raw: string }> {
  const written: string[] = [];
  const spy = vi.spyOn(pinoStreamOf(logger), 'write').mockImplementation((chunk: string) => {
    written.push(chunk);

    return true;
  });

  try {
    const value = await fn();

    // The request line is emitted from the server's `finish` listener, which runs on its own
    // turn of the loop: awaited briefly rather than read straight after the response.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const raw = written.join('');

    return {
      value,
      raw,
      lines: raw
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => ({ raw: line, record: JSON.parse(line) as Record<string, unknown> })),
    };
  } finally {
    spy.mockRestore();
  }
}

/* ========================================================================== *
 * Fixtures. Every insert goes through the migrator with the owning tenant's flag
 * set, because all three tables are FORCE ROW LEVEL SECURITY and each row has to
 * satisfy its own tenant's WITH CHECK.
 * ========================================================================== */

function eraseTenant(tenantId: string): void {
  execSql(migrationDsn(), `DELETE FROM tenants WHERE id = :'tenant'::uuid;`, {
    tenantId,
    flags: { 'app.privileged_erase': tenantId },
    variables: { tenant: tenantId },
  });
}

function plant(): void {
  execSql(
    migrationDsn(),
    `SELECT set_config('app.tenant_id', :'platform', false) \\g /dev/null
     INSERT INTO tenants (id, name) VALUES (:'platform', 'Shortkit platform');
     INSERT INTO workspaces (id, tenant_id, name) VALUES (:'platform_workspace', :'platform', 'Platform');
     INSERT INTO domains (id, tenant_id, workspace_id, hostname, state, is_system_default)
       VALUES (:'system_domain', :'platform', :'platform_workspace', :'platform_hostname', 'active', true);

     SELECT set_config('app.tenant_id', :'tenant_a', false) \\g /dev/null
     INSERT INTO workspaces (id, tenant_id, name) VALUES (:'workspace_a', :'tenant_a', 'A');
     INSERT INTO domains (id, tenant_id, workspace_id, hostname, state)
       VALUES (:'domain_pending', :'tenant_a', :'workspace_a', :'pending_hostname', 'pending_verification');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
       VALUES (:'tenant_a', :'workspace_a', :'system_domain', :'platform', :'platform_slug', :'destination_a');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
       VALUES (:'tenant_a', :'workspace_a', :'system_domain', :'platform', :'shared_slug', :'destination_a');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url, expires_at)
       VALUES (:'tenant_a', :'workspace_a', :'system_domain', :'platform', :'expired_slug', :'destination_a', now() - interval '1 hour');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url, activates_at)
       VALUES (:'tenant_a', :'workspace_a', :'system_domain', :'platform', :'scheduled_slug', :'destination_a', now() + interval '1 hour');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url, activates_at, expires_at)
       VALUES (:'tenant_a', :'workspace_a', :'system_domain', :'platform', :'in_window_slug', :'destination_a', now() - interval '1 minute', now() + interval '1 hour');
     -- The control characters are composed in SQL rather than passed as a psql variable, so
     -- what lands in the column is exactly one CR and exactly one CRLF and no escaping
     -- question stands between the fixture and the row.
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
       VALUES (:'tenant_a', :'workspace_a', :'system_domain', :'platform', :'bare_cr_slug',
               'https://example.test/a' || chr(13) || :'injected_header' || ': 1');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
       VALUES (:'tenant_a', :'workspace_a', :'system_domain', :'platform', :'crlf_slug',
               'https://example.test/a' || chr(13) || chr(10) || :'injected_header' || ': 1');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
       VALUES (:'tenant_a', :'workspace_a', :'domain_pending', :'tenant_a', :'pending_slug', :'destination_a');

     SELECT set_config('app.tenant_id', :'tenant_b', false) \\g /dev/null
     INSERT INTO workspaces (id, tenant_id, name) VALUES (:'workspace_b', :'tenant_b', 'B');
     INSERT INTO domains (id, tenant_id, workspace_id, hostname, state)
       VALUES (:'domain_b', :'tenant_b', :'workspace_b', :'tenant_b_hostname', 'active');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
       VALUES (:'tenant_b', :'workspace_b', :'domain_b', :'tenant_b', :'shared_slug', :'destination_b');`,
    {
      variables: {
        platform: PLATFORM_TENANT_ID,
        platform_workspace: PLATFORM_WORKSPACE_ID,
        system_domain: SYSTEM_DEFAULT_DOMAIN_ID,
        platform_hostname: PLATFORM_HOSTNAME,
        tenant_a: TENANT_A,
        tenant_b: TENANT_B,
        workspace_a: WORKSPACE_A,
        workspace_b: WORKSPACE_B,
        domain_b: DOMAIN_OWNED_BY_B,
        domain_pending: DOMAIN_NOT_ACTIVE,
        tenant_b_hostname: TENANT_B_HOSTNAME,
        pending_hostname: NOT_ACTIVE_HOSTNAME,
        platform_slug: PLATFORM_SLUG,
        shared_slug: SHARED_SLUG,
        expired_slug: EXPIRED_SLUG,
        scheduled_slug: SCHEDULED_SLUG,
        in_window_slug: IN_WINDOW_SLUG,
        bare_cr_slug: BARE_CR_SLUG,
        crlf_slug: CRLF_SLUG,
        injected_header: INJECTED_HEADER,
        pending_slug: ON_INACTIVE_DOMAIN_SLUG,
        destination_a: DESTINATION_A,
        destination_b: DESTINATION_B,
      },
    },
  );
}

/**
 * Holds every pooled connection open, so the next acquisition waits
 * `connectionTimeoutMillis` and then fails with an error carrying NO SQLSTATE (F-152). That
 * is the shape the redirect has to map to a 404, and the only honest way to produce it is
 * to actually exhaust the pool.
 */
async function saturatePool(): Promise<() => void> {
  const releases: (() => void)[] = [];
  const held: Promise<void>[] = [];

  for (let index = 0; index < POOL_MAX; index += 1) {
    held.push(
      new Promise<void>((acquired) => {
        void databaseTransaction(async () => {
          acquired();

          await new Promise<void>((release) => releases.push(release));
        }).catch(() => undefined);
      }),
    );
  }

  await Promise.all(held);

  return () => {
    for (const release of releases) {
      release();
    }
  };
}

beforeAll(async () => {
  assertAppRoleCannotBypassRls();
  createRlsFixture();
  eraseTenant(PLATFORM_TENANT_ID);
  plant();

  vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:1/api/auth');
  vi.stubEnv('GIT_COMMIT_SHA', '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  app = moduleRef.createNestApplication({ logger: false });
  // Exactly what `main.ts` sets, including the escaped literal that keeps every one-segment
  // `/api` GET route on `/api` (see `app.module.spec.ts`).
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }, REDIRECT_ROUTE_PREFIX_EXCLUSION],
  });
  await app.listen(0, '127.0.0.1');
  port = Number(new URL(await app.getUrl()).port);
}, 120_000);

/**
 * PLANTED ONCE, NOT PER TEST, AND THAT IS A PROPERTY OF THE SUBJECT RATHER THAN A SHORTCUT.
 * Nothing here mutates a row: the redirect is a read path, its transaction is `READ ONLY`,
 * and the one test that writes expects both of its inserts to be refused. Rebuilding the
 * two-tenant fixture per test would spend a psql round trip per assertion to restore state
 * no assertion can disturb.
 */
beforeEach(async () => {
  // COLD, PER TEST, AND THE ASSERTIONS BELOW DEPEND ON IT. Every statement count here, the
  // saturated-pool 404 and the two-domain resolution all describe a request that reaches
  // Postgres. A cached record from the test above answers instead, and each one measured
  // something else: see `cold-cache.ts` for the run that proved it.
  await clearRedirectCache();
  dbQueryCounter.reset();
});

afterAll(async () => {
  await app?.close();
  eraseTenant(PLATFORM_TENANT_ID);
  dropRlsFixture();
  await closeDatabase();
  vi.unstubAllEnvs();
});

/* ========================================================================== *
 * AC-2-14: the 302 and its headers.
 * ========================================================================== */

describe('AC-2-14: an active link answers 302 with the contract headers', () => {
  it('answers 302 with the destination byte for byte, and no rewriting of any kind', async () => {
    const probe = await onPlatform(`/${PLATFORM_SLUG}`);

    expect(probe.status).toBe(302);
    expect(probe.headers.location).toBe(DESTINATION_A);
    // The marker: `res.redirect` would have made this `a%7Cb`. It did not, because the
    // header is set directly.
    expect(probe.headers.location).toContain('a|b');
  });

  it('carries Cache-Control, Referrer-Policy and Server-Timing, and sets no cookie', async () => {
    const probe = await onPlatform(`/${PLATFORM_SLUG}`);

    expect(probe.headers['cache-control']).toBe('private, no-store');
    // The first of the two deliberate exceptions to helmet's defaults: passing the short
    // URL to the destination is the point of an attribution referrer, and the link is public.
    expect(probe.headers['referrer-policy']).toBe('unsafe-url');
    expect(probe.headers['server-timing']).toMatch(/^app;dur=\d+(\.\d+)?$/);
    expect(probe.headers['set-cookie']).toBeUndefined();
  });

  it('resolves whatever the Host casing and whatever the port (normalisation, step 1)', async () => {
    const upper = await get(`/${PLATFORM_SLUG}`, `LOCALHOST:${String(port)}`);
    const noPort = await get(`/${PLATFORM_SLUG}`, PLATFORM_HOSTNAME);

    expect([upper.status, noPort.status]).toEqual([302, 302]);
    expect([upper.headers.location, noPort.headers.location]).toEqual([
      DESTINATION_A,
      DESTINATION_A,
    ]);
  });

  it('costs exactly four statements: one transaction, its two-statement preamble, and two reads', async () => {
    dbQueryCounter.reset();

    await onPlatform(`/${PLATFORM_SLUG}`);

    expect(dbQueryCounter.read()).toBe(4);
  });
});

/* ========================================================================== *
 * AC-2-16: the default 404, its shape, and its CSP.
 * ========================================================================== */

describe('AC-2-16: the default 404', () => {
  it('answers 404 and not 200, as HTML, for an unknown slug', async () => {
    const probe = await onPlatform('/notaslug1');

    expect(probe.status).toBe(404);
    expect(probe.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(probe.body.startsWith('<!doctype html>')).toBe(true);
  });

  /**
   * D-2-14 and F-280's open half. The per-response CSP REPLACES helmet's, and
   * `frame-ancestors` does not fall back to `default-src`, so the served page has to carry
   * its own or the framing protection helmet adds is silently dropped on exactly the
   * response that renders tenant-controlled branding.
   */
  it('carries the contract CSP INCLUDING frame-ancestors none, and nosniff', async () => {
    const probe = await onPlatform('/notaslug1');

    expect(probe.headers['content-security-policy']).toBe(REDIRECT_404_CSP);
    expect(probe.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(probe.headers['x-content-type-options']).toBe('nosniff');
    expect(probe.headers['cache-control']).toBe('private, no-store');
  });

  it('answers the same 404 for an unknown hostname, and for a Host that is not a hostname', async () => {
    const unknownHost = await get('/notaslug1', 'nobody.example.test');
    const malformed = await get('/notaslug1', 'not a host name');

    expect([unknownHost.status, malformed.status]).toEqual([404, 404]);
    expect(unknownHost.body).toBe(malformed.body);
  });

  /**
   * F-003, the state predicate. A domain that never left `pending_verification` serves
   * nothing, including a link that really does point at it, which is the case a filter
   * written as an afterthought gets wrong.
   */
  it('answers 404 for a hostname whose domain is not active, link or no link', async () => {
    const probe = await get(`/${ON_INACTIVE_DOMAIN_SLUG}`, NOT_ACTIVE_HOSTNAME);

    expect(probe.status).toBe(404);
    expect(probe.headers.location).toBeUndefined();
  });
});

/* ========================================================================== *
 * AC-2-17: the shape fast-reject, and the two surfaces the controller must not see.
 * ========================================================================== */

describe('AC-2-17: a segment that cannot be a slug never reaches a store', () => {
  it.each(['/favicon.ico', '/robots.txt', `/${'a'.repeat(65)}`, '/-leading', '/trailing-'])(
    'answers the default 404 for %s with zero Postgres queries',
    async (path) => {
      dbQueryCounter.reset();

      const probe = await get(path, PLATFORM_HOSTNAME);

      expect(probe.status).toBe(404);
      expect(dbQueryCounter.read()).toBe(0);
    },
  );

  it('GET /health is answered by the health controller, not by a slug lookup', async () => {
    dbQueryCounter.reset();

    const probe = await onPlatform('/health');

    expect(probe.status).toBe(200);
    expect(JSON.parse(probe.body)).toMatchObject({ status: 'ok' });
    expect(dbQueryCounter.read()).toBe(0);
  });

  /**
   * The prefix exclusion is the escaped literal, so `GET /api/links` is still `GET
   * /api/links` and an unrouted `/api` path still reaches `ApiExceptionFilter`. If the
   * exclusion were the obvious `':slug'`, the first of these would answer this page and the
   * second would be the only `/api` route left standing.
   */
  it('no /api path reaches the redirect controller', async () => {
    const listRoute = await onPlatform('/api/links');
    const unrouted = await onPlatform('/api/no-such-route-exists-here');

    expect(listRoute.headers['content-type']).toContain('application/json');
    expect(listRoute.status).toBe(401);
    expect(unrouted.status).toBe(404);
    expect(unrouted.headers['content-type']).toContain('application/json');
  });
});

/* ========================================================================== *
 * AC-2-18: no 5xx, ever, including the failure with no SQLSTATE.
 * ========================================================================== */

describe('AC-2-18: the pool is exhausted and the visitor still gets a page', () => {
  it('answers the default 404 with the pool saturated, and logs one line naming no slug, host or destination', async () => {
    const release = await saturatePool();

    try {
      const captured = await capturingLogs(async () => onPlatform(`/${PLATFORM_SLUG}`));

      expect(captured.value.status).toBe(404);
      // AC-2-16's other half: the page renders with no database access at all, which is
      // what makes it available when the database is the thing that failed.
      expect(captured.value.body.startsWith('<!doctype html>')).toBe(true);
      expect(captured.value.headers['content-security-policy']).toBe(REDIRECT_404_CSP);

      const errors = captured.lines.filter((line) => line.record.level === 'error');

      expect(errors).toHaveLength(1);
      expect(errors[0].record.code).toBe('redirect_resolution_failed');
      expect(errors[0].record.route).toBe('/:slug');
      expect(errors[0].record.err_message).toBeUndefined();

      // GC-G, over the WHOLE capture rather than over the error line alone: the request
      // line is on it too, and neither may carry the concrete path or the destination.
      expect(captured.raw).not.toContain(PLATFORM_SLUG);
      expect(captured.raw).not.toContain('example.test');
      expect(captured.raw).not.toContain(PLATFORM_HOSTNAME);
    } finally {
      release();
    }
  }, 30_000);

  /**
   * AC-2-19's other half. `route` is the PATTERN and never the path a visitor typed, which
   * is the whole of GC-G on this surface: a concrete `/:slug` path is the click stream.
   */
  it('AC-2-19: the request line carries route /:slug, not the concrete path', async () => {
    const captured = await capturingLogs(async () => onPlatform(`/${PLATFORM_SLUG}`));

    const requestLines = captured.lines.filter((line) => line.record.route !== undefined);

    expect(requestLines).toHaveLength(1);
    expect(requestLines[0].record.route).toBe('/:slug');
    expect(requestLines[0].record.status).toBe(302);
    expect(captured.raw).not.toContain(PLATFORM_SLUG);
  });
});

/* ========================================================================== *
 * Invariant 1 again: a destination that is not a legal header value.
 * ========================================================================== */

/**
 * ============================================================================
 * THE `Location` VALUE IS WRITTEN VERBATIM, SO A ROW CAN CARRY SOMETHING UNWRITABLE.
 * ============================================================================
 *
 * The redirect does no read-time validation of `destination_url`, deliberately: AC-2-14
 * says the header is the stored value byte for byte, and a resolver that sanitised it
 * would be a second, quieter definition of what a destination is. The guarantee that the
 * value is writable therefore lives entirely on the WRITE paths, and there is no CHECK
 * constraint behind it, so a row planted by anything that skipped `destinationUrlContract`
 * (a bulk import, a backfill, a support script, psql) can hold a raw CR.
 *
 * What happens then is already correct and was, until this test, unmeasured: Node refuses
 * the header value with `ERR_INVALID_CHAR`, the controller's catch turns the throw into the
 * mandated default 404, and nothing splits. That is three mechanisms agreeing, none of them
 * named by a test, which is the shape this repository keeps filing findings about. A later
 * refactor of the catch, or a `writeHead` that skipped validation, would lose it silently.
 *
 * The rows are planted by SQL for exactly the reason the property exists: the contract that
 * would refuse them is on the route, and the route is not what wrote these.
 */
describe('a stored destination carrying a control character degrades to the 404', () => {
  it.each([
    [BARE_CR_SLUG, 'a bare CR'],
    [CRLF_SLUG, 'a CRLF'],
  ])('answers the default 404 for a destination containing %s (%s), never a 5xx', async (slug) => {
    const captured = await capturingLogs(async () => onPlatform(`/${slug}`));
    const probe = captured.value;

    expect(probe.status).toBe(404);
    expect(probe.status).toBeLessThan(500);
    expect(probe.body.startsWith('<!doctype html>')).toBe(true);
    expect(probe.headers['content-security-policy']).toBe(REDIRECT_404_CSP);

    // No second header reached the wire, under any spelling, and no partial `Location`
    // survived the throw that refused it.
    const names = probe.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());

    expect(names).not.toContain(INJECTED_HEADER.toLowerCase());
    expect(names).not.toContain('location');
    expect(probe.body).not.toContain(INJECTED_HEADER);

    // The 302's own header exception does not survive onto the 404 the catch renders.
    expect(probe.headers['referrer-policy']).not.toBe('unsafe-url');

    const errors = captured.lines.filter((line) => line.record.level === 'error');

    expect(errors).toHaveLength(1);
    expect(errors[0].record.code).toBe('redirect_resolution_failed');
    expect(errors[0].record.route).toBe('/:slug');
    // GC-G: the refused value is a destination, and a destination never reaches a log line,
    // which is why the message is withheld rather than being the obvious thing to report.
    expect(errors[0].record.err_message).toBeUndefined();
    expect(captured.raw).not.toContain('example.test');
    expect(captured.raw).not.toContain(INJECTED_HEADER);
  });

  it('serves the neighbouring links normally, so the refusal is the row and not the route', async () => {
    expect((await onPlatform(`/${PLATFORM_SLUG}`)).status).toBe(302);
  });
});

/* ========================================================================== *
 * AC-2-26 and AC-2-27: the validity window, on the Postgres path.
 * ========================================================================== */

describe('AC-2-26 and AC-2-27: the window is evaluated on the read', () => {
  it('answers 404 for a link whose expiry has passed, with no write anywhere', async () => {
    const probe = await onPlatform(`/${EXPIRED_SLUG}`);

    expect(probe.status).toBe(404);
    expect(probe.headers.location).toBeUndefined();
  });

  it('answers 404 for a link that has not activated yet', async () => {
    const probe = await onPlatform(`/${SCHEDULED_SLUG}`);

    expect(probe.status).toBe(404);
  });

  it('answers 302 when both bounds are absent', async () => {
    expect((await onPlatform(`/${PLATFORM_SLUG}`)).status).toBe(302);
  });

  /**
   * THE TEST THAT WOULD CATCH A CONVERSION THAT SILENTLY PRODUCED `Invalid Date`.
   *
   * Both timestamps come back from this connection as STRINGS: drizzle's node-postgres
   * session installs a type parser returning `timestamptz` verbatim, and that parser is on
   * the connection whatever issues the query. `isLinkActive` fails closed on a bound it
   * cannot read, so a broken conversion 404s every link that HAS a window, and every test
   * above would still pass, because each of them expects a 404 for its own reason. This
   * link carries BOTH bounds, both readable, both open, and it must answer 302.
   */
  it('reads a real instant out of both bounds, not an unparseable one', async () => {
    const probe = await onPlatform(`/${IN_WINDOW_SLUG}`);

    expect(probe.status).toBe(302);
    expect(probe.headers.location).toBe(DESTINATION_A);
  });
});

/* ========================================================================== *
 * Invariants 4 and 5: the domain a link may not lie about, from the READ side.
 * ========================================================================== */

/**
 * ============================================================================
 * THE REGRESSION MIGRATION 0005 AND ADR-0063 EXIST FOR, MEASURED WHERE IT MATTERS.
 * ============================================================================
 *
 * `links` names its domain as the pair `(domain_id, domain_tenant_id)`, keyed into
 * `domains (id, tenant_id)` and narrowed by `links_domain_owner_check` to the row's own
 * tenant or the platform. `migration-0005.int-spec.ts` proves the WRITE side: four refusals
 * and two admissions. This is the READ side, and it is the one that matters to a visitor:
 * the defect that motivated the key was not "a bad row exists" but "the redirect's own two
 * queries then served tenant A's destination under tenant B's hostname".
 *
 * Item 2 has exactly one domain in production and the property is therefore unobservable in
 * the shipped configuration, which is precisely why it is planted here: when item 3 lands
 * tenant-owned domains, the property is already measured rather than assumed, and the test
 * that would catch a regression is older than the code that could cause one.
 */
describe('invariant 5: a hostname resolves only links on its own domain', () => {
  it('serves each tenant its own destination for one slug held on two domains', async () => {
    const onPlatformDomain = await onPlatform(`/${SHARED_SLUG}`);
    const onTenantBDomain = await get(`/${SHARED_SLUG}`, `${TENANT_B_HOSTNAME}:${String(port)}`);

    expect(onPlatformDomain.status).toBe(302);
    expect(onPlatformDomain.headers.location).toBe(DESTINATION_A);

    expect(onTenantBDomain.status).toBe(302);
    expect(onTenantBDomain.headers.location).toBe(DESTINATION_B);
  });

  it('answers 404 on one hostname for a slug that exists only on the other (invariant 4)', async () => {
    // `PLATFORM_SLUG` exists on the system default domain and nowhere else.
    const elsewhere = await get(`/${PLATFORM_SLUG}`, `${TENANT_B_HOSTNAME}:${String(port)}`);

    expect(elsewhere.status).toBe(404);
    expect(elsewhere.headers.location).toBeUndefined();
  });

  /**
   * The database refuses the row the read side is protected from, so the two halves cannot
   * drift: even if a future create path forgot its application check, this insert is a
   * constraint violation rather than a link tenant A serves under tenant B's hostname.
   */
  it('the database refuses a link naming another tenant\'s domain, so no such row can be read', async () => {
    const stealDomain = (domainTenantId: string): void => {
      execSql(
        migrationDsn(),
        `INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
         VALUES (:'tenant'::uuid, :'workspace'::uuid, :'domain'::uuid, :'domain_tenant'::uuid, :'slug', :'destination')`,
        {
          tenantId: TENANT_A,
          variables: {
            tenant: TENANT_A,
            workspace: WORKSPACE_A,
            domain: DOMAIN_OWNED_BY_B,
            domain_tenant: domainTenantId,
            slug: 'stolen1',
            destination: DESTINATION_A,
          },
        },
      );
    };

    // Telling the truth about the owner fails the CHECK; lying about it fails the key.
    // Neither leaves a row, which is why the read side has nothing to filter.
    expect(() => stealDomain(TENANT_B)).toThrow(/links_domain_owner_check/);
    expect(() => stealDomain(TENANT_A)).toThrow(/links_domain_tenant_fk/);

    const probe = await get('/stolen1', `${TENANT_B_HOSTNAME}:${String(port)}`);

    expect(probe.status).toBe(404);
  });
});
