/**
 * Contract: `docs/contracts/auth-config-surface.md`
 * ADR: adr-0013, adr-0046, adr-0050, adr-0051, adr-0052, adr-0053, adr-0054, adr-0055,
 *      adr-0056, adr-0057, adr-0058, adr-0059, adr-0060, adr-0061
 * Produced by: TASK-003. Consumed by: TASK-004 (the mount), item 1b (appends a hook).
 *
 * The one composed Better Auth instance in this process. Nothing else calls `betterAuth()`.
 *
 * ONE OF EXACTLY TWO FILES UNDER `apps/api/src` PERMITTED TO NAME `betterAuthDatabase`
 * (ADR-0046, ADR-0056). The other is `db/client.ts`, which defines it.
 * `db/better-auth-database-callers.spec.ts` asserts the pair by equality, and three more
 * scans beside it bound who else can reach the auth role.
 *
 * ============================================================================
 * AND `auth` ITSELF IS A SECOND HANDLE ON THAT ROLE. NO SCAN SEES IT YET (F-207).
 * ============================================================================
 *
 * `(await auth.$context).adapter` is the same `shortkit_auth` connection with a friendlier
 * API: measured by the wave-2 security pass against a live scratch database through this
 * exact file — `findMany({ model: 'session' })` returned plaintext `token` values,
 * `{ model: 'account' }` the password hashes, `{ model: 'jwks' }` the encrypted private
 * key, and `create({ model: 'session' })` FORGED a session row for another user's id with
 * an attacker-chosen token. Any module that imports `auth` from here reaches all of it with
 * none of the four scanned spellings in its own text, so all four scans stay green — and
 * this sentence deliberately does not spell that import, because the fifth scan below has
 * to be able to name this file as the one place the specifier does not appear. (Spelling a
 * banned form inside a comment is F-191's shape, and it is the scans' own rule: a text scan
 * does not distinguish code from prose, and a commented-out call is one uncomment from
 * being real.) The contract's "`betterAuthDatabase()`'s result is not re-exported, not stored on
 * a module-level binding another file can import" is satisfied to the letter and defeated
 * in substance, because THIS binding is that handle and it has to be exported for the
 * mount.
 *
 * IT IS NAMED HERE BECAUSE IT IS NOT BOUNDED ANYWHERE ELSE. The remedy is a fifth scan in
 * `db/better-auth-database-callers.spec.ts` — an equality over who may import `auth` — or
 * an entry in ADR-0056's accepted costs. Both are outside this card's write scope (a spec
 * file and a frozen ADR) and are escalated in the TASK-003 report with a measured regex and
 * permitted set. Until one lands, that spec bounds who may reach `shortkit_auth` through
 * `db/client.ts` and NOT through this module, and a reader must not read it as more.
 *
 * ============================================================================
 * EVERY KEY BELOW IS FIXED BY AN ADR, AND NINE OF THEM DEGRADE SILENTLY.
 * ============================================================================
 *
 * `auth-config-surface.md`'s table is normative on conflict and marks which nine. Each one
 * is a value the library derives from the request, from `NODE_ENV` or from a published
 * constant when the key is absent, with nothing failing anywhere — so `auth.config.spec.ts`
 * asserts them off the composed instance rather than trusting this file to be read.
 *
 * NO KEY HERE READS `NODE_ENV`. That is GC-B, and it is the rule the library itself breaks
 * inside `node_modules` for the cookie flag, the rate limiter and the secret.
 */
import { ACCESS_TOKEN_LIFETIME_SECONDS } from '@shortkit/contracts';
import { betterAuth } from 'better-auth';
import type { Auth, BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { bearer, jwt } from 'better-auth/plugins';

import { betterAuthDatabase } from '../db/client';
import { betterAuthSchema } from '../db/schema/auth';
import { errorLogFields, logger } from '../observability/logger';
import {
  SESSION_LIFETIME_SECONDS,
  betterAuthSecret,
  betterAuthUrl,
  webAppOrigins,
} from './boot-assertions';
import { createTenantForNewUser } from './on-user-created';
import { revocationStore } from './revocation-store';
import { NoTenantMembershipError, tenantIdForUser } from './tenant-id-for-user';

/** The context Better Auth hands a `hooks.before` middleware. Inferred, never restated. */
export type AuthBeforeHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * A registry entry. Better Auth takes ONE `before` function, so `auth.config.ts` iterates
 * this array inside that one function.
 *
 * A hook that does not apply to `ctx.path` returns immediately. A hook that refuses throws
 * an `APIError` and nothing else: `dist/api/dispatch.mjs:86-89` rethrows anything from a
 * before hook that is not one, and a `TypeError` there is an unauthenticated 500 generator
 * against the credential surface (ADR-0013, F-228; ADR-0055).
 *
 * `ctx.body` is UNVALIDATED at this point: probes against 1.6.26 delivered `ctx.body.email`
 * as an object, as a number, and `ctx.body` as `undefined`.
 *
 * ============================================================================
 * AND YOUR `APIError`'s MESSAGE DOES NOT GO THROUGH THE BOUND LOGGER (F-216).
 * ============================================================================
 *
 * PUT NO TOKEN, EMAIL, USER ID OR INVITATION CODE IN IT. `api/index.mjs:199` is
 * ``const log = optLogLevel === "error" || optLogLevel === "warn" || optLogLevel === "debug"
 * ? logger : void 0`` followed by `log?.error(e.message)`, and that `logger` is
 * `@better-auth/core/env`'s PACKAGE-LEVEL SINGLETON (imported at `api/index.mjs:21`), not
 * the `log` hook this file binds below. So an `APIError` a hook throws reaches `console`
 * directly: no `LOGGABLE_FIELDS`, no `serializers.err`, no `disableColors`, none of
 * ADR-0028's one censoring mechanism. `ctx.logger` on the neighbouring branches IS the
 * bound one, which is what makes this easy to read past.
 *
 * The level did not cause it and lowering it does not fix it — `error`, `warn` and `debug`
 * are all enabling values, so it was equally true before ADR-0060. Nothing leaks today only
 * because every message that reaches it is a fixed string. Item 1b's invitation-validation
 * hook is the first one that will hold a token and an address while composing a refusal.
 */
export type AuthBeforeHook = (ctx: AuthBeforeHookContext) => Promise<void>;

/**
 * ============================================================================
 * APPENDED TO. NEVER ASSIGNED. A LATER AUTHOR WHO REPLACES THIS ARRAY SILENTLY
 * DELETES EVERY EARLIER HOOK.
 * ============================================================================
 *
 * Created empty in this initiative. Item 1b's invitation-validation hook and any
 * email-keyed rate-limit hook `push` onto it (ADR-0013, F-054, F-019). The appenders land
 * after this initiative closes, so this comment is the only thing they will read.
 */
export const beforeHooks: AuthBeforeHook[] = [];

/**
 * The declared origin, read once. `baseURL`, both jwt claim keys and the cookie's `Secure`
 * flag all come from this one value, which is the redundancy ADR-0059 takes deliberately:
 * setting only `baseURL` leaves `iss` on `sign.mjs:16-20`'s per-request derivation, and
 * setting only the claims leaves the cookie flag on `NODE_ENV`.
 */
const baseUrl = betterAuthUrl();

/**
 * `403`, not `401`. The session is valid and the credential is not the problem, so telling
 * the BFF to re-authenticate sends it into a loop that cannot terminate (ADR-0055).
 */
const NO_TENANT_MEMBERSHIP_MESSAGE =
  'This account has no tenant membership, so no access token can be issued.';

/**
 * A FIXED STRING. An `APIError`'s body is rendered to the caller verbatim
 * (`better-call/dist/to-response.mjs:127-131`), so it never interpolates the caught error,
 * the email, the user id or the tenant id (ADR-0054).
 */
const TENANT_PROVISIONING_FAILED_MESSAGE =
  'Sign-up completed but tenant provisioning failed. This account cannot be used; ' +
  'contact support.';

/**
 * ============================================================================
 * THE EXPLICIT TYPE ARGUMENT IS WHAT MAKES THE CONTRACT'S `Auth` ANNOTATION COMPILE.
 * ============================================================================
 *
 * `betterAuth` is `<Options extends BetterAuthOptions>(options: Options) => Auth<Options>`,
 * and `Auth<Options>` is INVARIANT in `Options` through `$context`'s adapter — so the
 * inferred `Auth<{ database: …; secret: string; … }>` is not assignable to the contract's
 * `Auth`, which is `Auth<BetterAuthOptions>`. Pinning the parameter here keeps the exported
 * declaration exactly the shape `auth-config-surface.md` fixes, at the cost of the
 * plugin-inferred `auth.api` endpoint types. Nothing in this repository reads those: the
 * mount is `toNodeHandler(auth)`, which needs `handler` alone (ADR-0013), and TASK-005
 * reaches the jwks over HTTP.
 */
export const auth: Auth = betterAuth<BetterAuthOptions>({
  /**
   * A SECOND POOL, ON A SECOND DSN, AS A SECOND ROLE (ADR-0046, ADR-0050). Migration `0001`
   * revokes the application role on all five Better Auth tables, so the application's own
   * client cannot read `user` at all.
   *
   * `schema` is passed EXPLICITLY. Without it the adapter falls back to `db._.fullSchema`,
   * whose keys are `authUser` and `authSession` rather than `user` and `session`, and every
   * model lookup raises `BetterAuthError`.
   *
   * `transaction: false` is stated rather than inherited (ADR-0046): the adapter never
   * enters `databaseTransaction`, which is what keeps that function's enumerated caller
   * list at five.
   */
  database: drizzleAdapter(betterAuthDatabase(), {
    provider: 'pg',
    schema: betterAuthSchema,
    transaction: false,
  }),

  /**
   * SILENT. Without an explicit key, `create-context.mjs:70` is `options.secret ||
   * env.BETTER_AUTH_SECRET || env.AUTH_SECRET || ""` and then `|| DEFAULT_SECRET` — a
   * constant anyone can read out of the package, and the symmetric key for
   * `jwks.privateKey`. `validateSecret` returns early under `isTest()` and throws only
   * under `isProduction`, so the two environments this repository has are the two it does
   * not cover (F-020, ADR-0051).
   */
  secret: betterAuthSecret(),

  /** SILENT. Unset, the issuer is whatever the caller's `Host` header says (ADR-0059). */
  baseURL: baseUrl,

  /**
   * SILENT. EXTENDS the API's own origin, never replaces it
   * (`context/helpers.mjs:61-70`), which is what lets the integration tier pass with the
   * variable unset. Spread because the accessor returns a readonly list.
   */
  trustedOrigins: [...webAppOrigins()],

  advanced: {
    /**
     * SILENT, AND THE COOKIE IS A FULL CREDENTIAL THROUGH THE `bearer` PLUGIN. Derived from
     * the declared origin's SCHEME and from nothing else. Absent, `cookies/index.mjs:21`
     * falls back to `NODE_ENV === 'production'` and the measured result was
     * `better-auth.session_token` with no `Secure` and no `__Secure-` prefix (ADR-0059).
     */
    useSecureCookies: baseUrl.startsWith('https://'),

    /**
     * ============================================================================
     * SILENT, AND THE ONE ABOVE'S DEFECT ONE KEY OVER. THIS IS THE CSRF CONTROL (F-206).
     * ============================================================================
     *
     * `create-context.mjs:210` is `skipOriginCheck: options.advanced?.disableOriginCheck
     * !== undefined ? options.advanced.disableOriginCheck : isTest() ? true : false`, and
     * `@better-auth/core/dist/env/env-impl.mjs:36` is `isTest = () => nodeENV === "test" ||
     * toBoolean(env.TEST)` with `toBoolean(v) = v ? v !== "false" : false`. So with this key
     * ABSENT the origin check is decided by `NODE_ENV` — GC-B again — and by a variable
     * named `TEST` that is truthy at `0`, at `no` and at every value but the literal
     * `"false"`. Measured: `NODE_ENV=production TEST=0` answered `200` to a cross-origin
     * `POST /sign-out` that otherwise answers `403 INVALID_ORIGIN`.
     *
     * IT ALSO TURNS OFF MORE THAN CSRF. `shouldSkipOriginCheck`
     * (`api/middlewares/origin-check.mjs:20-27,45,72,105`) gates `validateURL` as well, so
     * `callbackURL`, `redirectTo`, `errorCallbackURL` and `newUserCallbackURL` go
     * unvalidated on the same switch — better-auth's open-redirect guard rides on this key.
     *
     * AND WITHOUT IT NOTHING THIS CARD SHIPS AROUND `trustedOrigins` IS EVER EXERCISED:
     * the integration fixture spawns the API at `NODE_ENV=test`, so from wave 3 every test
     * that issues a request would run with the check off. `false` here makes the suite the
     * thing that tests it — verified by the wave-2 security pass: under `NODE_ENV=test` the
     * evil origin answers 403 while the API's own origin and a `WEB_APP_ORIGINS` entry both
     * still answer 200.
     */
    disableOriginCheck: false,
  },

  /** The library's own default, stated rather than inherited (ADR-0059). */
  session: { expiresIn: SESSION_LIFETIME_SECONDS },

  /**
   * SILENT. Better Auth's own logger writes through `console`, which reaches neither
   * `LOGGABLE_FIELDS` nor `serializers.err` nor any timestamp of ours — a second log
   * channel that defeats ADR-0028's "exactly one censoring mechanism" by construction
   * rather than by defect (ADR-0052).
   *
   * `'warn'`, NOT `'error'` AND NOT `'info'` (ADR-0060). Measured: at `'error'` the bound
   * hook received zero lines, losing `create-context.mjs:64`'s unresolved-baseURL warning,
   * the short-secret warning and `rate-limiter/index.mjs:284`'s "cannot determine a client
   * IP". `'info'` puts `sign-up.mjs:168`'s email address on the stream, which GC-G forbids.
   *
   * `args` IS DROPPED. `dispatch.mjs:72` and `index.mjs:208` pass error objects
   * positionally, and spreading them into pino's first argument would put an arbitrary
   * object's enumerable properties on the line — the shape `serializers.err` exists to
   * prevent (F-244). The message crosses as `msg`, which is the field ADR-0028 already
   * treats as uncensored; this makes the dependency's lines visible to one mechanism
   * instead of none, and does not make them safe.
   *
   * ============================================================================
   * `'warn'` ADMITS THE `error` BAND, AND TWO `error` SITES CARRY CALLER BYTES (F-209).
   * ============================================================================
   *
   * ADR-0060's audited basis is "no `warn` call site in 1.6.26 interpolates a value", which
   * is true and is only half the reach of this level: `shouldPublishLog` at `'warn'` passes
   * `warn` AND `error`. `origin-check.mjs:110` is
   * ``logger.error(`Invalid origin: ${originHeader}`)`` and `:55,77` are
   * ``logger.error(`Invalid ${label}: ${url}`)`` for `callbackURL`, `redirectTo`,
   * `errorCallbackURL` and `newUserCallbackURL` — so an unauthenticated caller writes a
   * string of their choosing into `msg`, once per request, bounded only by the header limit
   * and by TASK-004's `authBodyCap`. Measured: `{"level":"error","code":"better_auth",
   * "msg":"Invalid origin: https://evil.test"}`.
   *
   * IT IS NOT TRUNCATED HERE, AND THAT IS ADR-0052'S DECISION RATHER THAN AN OVERSIGHT.
   * Its alternatives table rejects "truncate `message` in the hook to a fixed length" on
   * F-108's reasoning — a truncated attacker string is still an attacker string and the
   * length is a number nobody can justify — and names the trigger that would reverse it: a
   * log store whose cost or retention an unauthenticated caller can move. The sink today is
   * a container's stdout and CI's job log. pino JSON-escapes the message, so no line can be
   * forged; what is admitted is volume and authorship, and the bound on volume is the
   * limiter, not a substring. Reversing this is one `.slice()` and an ADR amendment, in
   * that order.
   */
  logger: {
    level: 'warn',
    disableColors: true,
    log: (level, message) => {
      logger[level]({ code: 'better_auth' }, message);
    },
  },

  /**
   * SILENT, AND ONLY IN PRODUCTION. Better Auth's limiter is on by default there
   * (`create-context.mjs:171`, `enabled: options.rateLimit?.enabled ?? isProduction`) and
   * off in development and in the test environment. Its header is `X-Retry-After` rather
   * than `Retry-After` and its body carries no `code`, so a 429 from it maps to
   * `internal_error` at the web client; it is also IP-keyed on a topology where the key
   * would be the BFF's egress address. WE ARE THE LIMITER OF RECORD (TASK-004, ADR-0013).
   */
  rateLimit: { enabled: false },

  /**
   * `enabled: true` IS NOT A DEFAULT. `sign-up.mjs:144` answers
   * `400 EMAIL_PASSWORD_SIGN_UP_DISABLED` when it is falsy, so without it there is no
   * signup at all (ADR-0061).
   *
   * `autoSignIn: false` (ADR-0061) closes the duplicate-address status-code oracle:
   * `sign-up.mjs:162` computes its generic-duplicate branch from
   * `requireEmailVerification || autoSignIn === false`, so an existing address answers 200
   * with a synthetic user instead of `422 USER_ALREADY_EXISTS`. It also stops signup handing
   * back a live session on a request whose provisioning hook may still fail (ADR-0054).
   *
   * `minPasswordLength` AND `maxPasswordLength` ARE DELIBERATELY UNSET (Juano's ruling,
   * 2026-08-16, on frozen `auth-tokens.md:99`). The library's own 8 and 128 are the policy
   * of record and `@shortkit/contracts`' `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH` equal
   * them; setting these keys is what could put the two enforcement points out of step.
   * `requireEmailVerification` is unset for the same reason — mail is out of scope, so the
   * default `false` stands.
   */
  emailAndPassword: { enabled: true, autoSignIn: false },

  plugins: [
    jwt({
      /**
       * `jwks.disablePrivateKeyEncryption` is DELIBERATELY UNSET, so the default `false`
       * stands and the stored private key stays encrypted under the secret (ADR-0057).
       */
      jwt: {
        /** SILENT, both. The plugin does not inherit them from `baseURL` (ADR-0059). */
        issuer: baseUrl,
        audience: baseUrl,

        /**
         * ============================================================================
         * A TIME-SPAN STRING. A NUMBER IS AN ABSOLUTE `exp` AND MINTS EXPIRED TOKENS.
         * ============================================================================
         *
         * SILENT, and measured twice: `utils.mjs:15-19` returns a numeric
         * `expirationTime` as the claim directly, so `expirationTime: 300` sets `exp` to
         * epoch second 300 — 1970-01-01T00:05:00Z — and every token is rejected the
         * instant it is issued. `sec('300s')` is 300, so this form is `iat + 300`.
         *
         * THE CONSTANT STAYS A NUMBER in `@shortkit/contracts`, because
         * `REVOCATION_TTL_SECONDS` derives from it and arithmetic on a string is worse.
         * The conversion happens here, at the call site (F-168, Juano's ruling).
         */
        expirationTime: `${String(ACCESS_TOKEN_LIFETIME_SECONDS)}s`,

        definePayload: definePayload,
      },

      /**
       * `GET /api/auth/token` is the only mint. Without this,
       * `dist/plugins/jwt/index.mjs:185-188` mints a token from the `/get-session`
       * after-hook and returns it as `set-auth-jwt` — a second mint path with no contract
       * row, and one that would make a membership-less account fail `get-session` as well,
       * collapsing the BFF's ability to tell a signed-out visitor from a broken account
       * (ADR-0055).
       */
      disableSettingJwtHeader: true,
    }),

    /**
     * ============================================================================
     * IT COMPLETES A CREDENTIAL THAT `GET /get-session` ALREADY HANDS OUT (F-208).
     * ============================================================================
     *
     * Measured: `GET /api/auth/get-session` answers `200 {"session":{"token":"…"},…}` with
     * the session token IN THE BODY, so the `HttpOnly` flag in `auth-config-surface.md`'s
     * cookie table protects that credential against nothing that runs on the origin — and
     * `bearer()` is what makes the read value sufficient on its own, as
     * `Authorization: Bearer <token>`, from any client, which then mints JWTs at
     * `GET /api/auth/token`.
     *
     * ACCEPTED HERE, NOT CLOSED, AND THE REASONING IS NOT "IT IS SMALL". Reaching it needs
     * script on the origin: no CORS headers are configured, so a cross-site page cannot
     * read the body. Suppressing the field means an after-hook rewriting a library
     * response shape that `auth-tokens.md` documents and TASK-008 consumes, which is a
     * contract change rather than an implementation choice — and the field is what the
     * `bearer` plugin exists to be given, so removing it there while leaving `bearer()`
     * enabled fixes a symptom of a decision rather than the decision. The owner-level
     * options are TASK-008's BFF stripping `session.token` from any proxied body, or not
     * proxying the route. Escalated to `auth-config-surface.md` in the TASK-003 report,
     * because a decision about a credential belongs in an artifact and not in whichever
     * card meets it first.
     */
    bearer(),
  ],

  databaseHooks: {
    user: { create: { after: createTenant } },
    session: { delete: { after: revokeSession } },
  },

  /**
   * ONE `before` FUNCTION, ITERATING A REGISTRY. Ordered by registration, short-circuiting
   * on a throw. The array is created empty here so that item 1b's invitation-validation
   * hook and any rate-limit hook append rather than replace (ADR-0013, F-054).
   */
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      for (const hook of beforeHooks) {
        await hook(ctx);
      }
    }),
  },
});

/**
 * The claim set, fixed by GC-D and ADR-0013.
 *
 * `jti` MUST BE RETURNED EXPLICITLY: `sign.mjs:49` reads `if (payload.jti)
 * jwt.setJti(payload.jti)`, so the claim exists only when this function puts it there — a
 * probe against 1.6.26 with this exact config returned no `jti` at all (F-227). It is the
 * SESSION id and not a per-token random, deliberately: sign-out holds a session and not a
 * token, so keying on it is what makes one revocation cover every token that session ever
 * minted. It is therefore not unique per token and must never be used for replay detection.
 *
 * `sub` IS NOT WRITTEN HERE. `sign.mjs:56-59` spreads this return and then overwrites `sub`
 * with `getSubject?.(session) ?? session.user.id`, so a `sub` line here reads as
 * load-bearing and is not.
 *
 * `tid` is what removes the guard's chicken-and-egg problem: the guard needs a tenant to
 * open a transaction, and a database lookup for it would run outside tenant context.
 */
async function definePayload({
  user,
  session,
}: {
  user: { id: string; email: string; emailVerified: boolean };
  session: { id: string };
}): Promise<Record<string, unknown>> {
  return {
    jti: session.id,
    email: user.email,
    ev: user.emailVerified,
    tid: await tenantIdForClaim(user.id),
  };
}

/**
 * AC-4's mint leg. The refusal is raised BEFORE a payload is signed, so no token is ever
 * issued carrying an absent or empty `tid` (ADR-0055).
 *
 * NOTHING ELSE IS CAUGHT. A driver failure inside the lookup is not a membership absence
 * and must not be reported as one; it falls through to the empty 500, which is the correct
 * answer for an unknown fault and is what `NoTenantMembershipError` exists as a distinct
 * class for.
 */
async function tenantIdForClaim(userId: string): Promise<string> {
  try {
    return await tenantIdForUser(userId);
  } catch (error: unknown) {
    if (error instanceof NoTenantMembershipError) {
      throw new APIError('FORBIDDEN', {
        message: NO_TENANT_MEMBERSHIP_MESSAGE,
        code: 'NO_TENANT_MEMBERSHIP',
      });
    }

    throw error;
  }
}

/**
 * Runs after the `user` row commits, on the application pool as the application role.
 *
 * IT DOES NOT SWALLOW (ADR-0054, part 2): a 200 over an account that can never obtain a
 * `tid` claim is worse than an error, because only the second is visible. The original
 * error reaches the log exactly once, here, with no message on the line — the values in
 * scope are a user id and operator-typed text and `LOGGABLE_FIELDS` has a name for neither.
 */
async function createTenant(user: { id: string; name: string }): Promise<void> {
  try {
    await createTenantForNewUser({ id: user.id, name: user.name });
  } catch (error: unknown) {
    logger.error(
      {
        code: 'tenant_provisioning_failed',
        ...errorLogFields(error, { includeMessage: false }),
      },
      'tenant provisioning failed after the user row committed',
    );

    throw new APIError('INTERNAL_SERVER_ERROR', {
      message: TENANT_PROVISIONING_FAILED_MESSAGE,
      code: 'TENANT_PROVISIONING_FAILED',
    });
  }
}

/**
 * One hook covers sign-out, `revoke-session`, `revoke-other-sessions` and delete-user:
 * `with-hooks.mjs:115-147` reads the row before deleting and passes the whole row, and
 * `deleteManyWithHooks` does the same per row.
 *
 * NO `try`/`catch` HERE, AND THAT IS THE PORT'S GUARANTEE RATHER THAN AN OMISSION:
 * `revoke` never rejects (ADR-0053), because failing a sign-out over an unavailable store
 * contradicts ADR-0012's posture.
 *
 * The TTL is the full token lifetime counted from the write. The write site holds a session
 * and not a token, so there is no `exp` to subtract from, and anything shorter lets a live
 * token outlive its own revocation entry (F-227).
 */
async function revokeSession(session: { id: string }): Promise<void> {
  await revocationStore.revoke(session.id);
}
