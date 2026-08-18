/**
 * Contract: docs/contracts/mail-sender.md (`workspace_invitation`, invariants 4 and 5)
 * ADR: adr-0017-email-provider.md, adr-0021 (the link is the capability)
 * Produced by: TASK-1b-02
 * Consumed by: `render-mail.ts`. TASK-1b-08 builds the `data` and never touches the copy.
 *
 * The one message item 1b sends. Copy is human-facing prose and had its `stop-slop` pass
 * (GC-12); `templates.spec.ts` keeps a short denylist of the phrases that pass strips.
 *
 * WHAT IS IN THE BODY AND WHY. The raw token travels in `inviteUrl`'s fragment and this body
 * is one of the exactly two places under this system's control it may appear (GC-K; the
 * other is the fragment itself). It is on a line of its own in the text part so a reader,
 * `ConsoleMailSender`'s stdout consumer and the compose e2e (`check-compose-stack.sh` greps
 * for `/invitations/accept#token=`) all find it without parsing. The plain-text part carries
 * the URL verbatim because a mail client that strips fragments from `href` breaks the HTML
 * link (D-03's accepted cost) and the text is the fallback.
 *
 * WHAT IS NOT. No password, no JWT, no IP (invariant 5). The inviter's ADDRESS is here on
 * purpose — the recipient has to know who asked — and it is the reason no rendered body may
 * reach a log line: `LOGGABLE_FIELDS` names `template` and not `to`, `subject` or a body.
 *
 * ESCAPING. `tenantName`, `inviterEmail` and every workspace name are strings a user typed
 * and go through `escapeHtml` in the HTML part. The text part is `text/plain` and needs
 * none.
 */
import type { WorkspaceRole } from '@shortkit/contracts';

import type { OutboundMail } from '../mail-sender';

import { escapeHtml, formatExpiry } from './format';
import type { RenderedMail } from './render-mail';

export type WorkspaceInvitationData = Extract<
  OutboundMail,
  { template: 'workspace_invitation' }
>['data'];

/**
 * How a role reads to a person. `workspace_admin` is a column value, not a phrase; the
 * other two are already words. Exhaustive over `WorkspaceRole`, so a fourth role is a
 * compile error here rather than an underscore in somebody's inbox.
 */
export function roleLabel(role: WorkspaceRole): string {
  switch (role) {
    case 'workspace_admin':
      return 'workspace admin';
    case 'member':
      return 'member';
    case 'viewer':
      return 'viewer';
    default: {
      const unhandled: never = role;
      return String(unhandled);
    }
  }
}

export function renderWorkspaceInvitation(data: WorkspaceInvitationData): RenderedMail {
  const subject = `You've been invited to ${data.tenantName} on Shortkit`;
  const expiry = formatExpiry(data.expiresAt);

  const textWorkspaces = data.workspaces
    .map((workspace) => `  - ${workspace.name} (${roleLabel(workspace.role)})`)
    .join('\n');

  const text = [
    `${data.inviterEmail} invited you to join ${data.tenantName} on Shortkit.`,
    '',
    'You will have access to:',
    textWorkspaces,
    '',
    'Open this link to accept:',
    data.inviteUrl,
    '',
    `The link works once and expires on ${expiry}.`,
    'If you were not expecting this, ignore it. Nothing happens until you open the link.',
    '',
  ].join('\n');

  const htmlWorkspaces = data.workspaces
    .map(
      (workspace) =>
        `<li>${escapeHtml(workspace.name)} <span style="color:#555">(${escapeHtml(roleLabel(workspace.role))})</span></li>`,
    )
    .join('');

  const url = escapeHtml(data.inviteUrl);

  const html =
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">` +
    `<p>${escapeHtml(data.inviterEmail)} invited you to join <strong>${escapeHtml(data.tenantName)}</strong> on Shortkit.</p>` +
    `<p>You will have access to:</p><ul>${htmlWorkspaces}</ul>` +
    `<p><a href="${url}">Accept the invitation</a></p>` +
    `<p style="font-size:0.9em;color:#555">If the link does not open, copy this address into your browser:<br>${url}</p>` +
    `<p style="font-size:0.9em;color:#555">The link works once and expires on ${escapeHtml(expiry)}. ` +
    `If you were not expecting this, ignore it. Nothing happens until you open the link.</p>` +
    `</body></html>`;

  return { subject, text, html };
}
