/**
 * Contract: docs/contracts/mail-sender.md (this file is its Normative form)
 * ADR: adr-0017-email-provider.md, adr-0002 (send from `afterCommit`), adr-0028 (allowlist)
 * Produced by: TASK-1b-02
 * Consumed by: TASK-1b-08 (invitations dispatch). No verification caller exists; email
 *              verification is out of item 1b's scope and the member is here so the union
 *              has two arms and every sender is compiled against both.
 *
 * The port, and nothing that reads the environment. Which class stands behind `MAIL_SENDER`
 * is `mail-transport.ts`'s question and `mail.module.ts`'s factory answers it; this file is
 * what a caller and a test compile against.
 */
import type { WorkspaceRole } from '@shortkit/contracts';

export type MailTemplate = 'email_verification' | 'workspace_invitation';

/**
 * Discriminated on `template`, so a caller cannot dispatch an invitation without its
 * workspace list and cannot hand verification data to an invitation. Adding a template
 * means adding an arm here, and the renderer's exhaustive `switch` under `templates/` stops
 * compiling until it handles it. Every sender renders through that switch, so the contract's
 * "every implementation fails to compile until it handles the new case" holds by one edit.
 */
/**
 * `idempotencyKey` (2026-08-19, debt sweep, ledger 1b-W1-08): OPTIONAL, on both arms. When
 * present, `ResendMailSender` sends it as the `Idempotency-Key` header on BOTH attempts —
 * the first and the one retry — so a retry after a lost response (the provider accepted,
 * the answer never arrived) is deduplicated by Resend instead of double-sending. The
 * invitation dispatch sets it to the invitation row's id — a uuid, stable for the row's
 * lifetime and carrying no secret. Every other sender ignores the field: the fake and the
 * console cannot double-send, and the noop sends nothing. Absent means no header, which is
 * the pre-sweep behaviour, retained for any caller that has no natural key.
 */
export type OutboundMail =
  | {
      readonly template: 'email_verification';
      readonly to: string;
      readonly idempotencyKey?: string;
      readonly data: { readonly verificationUrl: string; readonly expiresAt: Date };
    }
  | {
      readonly template: 'workspace_invitation';
      readonly to: string;
      readonly idempotencyKey?: string;
      readonly data: {
        readonly inviteUrl: string;
        readonly inviterEmail: string;
        readonly tenantName: string;
        readonly workspaces: ReadonlyArray<{ readonly name: string; readonly role: WorkspaceRole }>;
        readonly expiresAt: Date;
      };
    };

/**
 * One method. `send` resolving means the BOUND transport accepted the message and nothing
 * more (`mail-sender.md`, invariant 2): under `resend` the provider took it, under every
 * other transport no message left the process. It never rejects in a way that fails the
 * caller's request (invariant 3): a provider failure is logged as `mail_dispatch_failed`
 * and swallowed, because by the time it fires the caller's transaction has committed.
 */
export interface MailSender {
  send(message: OutboundMail): Promise<void>;
}

/** The injection token. `MailModule` binds it by `useFactory` and exports it. */
export const MAIL_SENDER = Symbol('MAIL_SENDER');

/**
 * What a suite that declared `MAIL_TRANSPORT=fake` gets back from `app.get(MAIL_SENDER)`.
 * A suite that declared nothing gets `NoopMailSender`, which has no `sent`, so an assertion
 * on delivered mail in an undeclared suite fails to compile rather than passing for the
 * wrong reason (ADR-0017, "The fake sender is no longer free").
 */
export interface FakeMailSender extends MailSender {
  readonly sent: ReadonlyArray<OutboundMail>;
  clear(): void;
  lastTo(email: string): OutboundMail | undefined;
}
