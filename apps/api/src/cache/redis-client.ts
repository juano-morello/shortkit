/**
 * Contract: docs/contracts/redirect-cache.md ("Keys": `{env}` comes from
 *           `REDIS_KEY_NAMESPACE`, which is REQUIRED: the process refuses to boot when it
 *           is unset rather than defaulting to something that might collide).
 * ADR: adr-0012-redis-client-and-rate-limit-degradation.md (the constructor and its six
 *      options, verbatim; one client, one failure posture; `cacheAvailable`),
 *      adr-0040 (a boot-time behavioural choice keys on a declared property of the
 *      deployment, never on `NODE_ENV`), adr-0029 (no configured value in error text),
 *      adr-0028 (what a log line may carry).
 * Decision: D-2-09 (Redis presence is a declared binding; absence binds the degraded cache
 *           loudly), D-2-01 (the revocation store and the limiters are NOT rebound here).
 * Produced by: TASK-2-03 (item 2, wave 1).
 * Consumed by: `main.ts` (`assertRedisConfigured`), `cache.module.ts` (`readRedisBinding`,
 *              `redisClient`), the degradation suites (`cacheAvailable`,
 *              `simulateRedisUnavailable`).
 *
 * ============================================================================
 * `REDIS_URL` AND `REDIS_KEY_NAMESPACE` ARE READ IN THIS FILE AND NOWHERE ELSE. NEVER
 * `NODE_ENV` (GC-B).
 * ============================================================================
 *
 * The shape is `MAIL_TRANSPORT`'s, which is ADR-0040's: **validity is asserted
 * unconditionally, the requirement is conditional on the value, and absence selects a
 * binding rather than asserting nothing.** A malformed `REDIS_URL` refuses everywhere,
 * including in CI and on a laptop, because a typo that silently selects the degraded cache
 * is a deployment serving every redirect from Postgres while believing it has a cache.
 * Absence lands on `UnavailableRedirectCache` (which can do no harm, only extra queries)
 * and writes ONE warn line.
 *
 * ============================================================================
 * THE CLIENT IS MODULE-PRIVATE BY CONVENTION AND BY TEST.
 * ============================================================================
 *
 * ADR-0012 is "one `ioredis` client … shared by the redirect cache and the rate limiter",
 * and D-2-01 (Juano, 2026-08-19) DEFERRED the second half: the revocation store and the
 * three limiters stay process-local until the ADR superseding ADR-0030 lands. So the client
 * has exactly one consumer today, `cache.module.ts`, which binds `REDIRECT_CACHE`.
 * `redis-client.spec.ts` asserts that nothing outside `apps/api/src/cache/**` names
 * `redisClient`: a second consumer is a deliberate export in the card that adds it, not an
 * import somebody reaches for.
 *
 * BUILT ON FIRST USE, NOT AT IMPORT: `db/client.ts`'s rule, for the same reason. Unit
 * suites import this module graph and never reach a cache; a client constructed at import
 * would open a socket in every one of them.
 */
import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

import { logger } from '../observability/logger';

export const REDIS_URL_ENV = 'REDIS_URL';
export const REDIS_KEY_NAMESPACE_ENV = 'REDIS_KEY_NAMESPACE';

/** The two schemes `ioredis` speaks over RESP. `rediss:` is the TLS one (ADR-0012). */
const REDIS_URL_SCHEMES = ['redis:', 'rediss:'];

/**
 * A namespace becomes the second segment of every key (`sk:{env}:…`, GC-P), so a colon in it
 * would silently redraw the key structure and whitespace would produce a key nobody can type
 * at `redis-cli`. Everything else is allowed: the contract's values are `prod`, `staging`,
 * `dev` and `ci-{run_id}`, and a rule tighter than this would refuse a run id nobody
 * predicted.
 */
const NAMESPACE_FORBIDDEN = /[\s:]/;

/**
 * ============================================================================
 * THE THREE REFUSAL STRINGS. NONE INTERPOLATES A CONFIGURED VALUE (ADR-0029).
 * ============================================================================
 *
 * `REDIS_URL` is the single most credential-bearing variable in this file (`rediss://
 * default:<password>@host:6380` is the ordinary shape), so it is never quoted back, not in a
 * refusal, not in a log line, not in a stack. The refusal names the rule; the operator has
 * the environment in front of them.
 */
export const REDIS_URL_INVALID_MESSAGE =
  'REDIS_URL must be a redis:// or rediss:// URL (host and port, credentials optional). It is not a bare host:port and it is not a boolean. Unset it to run without a redirect cache. See docs/contracts/redirect-cache.md.';

export const REDIS_KEY_NAMESPACE_UNSET_MESSAGE =
  'REDIS_URL is set but REDIS_KEY_NAMESPACE is not. Every key begins sk:{REDIS_KEY_NAMESPACE}:, and a process that defaulted it would share a key space with whatever else pointed at that instance: a staging host record served to production visitors. Values in use: prod, staging, dev, ci-{run_id}. See docs/contracts/redirect-cache.md.';

export const REDIS_KEY_NAMESPACE_INVALID_MESSAGE =
  'REDIS_KEY_NAMESPACE may not contain a colon or whitespace: it is the second segment of every key (sk:{env}:hst:v1:{hostname}), so a colon in it redraws the key structure. See docs/contracts/redirect-cache.md.';

/**
 * The refusal `assertRedisConfigured` throws, and what `main.ts`'s `bootstrap().catch` maps
 * onto `boot_precondition: 'redirect_cache'`, the arrangement `MailBindingError` and
 * `AuthBindingError` already have, so the line an operator reads names WHICH declaration
 * refused (F-245).
 *
 * A class of its own rather than `main.ts`'s `BootPreconditionError` for the reason
 * `mail-transport.ts` records: that class is module-private to `main.ts`, and `main.ts` calls
 * `bootstrap()` at module scope, so a leaf module cannot import it without booting the API.
 *
 * NEVER CARRIES A VALUE. Every message is one of the three constants above.
 */
export class RedisBindingError extends Error {
  readonly binding = 'redirect_cache' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RedisBindingError';
  }
}

export interface RedisBinding {
  readonly url: string;
  readonly namespace: string;
}

/**
 * The declared binding, or `undefined` when this deployment declared no cache. THE ONE READ
 * OF BOTH VARIABLES; the assertion and the module factory both go through it, so the refusal
 * and the construction cannot disagree on what "set" means.
 *
 * Empty is unset (`REDIS_URL=` is what an env file produces for an absent variable, and it
 * is the same statement as absence). A `REDIS_URL` that is set and malformed is NOT absence:
 * it refuses, whatever else is declared.
 */
export function readRedisBinding(env: NodeJS.ProcessEnv): RedisBinding | undefined {
  const url = env[REDIS_URL_ENV];

  if (url === undefined || url.trim() === '') {
    return undefined;
  }

  assertUrlIsRedis(url);

  const namespace = env[REDIS_KEY_NAMESPACE_ENV];

  if (namespace === undefined || namespace.trim() === '') {
    throw new RedisBindingError(REDIS_KEY_NAMESPACE_UNSET_MESSAGE);
  }

  if (NAMESPACE_FORBIDDEN.test(namespace)) {
    throw new RedisBindingError(REDIS_KEY_NAMESPACE_INVALID_MESSAGE);
  }

  return { url, namespace };
}

/**
 * Called UNCONDITIONALLY from `main.ts`'s `assertBootPreconditions()`, beside the auth
 * bindings, the two trust boundaries and the mail transport. The gating is inside, and it
 * keys on `REDIS_URL`, never on `NODE_ENV` (GC-B).
 *
 *   1. ALWAYS: `REDIS_URL`, if set, is a `redis:`/`rediss:` URL.
 *   2. ONLY when it is set: `REDIS_KEY_NAMESPACE` is set and carries no colon or whitespace.
 *   3. When it is unset: log ONE warn line carrying `boot_precondition: 'redirect_cache'`
 *      and no other field, and return. That line is the only local evidence a deployment
 *      that forgot the variable ever gets: every redirect will resolve from Postgres and
 *      every response will be correct, which is exactly why nothing else would notice.
 *
 * Cannot check that a deployment which HAS a Redis pointed this process at it, and cannot
 * check that the instance is reachable: reachability is not a boot precondition here, by
 * design. ADR-0012's whole posture is that a redirect serves without Redis, so refusing to
 * boot on an unreachable cache would convert a degraded path into an outage.
 */
export function assertRedisConfigured(env: NodeJS.ProcessEnv): void {
  if (readRedisBinding(env) === undefined) {
    logger.warn(
      { boot_precondition: 'redirect_cache' },
      'REDIS_URL is unset: the redirect cache is bound to UnavailableRedirectCache, so every redirect resolves from Postgres and every cache write is a no-op. Declare REDIS_URL and REDIS_KEY_NAMESPACE to change that (docs/contracts/redirect-cache.md).',
    );
  }
}

/**
 * ============================================================================
 * ADR-0012'S CONSTRUCTOR OPTIONS, VERBATIM. EACH ONE ANSWERS AN AC.
 * ============================================================================
 *
 * `enableOfflineQueue: false`: a command while disconnected REJECTS immediately instead of
 *   queueing until reconnect, which is what lets AC-2-29 answer from Postgres rather than
 *   hang.
 * `maxRetriesPerRequest: 1`: one retry, then the command fails to the caller.
 * `commandTimeout: 50`: bounds a hung-but-CONNECTED server (AC-2-30). This is the only
 *   thing standing between a wedged Redis and the redirect's latency budget.
 * `connectTimeout: 1000`: bounds the establishment.
 * `retryStrategy`: `times * 200` capped at 5000, which is AC-2-31's "reconnects without a
 *   restart".
 * `lazyConnect: false`: the connection is opened when the client is constructed, so a
 *   deployment with an unreachable Redis is degraded from its first request rather than from
 *   its first command.
 *
 * Everything not listed is `ioredis`'s default and is left alone deliberately: this object is
 * the ADR's list and adding to it is an ADR conversation.
 */
export const REDIS_CLIENT_OPTIONS = {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 50,
  connectTimeout: 1000,
  retryStrategy: (times: number): number => Math.min(times * 200, 5000),
  lazyConnect: false,
} as const satisfies RedisOptions;

/** How often a client `error` event may reach the log. ADR-0012: "logs once per minute". */
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Builds a client on the ADR's options and attaches the `error` listener.
 *
 * THE LISTENER IS NOT OPTIONAL. `ioredis` emits `error` on every failed connection attempt,
 * and an `EventEmitter` emitting `error` with no listener is an uncaughtException. Node
 * takes the process down. That is the `pg` failure mode F-123 and F-137 already cost this
 * repository twice, one level over; a Redis outage must degrade the redirect, not kill the
 * API.
 *
 * THROTTLED TO ONE LINE PER MINUTE PER CLIENT. `retryStrategy` reconnects every 200 ms at
 * first, so an unreachable instance produces five events a second, and the honest signal,
 * "this process cannot reach its cache", is the same sentence every time.
 *
 * The line carries `code` and the error under `err`, which `serializers.err` reduces to
 * `err_name` and `err_stack` (F-244). NOT `err_message`: a connection error's message
 * carries the host and port, and while `db/client.ts` accepts that for Postgres, a Redis
 * URL's authority half is where the password lives and `ECONNREFUSED` is not worth the
 * class of accident ADR-0029 exists to prevent.
 */
export function createRedisClient(binding: RedisBinding): Redis {
  const client = new Redis(binding.url, REDIS_CLIENT_OPTIONS);

  let lastLoggedAt = 0;

  client.on('error', (error: Error) => {
    const now = Date.now();

    if (now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) {
      return;
    }

    lastLoggedAt = now;

    logger.warn(
      { err: error, code: 'redirect_cache_unavailable' },
      'the redirect cache client reported an error and will keep retrying; redirects resolve from Postgres until it reconnects (ADR-0012). Further occurrences are suppressed for a minute.',
    );
  });

  return client;
}

let client: Redis | undefined;

/**
 * The one client (ADR-0012), built on first use and shared afterwards. Its only sanctioned
 * caller is `cache.module.ts`, asserted by `redis-client.spec.ts` (see the file docblock).
 *
 * The binding is passed in rather than read here so that this function cannot be the thing
 * that decides whether a cache exists: that decision is `readRedisBinding`'s, once, and the
 * module factory acts on it. A second call with a DIFFERENT binding returns the first
 * client; there is one client per process by construction, and the only way to change it is
 * `closeRedisClient()`.
 */
export function redisClient(binding: RedisBinding): Redis {
  client ??= createRedisClient(binding);

  return client;
}

/**
 * ADR-0012's health signal: STATUS-BASED, NO COMMAND. A health check that issued a `PING`
 * would spend a billed round trip per probe and would itself be subject to the 50 ms
 * timeout, so a slow-but-alive cache would report itself dead.
 *
 * `false` when no client was ever built (no binding), which is the honest answer: there is
 * no cache.
 */
export function cacheAvailable(): boolean {
  return client?.status === 'ready';
}

/**
 * ============================================================================
 * THE DEGRADATION FIXTURE (ADR-0012 follow-up: "TASK-032 … owns `simulateRedisUnavailable()`").
 * ============================================================================
 *
 * Disconnects the client and REFUSES RECONNECTION until the returned function is called:
 * `ioredis`'s `disconnect()` with no argument sets `manuallyClosing`, so `retryStrategy` does
 * not fire and the client stays at `end`. Every read then answers `'unavailable'` and every
 * write is a no-op, which is precisely the state AC-2-29 asks for.
 *
 * SHIPPED CODE, NOT TEST SUPPORT, and deliberately: it acts on the module-private client,
 * which nothing outside this file can reach. It is consumed by TASK-2-07's and TASK-2-12's
 * degradation proofs, and it is inert (a no-op returning a no-op) in a process that declared
 * no Redis, where the cache is already unavailable and there is nothing to simulate.
 */
export function simulateRedisUnavailable(): () => void {
  if (client !== undefined && !simulated) {
    simulated = true;
    // No argument: `ioredis` sets `manuallyClosing`, so `retryStrategy` does NOT fire and
    // the client stays down until `restoreRedisAvailability` connects it again.
    client.disconnect();
  }

  return restoreRedisAvailability;
}

/**
 * Reconnects after `simulateRedisUnavailable()`. Idempotent, and it does not WAIT for the
 * connection: the caller polls until `cacheAvailable()`, which is what AC-2-31's "no
 * restart" means and what a fixed sleep would only appear to prove.
 *
 * ============================================================================
 * `disconnect()` IS ASYNCHRONOUS AND THIS FUNCTION IS WHERE THAT MATTERS.
 * ============================================================================
 *
 * Measured while placing the integration suite: `disconnect()` ends the socket, and the
 * status does not become `end` until Node delivers the close, so a `restore` called in the
 * same tick as the `simulate` sees a client that still reads `ready`. A version of this
 * function that only handled the settled case returned silently there and left the client
 * down for the REST OF THE PROCESS, with `cacheAvailable()` reporting `true` for the few
 * milliseconds a polling test needed to conclude it had recovered. Both orders are handled
 * here rather than left to the caller's timing.
 */
export function restoreRedisAvailability(): void {
  const target = client;

  if (target === undefined || !simulated) {
    return;
  }

  simulated = false;

  // A rejection from a connection that fails afterwards is reported through the `error`
  // listener rather than as an unhandled rejection here.
  const reconnect = (): void => {
    target.connect().catch(() => undefined);
  };

  if (target.status === 'end') {
    reconnect();

    return;
  }

  target.once('end', reconnect);
}

/**
 * Whether `simulateRedisUnavailable()` is in force. Module state rather than a parameter
 * because the fixture's two halves are called from different places (a `try` and its
 * `finally`, or two different tests), and a second `simulate` before a `restore` must not
 * queue a second reconnection.
 */
let simulated = false;

/**
 * Releases the client. Called by a suite that has finished with it: an open `ioredis`
 * connection keeps the event loop alive, so a test run would hang exactly as it did before
 * `allowExitOnIdle` was set on the pg pools.
 *
 * `quit()` first so the server sees a clean close; `disconnect()` unconditionally after,
 * because a `quit()` that rejects (the connection is already gone) must not leave the socket
 * and the reconnection timer behind.
 */
export async function closeRedisClient(): Promise<void> {
  const open = client;
  client = undefined;
  simulated = false;

  if (open === undefined) {
    return;
  }

  await open.quit().catch(() => undefined);
  open.disconnect();
}

function assertUrlIsRedis(value: string): void {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new RedisBindingError(REDIS_URL_INVALID_MESSAGE);
  }

  if (!REDIS_URL_SCHEMES.includes(parsed.protocol)) {
    throw new RedisBindingError(REDIS_URL_INVALID_MESSAGE);
  }
}
