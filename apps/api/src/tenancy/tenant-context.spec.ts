import { describe, expect, it } from 'vitest';

import {
  currentTenantId,
  TenantContextMissingError,
  tenantDb,
} from './tenant-context';

/**
 * F-128: contract invariant 4, which had no coverage at all.
 *
 * `docs/contracts/tenant-context.md`: "`tenantDb()` outside an active context
 * throws `TenantContextMissingError`. It never returns an unscoped client." That is
 * a GC-5 guarantee: an accessor that fell back to an unscoped handle would be a
 * query path reaching every tenant's rows with no transaction and no context flag,
 * which is the hole GC-5 exists to close, and it is decidable in process, with no
 * database, because nothing here opens a transaction.
 *
 * The active-context half of the same accessor needs a live Postgres and lives in
 * `test/tenancy/tenant-context.int-spec.ts`.
 */
describe('reading the ambient tenant context when none is active', () => {
  it('invariant 4: tenantDb() throws TenantContextMissingError rather than returning a client', () => {
    expect(() => tenantDb()).toThrow(TenantContextMissingError);
  });

  it('invariant 4: currentTenantId() throws TenantContextMissingError rather than returning a tenant id', () => {
    expect(() => currentTenantId()).toThrow(TenantContextMissingError);
  });
});
