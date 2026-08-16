/**
 * Contract: `.sdlc/identity-membership/design/contracts/auth-config-surface.md`
 * ADR: adr-0058-better-auth-secret-assertion-shape.md, adr-0059, adr-0051, adr-0050
 * Produced by: TASK-003 (this file and the three bindings). Extended by: TASK-004, wave 3.
 *
 * ============================================================================
 * THIS FILE MUST NOT IMPORT `auth.config.ts`. THE DEPENDENCY RUNS THE OTHER WAY.
 * ============================================================================
 *
 * `auth.config.ts` evaluates `betterAuth({ secret: betterAuthSecret(), baseURL:
 * betterAuthUrl(), ... })` at module scope. If this file imported it, `main.ts`'s import of
 * the assertions would evaluate the whole auth config first, an accessor would throw during
 * module evaluation, and the throw would land before `bootstrap()` runs and before any
 * boot-precondition wording reaches the log (ADR-0058).
 *
 * TASK-004 adds `assertTrustedClientIpHeaderConfigured`, `assertBffProxySecretConfigured`
 * and `assertAuthRoleSeparation` here in wave 3. None of them may import `auth.config.ts`
 * either, and `assertAuthRoleSeparation` reaches its pool through `db/client.ts`.
 *
 * NONE OF THESE READS `NODE_ENV`. That is GC-B, and it is the rule better-auth's own
 * `validateSecret` and its cookie-secure fallback both break inside `node_modules`, where
 * this repository's lint cannot reach them (ADR-0051, ADR-0059).
 */

/**
 * `better-auth@1.6.26`'s published fallback, `dist/utils/constants.mjs:2`, reached by the
 * `||` chain at `dist/context/create-context.mjs:70` and `:78` when nothing is configured.
 * Thirty-nine characters, so it clears the length floor. Rejected by exact value.
 */
export const BETTER_AUTH_PUBLISHED_DEFAULT_SECRET = 'better-auth-secret-12345678901234567890';

/** ADR-0051 promotes better-auth's `length < 32` warning to a refusal. */
export const BETTER_AUTH_SECRET_MIN_LENGTH = 32;

/** The session credential's lifetime. Stated rather than inherited (ADR-0059). */
export const SESSION_LIFETIME_SECONDS = 604_800;

/**
 * Raised by EVERY accessor and assertion in this file.
 *
 * One class across three bindings so `main.ts` reports the same `boot_precondition`
 * whichever path fired. From wave 3 the accessors win the race: `main.ts` imports
 * `auth.config.ts` for the mount, so a module-scope accessor throws before
 * `assertBootPreconditions()` is called and the assertion never executes (ADR-0058).
 *
 * NEVER CARRIES A VALUE, A PREFIX OF ONE, OR A LENGTH. It names the rule that was broken.
 * The secret is not in `LOGGABLE_FIELDS` and no field name is added for it, unlike
 * ADR-0045's user-id prefix where the value is not a credential.
 */
export class AuthBindingError extends Error {
  readonly binding: 'better_auth_secret' | 'better_auth_url' | 'web_app_origins';

  constructor(binding: AuthBindingError['binding'], message: string) {
    super(message);
    this.name = 'AuthBindingError';
    this.binding = binding;
  }
}

/**
 * The declared BETTER_AUTH_SECRET binding.
 *
 * THROWS `AuthBindingError` when the variable is unset, empty, shorter than 32 characters,
 * or equal to the library's published default. Three rejections, not four: TASK-019 removed
 * this repository's compose default from `docker-compose.yml` in wave 1, so F-144's
 * conditional fourth rejection has no referent (ADR-0058).
 *
 * It never returns `undefined` and never returns ''. `options.secret` is the FIRST OPERAND
 * OF A `||` CHAIN, not an override (`create-context.mjs:70`). A falsy return falls straight
 * through to `env.BETTER_AUTH_SECRET`, then `env.AUTH_SECRET`, then the published constant,
 * which is the symmetric key for `jwks.privateKey`.
 *
 * Reads `process.env` directly rather than taking an env argument, because its one caller is
 * `betterAuth({ secret: betterAuthSecret() })` at module scope where there is nothing to
 * thread one from. The assertions take `env` to match TASK-004's siblings.
 */
export function betterAuthSecret(): string {
  throw new Error('not implemented');
}

/**
 * The declared BETTER_AUTH_URL binding: the origin this API issues and verifies tokens for.
 *
 * THROWS `AuthBindingError` when unset, empty, unparseable, of a scheme other than `http:`
 * or `https:`, or carrying a path, query or fragment. Returns
 * `new URL(value).origin`, so a trailing slash is normalised rather than refused.
 *
 * ============================================================================
 * THIS IS NOT COSMETIC. UNSET, THE ISSUER IS WHATEVER THE CALLER'S HOST HEADER SAYS.
 * ============================================================================
 *
 * `create-context.mjs:85` sets `options.baseURL` to `''` when this does not resolve, and
 * `auth/base.mjs:19-27` then re-derives a base URL per request from the request itself.
 * `sign.mjs:16-20` computes `defaultIss` and `defaultAud` from that. Measured: the same
 * session cookie with `Host: evil.test` minted a valid token carrying
 * `iss="http://evil.test"`. It also decides the session cookie's `Secure` flag, which
 * otherwise falls back to `NODE_ENV === 'production'` (`cookies/index.mjs:21`). ADR-0059.
 *
 * ============================================================================
 * AND ONE RULE ABOUT THE HOST: `http:` IS LOOPBACK-ONLY.
 * ============================================================================
 *
 *   `https:` — any host.
 *   `http:`  — ONLY `localhost`, an address in `127.0.0.0/8`, or `[::1]`.
 *
 * Without it this binding permits the state it exists to close. Measured:
 * `BETTER_AUTH_URL=http://api.example.com` yields `better-auth.session_token` with
 * `secure: false` and no `__Secure-` prefix, WITH EVERY ASSERTION GREEN, because a value is
 * set. `advanced.useSecureCookies` is derived from this one string, so nothing else catches
 * it. The compose default is `http://localhost:3001`, and an operator who copies it to a real
 * host keeps the scheme; this rule is what turns that copy into a boot refusal.
 *
 * IT READS NO `NODE_ENV`. The discriminator is the host in the declared value. GC-B holds.
 *
 * It is a STRING test, not a resolution test: a hostname resolving to 127.0.0.1 is refused
 * under `http:`, and so is a TLS-terminating proxy speaking http to a non-loopback backend.
 * The correct value there is the PUBLIC `https:` origin, because that is what the browser
 * sees and what `iss`, `aud` and the cookie's `Secure` flag must describe.
 */
export function betterAuthUrl(): string {
  throw new Error('not implemented');
}

/**
 * The declared WEB_APP_ORIGINS binding: every origin the dashboard is served from.
 *
 * Comma-separated. Entries are trimmed and empty ones dropped. **Returns `[]` when the
 * variable is unset, which is legal**: the resolved trusted list always contains the API's
 * own origin (`context/helpers.mjs:61-70`), which is what lets the integration tier pass
 * with the variable unset. An unset value costs a local developer a `403 INVALID_ORIGIN` on
 * the login screen and costs the suite nothing.
 *
 * THROWS `AuthBindingError` when an entry does not parse as an origin, or when it breaks
 * either wildcard rule below. `matchesOriginPattern` (`auth/trusted-origins.mjs:18-23`)
 * treats a pattern containing a metacharacter and no `://` as a wildcard over the HOST, so a
 * bare `*` trusts every origin on the internet with no error anywhere. That value is exactly
 * what an implementer reaches for when every local login answers 403, which is why this
 * refuses rather than warns (ADR-0059).
 *
 * ============================================================================
 * THE METACHARACTERS ARE `*` AND `?`. BOTH. TWO RULES, NOT ONE.
 * ============================================================================
 *
 * `trusted-origins.mjs:18` enters wildcard mode on `*` OR `?`, and `?` matches a single
 * character: measured, `https://app.example.co?` trusts `https://app.example.com`.
 *
 *   1. NO HOST LABEL MAY BE ENTIRELY METACHARACTERS.
 *      Refuses `*`, `https://*`, `https://*.vercel.app`, `https://?.example.com`.
 *   2. NO METACHARACTER IN THE FINAL TWO LABELS, so the registrable domain is literal.
 *      Refuses `https://shortkit-*.app`, `https://app.example.co?`.
 *
 * `https://shortkit-*.vercel.app` passes both and is the preview form `auth-tokens.md:158-162`
 * documents. `https://*.vercel.app` is REFUSED, because that contract rules exactly that
 * entry out by name: "it trusts every application on the platform". Measured: it matches
 * `https://evil.vercel.app`, and end-to-end it let a cross-origin sign-up through with 200.
 * The unit test refuses it BY NAME, not only the bare `*`.
 *
 * Rule 2 approximates "the registrable domain" and is unsound under a multi-label public
 * suffix: `https://ex*.co.uk` passes and should not. Closing that needs a public-suffix list,
 * which is a dependency and a data file that goes stale, for a case this repository does not
 * have. Stated rather than closed.
 */
export function webAppOrigins(): readonly string[] {
  throw new Error('not implemented');
}

/**
 * The boot half of the secret rule. Same three rejections, same predicate, same error class.
 *
 * Needs no database, so it carries none of precondition 2's machinery: no retry budget, no
 * backoff, no verdict prefix (ADR-0058). A `process.env` read always answers, so the
 * distinction between "could not answer" and "answered unsafely" that `RLS_VERDICT_PREFIX`
 * exists to draw has nothing to separate here.
 *
 * The duplication with the accessor is deliberate (ADR-0051): an accessor that trusts a boot
 * assertion is unsafe in a unit test, a script or a worker that never ran one. One shared
 * predicate in this module is what keeps the two from disagreeing.
 */
export function assertBetterAuthSecretConfigured(_env: NodeJS.ProcessEnv): void {
  throw new Error('not implemented');
}

/** The boot half of the URL rule. Same predicate as `betterAuthUrl()` (ADR-0059). */
export function assertBetterAuthUrlConfigured(_env: NodeJS.ProcessEnv): void {
  throw new Error('not implemented');
}

/**
 * The boot half of the origins rule. Same predicate as `webAppOrigins()` (ADR-0059).
 *
 * A boot assertion and not only a unit test: the unit test proves the composed config is
 * right in CI, and the wildcard that clears a developer's 403 is written in a shell or an
 * env file that no test reads.
 */
export function assertWebAppOriginsConfigured(_env: NodeJS.ProcessEnv): void {
  throw new Error('not implemented');
}
