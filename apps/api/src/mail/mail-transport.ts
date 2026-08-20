/**
 * Contract: docs/contracts/mail-sender.md ("The mail transport", "The boot assertion",
 *           "Error strings", "Normative source")
 * ADR: adr-0017-email-provider.md ("The binding declares a transport, and absence sends
 *      nothing"), adr-0040 (a boot-time behavioural choice keys on a declared property of
 *      the deployment), adr-0029 (no configured value in error text), adr-0028
 * Produced by: TASK-1b-02
 * Consumed by: `main.ts` (`assertMailTransportConfigured`), `mail.module.ts`
 *              (`resolveMailTransport`, `readResendBinding`), `senders/resend-mail-sender.ts`
 *              (`resolveMailTransport` for guard 2), `vitest.setup.ts` (`MAIL_TEST_GUARD_MESSAGE`).
 *
 * ============================================================================
 * `MAIL_TRANSPORT` IS READ IN THIS FILE AND NOWHERE ELSE. NEVER `NODE_ENV`.
 * ============================================================================
 *
 * F-386. The rule this replaced was "`ResendMailSender` when `NODE_ENV` is `production` or
 * `staging`", and `Dockerfile:83` is `ENV NODE_ENV=production` in the image `docker compose`
 * runs — so the live provider was bound in every developer's laptop stack, and a test runner
 * that did not happen to set `NODE_ENV=test` (a `tsx` script, a child process with an
 * explicit `env`, a CI shell) had neither guard. A build flag decided who received mail.
 *
 * Now the transport is a DECLARED property of the deployment, in the shape ADR-0040 fixed
 * for `CLIENT_TRUST_BOUNDARY` and `BFF_TRUST_BOUNDARY`: validity is asserted
 * unconditionally, the requirement is conditional on the value, an unrecognised value is
 * fatal everywhere. What is INVERTED from those two is absence. There, absence means "assert
 * nothing"; here absence selects `NoopMailSender`, because the permissive branch of this
 * declaration spends money and reaches a stranger's inbox, and the safe default has to be
 * the transport that can do neither. `mail-sender.md` prices the alternatives.
 *
 * `resolveMailTransport` is the ONE read of the variable; `assertMailTransportConfigured`
 * goes through it. `mail-transport.spec.ts` scans `apps/api/src/**` (comments and string
 * literals stripped) and asserts this is the only file naming the variable in code, and that
 * nothing under `apps/api/src/mail/**` names `NODE_ENV` in code.
 */
import { logger } from '../observability/logger';

export const MAIL_TRANSPORT_ENV = 'MAIL_TRANSPORT';
export const RESEND_API_KEY_ENV = 'RESEND_API_KEY';
export const MAIL_FROM_ENV = 'MAIL_FROM';
export const MAIL_REPLY_TO_ENV = 'MAIL_REPLY_TO';

/** Unset is read as 'none'. Anything outside this set fails boot, everywhere. */
export const MAIL_TRANSPORTS = ['resend', 'console', 'fake', 'none'] as const;
export type MailTransport = (typeof MAIL_TRANSPORTS)[number];

/**
 * The counter every message reaching `NoopMailSender` increments. A NAME with no metrics
 * backend yet (verified in `mail-sender.md`, "Signal": nothing under `apps/api/src` imports a
 * metrics client), so the increment is process-local (`readMailSuppressedCount` in
 * `senders/noop-mail-sender.ts`) and the warn line per message is the whole
 * operator-visible signal. Same standing as `trusted_client_ip_unresolved_total` and
 * `bff_proxy_auth_mismatch_total`.
 */
export const MAIL_SUPPRESSED_COUNTER = 'mail_suppressed_total';

/**
 * ============================================================================
 * THE FIVE ERROR STRINGS. EXACT, AND NONE INTERPOLATES A CONFIGURED VALUE (ADR-0029).
 * ============================================================================
 *
 * `MAIL_FROM` and `RESEND_API_KEY` are the two reads most likely to carry something an
 * operator did not mean to publish, and the raw value of `MAIL_TRANSPORT` is not quoted
 * back either: the refusal names the rule, and the operator has the environment in front
 * of them.
 */
export const MAIL_TRANSPORT_INVALID_MESSAGE =
  'MAIL_TRANSPORT must be "resend", "console", "fake" or "none", or unset. It is not NODE_ENV and it is not a boolean.';

export const RESEND_API_KEY_UNSET_MESSAGE =
  'MAIL_TRANSPORT is "resend" but RESEND_API_KEY is not set. A deployment that sends mail must carry the provider credential. See docs/contracts/mail-sender.md.';

export const MAIL_FROM_UNSET_MESSAGE =
  'MAIL_TRANSPORT is "resend" but MAIL_FROM is not set. A live sender names its From address rather than defaulting to one. See docs/contracts/mail-sender.md.';

export const MAIL_TEST_GUARD_MESSAGE =
  'A test process must not be able to send mail. RESEND_API_KEY is set, or MAIL_TRANSPORT is "resend". Unset both in the test environment. See docs/contracts/mail-sender.md.';

export const RESEND_SENDER_NOT_DECLARED_MESSAGE =
  'ResendMailSender was constructed but MAIL_TRANSPORT is not "resend". The live sender is reachable only by explicit declaration. See docs/contracts/mail-sender.md.';

/**
 * The refusal `assertMailTransportConfigured` throws, and what `main.ts`'s
 * `bootstrap().catch` maps onto `boot_precondition: 'mail_transport'` — the same arrangement
 * `AuthBindingError.binding` has for the five auth bindings, so the line an operator reads
 * names WHICH declaration refused (F-245) and is machine-separable from
 * `database_reachable`, `runtime_role_cannot_bypass_rls` and `auth_role_separation`.
 *
 * WHY NOT `main.ts`'s OWN `BootPreconditionError`, which the contract names. That class is
 * module-private to `main.ts`, and `main.ts` calls `bootstrap()` at module scope, so a leaf
 * module cannot import it without booting the API. The auth bindings met the same wall and
 * answered it with a class of their own mapped in the catch (ADR-0058); this follows them.
 * Recorded as a dated divergence note in `mail-sender.md`. The FIELD VALUE is the contract's
 * verbatim, and it is the field value the tests key on.
 *
 * NEVER CARRIES A VALUE. Every message is one of the constants above.
 */
export class MailBindingError extends Error {
  readonly binding = 'mail_transport' as const;

  constructor(message: string) {
    super(message);
    this.name = 'MailBindingError';
  }
}

/**
 * Called UNCONDITIONALLY from `main.ts`'s `assertBootPreconditions()`, beside the auth
 * bindings and the two trust boundaries. The gating is inside, and it keys on
 * `MAIL_TRANSPORT`, never on `NODE_ENV` (F-386, GC-B; the file docblock has the reason).
 *
 *   1. ALWAYS: `MAIL_TRANSPORT`, if set, is one of `MAIL_TRANSPORTS`. Otherwise throw
 *      `MAIL_TRANSPORT_INVALID_MESSAGE`. `Resend`, `prod`, `true` and `1` all refuse, in
 *      tests and in CI too; a typo must never silently select a transport nobody named.
 *   2. ONLY when it is `resend`: `RESEND_API_KEY` and `MAIL_FROM` are set and non-empty.
 *      Otherwise throw `RESEND_API_KEY_UNSET_MESSAGE` or `MAIL_FROM_UNSET_MESSAGE`. An
 *      operator who asked for real mail and gets silence has a worse outcome than one whose
 *      process refused to start.
 *   3. When the resolved transport is `none`, including unset: log ONE warn line carrying
 *      `boot_precondition: 'mail_transport'` and no other field, and return. It fires for an
 *      explicit `none` too — one line per process start is cheap, and for the operator who
 *      forgot the variable it is the only local evidence that exists.
 *
 * `console`, `fake`, `none` and unset assert nothing else and reach no network.
 *
 * Cannot check that a deployment which sends mail declared a transport. Nothing local can
 * tell a process with no mail configured that it was meant to have some (ADR-0017 accepts
 * this: an invitation that did not arrive gets re-sent, a stranger receiving mail from a
 * laptop is unrecoverable).
 */
export function assertMailTransportConfigured(env: NodeJS.ProcessEnv): void {
  const transport = resolveMailTransport(env);

  if (transport === 'resend') {
    // Reads and refuses; the returned binding is discarded here and read again by the
    // factory in `mail.module.ts`, which is the one construction site of the live sender.
    readResendBinding(env);
    return;
  }

  if (transport === 'none') {
    logger.warn(
      { boot_precondition: 'mail_transport' },
      'MAIL_TRANSPORT is unset or "none": every message this process is asked to send is suppressed. Declare "console", "fake" or "resend" to change that (docs/contracts/mail-sender.md).',
    );
  }
}

/**
 * The bound transport. THE ONE READ OF `MAIL_TRANSPORT`; the assertion above goes through
 * it. Exact match, no trimming, no case folding: `Resend` and ` resend` are the typos the
 * unconditional check exists to catch, and a value that is normalised into acceptance is a
 * value in force that nobody wrote. Empty is unset — `MAIL_TRANSPORT=` is what an env file
 * produces when the variable it expands is absent, and it is the same statement as absence.
 *
 * Throws `MailBindingError(MAIL_TRANSPORT_INVALID_MESSAGE)` on anything else rather than
 * falling back to `none`: a factory that resolves after a skipped assertion (a test module
 * compiled without `main.ts`) must not turn a typo into a silently suppressed sender.
 */
export function resolveMailTransport(env: NodeJS.ProcessEnv): MailTransport {
  const declared = env[MAIL_TRANSPORT_ENV];

  if (declared === undefined || declared === '') {
    return 'none';
  }

  if (isMailTransport(declared)) {
    return declared;
  }

  throw new MailBindingError(MAIL_TRANSPORT_INVALID_MESSAGE);
}

/** What the live sender is constructed with. Read only under `resend`. */
export interface ResendBinding {
  readonly apiKey: string;
  readonly from: string;
  /** `MAIL_REPLY_TO`, optional; `undefined` when unset or empty. */
  readonly replyTo: string | undefined;
}

/**
 * The two required values under `resend`, refused by name when either is unset or empty,
 * and the optional reply-to. The assertion calls this to refuse at boot; the factory calls it
 * to construct. One reader for both so the refusal and the construction cannot disagree on
 * what "set" means. `MAIL_FROM` has no default on purpose (ADR-0017): a default in the
 * adapter is exactly how the `onboarding@resend.dev` placeholder becomes a decision.
 */
export function readResendBinding(env: NodeJS.ProcessEnv): ResendBinding {
  const apiKey = env[RESEND_API_KEY_ENV];

  if (apiKey === undefined || apiKey.trim() === '') {
    throw new MailBindingError(RESEND_API_KEY_UNSET_MESSAGE);
  }

  const from = env[MAIL_FROM_ENV];

  if (from === undefined || from.trim() === '') {
    throw new MailBindingError(MAIL_FROM_UNSET_MESSAGE);
  }

  const replyTo = env[MAIL_REPLY_TO_ENV];

  return {
    apiKey,
    from,
    replyTo: replyTo === undefined || replyTo.trim() === '' ? undefined : replyTo,
  };
}

function isMailTransport(value: string): value is MailTransport {
  return (MAIL_TRANSPORTS as readonly string[]).includes(value);
}
