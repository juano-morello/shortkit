/**
 * Contract: docs/contracts/mail-sender.md (`email_verification`)
 * ADR: adr-0017-email-provider.md
 * Produced by: TASK-1b-02
 * Consumed by: `render-mail.ts`. NO CALLER DISPATCHES THIS TEMPLATE. Email verification is
 *              outside item 1b (ADR-0061's `ev` claim stays unused); the arm exists in the
 *              `OutboundMail` union and this renderer exists so the union has two members and
 *              the exhaustive switch is exercised. Minimal on purpose; the copy is reviewed
 *              when a caller lands.
 */
import type { OutboundMail } from '../mail-sender';

import { escapeHtml, formatExpiry } from './format';
import type { RenderedMail } from './render-mail';

export type EmailVerificationData = Extract<OutboundMail, { template: 'email_verification' }>['data'];

export function renderEmailVerification(data: EmailVerificationData): RenderedMail {
  const subject = 'Verify your email address for Shortkit';
  const expiry = formatExpiry(data.expiresAt);

  const text = [
    'Open this link to confirm this address for your Shortkit account:',
    data.verificationUrl,
    '',
    `The link expires on ${expiry}.`,
    'If you did not create a Shortkit account, ignore it. Nothing happens until you open the link.',
    '',
  ].join('\n');

  const url = escapeHtml(data.verificationUrl);

  const html =
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">` +
    `<p>Confirm this address for your Shortkit account:</p>` +
    `<p><a href="${url}">Verify email address</a></p>` +
    `<p style="font-size:0.9em;color:#555">If the link does not open, copy this address into your browser:<br>${url}</p>` +
    `<p style="font-size:0.9em;color:#555">The link expires on ${escapeHtml(expiry)}. ` +
    `If you did not create a Shortkit account, ignore it. Nothing happens until you open the link.</p>` +
    `</body></html>`;

  return { subject, text, html };
}
