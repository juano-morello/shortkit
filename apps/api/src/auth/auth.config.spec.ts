import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  BETTER_AUTH_PUBLISHED_DEFAULT_SECRET,
  SESSION_LIFETIME_SECONDS,
} from './boot-assertions';

/**
 * STORY-001 — AC-5. TASK-003, wave 2.
 *
 * Contract: `docs/contracts/auth-config-surface.md` ("The composed configuration, key by
 * key", "Cookies", "What the implementer must guarantee"). ADR-0013, ADR-0051, ADR-0052,
 * ADR-0055, ADR-0059, ADR-0060, ADR-0061.
 *
 * AC-5: "Given the composed Better Auth configuration object, when a unit test reads it
 * without starting a server, then `rateLimit.enabled` is exactly `false`."
 *
 * ============================================================================
 * "WITHOUT STARTING A SERVER" IS SATISFIED, AND IT WAS MEASURED RATHER THAN ASSUMED.
 * ============================================================================
 *
 * `test-scout-wave2.md` left one item NOT VERIFIED: whether `betterAuth()`'s unawaited
 * `init()` performs network I/O as a side effect of importing this module in a process with
 * no reachable Postgres. Measured 2026-08-16 by composing the exact configuration below
 * against `DATABASE_AUTH_URL` pointed at `127.0.0.1:1`:
 *
 *   - `betterAuthDatabase()` runs synchronously at import and constructs a `pg.Pool`. The
 *     constructor opens no socket, so nothing connects.
 *   - `await auth.$context` RESOLVED IN 2 ms with no connection and no error, so the
 *     resolved cookie table and the resolved trusted-origin list are readable in this tier.
 *   - 500 ms after import, `process.on('unhandledRejection')` had fired ZERO times.
 *
 * So AC-5 is testable as written, no lazy accessor is owed, and the assertions below reach
 * past the raw option bag into what the library RESOLVED from it — which is the difference
 * between restating the config and testing it.
 *
 * ============================================================================
 * WHY THE ENV IS STUBBED AND THE IMPORT IS DYNAMIC
 * ============================================================================
 *
 * `auth.config.ts` evaluates `betterAuth({ secret: betterAuthSecret(), baseURL:
 * betterAuthUrl(), ... })` at MODULE SCOPE (`auth-config-surface.md`, "What the implementer
 * must guarantee"), so every accessor reads `process.env` the instant the module is
 * imported. A static import is hoisted above `vi.stubEnv` and would read the wrong values —
 * the same reason `src/health/health.spec.ts:62-69` imports `AppModule` dynamically. Each
 * test re-imports through `vi.resetModules()` because two of them need a different
 * `BETTER_AUTH_URL` and the module caches its instance.
 *
 * The DSN is a syntactically valid address of nothing. Nothing connects to it; it is there
 * because `authConnectionString()` (`db/client.ts:163-176`) throws on an empty value and
 * refuses to fall back to `DATABASE_URL` (ADR-0050).
 */

/** Loopback, so `boot-assertions.ts`'s `http:`-is-loopback-only rule admits it (ADR-0059). */
const BETTER_AUTH_URL_HTTP = 'http://localhost:3001';

/** The other side of the same rule: `https:` for any host. */
const BETTER_AUTH_URL_HTTPS = 'https://api.example.com';

const WEB_APP_ORIGIN = 'https://shortkit.example.com';

/**
 * Thirty-nine characters, hand-written here, and deliberately NOT
 * `BETTER_AUTH_PUBLISHED_DEFAULT_SECRET`. It clears ADR-0051's 32-character floor so the
 * accessor admits it, and it is a locally generated string of the shape ADR-0051 says is
 * fine — the disqualifying property is publication, not shape.
 */
const DECLARED_SECRET = 'wave-two-unit-fixture-secret-0a1b2c3d4';

const UNREACHABLE_AUTH_DSN = 'postgres://nobody:nothing@127.0.0.1:1/shortkit_unreachable';

interface JwtPluginOptions {
  readonly jwt?: {
    readonly issuer?: string;
    readonly audience?: string;
    readonly expirationTime?: unknown;
  };
  readonly disableSettingJwtHeader?: boolean;
}

/**
 * The composed instance, its raw option bag, and the context Better Auth resolved from it.
 *
 * `expect` inside a helper rather than a bare `throw`, so a stubbed or half-written
 * `auth.config.ts` fails as an assertion naming what is missing instead of as a `TypeError`
 * four frames into the first `expect` that dereferences it — the shape
 * `src/health/health.spec.ts`'s `expectJsonBody` already uses.
 */
async function composed(baseUrl: string): Promise<{
  readonly options: Record<string, unknown>;
  readonly context: {
    readonly authCookies: Record<string, { name: string; attributes: Record<string, unknown> }>;
    readonly trustedOrigins: readonly string[];
    readonly skipOriginCheck: unknown;
  };
  readonly jwtPlugin: JwtPluginOptions;
}> {
  vi.stubEnv('BETTER_AUTH_SECRET', DECLARED_SECRET);
  vi.stubEnv('BETTER_AUTH_URL', baseUrl);
  vi.stubEnv('WEB_APP_ORIGINS', WEB_APP_ORIGIN);
  vi.stubEnv('DATABASE_AUTH_URL', UNREACHABLE_AUTH_DSN);

  const module = (await import('./auth.config')) as { auth?: unknown };

  expect(
    module.auth,
    'auth.config.ts exports no composed Better Auth instance (`auth`)',
  ).toBeDefined();

  const auth = module.auth as {
    options: Record<string, unknown>;
    $context: Promise<{
      authCookies: Record<string, { name: string; attributes: Record<string, unknown> }>;
      trustedOrigins: readonly string[];
      skipOriginCheck: unknown;
    }>;
  };

  const plugins = (auth.options.plugins ?? []) as readonly {
    id: string;
    options?: JwtPluginOptions;
  }[];
  const jwtPlugin = plugins.find((plugin) => plugin.id === 'jwt');

  expect(jwtPlugin, 'the composed config registers no `jwt` plugin').toBeDefined();

  return {
    options: auth.options,
    context: await auth.$context,
    jwtPlugin: jwtPlugin?.options ?? {},
  };
}

/** The session-token cookie Better Auth resolved, whatever name the prefix rule gave it. */
function sessionCookie(context: {
  readonly authCookies: Record<string, { name: string; attributes: Record<string, unknown> }>;
}): { name: string; attributes: Record<string, unknown> } {
  return context.authCookies.sessionToken;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the composed Better Auth configuration', () => {
  it('AC-5: rateLimit.enabled is exactly false, read without starting a server', async () => {
    // Better Auth's own limiter is ON IN PRODUCTION BY DEFAULT and off everywhere a test or
    // a developer would meet it (`create-context.mjs:171`, `enabled: options.rateLimit
    // ?.enabled ?? isProduction`). Its header is `X-Retry-After`, its body carries no
    // `code: "rate_limited"`, and it is IP-keyed on a topology where the key is the BFF's
    // egress address — so a 429 from it maps to `internal_error` at the web client, in
    // production only. Of the Better Auth facts this design leans on it is the only one
    // that degrades silently and only there, which is why it is an AC of its own.
    //
    // Whole-key equality rather than a read of `.enabled`, so `{ enabled: false, window: … }`
    // — a limiter half-configured on the way back in — fails rather than passes.
    const { options } = await composed(BETTER_AUTH_URL_HTTP);

    expect(options.rateLimit).toEqual({ enabled: false });
  });

  it('ADR-0051: the secret is the declared binding and not the value published on npm', async () => {
    // `create-context.mjs:70` is `options.secret || env.BETTER_AUTH_SECRET ||
    // env.AUTH_SECRET || ""` and then `|| DEFAULT_SECRET`, so an ABSENT or FALSY `secret`
    // is not an override — it falls through to a constant anyone can read out of the
    // package. That constant is the symmetric key for `jwks.privateKey`, so one `jwks` row
    // plus a published string forges any `tid` claim in the product (F-020). `validateSecret`
    // returns early under `isTest()` and throws only under `isProduction`, which is
    // precisely the two environments this repository does not have.
    const { options } = await composed(BETTER_AUTH_URL_HTTP);

    expect(options.secret).toBe(DECLARED_SECRET);
  });

  it('ADR-0051: the secret is never the published default, whatever the environment holds', async () => {
    const { options } = await composed(BETTER_AUTH_URL_HTTP);

    expect(options.secret).not.toBe(BETTER_AUTH_PUBLISHED_DEFAULT_SECRET);
  });

  it('ADR-0059: baseURL is the declared BETTER_AUTH_URL, so the issuer is not the caller’s Host header', async () => {
    // `create-context.mjs:85` sets `options.baseURL` to `''` when this does not resolve and
    // `auth/base.mjs:19-27` then re-derives an origin PER REQUEST from the request itself.
    // Measured during the wave-2 security pass: one session, two `Host` values, two validly
    // signed tokens carrying different `iss`, same `kid`, both satisfying
    // `shortkitJwtClaimsContract`. The behavioural half of this is asserted over a real
    // mint in `test/auth/signup-creates-tenant.int-spec.ts`; this is the configured half.
    const { options } = await composed(BETTER_AUTH_URL_HTTPS);

    expect(options.baseURL).toBe(BETTER_AUTH_URL_HTTPS);
  });

  it('ADR-0059: the jwt plugin’s issuer is BETTER_AUTH_URL, which it does not inherit from baseURL', async () => {
    // Setting only `baseURL` leaves `iss` on `sign.mjs:16-20`'s per-request derivation:
    // the plugin computes `defaultIss` itself and does not read the resolved base URL for
    // free. Both keys are required by `auth-config-surface.md` and they are separate tests
    // because setting one and not the other is the exact half-fix the contract warns about.
    const { jwtPlugin } = await composed(BETTER_AUTH_URL_HTTPS);

    expect(jwtPlugin.jwt?.issuer).toBe(BETTER_AUTH_URL_HTTPS);
  });

  it('ADR-0059: the jwt plugin’s audience is BETTER_AUTH_URL', async () => {
    // `AuthGuard` step 4 compares `aud` against this same configured value, so a token
    // minted with a derived audience fails verification against a correct guard — or, worse,
    // passes one that compares against a derivation of its own.
    const { jwtPlugin } = await composed(BETTER_AUTH_URL_HTTPS);

    expect(jwtPlugin.jwt?.audience).toBe(BETTER_AUTH_URL_HTTPS);
  });

  it('F-168: expirationTime is a string, because a number is an absolute exp', async () => {
    // ============================================================================
    // THE TYPE *IS* THE DEFECT, WHICH IS WHY THIS IS NOT A RESTATEMENT OF THE CONFIG.
    // ============================================================================
    //
    // `dist/plugins/jwt/utils.mjs:15-19` returns a NUMERIC `expirationTime` unchanged as the
    // `exp` claim and sends only a STRING through `iat + sec(expirationTime)`. So
    // `expirationTime: ACCESS_TOKEN_LIFETIME_SECONDS` — the form
    // `packages/contracts/src/auth/index.ts` instructed until this card, and the form frozen
    // `auth-contracts.md` instructed too — sets `exp` to epoch second 300, i.e.
    // 1970-01-01T00:05:00Z. Measured twice: read at the source, then minted as a real token
    // by the wave-2 security pass, which read `exp = 300` back off it. Every token would be
    // rejected the instant it was issued and the BFF would refresh forever.
    //
    // `auth-config-surface.md` says the spec should assert the resulting `exp` and not the
    // option, and that IS where the value's correctness is proved —
    // `test/auth/signup-creates-tenant.int-spec.ts` asserts `exp - iat ===
    // ACCESS_TOKEN_LIFETIME_SECONDS` over a real mint. That test needs the wave-3 mount and
    // is red until then, so F-168 has no green proof anywhere in the meantime.
    //
    // The contract's objection was to `expirationTime === '300s'`, which pins a literal
    // nobody may change — a decision. This asserts the TYPE and neither the number nor the
    // unit, so it fails on the bug and passes on any correct duration string. Checked before
    // writing it, because "no resolved surface" is a claim and not an excuse:
    // `skipOriginCheck` above reads off `$context` because the library resolves it there,
    // and `expirationTime` has no such surface — it is consumed inside `signJWT` at mint
    // time. `sec()` cannot be called directly either: `better-auth`'s exports map has 56
    // subpaths and no wildcard, and `import('better-auth/dist/utils/time.mjs')` answers
    // ERR_MODULE_NOT_FOUND. Verified both, this session.
    const { jwtPlugin } = await composed(BETTER_AUTH_URL_HTTP);

    expect(jwtPlugin.jwt?.expirationTime).toBeTypeOf('string');
  });

  it('ADR-0055: disableSettingJwtHeader is true, so GET /token is the only mint', async () => {
    // `dist/plugins/jwt/index.mjs:185-188` mints a token from the `/get-session` after-hook
    // and returns it as `set-auth-jwt` unless this is set. Two consequences the ADR turns
    // on: a membership-less account would fail `get-session` as well as `/token`, which are
    // opposite answers and collapse the BFF's ability to tell a signed-out visitor from a
    // broken account; and a token minted as a side effect of a session read is a second
    // mint path with no contract row and no coverage.
    const { jwtPlugin } = await composed(BETTER_AUTH_URL_HTTP);

    expect(jwtPlugin.disableSettingJwtHeader).toBe(true);
  });

  it('ADR-0060: the logger level is warn, not error and not info', async () => {
    // MEASURED, and the reason it is not `'error'` is that the bound hook received ZERO
    // LINES at that level (F-175): it filtered out `create-context.mjs:64`'s warning that
    // the base URL is unset and the origin is being derived per request — the line that
    // reports two of this wave's major findings — plus the short-secret warning and
    // `rate-limiter/index.mjs:284`'s "cannot determine a client IP". `'info'` is the other
    // failure: `sign-up.mjs:168` puts an email address on the stream, which GC-G forbids.
    const { options } = await composed(BETTER_AUTH_URL_HTTP);

    expect((options.logger as { level?: unknown }).level).toBe('warn');
  });

  it('ADR-0052: a log hook is bound, so Better Auth’s console channel is not the one in use', async () => {
    // Better Auth's own `console.error`/`console.warn` bypasses the field allowlist
    // entirely, which defeats ADR-0028's "exactly one censoring mechanism" by construction
    // rather than by defect. Presence of the hook is what routes those lines into the
    // shared pino instance; what it is allowed to forward (`{ code: 'better_auth' }` and
    // the message, never `args`) is ADR-0052's and is not observable from here.
    const { options } = await composed(BETTER_AUTH_URL_HTTP);

    expect((options.logger as { log?: unknown }).log).toBeTypeOf('function');
  });

  it('ADR-0061: emailAndPassword.enabled is true, because it is not a default', async () => {
    // `sign-up.mjs:144` answers `400 EMAIL_PASSWORD_SIGN_UP_DISABLED` when this is falsy.
    // Omitting it means there is no signup at all, which is STORY-001 entire.
    const { options } = await composed(BETTER_AUTH_URL_HTTP);

    expect((options.emailAndPassword as { enabled?: unknown }).enabled).toBe(true);
  });

  it('ADR-0061: emailAndPassword.autoSignIn is false, which closes the duplicate-address status oracle', async () => {
    // `sign-up.mjs:162` computes its generic-duplicate branch from
    // `requireEmailVerification || autoSignIn === false`. With auto-sign-in ON, a duplicate
    // address answers `422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` and a fresh one answers
    // 200 — an unauthenticated enumeration oracle on a public route, with
    // `rateLimit: { enabled: false }` removing the library's own brake in the same card.
    // It also stops signup handing back a live session on a request whose provisioning hook
    // may still fail (ADR-0054). Two findings, one key.
    const { options } = await composed(BETTER_AUTH_URL_HTTP);

    expect((options.emailAndPassword as { autoSignIn?: unknown }).autoSignIn).toBe(false);
  });

  it('auth-tokens.md:99: neither password bound is set, so the library’s 8 and 128 stand', async () => {
    // Ruled by Juano 2026-08-16 against `auth-contracts.md`, which said the opposite:
    // frozen `auth-tokens.md` wins and `auth.config.ts` sets neither key.
    // `PASSWORD_MIN_LENGTH` and `PASSWORD_MAX_LENGTH` in `@shortkit/contracts` stay the
    // client-side form check and are equal to the library's own defaults
    // (`create-context.mjs:185-186`) — keeping the two enforcement points in agreement is
    // what NOT setting these achieves, and setting them is what breaks it.
    const { options } = await composed(BETTER_AUTH_URL_HTTP);
    const emailAndPassword = options.emailAndPassword as Record<string, unknown>;

    expect({
      minPasswordLength: emailAndPassword.minPasswordLength,
      maxPasswordLength: emailAndPassword.maxPasswordLength,
    }).toEqual({ minPasswordLength: undefined, maxPasswordLength: undefined });
  });

  it('ADR-0013 F-054: hooks.before is a function, so item 1b has a registry to append to', async () => {
    // Better Auth takes ONE `before` function. This design makes that function iterate
    // `beforeHooks`, so that the invitation-validation hook and any rate-limit hook APPEND
    // rather than replace — a later author who assigns the array silently deletes every
    // earlier hook. Without the key at all there is nothing for them to append to and the
    // discovery happens in a wave nobody is watching.
    const { options } = await composed(BETTER_AUTH_URL_HTTP);

    expect((options.hooks as { before?: unknown } | undefined)?.before).toBeTypeOf('function');
  });

  it('TASK-1b-09 / D-15: beforeHooks holds exactly [emailRateLimitHook, invitationValidationHook], in that order, by identity', async () => {
    // The registry is exported, and the two appenders are separate modules, so the order is
    // a fact about this file's one `push` and nothing else. The email bucket runs FIRST so an
    // attacker cannot use invitation-token probing to bypass it (ADR-0013's ordering rule).
    // Same `vi.resetModules()` cycle as `composed`, so the three modules are one instance set.
    vi.stubEnv('BETTER_AUTH_SECRET', DECLARED_SECRET);
    vi.stubEnv('BETTER_AUTH_URL', BETTER_AUTH_URL_HTTP);
    vi.stubEnv('WEB_APP_ORIGINS', WEB_APP_ORIGIN);
    vi.stubEnv('DATABASE_AUTH_URL', UNREACHABLE_AUTH_DSN);

    const [config, emailHook, invitationHook] = await Promise.all([
      import('./auth.config'),
      import('./email-rate-limit-hook'),
      import('./invitation-signup'),
    ]);

    expect(config.beforeHooks).toHaveLength(2);
    expect(config.beforeHooks[0]).toBe(emailHook.emailRateLimitHook);
    expect(config.beforeHooks[1]).toBe(invitationHook.invitationValidationHook);

    // And the after registry holds exactly the release hook, so a successful sign-in gives
    // its charge back (the bucket counts failed attempts — architect ruling, 2026-08-18).
    expect(config.afterHooks).toHaveLength(1);
    expect(config.afterHooks[0]).toBe(emailHook.emailRateLimitReleaseHook);
    expect((config.auth as { options: { hooks?: { after?: unknown } } }).options.hooks?.after).toBeTypeOf('function');
  });

  it('F-054: auth.config.ts declares beforeHooks once and never assigns it again — it pushes', () => {
    // A text rule, because the failure it guards against is silent: a later author who writes
    // `beforeHooks = [myHook]` deletes every earlier hook and every test that reads the
    // composed instance still sees "a function". The declaration is the one `=`; every other
    // mention is a `.push(` or a read.
    const source = readFileSync(fileURLToPath(new URL('./auth.config.ts', import.meta.url)), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const assignments = code.match(/\b(?:before|after)Hooks\s*=[^=]/g) ?? [];
    expect(assignments).toEqual([]);
    expect(code).toMatch(/export const beforeHooks: AuthBeforeHook\[\] = \[\];/);
    expect(code).toMatch(/beforeHooks\.push\(emailRateLimitHook, invitationValidationHook\);/);
    expect(code).toMatch(/export const afterHooks: AuthAfterHook\[\] = \[\];/);
    expect(code).toMatch(/afterHooks\.push\(emailRateLimitReleaseHook\);/);
    expect(code).not.toMatch(/(?:before|after)Hooks\.(splice|unshift|length\s*=|fill|reverse|sort)\b/);
  });

  it('TASK-1b-09: databaseHooks.user.create.after takes the endpoint context as its second argument, so the invited branch can read the body', async () => {
    const { options } = await composed(BETTER_AUTH_URL_HTTP);
    const after = (options.databaseHooks as { user?: { create?: { after?: unknown } } } | undefined)?.user?.create?.after;

    expect(after).toBeTypeOf('function');
    // `createTenant(user, ctx)`: two declared parameters. `provisionForNewUser` reads
    // `ctx?.body`; a one-parameter hook could not branch and would create a tenant for every
    // invitee (AC-1b-7's "no new tenant" would fail in the integration tier, which is where
    // the branch itself is proved).
    expect((after as (...args: unknown[]) => unknown).length).toBe(2);
  });

  it('ADR-0059: the resolved session cookie is HttpOnly, SameSite=Lax and Path=/', async () => {
    // Read off `$context.authCookies`, which is what `cookies/index.mjs:21,29-40` RESOLVED
    // from the option bag rather than what the option bag says — the cookie the browser
    // gets is one derivation away from the config and this is that derivation's output.
    // `maxAge` pins `session.expiresIn`: the session credential's own lifetime, stated
    // rather than inherited, and the number `sk_rt`'s 2592000 in `auth-tokens.md` outlives
    // by 23 days (escalated, not this card's).
    const { context } = await composed(BETTER_AUTH_URL_HTTP);

    expect(sessionCookie(context).attributes).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_LIFETIME_SECONDS,
    });
  });

  it('ADR-0059: an https base URL resolves a Secure, __Secure-prefixed session cookie', async () => {
    // ============================================================================
    // THIS TEST AND THE NEXT ARE A PAIR, AND THE PAIR IS THE WHOLE ASSERTION.
    // ============================================================================
    //
    // `advanced.useSecureCookies` must derive from the declared origin's SCHEME and from
    // nothing else (GC-B). An implementation that reads `NODE_ENV === 'production'` — which
    // is what the library itself does when the key is absent (`cookies/index.mjs:21`) —
    // answers `false` for BOTH cases in this tier, where `NODE_ENV` is `test`. So this test
    // is the one that fails on that defect and the next one alone cannot see it.
    //
    // The name matters as much as the flag: `useSecureCookies` also drives the `__Secure-`
    // prefix (`cookies/index.mjs:20,30`), and that cookie is a full credential through the
    // `bearer` plugin.
    const { context } = await composed(BETTER_AUTH_URL_HTTPS);
    const cookie = sessionCookie(context);

    expect({ name: cookie.name, secure: cookie.attributes.secure }).toEqual({
      name: '__Secure-better-auth.session_token',
      secure: true,
    });
  });

  it('ADR-0059: an http loopback base URL resolves a cookie with no Secure flag and no prefix', async () => {
    // The other half of the pair above. `http://localhost:3001` is the compose default and
    // is the origin the integration tier runs on, so this is not a hypothetical: a
    // `useSecureCookies: true` hardcoded to make the previous test pass would break every
    // local session, and this is what says so.
    const { context } = await composed(BETTER_AUTH_URL_HTTP);
    const cookie = sessionCookie(context);

    expect({ name: cookie.name, secure: cookie.attributes.secure }).toEqual({
      name: 'better-auth.session_token',
      secure: false,
    });
  });

  it('F-206: the origin check is on, and does not follow NODE_ENV or a TEST variable', async () => {
    // ============================================================================
    // OFF THE RESOLVED VALUE, NEVER THE OPTION, AND IN THIS TIER THAT IS THE WHOLE TEST.
    // ============================================================================
    //
    // `create-context.mjs:210` is `skipOriginCheck: options.advanced?.disableOriginCheck
    // !== undefined ? options.advanced.disableOriginCheck : isTest() ? true : false`, and
    // `@better-auth/core/dist/env/env-impl.mjs:36` is `isTest = () => nodeENV === "test" ||
    // toBoolean(env.TEST)` with `toBoolean(v) = v ? v !== "false" : false`. So an UNSET key
    // turns better-auth's CSRF origin check off in every test — and `TEST=0` turns it off in
    // production, because `"0" !== "false"`.
    //
    // MEASURED BEFORE THIS ASSERTION WAS WRITTEN, because a check that cannot fail is this
    // wave's signature defect. Composed three ways in this tier, where vitest sets BOTH
    // halves of the predicate live (`NODE_ENV=test`, `TEST=true`):
    //
    //     advanced: { disableOriginCheck: false }  →  skipOriginCheck = false
    //     advanced: {}                             →  skipOriginCheck = true
    //     no `advanced` key at all                 →  skipOriginCheck = true
    //
    // So deleting the key from `auth.config.ts` fails this test right here. Reading
    // `options.advanced.disableOriginCheck` instead would assert the input to that ternary
    // and never its output, which is the same class of mistake as asserting
    // `expirationTime === '300s'` rather than the `exp` it produces.
    const { context } = await composed(BETTER_AUTH_URL_HTTP);

    expect(context.skipOriginCheck).toBe(false);
  });

  it('auth-tokens.md:146-149: trustedOrigins extends the API’s own origin, never replaces it', async () => {
    // `context/helpers.mjs:74-77` resolves the list to `[new URL(baseURL).origin,
    // ...webAppOrigins]`. Asserted on the RESOLVED list rather than on the option, because
    // the property that matters is that the API's own origin survives whatever
    // `WEB_APP_ORIGINS` contains — which is what lets the integration suite pass with the
    // variable unset, and what a `trustedOrigins` built by overwriting would lose.
    const { context } = await composed(BETTER_AUTH_URL_HTTPS);

    expect([...context.trustedOrigins].sort()).toEqual(
      [BETTER_AUTH_URL_HTTPS, WEB_APP_ORIGIN].sort(),
    );
  });
});
