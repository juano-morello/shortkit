/**
 * Contract: design/contracts/mail-sender.md
 * ADR: adr-0017-email-provider.md, adr-0002-tenant-context-binding.md
 * Produced by: TASK-010
 * Consumed by: TASK-021
 *
 * Mail is dispatched from withTenantTransaction's `afterCommit`, NEVER inside the
 * transaction: the transaction holds a pooled connection for its whole lifetime.
 */
import type { WorkspaceRole } from '@shortkit/contracts';

export type MailTemplate = 'email_verification' | 'workspace_invitation';

/**
 * Discriminated on `template`, so a caller cannot dispatch an invitation without its
 * workspace list, and cannot pass verification data to an invitation.
 * Adding a template makes every implementation fail to compile until it handles it.
 */
export type OutboundMail =
  | {
      template: 'email_verification';
      to: string;
      data: { verificationUrl: string; expiresAt: Date };
    }
  | {
      template: 'workspace_invitation';
      to: string;
      data: {
        inviteUrl: string;
        inviterEmail: string;
        tenantName: string;
        workspaces: ReadonlyArray<{ name: string; role: WorkspaceRole }>;
        expiresAt: Date;
      };
    };

export interface MailSender {
  send(message: OutboundMail): Promise<void>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');

/** Bound when NODE_ENV is production or staging. Retries once on 5xx or network error, never on 4xx. */
export declare class ResendMailSender implements MailSender {
  /** Throws if NODE_ENV === 'test'. Guard 1 of 2 against a live send from a test. */
  constructor(apiKey: string, from: string);
  send(message: OutboundMail): Promise<void>;
}

/** Bound when NODE_ENV === 'development'. */
export declare class ConsoleMailSender implements MailSender {
  send(message: OutboundMail): Promise<void>;
}

/**
 * Bound when NODE_ENV === 'test'.
 * Guard 2 of 2 is in apps/api/vitest.setup.ts: it throws at import time if
 * RESEND_API_KEY is set. A test would have to defeat both to reach the network.
 */
export interface FakeMailSender extends MailSender {
  readonly sent: ReadonlyArray<OutboundMail>;
  clear(): void;
  lastTo(email: string): OutboundMail | undefined;
}

export function createFakeMailSender(): FakeMailSender {
  throw new Error('not implemented');
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/** Bodies are human-facing prose and get a stop-slop pass (GC-12). */
export function renderMail(_message: OutboundMail): RenderedMail {
  throw new Error('not implemented');
}
