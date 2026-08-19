/**
 * STORY-2-01, STORY-2-03: the platform tenant, the platform workspace and the system
 * default domain row (D-2-06, D-2-07, ADR-0063), driven through the REAL seed units.
 *
 * Produced by: TASK-2-02.
 * Contract: docs/contracts/rls-policy-template.md, redirect-resolution.md,
 *           domain-provisioning.md; ADR-0034 (seed contract), ADR-0063.
 *
 * ===========================================================================
 * IT RUNS `SEED_TRANSACTIONS`, NOT A COPY OF THEIR SQL, AND THAT IS THE POINT
 * ===========================================================================
 *
 * Every statement executed here comes from `scripts/seed.mts`: the same inserts, the same
 * `ON CONFLICT (id) DO NOTHING`, the same per-tenant `set_config`, the same order. A
 * fixture that re-typed the four rows would pass while the seed wrote something else, which
 * is the failure mode ADR-0034's rule 1 (idempotent BY CONSTRUCTION) is checkable against
 * at all only if the construction under test is the shipped one.
 *
 * The seed's OWN connection guard (`refuseUnrecognisedConnection`, rule 6) is not weakened
 * and not exercised: it refuses any database that is not `shortkit` and any role that is
 * not `shortkit_app`, it belongs to the CLI path, and this file never calls `main()`. What
 * makes that possible is the entry-point guard TASK-2-02 put around `await main()`.
 *
 * ===========================================================================
 * F-236 IS WHAT THIS FILE IS REALLY ABOUT
 * ===========================================================================
 *
 * A migration `INSERT` for these rows would run as `shortkit_migrator`: `NOBYPASSRLS`,
 * under `FORCE ROW LEVEL SECURITY`, with no `app.tenant_id` set. It writes ZERO ROWS and
 * REPORTS SUCCESS. So "the seed inserted rows" is not a detail. It is the property that
 * separates a working stack from one whose first `POST /api/links` answers 23503. The
 * assertions below therefore read row COUNTS returned by the units (non-zero on the first
 * run, zero on the second) and not only the rows' presence afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { sql } from 'drizzle-orm';

import { closeDatabase } from '../../src/db/client';
import {
  PLATFORM_TENANT_ID,
  PLATFORM_TENANT_NAME,
  PLATFORM_WORKSPACE_ID,
  PLATFORM_WORKSPACE_NAME,
  SYSTEM_DEFAULT_DOMAIN_ID,
  normaliseHostname,
  systemDefaultHostname,
} from '../../src/db/platform';
import { runTransaction, SEED_TRANSACTIONS } from '../../scripts/seed.mts';
import { withTenantTransaction } from '../../src/tenancy/tenant-context';
import { execSql, querySql } from '../support/psql';
import { appDsn, migrationDsn, TENANT_A } from '../support/rls-fixture';

/** The platform group. Named by its tenant id rather than by its index in the array. */
function platformTransaction() {
  const found = SEED_TRANSACTIONS.find(
    (transaction) => transaction.tenantId === PLATFORM_TENANT_ID,
  );

  if (found === undefined) {
    throw new Error(
      `scripts/seed.mts has no transaction for the platform tenant ${PLATFORM_TENANT_ID}. ` +
        'Without it the system default domain row does not exist and every link create ' +
        'answers 23503 (ADR-0063).',
    );
  }

  return found;
}

/**
 * Runs the platform group as `shortkit_app` against the integration database, exactly the
 * way the CLI runs it, and returns the rows each unit reported inserting.
 */
async function seedPlatform(): Promise<Record<string, number>> {
  const pool = new pg.Pool({ connectionString: appDsn() });
  const inserted = new Map<string, number>();

  try {
    const client: PoolClient = await pool.connect();

    try {
      await runTransaction(client, platformTransaction(), inserted);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  return Object.fromEntries(
    [...inserted].map(([key, rows]) => [key.slice(key.indexOf('/') + 1), rows]),
  );
}

/**
 * The platform rows and the customer tenant this file plants, removed through the migrator
 * so a rerun starts from nothing. `domains` and `workspaces` cascade from `tenants`, so the
 * one DELETE clears all four rows, and it runs under the migrator's grant with the flag
 * set, because both tables carry FORCE ROW LEVEL SECURITY.
 */
function dropPlatformRows(): void {
  eraseTenant(PLATFORM_TENANT_ID);
}

/**
 * ⚠ BOTH FLAGS, AND THE SECOND IS NOT DECORATION. `test/support/rls-fixture.ts`'s measured
 * rule, repeated here because getting it wrong is SILENT. `DELETE ... WHERE id = ...`
 * references a column, so PostgreSQL applies the SELECT policies; `tenants_privileged_erase`
 * is `FOR DELETE` and grants no read, so with `app.tenant_id` unset the statement sees no
 * row, reports `DELETE 0` and raises nothing. The rows then survive into the next run and
 * the "first run inserted a row" assertion fails against a database that was never clean.
 */
function eraseTenant(tenantId: string): void {
  execSql(migrationDsn(), `DELETE FROM tenants WHERE id = :'tenant'::uuid;`, {
    tenantId,
    flags: { 'app.privileged_erase': tenantId },
    variables: { tenant: tenantId },
  });
}

describe('normaliseHostname / systemDefaultHostname (redirect-resolution.md step 1, D-2-02)', () => {
  it('lowercases, strips the port, and applies IDNA, the same form redirect-cache.md keys on', () => {
    expect(normaliseHostname('LOCALHOST')).toBe('localhost');
    expect(normaliseHostname('localhost:3001')).toBe('localhost');
    expect(normaliseHostname('  Short.Example.TEST  ')).toBe('short.example.test');
    // A unicode homograph must not be able to produce a second row or a second cache key.
    expect(normaliseHostname('exämple.test')).toBe('xn--exmple-cua.test');
  });

  it('defaults to localhost when SYSTEM_DEFAULT_DOMAIN is unset or blank (D-2-02), and reads it when set', () => {
    expect(systemDefaultHostname({})).toBe('localhost');
    expect(systemDefaultHostname({ SYSTEM_DEFAULT_DOMAIN: '' })).toBe('localhost');
    expect(systemDefaultHostname({ SYSTEM_DEFAULT_DOMAIN: '   ' })).toBe('localhost');
    expect(systemDefaultHostname({ SYSTEM_DEFAULT_DOMAIN: 'Sk.Example:8080' })).toBe('sk.example');
  });
});

describe('the platform seed writes four rows, twice writes them once (ADR-0034 rule 1, ADR-0063)', () => {
  let first: Record<string, number>;
  let second: Record<string, number>;

  beforeAll(async () => {
    dropPlatformRows();
    first = await seedPlatform();
    second = await seedPlatform();
  }, 60_000);

  afterAll(async () => {
    dropPlatformRows();
    await closeDatabase();
  });

  it('the first run really writes: three units, each reporting a row it inserted (F-236 is the failure this excludes)', () => {
    // A migration INSERT would report success having written nothing. These are the counts
    // `INSERT` itself returned, under `shortkit_app`, with the flag set.
    expect(first).toEqual({ tenants: 1, workspaces: 1, domains: 1 });
  });

  it('the second run writes nothing and raises nothing: idempotent BY CONSTRUCTION, not by checking first', () => {
    expect(second).toEqual({ tenants: 0, workspaces: 0, domains: 0 });
  });

  it('the three rows carry the frozen uuids, the platform names, and the domain is active and flagged system default', () => {
    const rows = querySql<{ what: string; detail: string }>(
      migrationDsn(),
      `SELECT 'tenant' AS what, name AS detail FROM tenants WHERE id = :'tenant'::uuid
       UNION ALL
       SELECT 'workspace', name FROM workspaces WHERE id = :'workspace'::uuid AND tenant_id = :'tenant'::uuid
       UNION ALL
       SELECT 'domain', hostname || ' | ' || state::text || ' | ' || is_system_default::text || ' | ' || workspace_id::text
         FROM domains WHERE id = :'domain'::uuid AND tenant_id = :'tenant'::uuid
       ORDER BY 1`,
      {
        // THE READBACK NEEDS THE FLAG TOO, and that is not a fixture detail: all three
        // tables carry FORCE ROW LEVEL SECURITY, so even the OWNING role reads zero rows
        // with no context set, the same mechanism that makes a migration INSERT here
        // write nothing (F-236). A readback that "failed" without it would be measuring
        // the policy, not the seed.
        tenantId: PLATFORM_TENANT_ID,
        variables: {
          tenant: PLATFORM_TENANT_ID,
          workspace: PLATFORM_WORKSPACE_ID,
          domain: SYSTEM_DEFAULT_DOMAIN_ID,
        },
      },
    );

    expect(rows).toEqual([
      {
        what: 'domain',
        // The hostname is NORMALISED at the one place it enters the system. The seed reads
        // the same variable the API will, so this is `SYSTEM_DEFAULT_DOMAIN`'s value in
        // this process, so `localhost` by D-2-02 when nothing declares it.
        detail: `${systemDefaultHostname(process.env)} | active | true | ${PLATFORM_WORKSPACE_ID}`,
      },
      { what: 'tenant', detail: PLATFORM_TENANT_NAME },
      { what: 'workspace', detail: PLATFORM_WORKSPACE_NAME },
    ]);
  });

  it('a customer tenant transaction reads ZERO domains rows, and that is correct rather than broken (ADR-0063)', async () => {
    // `domains_tenant_isolation` compares `tenant_id` against `app.tenant_id`, and a
    // customer's flag is never PLATFORM_TENANT_ID. So the system default row is invisible
    // to every tenant-facing read, by design.
    //
    // NOTHING NEEDS IT VISIBLE. A repository test that "fixes" this by widening a policy,
    // by adding an OR on `is_system_default`, or by giving the redirect's flag a second
    // reader has turned D-2-06 into a cross-tenant read. The link create references the
    // row by FK (proven in migration-0005.int-spec.ts) and the API denormalises the
    // hostname from `SYSTEM_DEFAULT_DOMAIN`; the redirect reads it under
    // `app.redirect_context`, which is TASK-2-06's and set by exactly one file.
    execSql(
      migrationDsn(),
      `INSERT INTO tenants (id, name) VALUES (:'tenant'::uuid, 'seed-platform customer')
         ON CONFLICT (id) DO NOTHING`,
      { tenantId: TENANT_A, variables: { tenant: TENANT_A } },
    );

    try {
      const visible = await withTenantTransaction(TENANT_A, async (db) =>
        (await db.execute<{ id: string }>(sql`select id from domains`)).rows,
      );

      expect(visible).toEqual([]);
    } finally {
      eraseTenant(TENANT_A);
    }
  });
});
