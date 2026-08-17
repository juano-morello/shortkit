/**
 * Contract: `docs/contracts/auth-tokens.md` ("Verification", step 2: "Signature valid
 *           against JWKS cached in process for 600 s"; "What the implementer must
 *           guarantee": "JWKS is fetched over the loopback interface or from the in-process
 *           auth instance, not over the public internet"; "Versioning": key rolling)
 * ADR: adr-0013-better-auth-in-nestjs.md ("Verification is stateless, against cached JWKS"),
 *      adr-0059 (`BETTER_AUTH_URL` is the one declared origin)
 * Produced by: TASK-005 (wave 4). Read by `auth.guard.ts` through `JWKS_KEY_SET_SOURCE`.
 *
 * ============================================================================
 * THE PROCESS FETCHES ITS OWN MOUNT, AND THE URL IS DERIVED FROM `BETTER_AUTH_URL`.
 * ============================================================================
 *
 * The key set lives in the `jwks` table behind the auth role, and the only thing in this
 * process that may read it is the composed Better Auth instance (`auth.config.ts`), which
 * this module may not import: `auth.module.ts` and `better-auth-database-callers.spec.ts`
 * scan 5 both close that door, because the composed instance is a second handle on the
 * auth role and evaluating it needs the three bindings. `GET /api/auth/jwks` is that same
 * instance's public read, mounted in `main.ts` on the same socket this process listens on,
 * so the fetch below is the process calling itself. In every environment that exists today
 * that is a loopback hop: `docker-compose.yml` sets `BETTER_AUTH_URL` to
 * `http://localhost:3001` inside a container that listens on 3001, and the integration
 * harness sets it to `http://127.0.0.1:<port>`.
 *
 * WHY THAT ORIGIN AND NOT A HARD-CODED `127.0.0.1:${PORT}`: `BETTER_AUTH_URL` is the value
 * `auth.config.ts` writes into `iss` and `aud` (ADR-0059), so deriving the JWKS URL from it
 * makes "the origin the tokens name" and "the origin the keys are read from" one value read
 * once, and there is no second port variable for a deploy target to leave out of step. On a
 * topology where `BETTER_AUTH_URL` is a public origin the fetch goes out through it and
 * comes back over TLS — still this process's own key set, still integrity-protected, but not
 * loopback. That is a property of the deploy target ADR-0030 put out of scope, and it is the
 * reason `createJwksCache` takes `jwksUrl` as an injectable rather than a constant.
 *
 * ============================================================================
 * ONE FETCH PER TTL PER PROCESS, SHARED IN FLIGHT, AND A FAILURE NEVER POISONS THE CACHE.
 * ============================================================================
 *
 * The happy path is a memory read. Concurrent misses share one promise, so a burst of
 * requests at boot or at expiry costs one round trip and not one per request. When a
 * refresh fails and a set is already held, the stale set is served and the failure is
 * logged: `auth-tokens.md` rolls keys by publishing the new one and waiting 600 s, so a set
 * that is a few minutes past its TTL is exactly the set the tokens in flight were signed
 * with. The next call tries again — nothing here backs off, because the endpoint is this
 * process's own and a failure means the process is unwell (its database read failed), not
 * that a remote host needs sparing. When there is nothing held, the failure is the caller's:
 * the guard cannot verify anything without a key, and "could not verify" is a 500 and not a
 * 401 (F-245's rule, `auth.guard.ts`).
 *
 * TIME AND THE FETCH ARE INJECTED, for the reason `revocation-store.ts` gives for its
 * `Clock`: the TTL is a statement about elapsed time, and this repository proves such
 * statements with an injected clock rather than fake timers. The process-wide instance
 * `cachedKeySet` is built by the same factory with the real ones.
 *
 * NOTHING HERE LOGS THE URL, THE KEY SET OR THE ERROR MESSAGE. The two lines carry `code`
 * and the error's name and frames; a fetch error's message can name a host.
 */
import type { JSONWebKeySet } from 'jose';

import { errorLogFields, logger } from '../observability/logger';
import { betterAuthUrl } from './boot-assertions';

/** The card's name for jose's `JSONWebKeySet`, so callers need not import jose for the type. */
export type JsonWebKeySet = JSONWebKeySet;

/** ADR-0013: "caches the key set in process for 10 minutes". */
export const JWKS_CACHE_TTL_MS = 600_000;

/** Better Auth's jwt plugin route, base-path-relative under the `/api/auth` mount. */
export const JWKS_PATH = '/api/auth/jwks';

/** How long one fetch may take before it is abandoned. Loopback; anything near this is a hang. */
export const JWKS_FETCH_TIMEOUT_MS = 5_000;

export interface JwksCacheOptions {
  /** Defaults to `fetchKeySetOverHttp`. */
  readonly fetchKeySet?: (url: string) => Promise<JsonWebKeySet>;
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Defaults to `jwksUrl`, read per fetch so nothing here evaluates the binding at import. */
  readonly jwksUrl?: () => string;
}

export interface JwksCache {
  /** The current key set: from memory inside the TTL, otherwise fetched once and shared. */
  cachedKeySet(): Promise<JsonWebKeySet>;
}

/** `${BETTER_AUTH_URL}${JWKS_PATH}` — the same origin the tokens carry as `iss` (ADR-0059). */
export function jwksUrl(): string {
  return `${betterAuthUrl()}${JWKS_PATH}`;
}

export function createJwksCache(options: JwksCacheOptions = {}): JwksCache {
  const fetchKeySet = options.fetchKeySet ?? fetchKeySetOverHttp;
  const now = options.now ?? Date.now;
  const resolveUrl = options.jwksUrl ?? jwksUrl;

  let held: { readonly keySet: JsonWebKeySet; readonly fetchedAt: number } | undefined;
  let inFlight: Promise<JsonWebKeySet> | undefined;

  const refresh = async (): Promise<JsonWebKeySet> => {
    try {
      const keySet = await fetchKeySet(resolveUrl());
      assertKeySetShape(keySet);
      held = { keySet, fetchedAt: now() };

      return keySet;
    } catch (error: unknown) {
      if (held !== undefined) {
        logger.warn(
          { code: 'auth_jwks_refresh_failed', ...errorLogFields(error, { includeMessage: false }) },
          'the JWKS could not be refreshed, so the previously fetched key set is still in use',
        );

        return held.keySet;
      }

      logger.error(
        { code: 'auth_jwks_unavailable', ...errorLogFields(error, { includeMessage: false }) },
        'the JWKS could not be fetched and no key set is held, so no token can be verified',
      );

      throw error;
    } finally {
      inFlight = undefined;
    }
  };

  return {
    cachedKeySet(): Promise<JsonWebKeySet> {
      if (held !== undefined && now() - held.fetchedAt < JWKS_CACHE_TTL_MS) {
        return Promise.resolve(held.keySet);
      }

      inFlight ??= refresh();

      return inFlight;
    },
  };
}

/**
 * The real fetch. `fetchImpl` is a parameter so the spec can hand it a stub without touching
 * the global; the guard's path uses Node's own.
 */
export async function fetchKeySetOverHttp(url: string, fetchImpl: typeof fetch = fetch): Promise<JsonWebKeySet> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
  });

  if (response.status !== 200) {
    // The status and nothing else: a Better Auth error body is not a key set, and the URL
    // is not repeated because it can name a host.
    throw new Error(`the JWKS endpoint answered ${String(response.status)}`);
  }

  const body: unknown = await response.json();
  assertKeySetShape(body);

  return body;
}

/**
 * The shape and nothing more: `{ keys: object[] }`. jose validates each key when it is used,
 * and a set with zero keys is a real (if useless) key set that makes every token
 * `unauthenticated`, which is the correct answer for a process whose issuer has no key.
 */
function assertKeySetShape(value: unknown): asserts value is JsonWebKeySet {
  const keys = (value as { keys?: unknown } | null)?.keys;

  if (typeof value !== 'object' || value === null || !Array.isArray(keys) || !keys.every((key) => typeof key === 'object' && key !== null)) {
    throw new Error('the JWKS endpoint answered something that is not a key set');
  }
}

const processWide = createJwksCache();

/**
 * The process-wide cache: one fetch per TTL per process, which is what ADR-0013 asks for.
 * Bound to `JWKS_KEY_SET_SOURCE` in `auth.module.ts`.
 */
export function cachedKeySet(): Promise<JsonWebKeySet> {
  return processWide.cachedKeySet();
}
