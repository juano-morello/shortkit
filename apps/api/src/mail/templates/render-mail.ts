/**
 * Contract: docs/contracts/mail-sender.md (invariant 4: every template renders both
 *           `text/plain` and `text/html`, for every transport)
 * ADR: adr-0017-email-provider.md ("Templates are plain TypeScript template strings
 *      producing text and HTML, not a template engine")
 * Produced by: TASK-1b-02
 *
 * The one place a message becomes bytes. Every sender that renders (`console`, `resend`)
 * calls `renderMail`, and its `switch` is exhaustive over `OutboundMail['template']`: the
 * `never` at the bottom is what turns "add a template" into a compile error until a
 * renderer exists, which is the guarantee `mail-sender.md` asks the implementer for.
 */
import type { OutboundMail } from '../mail-sender';

import { renderEmailVerification } from './email-verification';
import { renderWorkspaceInvitation } from './workspace-invitation';

export interface RenderedMail {
  readonly subject: string;
  /** `text/plain`. What `ConsoleMailSender` prints. The URL is on a line of its own. */
  readonly text: string;
  /** `text/html`. Every interpolated value is HTML-escaped; the URL is both `href` and text. */
  readonly html: string;
}

export function renderMail(message: OutboundMail): RenderedMail {
  switch (message.template) {
    case 'workspace_invitation':
      return renderWorkspaceInvitation(message.data);
    case 'email_verification':
      return renderEmailVerification(message.data);
    default: {
      // Exhaustive by construction. A new `OutboundMail` arm lands here as a type error.
      const unhandled: never = message;
      throw new Error(`no renderer for mail template ${String((unhandled as OutboundMail).template)}`);
    }
  }
}
