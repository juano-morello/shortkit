/**
 * The rows and the HTTP probe the two TASK-2-07 suites share.
 *
 * `redirect-cache.int-spec.ts` measures what each cache state costs and
 * `redirect-degraded.int-spec.ts` takes the cache away; both need the same handful of links
 * on the same seeded system default domain, and neither needs the two-domain, control-
 * character, pool-saturation fixture `redirect.int-spec.ts` carries for TASK-2-06's own ACs.
 * Extracted rather than copied twice: a fixture that drifts between two suites measuring the
 * same path is a suite that disagrees with itself about what a warm key holds.
 *
 * Every insert goes through the MIGRATOR with the owning tenant's flag set, because all three
 * tables are FORCE ROW LEVEL SECURITY and each row has to satisfy its own tenant's WITH
 * CHECK: a migrator insert without the flag writes zero rows and reports success (F-236).
 */
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';

import {
  PLATFORM_TENANT_ID,
  PLATFORM_WORKSPACE_ID,
  SYSTEM_DEFAULT_DOMAIN_ID,
} from '../../src/db/platform';
import { execSql } from '../support/psql';
import { TENANT_A, migrationDsn } from '../support/rls-fixture';

/** The seeded system default domain's hostname (`SYSTEM_DEFAULT_DOMAIN` default, D-2-02). */
export const PLATFORM_HOSTNAME = 'localhost';
/** A hostname no `domains` row carries. Its negative is cached at `hst:`. */
export const UNKNOWN_HOSTNAME = 'nobody.example.test';
/** A domain that never left `pending_verification`. F-003, and its cache half. */
export const NOT_ACTIVE_HOSTNAME = 'pending.example.test';

const WORKSPACE_A = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const DOMAIN_NOT_ACTIVE = 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4';

/**
 * A destination Express's own `res.redirect` would not return unchanged (`encodeUrl`
 * percent-encodes `|`), so "byte-identical from the cache too" is measurable.
 */
export const DESTINATION = 'https://example.test/spring?utm_source=a|b&x=1';

/** Active, no window: the ordinary hot-path link. */
export const ACTIVE_SLUG = 'cached01';
/** `expires_at` an hour ago: 404, and the record still caches (the window is a read-time check). */
export const EXPIRED_SLUG = 'expired1';
/** `expires_at` two minutes out: the TTL clamp has something to clamp (AC-2-28). */
export const SOON_SLUG = 'soon1234';
/** A real link on the domain that is NOT active. Serves nothing, caches nothing positive. */
export const ON_INACTIVE_DOMAIN_SLUG = 'pending1';
/** Conforms to `SLUG_PATTERN` and matches no row: the `rdr:` negative entry's subject. */
export const UNKNOWN_SLUG = 'nowhere1';

/** Seconds `SOON_SLUG` has left, so a clamped TTL can be compared against it. */
export const SOON_EXPIRY_SECONDS = 120;

export function eraseTenant(tenantId: string): void {
  execSql(migrationDsn(), `DELETE FROM tenants WHERE id = :'tenant'::uuid;`, {
    tenantId,
    flags: { 'app.privileged_erase': tenantId },
    variables: { tenant: tenantId },
  });
}

export function plantRedirectFixture(): void {
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
       VALUES (:'tenant_a', :'workspace_a', :'system_domain', :'platform', :'active_slug', :'destination');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url, expires_at)
       VALUES (:'tenant_a', :'workspace_a', :'system_domain', :'platform', :'expired_slug', :'destination', now() - interval '1 hour');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url, expires_at)
       VALUES (:'tenant_a', :'workspace_a', :'system_domain', :'platform', :'soon_slug', :'destination', now() + interval '2 minutes');
     INSERT INTO links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
       VALUES (:'tenant_a', :'workspace_a', :'domain_pending', :'tenant_a', :'pending_slug', :'destination');`,
    {
      variables: {
        platform: PLATFORM_TENANT_ID,
        platform_workspace: PLATFORM_WORKSPACE_ID,
        system_domain: SYSTEM_DEFAULT_DOMAIN_ID,
        platform_hostname: PLATFORM_HOSTNAME,
        tenant_a: TENANT_A,
        workspace_a: WORKSPACE_A,
        domain_pending: DOMAIN_NOT_ACTIVE,
        pending_hostname: NOT_ACTIVE_HOSTNAME,
        active_slug: ACTIVE_SLUG,
        expired_slug: EXPIRED_SLUG,
        soon_slug: SOON_SLUG,
        pending_slug: ON_INACTIVE_DOMAIN_SLUG,
        destination: DESTINATION,
      },
    },
  );
}

export interface Probe {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * `node:http` rather than `fetch`, for `redirect.int-spec.ts`'s reason: the `Host` header is
 * whatever the connection was opened with, and this can send one a client library would
 * refuse to. The server listens on loopback, so `localhost` really is the request's hostname.
 */
export async function get(port: number, path: string, host: string): Promise<Probe> {
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
export async function onPlatform(port: number, path: string): Promise<Probe> {
  return get(port, path, `${PLATFORM_HOSTNAME}:${String(port)}`);
}
