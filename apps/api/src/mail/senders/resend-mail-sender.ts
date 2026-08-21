/**
 * Contract: docs/contracts/mail-sender.md (`resend`, "No test sends mail", "Signal",
 *           invariants 2 and 3)
 * ADR: adr-0017-email-provider.md (Resend; the two guards; a send failure after commit is
 *      logged and does not fail the request), adr-0028, adr-0029
 * Produced by: TASK-1b-02
 * Consumed by: `mail.module.ts`, THE ONLY CONSTRUCTION SITE IN SHIPPED CODE. Nothing else
 *              may `new ResendMailSender(...)`; a second site is a finding.
 *
 * Bound under `MAIL_TRANSPORT=resend`. One `POST https://api.resend.com/emails` with a
 * bearer key, over `fetch`: no SDK. ADR-0017 sized the adapter at "one POST with an API
 * key, under 40 lines", and a dependency for one request would be a supply-chain surface
 * bought for nothing the platform `fetch` does not already do.
 *
 * ============================================================================
 * GUARD 2 OF 2 AGAINST A LIVE SEND FROM A TEST. NEITHER GUARD READS `NODE_ENV`.
 * ============================================================================
 *
 * The constructor throws `RESEND_SENDER_NOT_DECLARED_MESSAGE` unless the environment it is
 * handed resolves to `resend`. Guard 1 is `vitest.setup.ts` refusing to import when
 * `RESEND_API_KEY` is set or `MAIL_TRANSPORT` is `resend`. A test would have to defeat both,
 * and defeating both means setting two variables on purpose rather than inheriting a build
 * flag from a base image (F-386). This guard also covers a direct construction in a runner
 * that is not vitest (a `tsx` script, a child process with its own `env`) which guard 1
 * never sees.
 *
 * ============================================================================
 * `send` NEVER THROWS INTO THE CALLER (invariant 3). RETRY ONCE ON 5xx / NETWORK, NEVER 4xx.
 * ============================================================================
 *
 * THE RETRY IS SAFE BECAUSE OF THE `Idempotency-Key` (2026-08-19, debt sweep, 1b-W1-08).
 * A network throw does not say whether the provider accepted the message before the
 * response was lost, so a bare retry could send twice. When the `OutboundMail` carries an
 * `idempotencyKey` (the invitation dispatch sets the invitation id), both attempts send
 * it as the `Idempotency-Key` header and Resend deduplicates. A message without a key
 * keeps the pre-sweep behaviour: no header, and the double-send window stands for that
 * caller alone.
 *
 * By the time this runs the caller's transaction has committed (`afterCommit`, ADR-0002),
 * so a failure here cannot roll anything back and must not turn a created invitation into a
 * 5xx. The final failure is one error line, `msg: 'mail_dispatch_failed'`, fields `template`,
 * `err_name`, `err_message`, and the message is either this file's own "Resend answered
 * HTTP <status>" or the platform's "fetch failed"; the provider's response BODY is drained
 * and never read, because Resend's error text can quote the field it rejected, and the `to`
 * field is an address. A 4xx is a request the provider will refuse again identically, so it
 * is not retried; a 5xx or a socket error is retried exactly once and then reported.
 *
 * NOTHING HERE LOGS THE KEY, THE FROM ADDRESS, THE RECIPIENT OR THE BODY (ADR-0029, GC-K).
 * `senders.spec.ts` asserts the error line against a fake `fetch`.
 */
import { errorLogFields, logger } from '../../observability/logger';
import type { MailSender, OutboundMail } from '../mail-sender';
import { MailBindingError, RESEND_SENDER_NOT_DECLARED_MESSAGE, resolveMailTransport } from '../mail-transport';
import { renderMail } from '../templates/render-mail';

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/**
 * The provider answered and the answer was not 2xx. Carries the status and NOTHING from the
 * response body (see the file docblock); its message is what reaches `err_message`.
 */
export class ResendRejectedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Resend answered HTTP ${String(status)}`);
    this.name = 'ResendRejectedError';
    this.status = status;
  }
}

export interface ResendMailSenderOptions {
  /** `MAIL_REPLY_TO`, when declared. */
  readonly replyTo?: string;
  /** The platform `fetch` by default; a fake in the unit tier, which never reaches a socket. */
  readonly fetch?: typeof fetch;
}

type Attempt = { readonly accepted: true } | { readonly accepted: false; readonly retryable: boolean; readonly error: Error };

export class ResendMailSender implements MailSender {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly replyTo: string | undefined;
  private readonly fetchImpl: typeof fetch;

  /**
   * Throws `RESEND_SENDER_NOT_DECLARED_MESSAGE` when `env` does not resolve to `resend`
   * (guard 2 of 2). Reads the transport through `resolveMailTransport`, so this file is not
   * a second reader of the variable.
   */
  constructor(apiKey: string, from: string, env: NodeJS.ProcessEnv, options: ResendMailSenderOptions = {}) {
    if (resolveMailTransport(env) !== 'resend') {
      throw new MailBindingError(RESEND_SENDER_NOT_DECLARED_MESSAGE);
    }

    this.apiKey = apiKey;
    this.from = from;
    this.replyTo = options.replyTo;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async send(message: OutboundMail): Promise<void> {
    let failure: unknown;

    try {
      const outcome = await this.dispatch(message);

      if (outcome.accepted) {
        return;
      }

      failure = outcome.error;
    } catch (error: unknown) {
      // Rendering or serialising threw (an invalid `expiresAt` is the realistic case). It
      // is still a dispatch failure and still not the caller's 5xx.
      failure = error;
    }

    // `includeMessage: true` because every message that can arrive here is a fixed shape
    // this file controls, the platform's own ("fetch failed"), or a renderer's: none of
    // which carries the key, an address or the token. The provider's body was drained unread.
    logger.error(
      { template: message.template, ...errorLogFields(failure, { includeMessage: true }) },
      'mail_dispatch_failed',
    );
  }

  private async dispatch(message: OutboundMail): Promise<Attempt> {
    const rendered = renderMail(message);
    const body = JSON.stringify({
      from: this.from,
      to: [message.to],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      ...(this.replyTo === undefined ? {} : { reply_to: this.replyTo }),
    });

    const first = await this.attempt(body, message.idempotencyKey);

    // Exactly one retry, and only for a failure the provider did not decide (a 5xx or no
    // answer at all). A 4xx is the provider deciding, and asking again changes nothing.
    // The idempotency key is IDENTICAL on both attempts: that identity is the whole
    // point (1b-W1-08): a first attempt whose response was lost after acceptance and its
    // retry carry one key, so Resend deduplicates instead of sending twice.
    return !first.accepted && first.retryable ? this.attempt(body, message.idempotencyKey) : first;
  }

  private async attempt(body: string, idempotencyKey?: string): Promise<Attempt> {
    let response: Response;

    try {
      response = await this.fetchImpl(RESEND_EMAILS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          // 2026-08-19 (1b-W1-08): Resend deduplicates on this header. Present only when
          // the message carries a key; the value is the caller's (the invitation id).
          ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
        },
        body,
      });
    } catch (error: unknown) {
      // A socket-level failure: refused, reset, DNS, timeout. Retryable once.
      return { accepted: false, retryable: true, error: error instanceof Error ? error : new Error(String(error)) };
    }

    // Drained so the connection is released, and DISCARDED: the provider's error text can
    // quote the rejected field, and the recipient address is one of the fields.
    await response.arrayBuffer().catch(() => undefined);

    if (response.ok) {
      return { accepted: true };
    }

    return { accepted: false, retryable: response.status >= 500, error: new ResendRejectedError(response.status) };
  }
}
