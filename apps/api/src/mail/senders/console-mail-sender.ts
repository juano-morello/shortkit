/**
 * Contract: docs/contracts/mail-sender.md (`console`, invariants 4 and 5)
 * ADR: adr-0017-email-provider.md ("`console` stays available and stays opt-in"), adr-0028
 * Produced by: TASK-1b-02
 * Consumed by: the compose stack (`docker-compose.yml` declares `console`, D-02, TASK-1b-11)
 *              and `check-compose-stack.sh`, which greps the API log for the invite URL.
 *
 * Bound under `MAIL_TRANSPORT=console`. Writes the rendered TEXT part to stdout and sends
 * nothing. Reaches no network.
 *
 * ============================================================================
 * THIS IS THE ONE SANCTIONED `console` CALL UNDER `apps/api/src`, AND IT IS ON PURPOSE.
 * ============================================================================
 *
 * `eslint.config.mjs` sets `no-console: error` for the whole API so nothing bypasses the
 * pino instance and its field allowlist (ADR-0028, GC-9). This file's whole purpose is the
 * bypass: the recipient address and a URL carrying a single-use invitation token are what a
 * developer opted in to read out of their laptop's container log, and neither may travel
 * through the logger — `to` and the URL are not in `LOGGABLE_FIELDS` and are never to be
 * added (`logging-and-headers.md`, the never-allowlist), and a `msg` carrying them would be
 * a log line carrying a token, which GC-K forbids. So the message goes to stdout as plain
 * text, on its own channel, through `console.log`, and the disable comment is scoped to that
 * one statement.
 *
 * AND IT IS WHY `console` IS NOT WHAT AN UNSET `MAIL_TRANSPORT` SELECTS. Stdout is a log
 * destination in every deployment that has one; a real deployment that forgot the variable
 * would otherwise print raw tokens into its platform log store. Absence binds
 * `NoopMailSender`; a stack that wants this output declares it (ADR-0017, "Bind
 * `ConsoleMailSender` on absence" — rejected).
 *
 * THE SHAPE, fixed so the compose e2e and a developer's `grep` can rely on it. One
 * `console.log` per message, so the block is one write and lines from concurrent pino
 * output do not interleave inside it:
 *
 *   --- outbound mail (console transport; nothing was sent) ---
 *   To: <to>
 *   Subject: <subject>
 *
 *   <text part, verbatim; the URL is on a line of its own>
 *   --- end of outbound mail ---
 */
import type { MailSender, OutboundMail } from '../mail-sender';
import { renderMail } from '../templates/render-mail';

export const CONSOLE_MAIL_HEADER = '--- outbound mail (console transport; nothing was sent) ---';
export const CONSOLE_MAIL_FOOTER = '--- end of outbound mail ---';

/** The exact bytes `send` writes, minus the trailing newline `console.log` adds. Exported for the spec. */
export function formatConsoleMail(message: OutboundMail): string {
  const rendered = renderMail(message);

  return [
    CONSOLE_MAIL_HEADER,
    `To: ${message.to}`,
    `Subject: ${rendered.subject}`,
    '',
    rendered.text,
    CONSOLE_MAIL_FOOTER,
  ].join('\n');
}

export class ConsoleMailSender implements MailSender {
  async send(message: OutboundMail): Promise<void> {
    // The one sanctioned bypass of the shared logger; the file docblock has the reason.
    // eslint-disable-next-line no-console
    console.log(formatConsoleMail(message));
  }
}
