/**
 * Contract: docs/contracts/redirect-resolution.md ("The GC-5 exception, narrowed"),
 *           tenant-context.md (`databaseTransaction`'s sanctioned consumer table, row 2;
 *           "Deliberate exclusions", row 1), isolation-coverage.md (clauses A1 to A4, whose
 *           flag table names THIS FILE as `app.redirect_context`'s only owner)
 * ADR: adr-0003-rls-policy-template-and-roles.md, adr-0002-tenant-context-binding.md,
 *      adr-0049-context-flags-are-never-cast-directly.md, adr-0063-platform-tenant-and-system-default-domain.md
 * Produced by: TASK-2-06
 *
 * ============================================================================
 * THE ONLY FILE IN THE REPOSITORY THAT SETS `app.redirect_context`.
 * ============================================================================
 *
 * The policies that READ the flag are in `db/rls.ts` (`redirectReadPolicy`), applied to
 * `domains` and `links` by migration `0005` and to nothing else. Until this file landed
 * nothing set the flag at all, so both policies admitted nothing on every backend, which
 * is what the isolation suite's `domains` and `links` batteries prove incidentally on every
 * run, and which is the fail-closed direction.
 *
 * SQL issued, in this order, once per resolution:
 *
 *   BEGIN;
 *   SET TRANSACTION READ ONLY;
 *   SELECT set_config('app.redirect_context', 'on', true);
 *   SELECT id, tenant_id, workspace_id FROM domains WHERE hostname = $1 AND state = 'active';
 *   SELECT id, tenant_id, workspace_id, domain_id, destination_url, expires_at, activates_at
 *     FROM links WHERE domain_id = $1 AND slug = $2;
 *   COMMIT;
 *
 * `AND state = 'active'` IS PART OF THE PERMITTED SHAPE, NOT AN OPTIONAL FILTER (F-003).
 * Without it any signed-up user could put a hostname of Shortkit's own into
 * `pending_verification` and have the redirect resolve every unmatched path on that host
 * against their row: attacker-controlled 302s and attacker-supplied branding from the
 * platform origin, plus dangling-DNS takeover of a deleted domain whose CNAME still points
 * here. `active` is the only state in which serving someone's traffic is justified.
 *
 * `set_config` RATHER THAN `SET LOCAL` (F-007), though this flag takes a constant: `SET`
 * accepts no bind parameter, and the shortest repair for the flags that DO take a value is
 * string interpolation at the one statement all of RLS depends on. One mechanism for all
 * four flags, and clause A4 can assert the first argument is a quoted literal everywhere.
 *
 * ============================================================================
 * WHY THE TWO STATEMENTS DO NOT GO THROUGH DRIZZLE, AND HOW THEY BIND INSTEAD.
 * ============================================================================
 *
 * The recorded hot-path constraint (README, `app.module.ts`) is "one parameterised
 * statement behind a cache, no ORM, and no import from the management API", and
 * `redirect-isolation.spec.ts` asserts the no-ORM half by grep over this whole directory:
 * no import specifier naming drizzle, at any depth. That is not a style preference. A query
 * builder here is the thing a well-meaning refactor reaches for first, and what it emits is
 * no longer a shape a reviewer can read off the page or a test can compare against two
 * string constants.
 *
 * `databaseTransaction` hands over drizzle's transaction handle all the same, because it is
 * the only way to reach the runtime pool, and this module is row 2 of its sanctioned
 * consumer table. The statements are issued through the session's own prepared-query path, which is
 * the same path drizzle's `execute()` takes one call later: a `{ sql, params }` pair goes to
 * `pg`, `$1` and `$2` are bound by the DRIVER, and no visitor-supplied byte is ever
 * concatenated into SQL text. The two texts are module constants, so "exactly two query
 * shapes are permitted here, verbatim" is a string comparison in a test rather than a
 * reading exercise.
 *
 * NOTHING ELSE MAY BE ADDED HERE. A third statement (a count, a probe, a join that saves a
 * round trip) widens an escape that is narrowed four ways on purpose: FOR SELECT policies,
 * on two tables, inside a READ ONLY transaction, in one file whose uniqueness is asserted
 * by grep.
 */
import { dbQueryCounter } from '../../cache/db-query-counter';
import { databaseTransaction } from '../../db/client';
import type { DatabaseTransaction } from '../../db/client';

/**
 * Statement 1 of exactly 2. `hostname` arrives normalised (lowercase, IDNA, port stripped)
 * and the column stores the normalised form, so the two cannot disagree.
 */
export const ACTIVE_DOMAIN_BY_HOSTNAME =
  "SELECT id, tenant_id, workspace_id FROM domains WHERE hostname = $1 AND state = 'active'";

/**
 * Statement 2 of exactly 2. Keyed on `(domain_id, slug)`, which is the unique constraint's
 * own shape, so this reads at most one row through the index that already exists.
 *
 * `domain_id` COMES FROM STATEMENT 1'S RESULT AND NEVER FROM THE REQUEST. That is what makes
 * `redirect-resolution.md` invariant 5 true by construction: a link whose domain is not the
 * one the hostname resolved to is not a row this statement can return, whatever `links`
 * holds. Since 2026-08-19 the database agrees from the other side as well: migration 0005
 * gives `links` a `(domain_id, domain_tenant_id)` composite key into `domains (id,
 * tenant_id)` and a CHECK narrowing the owner to the row's own tenant or the platform
 * (ADR-0063), so the property is enforced at the write and measured at the read.
 */
export const LINK_BY_DOMAIN_AND_SLUG =
  'SELECT id, tenant_id, workspace_id, domain_id, destination_url, expires_at, activates_at FROM links WHERE domain_id = $1 AND slug = $2';

/** The preamble, which is two statements and is counted as two by `dbQueryCounter`. */
const READ_ONLY = 'SET TRANSACTION READ ONLY';
const OPEN_REDIRECT_CONTEXT = "SELECT set_config('app.redirect_context', 'on', true)";

/**
 * A `domains` row, in the column names Postgres returns. Deliberately snake_case and
 * deliberately not exported as a domain type: mapping into `ResolvedHost` is the
 * repository's, and a shape named after the table stops there.
 */
export interface DomainRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string;
}

/**
 * A `links` row. The two timestamps arrive as STRINGS: drizzle's node-postgres session
 * installs a type parser that returns `timestamptz` verbatim rather than as a `Date`, and
 * that parser is on the connection whatever issues the query. The repository converts;
 * `isLinkActive` would fail closed on an unreadable bound, which is the safe direction but
 * would also 404 a valid link, so the conversion is not left to chance.
 */
export interface LinkRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly domain_id: string;
  readonly destination_url: string;
  readonly expires_at: string | Date | null;
  readonly activates_at: string | Date | null;
}

/** The handle `fn` receives. Two methods, one per permitted statement, and no escape. */
export interface RedirectReadDb {
  activeDomainByHostname(hostname: string): Promise<DomainRow | undefined>;
  linkByDomainAndSlug(domainId: string, slug: string): Promise<LinkRow | undefined>;
}

/**
 * The session's prepared-query surface, as this file uses it. Declared structurally so the
 * module names no drizzle import: the value comes from `databaseTransaction`'s callback
 * argument, whose type is `db/client.ts`'s.
 */
interface PreparedStatement {
  execute(): Promise<unknown>;
}

async function issue<TRow>(
  tx: DatabaseTransaction,
  text: string,
  params: readonly unknown[],
): Promise<TRow[]> {
  // Every statement, the preamble included: `redirect-cache.md` says the counter increments
  // on every Postgres query the redirect path issues, and the assertion downstream is that
  // a cache hit issues NONE (TASK-2-07, AC-2-15). A preamble that did not count would make
  // "zero" mean "zero data statements", which is a weaker claim than the one on the tin.
  dbQueryCounter.increment();

  const prepared: PreparedStatement = tx._.session.prepareQuery(
    { sql: text, params: [...params] },
    undefined,
    undefined,
    false,
  );

  return ((await prepared.execute()) as { rows: TRow[] }).rows;
}

/**
 * Opens the redirect's read transaction, sets the flag, and hands `fn` the two statements.
 *
 * READ ONLY IS ISSUED FIRST AND IS NOT DECORATION. The policies this transaction opens are
 * `FOR SELECT` only, so a write would be refused anyway. But a transaction that cannot
 * write is a stronger statement to an auditor than a set of policies that happen not to
 * grant one, and it costs one statement on a path that is about to issue two more.
 */
export async function withRedirectRead<T>(fn: (db: RedirectReadDb) => Promise<T>): Promise<T> {
  return databaseTransaction(async (tx) => {
    await issue(tx, READ_ONLY, []);
    await issue(tx, OPEN_REDIRECT_CONTEXT, []);

    return fn({
      async activeDomainByHostname(hostname: string): Promise<DomainRow | undefined> {
        return (await issue<DomainRow>(tx, ACTIVE_DOMAIN_BY_HOSTNAME, [hostname]))[0];
      },

      async linkByDomainAndSlug(domainId: string, slug: string): Promise<LinkRow | undefined> {
        return (await issue<LinkRow>(tx, LINK_BY_DOMAIN_AND_SLUG, [domainId, slug]))[0];
      },
    });
  });
}
