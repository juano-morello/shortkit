import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { createHmac } from 'node:crypto';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CLICK_USER_AGENT_MAX_LENGTH } from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import {
  CLICK_ROW_BIND_PARAMETERS,
  ClickEventBuffer,
  POSTGRES_MAX_BIND_PARAMETERS,
} from '../../src/clicks/click-event-buffer';
import { ClickEventWriterRepository } from '../../src/clicks/click-event.writer';
import { UNKNOWN_IP_SENTINEL } from '../../src/clicks/trusted-client-ip';
import { closeDatabase } from '../../src/db/client';
import {
  PLATFORM_TENANT_ID,
  PLATFORM_WORKSPACE_ID,
  SYSTEM_DEFAULT_DOMAIN_ID,
} from '../../src/db/platform';
import { REDIRECT_ROUTE_PREFIX_EXCLUSION } from '../../src/redirect/redirect.module';
import { withTenantTransaction } from '../../src/tenancy/tenant-context';
import { clearRedirectCache } from '../cache/cold-cache';
import { startApiServer } from '../support/api-server';
import { authServerEnv } from '../support/auth-fixture';
import { execSql, querySql } from '../support/psql';
import {
  TENANT_A,
  TENANT_B,
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
} from '../support/rls-fixture';

/**
 * STORY-2-07 on the write path: AC-2-33 (exactly one row per resolved redirect, awaiting
 * `flush()` and never sleeping), AC-2-34 (zero rows on the outcomes that are not a redirect;
 * an idempotent retry), AC-2-36 (the three trusted-address cases, verbatim from the
 * contract), AC-2-37 (the tenant salt, and the boot refusal), AC-2-38's SIGTERM clause.
 * TASK-2-09, wave 4.
 *
 * Contract: `docs/contracts/click-events.md`, `trusted-client-address.md`,
 * `redirect-resolution.md` (decision step 7). ADR-0010, ADR-0040; D-2-10, D-2-17.
 *
 * ============================================================================
 * THE REDIRECT IS DRIVEN OVER REAL HTTP, AND THE ROW IS READ WITH `psql`.
 * ============================================================================
 *
 * Every assertion below is about a value that crossed both boundaries: a header the visitor
 * chose, and a column RLS admitted. Calling the sink directly would prove the buffer works
 * and nothing about whether the handler calls it once, on the right decision, with the
 * tenant of the record it resolved, which is the half of AC-2-33 that has bitten before.
 *
 * `node:http` rather than `fetch` for the reason `redirect.int-spec.ts` gives: it can send a
 * `Host` a client library would refuse to, and it can send the header bag verbatim.
 */

const PLATFORM_HOSTNAME = 'localhost';
/** Tenant B's own active domain. The same shape item 3 makes ordinary, planted today. */
const TENANT_B_HOSTNAME = '127.0.0.1';

const WORKSPACE_A = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const WORKSPACE_B = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
const DOMAIN_OWNED_BY_B = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';

const LINK_A = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
const LINK_B = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5';
const LINK_EXPIRED = 'd6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6';

const SLUG_A = 'clicksA1';
const SLUG_B = 'clicksB1';
const SLUG_EXPIRED = 'clicksX1';
const SLUG_NOBODY_HAS = 'nosuch01';

const DESTINATION = 'https://example.test/clicked?x=1';

/** 32 bytes of base64url. A fixture for this suite; it hashes nothing but test traffic. */
const CLICK_KEY = 'FIXTURE-click-ip-hash-key-not-a-real-value0';

const DECLARED_HEADER = 'x-test-client-ip';
const VISITOR_IP = '203.0.113.7';

/** What the contract's `ip_hash` formula produces, computed independently of the shipped code. */
function expectedHash(tenantId: string, ip: string): string {
  return createHmac('sha256', Buffer.from(CLICK_KEY, 'base64url'))
    .update(`${tenantId}:${ip}`)
    .digest('base64url')
    .slice(0, 22);
}

let app: INestApplication | undefined;
let port = 0;

/* ========================================================================== *
 * HTTP, at a level that lets the Host header and the header bag be anything.
 * ========================================================================== */

interface Probe {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
}

async function get(
  path: string,
  host: string,
  headers: Record<string, string> = {},
  target = port,
): Promise<Probe> {
  return new Promise<Probe>((resolve, reject) => {
    const call = httpRequest(
      {
        host: '127.0.0.1',
        port: target,
        path,
        method: 'GET',
        headers: { host, ...headers },
        setHost: false,
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers });
        });
      },
    );

    call.on('error', reject);
    call.end();
  });
}

function onPlatform(path: string, headers: Record<string, string> = {}): Promise<Probe> {
  return get(path, `${PLATFORM_HOSTNAME}:${String(port)}`, headers);
}

/* ========================================================================== *
 * The rows, read through the owner role with the tenant flag set: `click_events`
 * is FORCE ROW LEVEL SECURITY, so even the owner reads nothing without it.
 * ========================================================================== */

interface ClickRow {
  id: string;
  tenantId: string;
  linkId: string;
  domainId: string;
  ipHash: string;
  userAgent: string | null;
  occurredAt: string;
}

function clickRowsFor(tenantId: string, linkId?: string): ClickRow[] {
  return querySql<ClickRow>(
    migrationDsn(),
    `select id, tenant_id as "tenantId", link_id as "linkId", domain_id as "domainId",
            ip_hash as "ipHash", user_agent as "userAgent",
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') as "occurredAt"
       from click_events
      where tenant_id = :'tenant'::uuid
        ${linkId === undefined ? '' : "and link_id = :'link'::uuid"}
      order by id`,
    { tenantId, variables: { tenant: tenantId, link: linkId ?? tenantId } },
  );
}

/** A COUNT rather than the rows: a nine-thousand-row select overflows `spawnSync`'s buffer. */
function clickCountFor(tenantId: string, linkId: string): number {
  const [row] = querySql<{ n: number }>(
    migrationDsn(),
    `select count(*)::int as n from click_events
      where tenant_id = :'tenant'::uuid and link_id = :'link'::uuid`,
    { tenantId, variables: { tenant: tenantId, link: linkId } },
  );

  return row?.n ?? -1;
}

function deleteClicks(): void {
  for (const tenantId of [TENANT_A, TENANT_B]) {
    execSql(migrationDsn(), `DELETE FROM click_events WHERE tenant_id = :'tenant'::uuid`, {
      tenantId,
      variables: { tenant: tenantId },
    });
  }
}

/* ========================================================================== *
 * Fixtures. Every insert runs with the owning tenant's flag set, because all
 * three tables are FORCE ROW LEVEL SECURITY and each row satisfies its own
 * tenant's WITH CHECK (the shape `redirect.int-spec.ts` established).
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
     INSERT INTO links (id, tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
       VALUES (:'link_a', :'tenant_a', :'workspace_a', :'system_domain', :'platform', :'slug_a', :'destination');
     INSERT INTO links (id, tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url, expires_at)
       VALUES (:'link_expired', :'tenant_a', :'workspace_a', :'system_domain', :'platform', :'slug_expired', :'destination', now() - interval '1 hour');

     SELECT set_config('app.tenant_id', :'tenant_b', false) \\g /dev/null
     INSERT INTO workspaces (id, tenant_id, name) VALUES (:'workspace_b', :'tenant_b', 'B');
     INSERT INTO domains (id, tenant_id, workspace_id, hostname, state)
       VALUES (:'domain_b', :'tenant_b', :'workspace_b', :'hostname_b', 'active');
     INSERT INTO links (id, tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
       VALUES (:'link_b', :'tenant_b', :'workspace_b', :'domain_b', :'tenant_b', :'slug_b', :'destination');`,
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
        hostname_b: TENANT_B_HOSTNAME,
        link_a: LINK_A,
        link_b: LINK_B,
        link_expired: LINK_EXPIRED,
        slug_a: SLUG_A,
        slug_b: SLUG_B,
        slug_expired: SLUG_EXPIRED,
        destination: DESTINATION,
      },
    },
  );
}

function buffer(): ClickEventBuffer {
  const instance = app;

  if (instance === undefined) {
    throw new Error('the application was not built; nothing below could have a buffer');
  }

  return instance.get(ClickEventBuffer, { strict: false });
}

beforeAll(async () => {
  assertAppRoleCannotBypassRls();
  createRlsFixture();
  eraseTenant(PLATFORM_TENANT_ID);
  plant();

  vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:1/api/auth');
  vi.stubEnv('GIT_COMMIT_SHA', '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b');
  // Read once, when the module compiles (`clicks.module.ts`), so it is stubbed before the
  // graph is built and never touched again.
  vi.stubEnv('CLICK_IP_HASH_KEY', CLICK_KEY);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }, REDIRECT_ROUTE_PREFIX_EXCLUSION],
  });
  await app.listen(0, '127.0.0.1');
  port = Number(new URL(await app.getUrl()).port);
}, 120_000);

beforeEach(async () => {
  // The declared header is set per test, never inherited from the runner's environment:
  // AC-2-36's first case is exactly "no declared header", and a suite that inherited one
  // would pass it vacuously.
  vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', undefined);
  await buffer().flush();
  deleteClicks();
  // The click a resolution enqueues carries the TENANT OF THE RECORD, so a cached record
  // from the test above writes the row under the wrong tenant and this file's subject
  // disappears. Cold, per test, for the reason `cold-cache.ts` gives.
  await clearRedirectCache();
});

afterAll(async () => {
  await app?.close();
  eraseTenant(PLATFORM_TENANT_ID);
  dropRlsFixture();
  await closeDatabase();
  vi.unstubAllEnvs();
});

/* ========================================================================== *
 * AC-2-33: exactly one row per resolved redirect.
 * ========================================================================== */

describe('AC-2-33: a resolved redirect appends exactly one click event', () => {
  it('writes one row carrying the link, the domain and the tenant of the record it resolved', async () => {
    const probe = await onPlatform(`/${SLUG_A}`, { 'user-agent': 'Mozilla/5.0 (a probe)' });

    expect(probe.status).toBe(302);

    // AWAITED, NEVER SLEPT (ADR-0010: "the AC-56 test awaits `flush()`"). A 1000 ms sleep
    // would be the flaky test the hook exists to prevent.
    await buffer().flush();

    const rows = clickRowsFor(TENANT_A, LINK_A);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
    expect(rows[0]?.linkId).toBe(LINK_A);
    expect(rows[0]?.domainId).toBe(SYSTEM_DEFAULT_DOMAIN_ID);
    expect(rows[0]?.userAgent).toBe('Mozilla/5.0 (a probe)');
    expect(rows[0]?.ipHash).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(rows[0]?.occurredAt).not.toBe('');
  });

  it('appends a second row for a second redirect, with time-sorted UUID v7 ids', async () => {
    await onPlatform(`/${SLUG_A}`);
    await onPlatform(`/${SLUG_A}`);
    await buffer().flush();

    const rows = clickRowsFor(TENANT_A, LINK_A);

    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }

    // Ordered by id above, and the ids sort by draw order, so this is also arrival order.
    expect(rows[0]?.occurredAt.localeCompare(rows[1]?.occurredAt ?? '')).toBeLessThanOrEqual(0);
  });

  it('writes the tenant of the record, not of the caller: tenant B\'s domain writes tenant B\'s row', async () => {
    await get(`/${SLUG_B}`, TENANT_B_HOSTNAME);
    await buffer().flush();

    expect(clickRowsFor(TENANT_B, LINK_B)).toHaveLength(1);
    expect(clickRowsFor(TENANT_A)).toHaveLength(0);
  });

  /**
   * AC-2-38's truncation clause, over the wire. FOUR KIB AND NOT SIXTEEN, and the reason is
   * worth recording: Node's HTTP server bounds the whole header block at 16 KiB
   * (`--max-http-header-size`), so a 16 KiB `User-Agent` never reaches a handler at all:
   * the server answers 431 and no redirect, and therefore no click, happens. The 16 KiB case
   * is asserted where it is reachable, at the buffer (`click-event-buffer.spec.ts`), which
   * is also where F-013's heap measurement was taken. What this proves is the half only the
   * database can: the value that lands in `varchar(512)` is the truncated one.
   */
  it('truncates an oversized User-Agent to 512 characters in the stored row (AC-2-38)', async () => {
    await onPlatform(`/${SLUG_A}`, { 'user-agent': 'u'.repeat(4 * 1024) });
    await buffer().flush();

    expect(clickRowsFor(TENANT_A, LINK_A)[0]?.userAgent).toHaveLength(CLICK_USER_AGENT_MAX_LENGTH);
  });
});

/* ========================================================================== *
 * AC-2-34: zero rows on every outcome that is not a resolved redirect.
 * ========================================================================== */

describe('AC-2-34: nothing but a resolved redirect writes a row', () => {
  it('writes nothing for an unknown slug (404)', async () => {
    const probe = await onPlatform(`/${SLUG_NOBODY_HAS}`);
    await buffer().flush();

    expect(probe.status).toBe(404);
    expect(clickRowsFor(TENANT_A)).toHaveLength(0);
    expect(clickRowsFor(TENANT_B)).toHaveLength(0);
  });

  it('writes nothing for a link outside its validity window, which resolves to a 404', async () => {
    const probe = await onPlatform(`/${SLUG_EXPIRED}`);
    await buffer().flush();

    expect(probe.status).toBe(404);
    expect(clickRowsFor(TENANT_A, LINK_EXPIRED)).toHaveLength(0);
  });

  it('writes nothing for a path that fails the shape check before any I/O', async () => {
    const probe = await onPlatform('/favicon.ico');
    await buffer().flush();

    expect(probe.status).toBe(404);
    expect(clickRowsFor(TENANT_A)).toHaveLength(0);
  });

  /**
   * The retry ADR-0010 makes idempotent: the second attempt re-sends the SAME ids, and
   * `ON CONFLICT (id) DO NOTHING` writes nothing the first landed. Driven through the shipped
   * writer rather than by simulating a driver failure, because what is under test is the
   * STATEMENT: that it is `DO NOTHING` and never `DO UPDATE` (F-341).
   */
  it('a repeated batch writes one row per id, never two and never an update', async () => {
    await onPlatform(`/${SLUG_A}`);

    const buffered = [...buffer().buffered];
    expect(buffered).toHaveLength(1);

    const writer = app?.get(ClickEventWriterRepository, { strict: false });

    if (writer === undefined) {
      throw new Error('the writer did not resolve from the production graph');
    }

    await withTenantTransaction(TENANT_A, async () => writer.append(buffered));
    await withTenantTransaction(TENANT_A, async () => writer.append(buffered));
    // And once more through the buffer's own flush, which holds the same events.
    await buffer().flush();

    const rows = clickRowsFor(TENANT_A, LINK_A);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(buffered[0]?.id);
    expect(rows[0]?.ipHash).toBe(buffered[0]?.ipHash);
  });
});

/* ========================================================================== *
 * The wire ceiling, against the real protocol: a legal buffer must be sendable.
 * ========================================================================== */

describe('a group larger than one INSERT can carry still lands, every row of it', () => {
  /**
   * ============================================================================
   * THE BOUNDARY, DRIVEN RATHER THAN DESCRIBED.
   * ============================================================================
   *
   * The extended query protocol carries the parameter count as an Int16 and drizzle emits
   * seven per row, so 9362 rows is the largest statement that can go over the wire: measured
   * here against Postgres 17 through the shipped writer, 9362 is accepted and 9363 raises
   * 08P01. The buffer's own cap is 10,000 rows, and an agentless row is the cheapest one an
   * anonymous visitor can produce on a surface that is deliberately never rate limited, so a
   * single-tenant group legitimately reaches a size the wire refuses. Unchunked, the retry
   * re-sent the identical rows, failed identically, and dropped the WHOLE group: total loss
   * exactly when a slow database had made the buffer large.
   *
   * The enqueue is direct rather than through 9400 HTTP requests: what is under test is the
   * flusher meeting Postgres, and the redirect's own call into `enqueue` is asserted above.
   */
  it('writes 9400 rows in one tenant group, which one statement could not have carried', async () => {
    const size = 9400;

    expect(size * CLICK_ROW_BIND_PARAMETERS).toBeGreaterThan(POSTGRES_MAX_BIND_PARAMETERS);

    for (let event = 0; event < size; event += 1) {
      buffer().enqueue({
        linkId: LINK_A,
        domainId: SYSTEM_DEFAULT_DOMAIN_ID,
        tenantId: TENANT_A,
        occurredAt: new Date(),
        headers: {},
      });
    }

    expect(buffer().size).toBe(size);

    await buffer().flush();

    expect(clickCountFor(TENANT_A, LINK_A)).toBe(size);
    expect(buffer().size).toBe(0);
  }, 120_000);
});

/* ========================================================================== *
 * AC-2-36: the three cases the contract writes out, and no fourth reading of a header.
 * ========================================================================== */

describe('AC-2-36: `ip_hash` comes from the declared trusted header or from nothing', () => {
  it('case 1: X-Forwarded-For with no declared header stores the SENTINEL\'s hash', async () => {
    await onPlatform(`/${SLUG_A}`, { 'x-forwarded-for': VISITOR_IP });
    await buffer().flush();

    const stored = clickRowsFor(TENANT_A, LINK_A)[0]?.ipHash;

    expect(stored).toBe(expectedHash(TENANT_A, UNKNOWN_IP_SENTINEL));
    expect(stored).not.toBe(expectedHash(TENANT_A, VISITOR_IP));
  });

  it('case 2: a declared header, only X-Forwarded-For sent, stores the sentinel\'s hash', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', DECLARED_HEADER);

    await onPlatform(`/${SLUG_A}`, { 'x-forwarded-for': VISITOR_IP });
    await buffer().flush();

    expect(clickRowsFor(TENANT_A, LINK_A)[0]?.ipHash).toBe(
      expectedHash(TENANT_A, UNKNOWN_IP_SENTINEL),
    );
  });

  /** The one assertion separating this resolver from `resolveRateLimitPrincipal` (F-031). */
  it('case 3: the BFF pair WITH a valid proxy-auth secret still stores the sentinel\'s hash', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', DECLARED_HEADER);
    vi.stubEnv('BFF_PROXY_SECRET', 'FIXTURE-bff-proxy-secret_not_a_real_value_00');

    await onPlatform(`/${SLUG_A}`, {
      'x-shortkit-client-ip': VISITOR_IP,
      'x-shortkit-proxy-auth': 'FIXTURE-bff-proxy-secret_not_a_real_value_00',
    });
    await buffer().flush();

    expect(clickRowsFor(TENANT_A, LINK_A)[0]?.ipHash).toBe(
      expectedHash(TENANT_A, UNKNOWN_IP_SENTINEL),
    );
  });

  it('stores the DECLARED header\'s address, hashed, when the deployment declares one', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', DECLARED_HEADER);

    await onPlatform(`/${SLUG_A}`, { [DECLARED_HEADER]: VISITOR_IP });
    await buffer().flush();

    expect(clickRowsFor(TENANT_A, LINK_A)[0]?.ipHash).toBe(expectedHash(TENANT_A, VISITOR_IP));
  });

  it('the raw address reaches no column: no row anywhere holds it in any field', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', DECLARED_HEADER);

    await onPlatform(`/${SLUG_A}`, { [DECLARED_HEADER]: VISITOR_IP, 'user-agent': 'probe' });
    await buffer().flush();

    expect(JSON.stringify(clickRowsFor(TENANT_A, LINK_A))).not.toContain(VISITOR_IP);
  });
});

/* ========================================================================== *
 * AC-2-37: the tenant salt, and the boot refusal.
 * ========================================================================== */

describe('AC-2-37: the HMAC is salted with the tenant, and the key is required at boot', () => {
  it('the same visitor under two tenants produces two different hashes', async () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', DECLARED_HEADER);

    await onPlatform(`/${SLUG_A}`, { [DECLARED_HEADER]: VISITOR_IP });
    await get(`/${SLUG_B}`, TENANT_B_HOSTNAME, { [DECLARED_HEADER]: VISITOR_IP });
    await buffer().flush();

    const a = clickRowsFor(TENANT_A, LINK_A)[0]?.ipHash;
    const b = clickRowsFor(TENANT_B, LINK_B)[0]?.ipHash;

    expect(a).toBe(expectedHash(TENANT_A, VISITOR_IP));
    expect(b).toBe(expectedHash(TENANT_B, VISITOR_IP));
    expect(a).not.toBe(b);
  });

  /**
   * D-2-17's refusal, against a REAL BOOT: `assertBootPreconditions()` runs in `main.ts`, so
   * an in-process module graph cannot exercise it: that graph is exactly the one that mints
   * an ephemeral key instead (`ip-hash.ts`).
   */
  it('the process refuses to boot without CLICK_IP_HASH_KEY, naming the precondition', async () => {
    await expect(
      startApiServer({ env: (baseUrl) => ({ ...authServerEnv(baseUrl), CLICK_IP_HASH_KEY: '' }) }),
    ).rejects.toThrow(/click_ip_hash_key/);
  }, 180_000);

  it('the process refuses to boot on a malformed key, and the refusal never quotes it', async () => {
    const malformed = 'not-32-bytes-of-base64url';

    const failure = await startApiServer({
      env: (baseUrl) => ({ ...authServerEnv(baseUrl), CLICK_IP_HASH_KEY: malformed }),
    }).then(
      async (server) => {
        await server.stop();

        return new Error('the API booted with a malformed CLICK_IP_HASH_KEY');
      },
      (error: unknown) => error as Error,
    );

    // `startApiServer`'s rejection carries the child's whole captured output, so this reads
    // the refusal line the operator would read.
    expect(failure.message).toContain('click_ip_hash_key');
    expect(failure.message).not.toContain(malformed);
  }, 180_000);
});

/* ========================================================================== *
 * AC-2-38's shutdown clause: SIGTERM drains, within the bound.
 * ========================================================================== */

describe('AC-2-38: SIGTERM drains the buffer inside its 5 s bound', () => {
  it('lands the buffered click and exits, rather than dropping it on an ordinary restart', async () => {
    const server = await startApiServer({
      env: (baseUrl) => ({ ...authServerEnv(baseUrl), CLICK_IP_HASH_KEY: CLICK_KEY }),
    });

    try {
      // The child serves the redirect on its own port, outside the `/api` prefix (ADR-0006).
      // `node:http` and not `fetch`, because `Host` is a forbidden header there and this
      // request has to arrive at the platform hostname rather than at 127.0.0.1.
      const childPort = Number(new URL(server.baseUrl).port);
      const probe = await get(`/${SLUG_A}`, PLATFORM_HOSTNAME, {}, childPort);

      expect(probe.status).toBe(302);

      // SIGTERM IMMEDIATELY, WITH NOTHING BETWEEN. The flush window is 1000 ms, so the
      // buffer still holds the event; the assertion below on the drain's own count is what
      // makes that a measurement rather than an assumption: a run where the timer won the
      // race reports 0 and fails, instead of passing on a row the drain never wrote.
      const started = Date.now();
      await server.stop();
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(5000);
      expect(server.output()).toMatch(/SIGTERM: 1 buffered click events were drained/);
      expect(clickRowsFor(TENANT_A, LINK_A)).toHaveLength(1);
    } finally {
      await server.stop();
    }
  }, 180_000);
});
