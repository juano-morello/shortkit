/**
 * Contract: docs/contracts/redirect-cache.md ("Values": both record shapes, field for
 *           field), redirect-resolution.md ("Normative types")
 * ADR: adr-0008-redirect-cache-shape.md (why the cached record carries whole values),
 *      adr-0009-expiry-eviction.md (the window is decided from the record, on every read)
 * Produced by: TASK-2-07 (item 2, wave 4).
 *
 * ============================================================================
 * THE ONE PLACE THE CACHE'S SHAPES AND THE DECISION'S SHAPES MEET.
 * ============================================================================
 *
 * `CachedHost`/`CachedLink` are short-keyed because they are billed per byte (GC-3);
 * `ResolvedHost`/`ResolvedLink` are the decision's, and `redirect.service.ts` never sees a
 * two-letter field. Keeping the translation here is what lets step 4 run one `isLinkActive`
 * over a record that came from either side, which is the property ADR-0008 chose the cached
 * fields for and the property ADR-0009 depends on: a cache hit evaluates the validity window
 * with no I/O, because `ea` and `aa` are on the record.
 *
 * ============================================================================
 * `toCachedLink` CAN REFUSE, AND THE REFUSAL IS THE FAIL-CLOSED DIRECTION.
 * ============================================================================
 *
 * A `timestamptz` that did not parse reaches `ResolvedLink` as an `Invalid Date`
 * (`redirect-read.repository.ts` keeps it that way on purpose, since `isLinkActive` fails
 * closed on a bound it cannot read). `getTime()` on one is `NaN`, which `redirect-cache.ts`'s
 * own decoder rejects — so writing it would produce a key that reads back `'unavailable'`
 * every time, an hour of Redis memory holding a value nothing can use. `null` here means
 * "do not cache this record", the request is served from the row already in hand, and the
 * next one pays the same query.
 */
import type { CachedHost, CachedLink } from '../cache/redirect-cache';

import type { ResolvedHost, ResolvedLink } from './redirect.types';

/**
 * A positive host record is only ever written for a domain in state `active`, and that rule
 * is the CALLER's: statement 1 carries `AND state = 'active'`, so a host that resolved is an
 * active one (F-003, `redirect-cache.md` "Only an `active` domain is cached").
 *
 * `b` IS THE BRANDING ANSWER, NOT A HINT. ADR-0011 asks the port on a cache miss only, so a
 * cached host's `b` is what a 404 renders from. Item 2 has no branding column and no bound
 * port, so every record written here carries `b: null` truthfully. The card that binds the
 * port owns the other half: `resolveHost` must fill `ResolvedHost.branding` BEFORE the record
 * is written, or a branded host will cache as unbranded for the host TTL.
 */
export function toCachedHost(host: ResolvedHost): CachedHost {
  return {
    v: 1,
    dm: host.domainId,
    t: host.tenantId,
    w: host.workspaceId,
    b:
      host.branding === null
        ? null
        : {
            lg: host.branding.logoUrl,
            bc: host.branding.brandColor,
            fb: host.branding.fallbackUrl,
          },
  };
}

export function fromCachedHost(record: CachedHost): ResolvedHost {
  return {
    domainId: record.dm,
    tenantId: record.t,
    workspaceId: record.w,
    branding:
      record.b === null
        ? null
        : { logoUrl: record.b.lg, brandColor: record.b.bc, fallbackUrl: record.b.fb },
  };
}

/** `null` when a bound cannot be read; see the file docblock. */
export function toCachedLink(link: ResolvedLink): CachedLink | null {
  const ea = epochOrNull(link.expiresAt);
  const aa = epochOrNull(link.activatesAt);

  if (Number.isNaN(ea) || Number.isNaN(aa)) {
    return null;
  }

  return {
    v: 1,
    id: link.id,
    d: link.destinationUrl,
    dm: link.domainId,
    w: link.workspaceId,
    // The click writer opens its tenant transaction from this, with no second lookup, which
    // is why click emission is not a fourth GC-5 exclusion (ADR-0008, D-2-10).
    t: link.tenantId,
    ea,
    aa,
  };
}

export function fromCachedLink(record: CachedLink): ResolvedLink {
  return {
    id: record.id,
    destinationUrl: record.d,
    domainId: record.dm,
    workspaceId: record.w,
    tenantId: record.t,
    expiresAt: record.ea === null ? null : new Date(record.ea),
    activatesAt: record.aa === null ? null : new Date(record.aa),
  };
}

/** `null` for an absent bound, `NaN` for one that cannot be read. Never a silent `null`. */
function epochOrNull(bound: Date | null): number | null {
  return bound === null ? null : bound.getTime();
}
