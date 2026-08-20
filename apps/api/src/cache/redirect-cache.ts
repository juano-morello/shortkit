/**
 * Contract: docs/contracts/redirect-cache.md (THE NORMATIVE FORM). Keys, both value shapes,
 *           the sentinel, the four TTLs, `linkTtlSeconds`, the `SET key value EX ttl` rule,
 *           and `'unavailable'` ≠ `'miss'` all come from that file and are not decided here.
 * ADR: adr-0008-redirect-cache-shape.md (two namespaces, whole records, negative entries),
 *      adr-0009-expiry-eviction.md (the clamp is hygiene; `isLinkActive` is correctness),
 *      adr-0012-redis-client-and-rate-limit-degradation.md (bounded, offline queue off,
 *      a failed read falls through to Postgres).
 * Produced by: TASK-2-03 (item 2, wave 1).
 * Consumed by: TASK-2-06/2-07 (`resolveHost`/`resolveLink` behind the `REDIRECT_CACHE`
 *              token), TASK-2-08 (the after-commit invalidation subscriber).
 *
 * ============================================================================
 * NO REDIS CLIENT IS IMPORTED HERE. THE CLIENT ARRIVES AS `RedirectCacheClient`.
 * ============================================================================
 *
 * The three commands this cache issues are `GET`, `SET … EX` and `DEL`, and writing the
 * class against that surface rather than against `ioredis` buys two things: the key strings,
 * the codecs, the TTL arithmetic and every degradation branch are unit-testable with no
 * Docker (AC-1's clean-clone rule), and `cache.module.ts` stays the one file that names the
 * client at all (ADR-0012's "one client, one failure posture").
 *
 * ============================================================================
 * WHAT NEVER LEAVES THIS FILE AS A THROW (GC-O).
 * ============================================================================
 *
 * Every READ answers `'unavailable'` on any failure: a rejection, a synchronous throw, a
 * disconnected client, a timeout, a value that does not decode. Every WRITE (`setHost`,
 * `setLink`) swallows its failure: a cache fill that did not happen costs a Postgres query
 * on the next request and nothing else, and the visitor's response is already decided by
 * then.
 *
 * DELETIONS ARE THE ONE ASYMMETRY AND IT IS DELIBERATE. `delHost`/`delLink` REJECT when the
 * deletion did not happen, because their caller is TASK-2-08's after-commit subscriber,
 * which owns the retry at 200 ms and 1000 ms and the `cache_invalidation_failed` line
 * (D-2-15). Swallowing here would leave it nothing to retry and nothing to report, and
 * staleness past GC-2's five seconds with no signal at all. Deletions never run on the
 * visitor's path, so GC-O is untouched.
 */

/** The Nest token every consumer injects. The client itself is not injectable anywhere. */
export const REDIRECT_CACHE = Symbol('REDIRECT_CACHE');

/**
 * The three commands, as this module needs them. `ioredis`'s `Redis` satisfies it
 * structurally (`cache.module.ts` is where that is checked by the compiler).
 *
 * `status` is read before every command: `enableOfflineQueue: false` would reject a command
 * issued while disconnected anyway, and not issuing it at all is what keeps a dead client
 * off the 50 ms budget entirely.
 */
export interface RedirectCacheClient {
  readonly status: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * A positive `hst:` record is written ONLY for a domain in state `active`
 * (`redirect-cache.md`, "Only an `active` domain is cached"; F-003). Any other state caches
 * as MISS. This module cannot enforce that: `resolveHost` is the only writer of positive
 * host records and it owns the rule.
 */
export interface CachedHost {
  readonly v: 1;
  /** domainId */
  readonly dm: string;
  /** tenantId */
  readonly t: string;
  /** workspaceId */
  readonly w: string;
  /** branding: logo URL, brand colour, fallback URL */
  readonly b: { readonly lg: string | null; readonly bc: string | null; readonly fb: string | null } | null;
}

export interface CachedLink {
  readonly v: 1;
  readonly id: string;
  /** destinationUrl */
  readonly d: string;
  /** domainId */
  readonly dm: string;
  /** workspaceId */
  readonly w: string;
  /** tenantId: lets the click writer open a tenant transaction with no lookup (GC-5) */
  readonly t: string;
  /** expiresAt, epoch ms */
  readonly ea: number | null;
  /** activatesAt, epoch ms */
  readonly aa: number | null;
}

/**
 * The cached negative. One byte, stored under the same key as a real value so a lookup is
 * one `GET` in every case (ADR-0008).
 */
export const MISS_SENTINEL = '\u0000';

export const HOST_TTL_S = 300;
export const HOST_MISS_TTL_S = 300;
/**
 * 3600 in EVERY environment, including tests (SC-3, ADR-0008). There is no test TTL to
 * drift from production: the invalidation test has to pass with the TTL at one hour, so the
 * shipped value is one hour.
 */
export const LINK_TTL_S = 3600;
export const LINK_MISS_TTL_S = 60;

/**
 * The contract's function, verbatim. MEMORY AND COST HYGIENE, NOT CORRECTNESS: a record
 * whose window has closed stops serving because `isLinkActive` is evaluated on every read
 * (ADR-0009), not because the key expired. Deleting the read-time check and leaning on this
 * clamp is a defect, and `redirect-cache.spec.ts` says so in a test name.
 */
export function linkTtlSeconds(link: CachedLink, now: number): number {
  const bounds = [LINK_TTL_S];

  if (link.ea !== null) bounds.push(Math.ceil((link.ea - now) / 1000));
  if (link.aa !== null && link.aa > now) bounds.push(Math.ceil((link.aa - now) / 1000));

  return Math.max(1, Math.min(...bounds));
}

/**
 * `sk:{env}:hst:v1:{hostname}`. `{hostname}` is already lowercased, IDNA-normalised and
 * port-stripped by the time it arrives (`domain-provisioning.md`), so the key and the row
 * cannot disagree; this function does not normalise and must not start.
 */
export function hostKey(namespace: string, hostname: string): string {
  return `sk:${namespace}:hst:v1:${hostname}`;
}

/** `sk:{env}:rdr:v1:{hostname}:{slug}`. The slug is verbatim and case-sensitive (ADR-0007). */
export function linkKey(namespace: string, hostname: string, slug: string): string {
  return `sk:${namespace}:rdr:v1:${hostname}:${slug}`;
}

export interface RedirectCache {
  getHost(hostname: string): Promise<CachedHost | 'miss' | 'unavailable'>;
  setHost(hostname: string, value: CachedHost | 'miss'): Promise<void>;
  delHost(hostname: string): Promise<void>;

  getLink(hostname: string, slug: string): Promise<CachedLink | 'miss' | 'unavailable'>;
  setLink(hostname: string, slug: string, value: CachedLink | 'miss'): Promise<void>;
  delLink(hostname: string, slug: string): Promise<void>;
}

/**
 * What a failed DELETION rejects with. CARRIES NO KEY, NO HOSTNAME AND NO SLUG (GC-G,
 * D-2-15): the key embeds the slug, and an identifier reconstructible from an id stays off
 * the line. The subscriber logs `code`, `link_id` and `attempts`.
 */
export class RedirectCacheUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RedirectCacheUnavailableError';
  }
}

const NOT_CONNECTED_MESSAGE =
  'the redirect cache is not connected, so the key was not deleted. The mutation itself committed; this is the invalidation half (docs/contracts/redirect-cache.md).';

export class RedisRedirectCache implements RedirectCache {
  private readonly client: RedirectCacheClient;
  private readonly namespace: string;

  constructor(client: RedirectCacheClient, namespace: string) {
    this.client = client;
    this.namespace = namespace;
  }

  async getHost(hostname: string): Promise<CachedHost | 'miss' | 'unavailable'> {
    return this.read(hostKey(this.namespace, hostname), isCachedHost);
  }

  async setHost(hostname: string, value: CachedHost | 'miss'): Promise<void> {
    return this.write(
      hostKey(this.namespace, hostname),
      value,
      value === 'miss' ? HOST_MISS_TTL_S : HOST_TTL_S,
    );
  }

  async delHost(hostname: string): Promise<void> {
    return this.remove(hostKey(this.namespace, hostname));
  }

  async getLink(hostname: string, slug: string): Promise<CachedLink | 'miss' | 'unavailable'> {
    return this.read(linkKey(this.namespace, hostname, slug), isCachedLink);
  }

  async setLink(hostname: string, slug: string, value: CachedLink | 'miss'): Promise<void> {
    return this.write(
      linkKey(this.namespace, hostname, slug),
      value,
      value === 'miss' ? LINK_MISS_TTL_S : linkTtlSeconds(value, Date.now()),
    );
  }

  async delLink(hostname: string, slug: string): Promise<void> {
    return this.remove(linkKey(this.namespace, hostname, slug));
  }

  /**
   * ONE `GET`, THREE OUTCOMES, AND NO FOURTH; and the mapping of an ABSENT key is the part
   * a reader has to have (amendment of 2026-08-19 in `redirect-cache.md`).
   *
   * `'miss'` is the SENTINEL and nothing else: it answers the request with a 404 and zero
   * Postgres queries, so a key that was simply never written must not produce it, or an
   * empty cache would 404 every link in the database. Absence therefore joins the failures
   * under `'unavailable'`, whose contract is exactly "the caller must query Postgres". The
   * cost of the merge is that `'unavailable'` is not on its own evidence of an outage:
   * `cacheAvailable()` is the health signal, and a degradation line keyed on this value
   * would fire on every cold key.
   */
  private async read<T>(key: string, decoded: (value: unknown) => value is T): Promise<T | 'miss' | 'unavailable'> {
    if (this.client.status !== 'ready') {
      return 'unavailable';
    }

    let raw: string | null;

    try {
      raw = await this.client.get(key);
    } catch {
      // A rejection (ADR-0012's `commandTimeout`, `enableOfflineQueue: false`, a dropped
      // connection) and a synchronous throw are the same answer. The client logs its own
      // `error` events, throttled; a line here would be one per request during an outage.
      return 'unavailable';
    }

    if (raw === MISS_SENTINEL) {
      return 'miss';
    }

    if (raw === null) {
      return 'unavailable';
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return 'unavailable';
    }

    // A value that does not decode (a bumped `v`, a truncated write, a key some other
    // process wrote) is answered from Postgres. The alternative directions are both worse:
    // `'miss'` would 404 a live link, and a half-built record would 302 somewhere nobody
    // chose.
    return decoded(parsed) ? parsed : 'unavailable';
  }

  /**
   * `SET key value EX ttl`, ONE COMMAND (the contract's rule): `SET` then `EXPIRE` leaves a
   * window in which a crash between the two strands a key with no expiry, and costs a second
   * billed command on the hot path.
   */
  private async write(key: string, value: CachedHost | CachedLink | 'miss', ttl: number): Promise<void> {
    if (this.client.status !== 'ready') {
      return;
    }

    try {
      await this.client.set(key, value === 'miss' ? MISS_SENTINEL : JSON.stringify(value), 'EX', ttl);
    } catch {
      // Swallowed on purpose: see the file docblock. The next request pays one Postgres
      // query, which is the same price the miss would have cost.
    }
  }

  /** Rejects when the deletion did not happen. See the file docblock for why. */
  private async remove(key: string): Promise<void> {
    if (this.client.status !== 'ready') {
      throw new RedirectCacheUnavailableError(NOT_CONNECTED_MESSAGE);
    }

    try {
      await this.client.del(key);
    } catch (error) {
      throw new RedirectCacheUnavailableError(NOT_CONNECTED_MESSAGE, { cause: error });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isEpochOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isBrandingOrNull(value: unknown): boolean {
  if (value === null) {
    return true;
  }

  return (
    isRecord(value) &&
    (value.lg === null || isString(value.lg)) &&
    (value.bc === null || isString(value.bc)) &&
    (value.fb === null || isString(value.fb))
  );
}

function isCachedHost(value: unknown): value is CachedHost {
  return (
    isRecord(value) &&
    value.v === 1 &&
    isString(value.dm) &&
    isString(value.t) &&
    isString(value.w) &&
    isBrandingOrNull(value.b)
  );
}

function isCachedLink(value: unknown): value is CachedLink {
  return (
    isRecord(value) &&
    value.v === 1 &&
    isString(value.id) &&
    isString(value.d) &&
    isString(value.dm) &&
    isString(value.w) &&
    isString(value.t) &&
    isEpochOrNull(value.ea) &&
    isEpochOrNull(value.aa)
  );
}
