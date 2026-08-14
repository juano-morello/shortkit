/**
 * Contract: design/contracts/tenant-membership-lookup.md
 * ADR: adr-0045-token-mint-membership-lookup.md, adr-0002-tenant-context-binding.md,
 *      adr-0003-rls-policy-template-and-roles.md
 * Produced by: TASK-002
 *
 * ============================================================================
 * EXCLUSION 3 OF EXACTLY 3. THE ONLY FILE THAT MAY SET `app.membership_lookup_user`.
 * ============================================================================
 *
 * `tid` must be in every token (GC-D), it comes from `tenant_memberships`, and
 * `tenant_memberships` is tenant-scoped. At token-mint time no tenant is known — that is
 * the whole reason the claim exists — so `withTenantTransaction` cannot be used and a
 * plain `databaseTransaction` sees zero rows by policy. This file is the escape, and
 * ADR-0045 is the ADR `tenant-context.md` demanded before a fifth `databaseTransaction`
 * consumer could exist.
 *
 * It lives under `auth/` rather than `tenancy/` for the same reason `redirect-read.ts`
 * lives under `redirect/` and `privileged-eraser.ts` under `gdpr/`: an escape belongs
 * beside the feature that needs it, so its one caller is next door.
 *
 * WRITE THE FLAG NAME AS AN INLINE SQL LITERAL, NOT AS AN IMPORTED CONSTANT (clause A4).
 * Only the value is bound. `set_config` is the parameterised form of SET LOCAL, which
 * accepts no bind parameter at all. NO CONTEXT FLAG IS EVER SET BY CONCATENATION.
 *
 * THERE IS NO RUNTIME GUARD KEEPING THIS OFF THE REQUEST PATH. The control is that
 * `withMembershipLookup` is imported by exactly one file,
 * `apps/api/src/auth/tenant-id-for-user.ts`, and TASK-056 asserts that by grep — the same
 * file-level control the `databaseTransaction` list uses, for the same reason: what a
 * reviewer checks a diff against is a list of file names.
 *
 * SQL issued:
 *   BEGIN;
 *   SET TRANSACTION READ ONLY;
 *   SELECT set_config('statement_timeout',                   $1, true);
 *   SELECT set_config('idle_in_transaction_session_timeout', $2, true);
 *   SELECT set_config('app.membership_lookup_user',          $3, true);
 *
 * READ ONLY IS NOT REDUNDANT WITH THE `FOR SELECT` POLICY. The handle also reaches the
 * five RLS-exempt Better Auth tables (ADR-0044), where a write would be unconstrained.
 * Read-only closes the transaction rather than one table.
 */
import { sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';

import { databaseTransaction } from '../db/client';
import type * as schema from '../db/schema';

declare const membershipLookupBrand: unique symbol;

/** The same 5 s budget `withTenantTransaction` gives a request path. */
const STATEMENT_TIMEOUT_MS = 5000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000;

/** A Better Auth id is short; 255 is the ceiling a `text` column has no reason to exceed. */
const MAX_USER_ID_LENGTH = 255;

/** F-132's rule: eight characters of the rejected value and its length, never the whole. */
const REPORTED_PREFIX_LENGTH = 8;

/**
 * A handle inside an open membership-lookup transaction. Deliberately NOT assignable to
 * `TenantDb`: a repository written against tenant context cannot be handed one by
 * mistake, and this handle has no tenant flag set.
 *
 * The tenant flag is named by description rather than by literal, for the reason the
 * header gives about this file's own flag: clause A2 is per flag, and this file is not on
 * the permitted list for that one. The design stub carried the literal here.
 *
 * The `any` query-result and table-relation type params match `TenantDb`'s, which are
 * supplied by drizzle-orm's own generics rather than by this module.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MembershipLookupDb = PgTransaction<any, typeof schema, any> & {
  readonly [membershipLookupBrand]: true;
};

/**
 * The rejected value is reported as a short prefix and a length, never in full (F-132).
 * A user id is a stable identifier for a person and `LOGGABLE_FIELDS` has no name for one.
 *
 * NOT because `err_stack` begins with the message (F-027): `serializers.err` passes
 * `includeMessage: false` and `err_stack` carries frames only, by construction
 * (`logger.ts:159,880-884`). The reason is that `includeMessage: true` is opt-in at two
 * sanctioned call sites, so a message is one subclass change from being logged.
 */
export class InvalidLookupUserIdError extends Error {
  constructor(value: string) {
    super(
      `Membership lookup user id is empty or over ${String(MAX_USER_ID_LENGTH)} characters: ` +
        `${JSON.stringify(value.slice(0, REPORTED_PREFIX_LENGTH))}... ` +
        `(${String(value.length)} characters)`,
    );
    this.name = 'InvalidLookupUserIdError';
  }
}

/**
 * Opens a READ ONLY transaction, sets `app.membership_lookup_user` via `set_config`, runs
 * `fn` inside it. Commits when `fn` resolves, rolls back and rethrows the original error
 * when it throws.
 *
 * Sets no tenant context and enters no `AsyncLocalStorage` store, so `tenantDb()` and
 * `currentTenantId()` still throw inside `fn`.
 *
 * `userId` is asserted non-empty and at most 255 characters before it reaches
 * `set_config`. The value is bound, so this is a shape check and not an injection
 * defence.
 */
export async function withMembershipLookup<T>(
  userId: string,
  fn: (db: MembershipLookupDb) => Promise<T>,
): Promise<T> {
  if (userId === '' || userId.length > MAX_USER_ID_LENGTH) {
    throw new InvalidLookupUserIdError(userId);
  }

  return databaseTransaction(async (tx) => {
    const db = tx as MembershipLookupDb;

    // FIRST STATEMENT IN THE TRANSACTION, and it has to be: PostgreSQL refuses
    // `SET TRANSACTION` once the transaction has done any work.
    await tx.execute(sql`set transaction read only`);

    // Every flag name is an inline quoted literal and only the value is bound.
    // `set_config` is the parameterised form of SET LOCAL, which accepts no bind
    // parameter at all, and clause A4 forbids passing an identifier as the first
    // argument — so there is no named constant for a flag name anywhere in this file.
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`,
    );
    await tx.execute(
      sql`select set_config('idle_in_transaction_session_timeout', ${String(IDLE_IN_TRANSACTION_TIMEOUT_MS)}, true)`,
    );
    await tx.execute(sql`select set_config('app.membership_lookup_user', ${userId}, true)`);

    // No `tenantStorage.run`, deliberately: `tenantDb()` and `currentTenantId()` must
    // keep throwing inside `fn`. This transaction has no tenant and never will.
    return fn(db);
  });
}
