/**
 * Contract: docs/contracts/mail-sender.md (`none`, "Signal")
 * ADR: adr-0017-email-provider.md ("Absence selects a no-op sender rather than failing an
 *      assertion"), adr-0028
 * Produced by: TASK-1b-02
 *
 * Bound under `none` and under an unset `MAIL_TRANSPORT`. Discards the message.
 *
 * `send` RESOLVES. A caller cannot distinguish it from a delivered message, which is
 * deliberate: no request path branches on whether mail is configured, and the caller's
 * `afterCommit` completes the same way it would under `resend`. What it does emit is one
 * warn line per message (`msg: 'mail_suppressed'`, field `template` and nothing else) and one
 * increment of `MAIL_SUPPRESSED_COUNTER`.
 *
 * ONE LINE PER MESSAGE, NOT ONE PER MINUTE. Volume is a handful a day (ADR-0017), and the
 * operator this line is written for is the one who invited somebody from a deployment that
 * cannot send; sampling would hide the one message they are looking for.
 *
 * RECORDS NOTHING. `FakeMailSender` is the one that records; a long-lived process
 * accumulating every suppressed message is a memory leak with an audit trail.
 *
 * WHAT THE LINE MAY NOT CARRY. `to`, the URL, the token, the subject: `LOGGABLE_FIELDS`
 * would censor them anyway (ADR-0028), and they are not written in the first place so the
 * censor is a second line of defence rather than the only one. AC-1b-4 asserts the line
 * carries `template` and no address, URL or token.
 */
import { logger } from '../../observability/logger';
import type { MailSender, OutboundMail } from '../mail-sender';

/**
 * The process-local value behind `MAIL_SUPPRESSED_COUNTER`. There is no metrics client to
 * hand it to (`mail-sender.md`, "Signal"), so it is a number a test can read; when a
 * backend lands, this is the increment that moves onto it.
 */
let suppressed = 0;

export function readMailSuppressedCount(): number {
  return suppressed;
}

export class NoopMailSender implements MailSender {
  async send(message: OutboundMail): Promise<void> {
    suppressed += 1;
    logger.warn({ template: message.template }, 'mail_suppressed');
  }
}
