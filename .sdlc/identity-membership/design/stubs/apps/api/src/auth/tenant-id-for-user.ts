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
 * The implementation imports `withMembershipLookup` from `./membership-lookup`. The stub
 * does not, because an unused import fails `noUnusedLocals`.
 */

/**
 * ============================================================================
 * THE MESSAGE CARRIES A PREFIX, NOT THE USER ID. THIS IS NOT STYLE.
 * ============================================================================
 *
 * `serializers.err` reduces a logged error to `err_name` and `err_stack`, and
 * `Error.stack` begins with the message — so anything interpolated into the message
 * reaches the log line whatever `LOGGABLE_FIELDS` says (ADR-0028, GC-G). Whether a user
 * identifier joins that allowlist, and under what name, is a decision this initiative has
 * not made, and this error must not make it by accident. Eight characters and a length,
 * the same rule `InvalidTenantIdError` follows (F-132).
 *
 * The full value is on `.userId` for the caller. NO EMAIL ADDRESS APPEARS HERE IN ANY
 * FORM: this is the one path that holds a user id and an email at the same time.
 */
export class NoTenantMembershipError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super('not implemented');
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
export async function tenantIdForUser(_userId: string): Promise<string> {
  throw new Error('not implemented');
}
