/**
 * Contract: `docs/contracts/invitation-tokens.md` ("The invited-signup branch uses the same
 *           entry point"), `docs/contracts/auth-config-surface.md` (the `hooks.before` and
 *           `databaseHooks.user.create.after` rows; invariants 3, 4, 5; error cases),
 *           `docs/contracts/auth-tokens.md` (the signup body `{ email, password, name,
 *           invitationToken? }`)
 * ADR: adr-0015 (invited signup does not create a tenant), adr-0021 (the token is the
 *      capability; the tenant id comes from the verified row), adr-0013 (the registry;
 *      F-228), adr-0054 (residue), adr-0055 (an `APIError` and nothing else), adr-0029 /
 *      F-216 (fixed messages), D-01 (the link is the capability), D-18
 * Produced by: TASK-1b-09 (item 1b, wave 3). `invitationValidationHook` is appended SECOND to
 *              `beforeHooks` by `auth.config.ts`; `provisionForNewUser` is what
 *              `databaseHooks.user.create.after` calls.
 *
 * ============================================================================
 * THE SINGLE ANONYMOUS PATH THAT WRITES `tenant_memberships` (ADR-0021, ADR-0015).
 * ============================================================================
 *
 * Both halves run in the child process, inside Better Auth's handler, OUTSIDE the Nest
 * graph: route enumeration cannot see them and nothing can be injected into them, which is
 * why they call the two plain functions of `invitations/capability-lookup.ts` — the only two
 * that may open a tenant transaction from a token (GC-L, D-17) — and never parse a token
 * themselves.
 *
 *   hooks.before, `/sign-up/email`, when the body carries a string `invitationToken`:
 *     `findInvitationByCapabilityToken(token)`. `null` (malformed, unknown, wrong-tenant —
 *     one answer, ADR-0021) → 404 `INVITATION_NOT_FOUND`. Expired / revoked / accepted →
 *     410 / 410 / 409. NO USER IS CREATED: `databaseHooks.user.create.after` cannot roll back
 *     the insert that triggered it, so a refusal there would leave a `user` row behind.
 *
 *   databaseHooks.user.create.after (`provisionForNewUser`), the same predicate:
 *     token → `acceptInvitationByCapabilityToken(token, { userId, tenantMembership:
 *     'create' })`, which re-verifies the digest, consumes the token, writes the named
 *     `memberships` rows and the `tenant_memberships` row at `INVITEE_TENANT_ROLE`, in ONE
 *     transaction, and takes the tenant id FROM THE VERIFIED ROW (GC-E) — no `tenants` row is
 *     written. No token → `createTenantForNewUser(user)`, the uninvited branch.
 *
 * ============================================================================
 * ONE PREDICATE FOR BOTH HOOKS, SO THEY CANNOT DISAGREE ABOUT WHETHER A SIGNUP IS INVITED.
 * ============================================================================
 *
 * `invitationTokenFrom(body)` is the one function that decides. A non-empty string is a
 * token; an object, a number, an empty string, `null`, an absent key, an absent body are all
 * "not invited" — for the before hook (nothing to validate, the signup is uninvited) AND for
 * the after hook (a tenant is created). If the two used different readings, a body the
 * before hook let through unvalidated could reach the accept function, or a validated token
 * could be ignored and a tenant created for an invitee (AC-1b-10).
 *
 * The after hook receives the endpoint context: `with-hooks.mjs` reads
 * `getCurrentAuthContext()` (an `AsyncLocalStorage` scoped to the request) and passes it as
 * the second argument, so `ctx.body` is the same parsed body the before hook saw. No
 * per-request stash is kept anywhere in this process; the mechanism is the framework's own
 * request context, verified by `test/auth/signup-invited.int-spec.ts` against the child.
 *
 * ============================================================================
 * `ctx.body` IS UNVALIDATED (F-228), THE HOOK THROWS `APIError` AND NOTHING ELSE (ADR-0055),
 * AND EVERY MESSAGE IS A FIXED CONSTANT (F-216, GC-K).
 * ============================================================================
 *
 * `hooks.before` runs ahead of the endpoint's zod validation, so `invitationTokenFrom` accepts
 * `unknown` and never throws. Anything the lookup throws that is not one of the four
 * invitation states is caught, logged ONCE through the bound logger with
 * `errorLogFields(error, { includeMessage: false })` (GC-G: the values in scope are a token
 * and an address, and `LOGGABLE_FIELDS` names neither), and rethrown as
 * `500 INVITATION_LOOKUP_FAILED` — because `dispatch.mjs:86-89` rethrows a non-`APIError`
 * as a body-less 500 that skips every later hook. And an `APIError`'s message reaches
 * `console` through better-auth's package-level logger, past the pino allowlist (F-216), so
 * every message below is a constant that contains no token, address, tenant id, user id or
 * invitation id. `test/auth/signup-invited.int-spec.ts` scans the child's captured bytes for
 * the token and the invited address on every refusal.
 *
 * ============================================================================
 * D-01: THE LINK IS THE CAPABILITY. NO ADDRESS COMPARISON HERE.
 * ============================================================================
 *
 * Ruled by Juano 2026-08-18: any address may sign up with a valid token; `invitations.email`
 * is the mail recipient and a prefill. Nothing in this module reads the row's `email`.
 *
 * Failure of the accept AFTER the `user` row committed is ADR-0054's residue — a `user` row
 * with no `tenant_memberships` row, which cannot obtain a `tid` claim — and `auth.config.ts`
 * turns it into `500 TENANT_PROVISIONING_FAILED` exactly as it does for the uninvited branch.
 * The invitation stays `pending` (the accept transaction rolled back), so the person can
 * retry from a different address; the orphaned `user` row is the accepted cost (ADR-0015).
 */
import { APIError } from 'better-auth/api';

import { acceptInvitationByCapabilityToken, findInvitationByCapabilityToken } from '../invitations/capability-lookup';
import {
  InvitationAlreadyAcceptedError,
  InvitationExpiredError,
  InvitationRevokedError,
} from '../invitations/errors';
import { errorLogFields, logger } from '../observability/logger';
import type { AuthBeforeHook } from './before-hook';
import { createTenantForNewUser } from './on-user-created';

/**
 * The base-path-relative endpoint path Better Auth reports on `ctx.path` for
 * `POST /api/auth/sign-up/email`. Pinned by the integration test the same way the sign-in
 * path is (F-025 b): a wrong literal here is a hook that never validates.
 */
export const SIGN_UP_EMAIL_PATH = '/sign-up/email';

/** The body key `auth-tokens.md` fixes for the token: `{ email, password, name, invitationToken? }`. */
export const INVITATION_TOKEN_BODY_KEY = 'invitationToken';

// ----------------------------------------------------------------------------
// FIXED MESSAGES. Every one reaches `console` uncensored (F-216) and the response body
// verbatim. None names a value.
// ----------------------------------------------------------------------------

export const INVITATION_NOT_FOUND_MESSAGE = 'Invitation not found.';
export const INVITATION_EXPIRED_MESSAGE = 'This invitation has expired.';
export const INVITATION_REVOKED_MESSAGE = 'This invitation has been revoked.';
export const INVITATION_ALREADY_ACCEPTED_MESSAGE = 'This invitation has already been accepted.';
export const INVITATION_LOOKUP_FAILED_MESSAGE =
  'The invitation could not be verified. Try again shortly.';

/**
 * The `code` values on the refusals. The web's `mapBetterAuthError` maps them onto
 * `not_found`, `invitation_expired`, `invitation_revoked`, `invitation_already_accepted` and
 * `internal_error` (TASK-1b-12); the statuses here are `ERROR_CODE_STATUS` of those codes.
 */
export const INVITATION_HOOK_CODES = {
  notFound: 'INVITATION_NOT_FOUND',
  expired: 'INVITATION_EXPIRED',
  revoked: 'INVITATION_REVOKED',
  alreadyAccepted: 'INVITATION_ALREADY_ACCEPTED',
  lookupFailed: 'INVITATION_LOOKUP_FAILED',
} as const;

/**
 * THE ONE PREDICATE. A non-empty string under `invitationToken` is the token; anything else
 * — an object, a number, an empty string, `null`, an absent key, a non-object body — is
 * `undefined`, "not invited". Accepts `unknown` and NEVER THROWS (F-228).
 *
 * Nothing is trimmed or otherwise repaired: the token is a bearer credential compared by
 * digest, and a string with stray whitespace is simply one that `findInvitationByCapabilityToken`
 * answers `null` for.
 */
export function invitationTokenFrom(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const candidate: unknown = (body as Record<string, unknown>)[INVITATION_TOKEN_BODY_KEY];

  return typeof candidate === 'string' && candidate !== '' ? candidate : undefined;
}

/**
 * The second entry of `beforeHooks`. Applies to `/sign-up/email` with a string
 * `invitationToken` only; a signup without one is untouched. Verifies the token through the
 * sanctioned lookup and refuses — with an `APIError` and nothing else — so that no `user` row
 * is created for a token that would not accept.
 */
export const invitationValidationHook: AuthBeforeHook = async (ctx) => {
  if (ctx.path !== SIGN_UP_EMAIL_PATH) {
    return;
  }

  const token = invitationTokenFrom(ctx.body);

  if (token === undefined) {
    return;
  }

  let verified: Awaited<ReturnType<typeof findInvitationByCapabilityToken>>;

  try {
    verified = await findInvitationByCapabilityToken(token);
  } catch (error: unknown) {
    throw refusalFor(error);
  }

  if (verified === null) {
    throw new APIError('NOT_FOUND', {
      code: INVITATION_HOOK_CODES.notFound,
      message: INVITATION_NOT_FOUND_MESSAGE,
    });
  }
};

/**
 * What `databaseHooks.user.create.after` runs. Same predicate as the before hook: a token
 * → the invited branch, which consumes it and writes the memberships in the inviter's
 * tenant and creates NO tenant (ADR-0015); no token → `createTenantForNewUser`.
 *
 * Rejections propagate verbatim (ADR-0054 part 2: the hook does not swallow); `auth.config.ts`
 * is where either branch's failure becomes `500 TENANT_PROVISIONING_FAILED` and is logged
 * once, with no message on the line.
 */
export async function provisionForNewUser(
  user: { readonly id: string; readonly name: string },
  ctx: { readonly body?: unknown } | null | undefined,
): Promise<void> {
  const token = invitationTokenFrom(ctx?.body);

  if (token === undefined) {
    await createTenantForNewUser({ id: user.id, name: user.name });
    return;
  }

  await acceptInvitationByCapabilityToken(token, { userId: user.id, tenantMembership: 'create' });
}

/**
 * The four state errors become the four codes; anything else is logged once (name and stack,
 * never the message — GC-G) and becomes `500 INVITATION_LOOKUP_FAILED`, so the request is
 * refused with a body and a fixed message rather than aborted with a body-less 500 that
 * skips every later hook (F-228, ADR-0055).
 */
function refusalFor(error: unknown): APIError {
  // No `InvitationTenantConflictError` branch, deliberately: it is thrown only when a tenant
  // context is active and differs from the token's prefix (D-04), and no tenant context is
  // ever active inside a Better Auth hook. If it ever were, it is a defect and the 500 below
  // is the right answer, not a 409.
  if (error instanceof InvitationExpiredError) {
    return new APIError('GONE', {
      code: INVITATION_HOOK_CODES.expired,
      message: INVITATION_EXPIRED_MESSAGE,
    });
  }

  if (error instanceof InvitationRevokedError) {
    return new APIError('GONE', {
      code: INVITATION_HOOK_CODES.revoked,
      message: INVITATION_REVOKED_MESSAGE,
    });
  }

  if (error instanceof InvitationAlreadyAcceptedError) {
    return new APIError('CONFLICT', {
      code: INVITATION_HOOK_CODES.alreadyAccepted,
      message: INVITATION_ALREADY_ACCEPTED_MESSAGE,
    });
  }

  logger.error(
    {
      code: 'invitation_lookup_failed',
      ...errorLogFields(error, { includeMessage: false }),
    },
    'the sign-up invitation lookup failed before the user row was written',
  );

  return new APIError('INTERNAL_SERVER_ERROR', {
    code: INVITATION_HOOK_CODES.lookupFailed,
    message: INVITATION_LOOKUP_FAILED_MESSAGE,
  });
}
