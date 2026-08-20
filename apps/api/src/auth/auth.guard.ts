/**
 * Contract: `docs/contracts/auth-tokens.md` ("Verification, performed by `AuthGuard`",
 *           "Invariants a caller may rely on", "What the implementer must guarantee"),
 *           `docs/contracts/error-envelope.md` (every refusal is a `DomainError`; 401 for
 *           `unauthenticated` and `token_expired`, and no other status for either),
 *           `docs/contracts/revocation-store.md` ("What the caller may assume, and what the
 *           implementer must guarantee": the read site wraps `isRevoked` and skips open),
 *           `docs/contracts/tenant-context.md` (`RequestContext`, `PUBLIC_ROUTE_METADATA`)
 * ADR: adr-0013-better-auth-in-nestjs.md (stateless verification, revocation, `jti` is the
 *      session id), adr-0012 (the skip-open posture when the store cannot answer), adr-0053
 *      (the shipped store never rejects, and the branch is required anyway), adr-0015 (F-029:
 *      the tid backstop), adr-0024 (a refusal is a `DomainError`), adr-0028 (nothing here
 *      logs a claim, a header or a token), adr-0002 (no database read before the tenant
 *      transaction opens)
 * Produced by: TASK-005 (wave 4). Registered as `APP_GUARD` in `auth.module.ts`, so every
 *              Nest route is guarded unless it carries `PUBLIC_ROUTE_METADATA`. TASK-006
 *              writes the `@Public()` decorator that sets that key and the interceptor that
 *              reads `REQUEST_CONTEXT_KEY`.
 *
 * ============================================================================
 * EIGHT STEPS, SHORT-CIRCUITING, IN THE CARD'S ORDER — WITH ONE STATED DEVIATION.
 * ============================================================================
 *
 *   1. Public-route check. `PUBLIC_ROUTE_METADATA` on the handler or its class: return
 *      `true`, populate nothing, read no token. A handler that forgets `@Public()` is
 *      treated as authenticated and gets a 401, which is the safe direction.
 *   2. Bearer presence: `Authorization: Bearer <token>`, else 401 `unauthenticated`.
 *   3. Signature against the cached JWKS, else 401 `unauthenticated`.
 *   4. `exp`, else 401 `token_expired` — the one 401 with a distinct code; the BFF branches
 *      on it to refresh (`auth-tokens.md` invariant 4).
 *   5. `iss` and `aud` equal the declared origin, else 401 `unauthenticated`.
 *   7. Claim shape: `tid` uuid-shaped, `sub` non-empty, `ev` boolean, else 401
 *      `unauthenticated` — the F-029 backstop, so a tid-less token is a 401 here and not a
 *      500 from `withTenantTransaction` one layer down.
 *   6. Revocation: `isRevoked(claims.jti)`. Revoked, 401 `unauthenticated`. Store cannot
 *      answer, SKIP OPEN and log (ADR-0012), so a captured token stays usable for at most
 *      its remaining 300 s.
 *   8. Populate `RequestContext` from `sub`, `tid`, `email`, `ev`. FROM CLAIMS ONLY. NO
 *      DATABASE READ. `email` since TASK-1b-05 (D-06): the mail template needs the inviter's
 *      address and the app role cannot read `user`; it is never logged (GC-G).
 *
 * Steps 3, 4, 5 and 7 are one call, `verifyAndReadClaims`, and 7 runs before 6. The card
 * writes 6 before 7; the deviation is deliberate and observable only in what the store is
 * asked. `verifyAndReadClaims` returns `ShortkitJwtClaims`, and that type is a lie unless the
 * shape has been checked before it returns — and step 6 needs `claims.jti` to be a non-empty
 * string, which only step 7 establishes (`revocation-store.md` gives `''` its own row and
 * says why the guard must never ask about it). Both orders answer 401 `unauthenticated` to a
 * malformed token; this one answers it without a store read.
 *
 * Email verification is off in this initiative (TASK-005's card): a false `ev` does not
 * produce 403 `email_not_verified` here. The code stays in `ERROR_CODES`, unused.
 *
 * ============================================================================
 * NOTHING HERE LOGS THE TOKEN, THE HEADER, THE EMAIL, OR THE CLAIM SET.
 * ============================================================================
 *
 * `LOGGABLE_FIELDS` is an allowlist and an unnamed field renders `[redacted]`, but `msg` is
 * a key no censoring path can reach, so the one line this file writes — the degraded
 * revocation check — is a fixed string plus `code` and the error's name and frames. A
 * refusal is not logged here at all; the filter records the `DomainError` under its
 * `request_id`, and its message is one of two fixed strings (`auth-claims.ts`).
 *
 * `REQUEST_CONTEXT_KEY` is a registered symbol rather than a string property for the same
 * reason: `JSON.stringify` skips symbol keys, so a request object that reaches a log line
 * whole (which ADR-0028 censors anyway) never carries the context under a key a scan has to
 * know about.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { DomainError } from '../common/errors/domain-error';
import { errorLogFields, logger } from '../observability/logger';
import { PUBLIC_ROUTE_METADATA } from '../tenancy/tenant-context';
import type { RequestContext } from '../tenancy/tenant-context';
import { UNAUTHENTICATED_MESSAGE, verifyAndReadClaims } from './auth-claims';
import type { JsonWebKeySet } from './jwks-cache';
import type { RevocationStore } from './revocation-store';

/**
 * The request property the populated `RequestContext` is written to and TASK-006's
 * interceptor reads it from. `Symbol.for`, like `DOMAIN_ERROR_MARKER`, so a second copy of
 * this module in one process (a vitest workspace, a bundle beside source) reads the same key.
 */
export const REQUEST_CONTEXT_KEY: unique symbol = Symbol.for('shortkit.requestContext');

/**
 * The store the guard reads. Bound to the process-wide `revocationStore` in `auth.module.ts`
 * (one instance per process, `revocation-store.md`); a spec overrides it to hand the guard a
 * port that rejects, which the shipped one cannot.
 */
export const REVOCATION_STORE = Symbol('REVOCATION_STORE');

/**
 * Where the key set comes from: `cachedKeySet` from `jwks-cache.ts` in `auth.module.ts`, a
 * local pair's public half in a spec.
 */
export const JWKS_KEY_SET_SOURCE = Symbol('JWKS_KEY_SET_SOURCE');

export type KeySetSource = () => Promise<JsonWebKeySet>;

/** What this guard reads from the request. Named, like `exception-filter.ts` names its four members. */
interface GuardedRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  [REQUEST_CONTEXT_KEY]?: RequestContext;
}

const BEARER_SCHEME = 'bearer';

@Injectable()
export class AuthGuard implements CanActivate {
  /**
   * `@Inject(Reflector)` is written out although the type alone would do for Nest: the
   * repository's `consistent-type-imports` rule is not type-aware, so a value import used only
   * as a constructor parameter type is flagged, and an `import type` would erase the
   * `design:paramtypes` entry the injector reads (ADR-0001). The explicit token keeps both
   * honest.
   */
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(REVOCATION_STORE) private readonly revocationStore: RevocationStore,
    @Inject(JWKS_KEY_SET_SOURCE) private readonly keySet: KeySetSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Handler first, then class: `getAllAndOverride` returns the first defined value in
    // that order, so a handler-level marker on a controller that carries none is seen and
    // a class-level marker covers every handler. Presence is the test — the value is the
    // justification string TASK-056 prints, and the guard does not judge it.
    const publicJustification = this.reflector.getAllAndOverride<unknown>(PUBLIC_ROUTE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (publicJustification !== undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<GuardedRequest>();

    // 2.
    const token = bearerToken(request.headers.authorization);

    if (token === undefined) {
      throw new DomainError('unauthenticated', UNAUTHENTICATED_MESSAGE);
    }

    // 3, 4, 5, 7. A key-set source that cannot answer propagates as itself: "could not
    // verify" is a 500 (F-245's rule) and not a 401 that would send the BFF back to a login
    // whose fresh token fails the same way.
    const claims = await verifyAndReadClaims(token, await this.keySet(), process.env);

    // 6.
    if (await this.isRevoked(claims.jti)) {
      throw new DomainError('unauthenticated', UNAUTHENTICATED_MESSAGE);
    }

    // 8. Claims only. `tid` is already canonical (lower case) from `verifyAndReadClaims`.
    request[REQUEST_CONTEXT_KEY] = {
      userId: claims.sub,
      tenantId: claims.tid,
      email: claims.email,
      emailVerified: claims.ev,
    };

    return true;
  }

  /**
   * ADR-0012's posture, applied to the one store read on the request path. A rejection is
   * "could not tell", not "not revoked" (`revocation-store.md` invariant 3), and the guard
   * chooses to proceed rather than to refuse every request while the store is down — the
   * captured-token cost is bounded by `exp` at 300 s (ADR-0013). Logged so it can be counted;
   * `auth_revocation_degraded_total` is carried in `code`, there being no metrics pipeline yet.
   *
   * ============================================================================
   * UNREACHABLE WITH `InMemoryRevocationStore` AND REQUIRED ANYWAY (ADR-0053).
   * ============================================================================
   *
   * A `Map` read cannot fail. TASK-030 rebinds `REVOCATION_STORE` to a Redis-backed port
   * without touching this file, and this is the branch that has to already exist when it does.
   * Removing it as dead code re-opens the gap on the day Redis arrives.
   *
   * Every rejection is skipped open, not only `RevocationStoreUnavailableError`: the contract
   * says a store may reject only with that class, and one that rejects with anything else has
   * broken its contract, but refusing every authenticated request until it is fixed is the
   * worse failure. The class is on the line as `err_name`, which is what makes it findable.
   */
  private async isRevoked(sessionId: string): Promise<boolean> {
    try {
      return await this.revocationStore.isRevoked(sessionId);
    } catch (error: unknown) {
      logger.warn(
        { code: 'auth_revocation_degraded', ...errorLogFields(error, { includeMessage: false }) },
        'the revocation store could not answer, so the check was skipped and the token was ' +
          'accepted on its signature and expiry alone (ADR-0012)',
      );

      return false;
    }
  }
}

/**
 * The token out of `Authorization: Bearer <token>`, or `undefined` for anything else: no
 * header, a repeated header, another scheme, a bare scheme, or trailing material. The scheme
 * is matched case-insensitively (RFC 7235 §2.1); the token itself is passed through untouched.
 */
function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }

  const [scheme, token, ...rest] = header.trim().split(/\s+/);

  if (scheme?.toLowerCase() !== BEARER_SCHEME || token === undefined || token === '' || rest.length > 0) {
    return undefined;
  }

  return token;
}
