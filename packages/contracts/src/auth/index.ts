/**
 * Contract: docs/contracts/auth-contracts.md
 * ADR: adr-0047-password-policy.md, adr-0013-better-auth-in-nestjs.md,
 *      adr-0005-contract-distribution.md
 * Produced by: TASK-001
 *
 * BETTER AUTH OWNS THE TWO ENDPOINTS THESE DESCRIBE. `/api/auth/sign-up/email` and
 * `/api/auth/sign-in/email` are handled by a node handler mounted ahead of Nest
 * (ADR-0013, GC-C), so no Nest pipe validates against these schemas and nothing in
 * `apps/api` parses a request body with them. They state what the client sends and what
 * it may rely on receiving.
 *
 * THIS PACKAGE MAY IMPORT `zod` AND NOTHING ELSE (ADR-0005).
 *
 * Every schema here has identical input and output types. None uses `.transform()`:
 * `apps/web` builds request bodies from these types and parses responses into them.
 */
import { z } from 'zod';

import { NAME_CONTROL_CHARACTERS_MESSAGE, containsControlCharacter } from '../workspaces';

/**
 * ADR-0047. Better Auth's own floor and ceiling, adopted deliberately rather than
 * inherited from `dist/context/create-context.mjs:185-186`'s `|| 8` and `|| 128`.
 *
 * `auth.config.ts` reads these two constants into `emailAndPassword.minPasswordLength`
 * and `.maxPasswordLength`, so the two enforcement points cannot disagree about the
 * number. BETTER AUTH IS THE ENFORCER OF RECORD; the zod bound is a form check that
 * happens to run on both sides of the wire.
 *
 * 128 is a real bound. `authBodyCap` admits 32 KB and password hashing is deliberately
 * expensive, so without a ceiling a caller could submit a 32 KB password and spend the
 * API's CPU rather than its own. Better Auth checks the length before it hashes.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Added 2026-08-19 (debt sweep, ledger 1b-W1-09): the signup name gains a ceiling. The
 * field had a floor (`min(1)`) and no ceiling; 200 characters is generous for a person's
 * name and stops a 32 KB one riding the auth body cap into `user.name` — and from there,
 * verbatim, into `tenants.name` (`on-user-created.ts`, F-198). Same shape as the password
 * bounds: a constant here, asserted through the parse in `auth.spec.ts`.
 */
export const SIGNUP_NAME_MAX_LENGTH = 200;

/**
 * `name` is REQUIRED. `better-auth@1.6.26` answers 400 to a sign-up body without it —
 * measured, and recorded at `apps/api/test/support/auth-fixture.ts:56-60`.
 *
 * Added 2026-08-19 (debt sweep, ledger 1b-W1-09): control characters are refused, with the
 * rule and fixed message `../workspaces` exports for every name field. THIS FIELD IS ALSO
 * THE TENANT NAME — `on-user-created.ts` copies `user.name` verbatim into `tenants.name`
 * (F-198, Juano's ruling) — so the refusal covers the ledger's "workspace and TENANT
 * names" both. Honest limit of the change: Better Auth is the wire enforcer for this
 * endpoint and validates neither bound (no Nest pipe parses this schema, see the file
 * header), so a direct HTTP signup can still plant a control character or a long name;
 * this contract refuses it everywhere the repository parses — the web form
 * (`credential-form.tsx`) before submit, and any future server-side reader. No trim, on
 * purpose: Better Auth stores the field as sent, and a contract that trims would state a
 * shape the wire does not have.
 */
export const signUpRequestContract = z.object({
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  name: z
    .string()
    .min(1)
    .max(SIGNUP_NAME_MAX_LENGTH)
    .refine((name) => !containsControlCharacter(name), NAME_CONTROL_CHARACTERS_MESSAGE),
});

export type SignUpRequest = z.infer<typeof signUpRequestContract>;

/**
 * SIGN-IN DOES NOT APPLY THE LENGTH BOUNDS, AND THAT IS DELIBERATE. A floor raised later
 * would otherwise lock out every account created under the old one, and the check would
 * reject a correct password with a validation error rather than an authentication one.
 */
export const signInRequestContract = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type SignInRequest = z.infer<typeof signInRequestContract>;

/**
 * The `user` object both endpoints return, after `parseUserOutput`.
 *
 * `id` is `z.string()` and NOT a uuid: Better Auth generates its own ids. That is the
 * same fact that makes `tenant_memberships.user_id` a `text` column (ADR-0015).
 *
 * `createdAt` and `updatedAt` are ISO strings because they crossed JSON. In the database
 * they are `timestamptz` (docs/contracts/auth-schema.md).
 */
export const authUserContract = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().email(),
  emailVerified: z.boolean(),
  image: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AuthUser = z.infer<typeof authUserContract>;

/**
 * What a successful sign-up or sign-in returns.
 * `dist/api/routes/sign-up.mjs:252-265`, `dist/api/routes/sign-in.mjs:336-341`.
 *
 * `token` IS THE BETTER AUTH SESSION TOKEN, NOT A JWT, AND IT IS THE CREDENTIAL. It must
 * never be logged, never be rendered, and never leave the server side of `apps/web`
 * (ADR-0014, GC-G). It is nullable because sign-up returns `token: null` when auto
 * sign-in is disabled.
 *
 * A PLAIN `z.object`, DELIBERATELY NOT `.strict()`. Sign-in additionally returns
 * `redirect` and `url`, which this repository does not use; zod strips them. Making this
 * strict would fail every sign-in the day Better Auth adds a field.
 */
export const authSessionContract = z.object({
  token: z.string().nullable(),
  user: authUserContract,
});

export type AuthSession = z.infer<typeof authSessionContract>;

/**
 * The claim set, fixed by ADR-0013 and GC-D. `AuthGuard` reads it with no database query.
 *
 * THREE THINGS A LATER READER MUST NOT RE-DERIVE:
 *
 * 1. `jti` IS THE BETTER AUTH SESSION ID AND IS NOT UNIQUE PER TOKEN. It is the
 *    revocation handle. A random per-token `jti` cannot be revoked by sign-out, which
 *    holds a session and not a token (F-227). Nothing here uses it for replay detection,
 *    and a change that needs that adds `sid` and moves revocation onto it.
 * 2. `sub` IS NOT WRITTEN BY `definePayload`. `dist/plugins/jwt/sign.mjs:53-61` spreads
 *    the payload and then overwrites `sub` with `getSubject?.(session) ?? user.id`.
 *    Writing it in `definePayload` has no effect.
 * 3. `aud` IS A SINGLE STRING, not an array. `sign.mjs:45` calls `setAudience` with one
 *    value.
 */
export const shortkitJwtClaimsContract = z.object({
  sub: z.string().min(1),
  tid: z.string().uuid(),
  email: z.string().email(),
  ev: z.boolean(),
  jti: z.string().min(1),
  exp: z.number().int(),
  iat: z.number().int(),
  iss: z.string().min(1),
  aud: z.string().min(1),
});

export type ShortkitJwtClaims = z.infer<typeof shortkitJwtClaimsContract>;

/**
 * ADR-0013 fixes 300 seconds, and the revocation TTL is the same number, declared here once.
 *
 * ============================================================================
 * THE VALUE IS A NUMBER HERE AND THE CALL SITE CONVERTS IT TO A TIME-SPAN STRING.
 * ============================================================================
 *
 * `auth.config.ts` writes `` expirationTime: `${String(ACCESS_TOKEN_LIFETIME_SECONDS)}s` ``.
 * Corrected 2026-08-16 (F-168, Juano's ruling): this docblock instructed the BARE NUMBER,
 * which is a defect. `dist/plugins/jwt/utils.mjs:15-19` returns a numeric `expirationTime`
 * as the `exp` claim UNCHANGED, so `expirationTime: 300` sets `exp` to epoch second 300 —
 * 1970-01-01T00:05:00Z — and every token is rejected the instant it is issued. Only a
 * string goes through `iat + sec(expirationTime)`, and `sec('300s')` is 300. Measured
 * twice: at the source, and on a real token minted with this exact configuration.
 *
 * It stays a NUMBER here rather than becoming `'300s'`, because `REVOCATION_TTL_SECONDS`
 * derives from it and arithmetic on a string is worse than one conversion at the one call
 * site that needs the other form.
 */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 300;
