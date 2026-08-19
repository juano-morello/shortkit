import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { LocalAuthRateLimiter } from './auth-rate-limit';
import { AuthGuard, JWKS_KEY_SET_SOURCE, REVOCATION_STORE } from './auth.guard';
import { cachedKeySet } from './jwks-cache';
import { AUTH_RATE_LIMIT_PORT } from './ports/auth-rate-limit.port';
import { revocationStore } from './revocation-store';

/**
 * ADR: adr-0013-better-auth-in-nestjs.md, adr-0011 (the port shape), adr-0012
 * Produced by: TASK-003. Extended by: TASK-004 (`AUTH_RATE_LIMIT_PORT`), TASK-005 (`AuthGuard`).
 *
 * ============================================================================
 * THE BETTER AUTH HANDLER IS NOT IN THIS MODULE, AND CANNOT BE.
 * ============================================================================
 *
 * ADR-0013 mounts it as one Express registration in `main.ts` (TASK-004, wave 3), outside
 * the Nest graph: it needs the raw request body, which Nest's body parser has already
 * consumed by the time a controller runs. So this module holds nothing of the mount, and
 * `ApiExceptionFilter` never sees a Better Auth response — `auth.config.ts` raises its own
 * failures as `APIError` for that reason (ADR-0055).
 *
 * WHAT IT DOES HOLD, SINCE WAVE 3, IS THE AUTH RATE-LIMIT PORT (`rate-limit.md`, "Ownership
 * and injection order": "the auth module declares the port, exactly as the redirect module
 * declares its branding port"). `main.ts` resolves the token with `app.get()` and hands the
 * implementation to `authRateLimit` on the mount, so the middleware outside the graph is
 * bound by the graph — and an unbound token fails `app.get()` at boot, which is the
 * "required, not `@Optional()`" property the contract asks for. TASK-051 rebinds the same
 * token to a Redis-backed implementation here without touching the mount.
 *
 * `LocalAuthRateLimiter` holds no connection and reads no environment at construction, so
 * compiling this module in the unit tier costs an `unref()`ed timer and nothing else.
 *
 * SINCE WAVE 4 IT ALSO HOLDS `AuthGuard`, AS `APP_GUARD` (TASK-005). Global rather than
 * per-controller so that every Nest route is guarded BY DEFAULT and a handler that forgets
 * `@Public()` answers 401, which is the safe direction (`auth-tokens.md`, "Verification").
 * `GET /health` is a Nest route too and carries `PUBLIC_ROUTE_METADATA` for that reason.
 * The guard's two collaborators are bound here by token: the process-wide `revocationStore`
 * (one instance per process — `auth.config.ts` writes to it and the guard reads it, and two
 * instances would be two maps) and `cachedKeySet` (one JWKS fetch per TTL per process).
 * Neither reads the environment at construction; the guard reads `BETTER_AUTH_URL` per
 * request, so the unit tier still compiles this module with no auth bindings set — a
 * guarded route in that tier needs them, a public one does not.
 *
 * IT DELIBERATELY IMPORTS NOTHING FROM `auth.config.ts`. That module evaluates
 * `betterAuth({ secret: betterAuthSecret(), baseURL: betterAuthUrl(), ... })` at module
 * scope, so importing it here would make every `AppModule` compile — including the ones in
 * the unit tier — require the auth bindings to be set.
 */
@Module({
  providers: [
    { provide: AUTH_RATE_LIMIT_PORT, useClass: LocalAuthRateLimiter },
    { provide: REVOCATION_STORE, useValue: revocationStore },
    { provide: JWKS_KEY_SET_SOURCE, useValue: cachedKeySet },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AUTH_RATE_LIMIT_PORT],
})
export class AuthModule {}
