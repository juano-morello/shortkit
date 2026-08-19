/**
 * Contract: docs/contracts/redirect-resolution.md ("The GC-5 exception, narrowed",
 *           invariants 4 and 5), isolation-coverage.md (`ISOLATION_EXCLUSIONS` entry 1,
 *           `repo:RedirectReadRepository.resolveByHostAndSlug`)
 * ADR: adr-0003-rls-policy-template-and-roles.md, adr-0020-isolation-suite-enumeration.md,
 *      adr-0063-platform-tenant-and-system-default-domain.md
 * Produced by: TASK-2-06
 *
 * ============================================================================
 * THE CLASS AND METHOD NAME ARE LOAD-BEARING (`SurfaceId`, isolation-coverage.md).
 * ============================================================================
 *
 * `ISOLATION_EXCLUSIONS` already carries `repo:RedirectReadRepository.resolveByHostAndSlug`
 * and its LENGTH is asserted at three. Renaming this class or that method changes the id
 * and breaks the exclusion, which is the designed loud failure. Consuming the pre-paid
 * entry is the expected diff-free path for this card: no exclusion is added, none is
 * edited, and the suite's length assertion is untouched.
 *
 * NO `@TenantScopedRepository()` HERE, AND THAT IS THE WHOLE DIFFERENCE. That decorator
 * marks a class the isolation harness calls with another tenant's ids inside an actor's
 * transaction, and there is no tenant here to be another one of: the visitor is anonymous
 * and the only inputs are a hostname and a slug. The read is narrowed by database policy
 * instead, which is what an exclusion means in this repository.
 *
 * ============================================================================
 * ONE TRANSACTION FOR BOTH STATEMENTS, AND WHY THE HOST COMES BACK EITHER WAY.
 * ============================================================================
 *
 * `resolveByHostAndSlug` returns the resolved host BESIDE the link, including when the link
 * is null. Step 6 of the decision order needs the host to reach branding (a branded 404
 * and a fallback 302 both belong to the host, not to the link), so returning only the link
 * would force a second lookup for the commonest 404 there is. One `withRedirectRead` covers
 * both statements: one BEGIN, one flag, one COMMIT.
 *
 * `resolveHost` is the same first statement on its own. TASK-2-07 needs it when the LINK
 * key is cached and the HOST key is not, which the two different TTLs (3600 and 300) make
 * an ordinary state rather than an edge case.
 */
import { Injectable } from '@nestjs/common';

import { withRedirectRead } from './db/redirect-read';
import type { DomainRow, LinkRow, RedirectReadDb } from './db/redirect-read';
import type { ResolvedHost, ResolvedLink } from './redirect.types';

/** What one resolution learned: the host, and the link on that host if there is one. */
export interface RedirectRead {
  readonly host: ResolvedHost | null;
  readonly link: ResolvedLink | null;
}

/**
 * `timestamptz` arrives as a string on this connection (see `LinkRow`). An unparseable
 * value stays unparseable rather than becoming `null`: `isLinkActive` fails closed on a
 * bound it cannot read, and turning it into "no bound" would make an unreadable expiry mean
 * "serves forever", which is the wrong direction for an anonymous visitor's 302.
 */
function timestamp(value: string | Date | null): Date | null {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

function toHost(row: DomainRow): ResolvedHost {
  return {
    domainId: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    // Item 2 has no branding column and no bound port. Step 6 fills this in from
    // `REDIRECT_BRANDING_PORT` when it needs it, and only then (ADR-0011).
    branding: null,
  };
}

function toLink(row: LinkRow): ResolvedLink {
  return {
    id: row.id,
    destinationUrl: row.destination_url,
    domainId: row.domain_id,
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    expiresAt: timestamp(row.expires_at),
    activatesAt: timestamp(row.activates_at),
  };
}

@Injectable()
export class RedirectReadRepository {
  /**
   * `hostname` and `slug` are already normalised and shape-checked by the service: the
   * hostname is lowercase, IDNA-folded and portless, and the slug conforms to
   * `SLUG_PATTERN`. Nothing here re-validates, and nothing here interpolates: both values
   * reach Postgres as bound parameters.
   */
  async resolveByHostAndSlug(hostname: string, slug: string): Promise<RedirectRead> {
    return withRedirectRead(async (db: RedirectReadDb): Promise<RedirectRead> => {
      const domain = await db.activeDomainByHostname(hostname);

      // No active domain is the end of it. Reading `links` for a hostname that resolves to
      // nothing would be a slug lookup across every domain in the system, which is exactly
      // the query shape the `(domain_id, slug)` uniqueness rule exists to prevent (GC-6).
      if (domain === undefined) {
        return { host: null, link: null };
      }

      const host = toHost(domain);
      const link = await db.linkByDomainAndSlug(host.domainId, slug);

      return { host, link: link === undefined ? null : toLink(link) };
    });
  }

  /**
   * Statement 1, and statement 2 in the SAME transaction ONLY when the domain that resolved is
   * not `keptDomainId`. One `withRedirectRead`, one preamble, either way.
   *
   * THIS EXISTS SO THAT VALIDATING A CACHED LINK RECORD AGAINST A FRESHLY RESOLVED HOST NEVER
   * OPENS A SECOND TRANSACTION. The caller holds a `rdr:` record and a cold `hst:` key; the
   * record is usable only if it names the domain the hostname resolves to now, and that is not
   * knowable before statement 1 runs. Resolving the host and then reading the link through a
   * second call would pay the two-statement preamble twice, which is the outcome reading both
   * cache keys up front exists to avoid.
   *
   * `link` IS NULL FOR TWO DIFFERENT REASONS and the caller can tell them apart with the
   * comparison it already made: when `host.domainId === keptDomainId` the statement was never
   * issued and the caller keeps its own record; otherwise null means the row does not exist.
   */
  async resolveHostKeepingLinkOn(
    hostname: string,
    slug: string,
    keptDomainId: string,
  ): Promise<RedirectRead> {
    return withRedirectRead(async (db: RedirectReadDb): Promise<RedirectRead> => {
      const domain = await db.activeDomainByHostname(hostname);

      if (domain === undefined) {
        return { host: null, link: null };
      }

      const host = toHost(domain);

      if (host.domainId === keptDomainId) {
        return { host, link: null };
      }

      const link = await db.linkByDomainAndSlug(host.domainId, slug);

      return { host, link: link === undefined ? null : toLink(link) };
    });
  }

  async resolveHost(hostname: string): Promise<ResolvedHost | null> {
    return withRedirectRead(async (db: RedirectReadDb): Promise<ResolvedHost | null> => {
      const domain = await db.activeDomainByHostname(hostname);

      return domain === undefined ? null : toHost(domain);
    });
  }

  /**
   * Statement 2 on its own (TASK-2-07), for the other ordinary state the two TTLs produce:
   * the HOST record cached and the link key not: a link that was just edited, a negative
   * entry that has run out its 60 seconds, or a key nobody has asked for yet.
   *
   * NO NEW STATEMENT SHAPE AND NO NEW EXCLUSION. The text is `LINK_BY_DOMAIN_AND_SLUG`, the
   * same module constant the combined read issues, so `redirect-isolation.spec.ts`'s "exactly
   * these SELECT literals" comparison is untouched; the escape stays two tables, two shapes,
   * one READ ONLY transaction, one file. `resolveHost` shipped on the same terms in TASK-2-06.
   *
   * `domainId` COMES FROM A RESOLVED HOST AND NEVER FROM THE REQUEST (statement 1's result on
   * this request, or the cached record that statement 1 wrote), which is what keeps invariant
   * 5 true by construction on this path too. The caller additionally refuses a cached record
   * whose `dm` is not the domain that resolved, so a hostname that changed hands cannot serve
   * the previous owner's link out of a surviving key.
   */
  async resolveLinkOnDomain(domainId: string, slug: string): Promise<ResolvedLink | null> {
    return withRedirectRead(async (db: RedirectReadDb): Promise<ResolvedLink | null> => {
      const link = await db.linkByDomainAndSlug(domainId, slug);

      return link === undefined ? null : toLink(link);
    });
  }
}
