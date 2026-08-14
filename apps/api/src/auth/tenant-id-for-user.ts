/**
 * Contract: design/contracts/tenant-membership-lookup.md
 * ADR: adr-0045-token-mint-membership-lookup.md, adr-0015-user-tenant-cardinality.md,
 *      adr-0013-better-auth-in-nestjs.md
 * Produced by: TASK-002
 *
 * The single lookup that turns a user id into a `tid` claim. `definePayload` calls it at
 * token-mint time (ADR-0013), once per token, never per request.
 *
 * THIS FILE CONTAINS NO `set_config` CALL, NO `app.` FLAG STRING, AND NO IMPORT OF
 * `databaseTransaction`. `withMembershipLookup` is its only database reach, and clauses
 * A1 and A2 fail the run if that changes.
 *
 * `UNIQUE (user_id)` means at most one row (ADR-0015). A second row is impossible at the
 * database; if one is ever returned this throws rather than choosing.
 *
 * The implementation imports `withMembershipLookup` from `./membership-lookup`. That is
 * its only database reach.
 */
import { sql } from 'drizzle-orm';

import { withMembershipLookup } from './membership-lookup';

/** F-132's rule: eight characters of the user id and its length, never the whole value. */
const REPORTED_PREFIX_LENGTH = 8;

/**
 * ============================================================================
 * THE MESSAGE CARRIES A PREFIX, NOT THE USER ID. THIS IS NOT STYLE.
 * ============================================================================
 *
 * NOT because `err_stack` leaks it — it does not, and believing so is F-027.
 * `logger.ts:159` binds `serializers.err` with `includeMessage: false`, and
 * `logger.ts:880-884` records that `err_stack` carries frames only: the
 * `${name}: ${message}` header is stripped by prefix and then by shape. The logger was
 * built to make exactly that premise untrue (F-090, F-093, F-108, F-111).
 *
 * The reasons that hold: `includeMessage: true` is opt-in at two sanctioned call sites and
 * `DomainError` is one, so a message is one subclass change from being logged; and this
 * error is thrown inside `definePayload`, on a mount outside the Nest graph, so the code
 * that handles it belongs to the dependency (ADR-0052 binds its logger and drops its
 * positional args). Whether a user identifier joins `LOGGABLE_FIELDS`, and under what name,
 * is a decision this initiative has not made, and this error must not make it by accident.
 * Eight characters and a length, the same rule `InvalidTenantIdError` follows (F-132).
 *
 * The full value is on `.userId` for the caller. NO EMAIL ADDRESS APPEARS HERE IN ANY
 * FORM: this is the one path that holds a user id and an email at the same time.
 */
export class NoTenantMembershipError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super(
      `No tenant_memberships row for user ` +
        `${JSON.stringify(userId.slice(0, REPORTED_PREFIX_LENGTH))}... ` +
        `(${String(userId.length)} characters), so this account cannot obtain a tid claim.`,
    );
    this.name = 'NoTenantMembershipError';
    this.userId = userId;
  }
}

/**
 * The tenant id on this user's single `tenant_memberships` row, lower-cased.
 *
 * Statement, inside `withMembershipLookup(userId, ...)`:
 *   SELECT tenant_id FROM tenant_memberships WHERE user_id = $1
 *
 * THROWS `NoTenantMembershipError` WHEN NO ROW EXISTS. Never returns `null`, never
 * returns an empty string. Token minting therefore fails and an orphaned `user` row — the
 * accepted residue of a non-atomic signup (ADR-0015, GC-E) — never receives a JWT at all.
 * That is the primary stop; `AuthGuard`'s claim-shape check is the backstop.
 *
 * The result is lower-cased so it is the canonical form `assertUuid` returns and a later
 * equality test against a row's `tenant_id` cannot disagree by case (F-130).
 */
export async function tenantIdForUser(userId: string): Promise<string> {
  const rows = await withMembershipLookup(userId, async (db) => {
    const result = await db.execute<{ tenant_id: string }>(
      sql`select tenant_id from tenant_memberships where user_id = ${userId}`,
    );

    return result.rows;
  });

  // `UNIQUE (user_id)` means a second row is impossible at the database. If one is ever
  // returned the constraint is gone, and choosing one of two tenants for a token claim
  // is the worst available answer — so this throws rather than picking.
  if (rows.length > 1) {
    throw new Error(
      `tenant_memberships returned ${String(rows.length)} rows for one user id. ` +
        'tenant_memberships_user_unique bounds this lookup to one row (ADR-0015); if it ' +
        'returned more, that constraint is not on the table.',
    );
  }

  const tenantId = rows[0]?.tenant_id;

  if (tenantId === undefined) {
    throw new NoTenantMembershipError(userId);
  }

  // PostgreSQL renders `uuid` lower case already. The call is here so the value is the
  // canonical form `assertUuid` returns and a later equality test against a row's
  // `tenant_id` cannot disagree by case (F-130).
  return tenantId.toLowerCase();
}
