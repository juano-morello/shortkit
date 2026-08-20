/**
 * Contract: docs/contracts/mail-sender.md (`fake`, `FakeMailSender`)
 * ADR: adr-0017-email-provider.md
 * Produced by: TASK-1b-02
 *
 * Bound under `MAIL_TRANSPORT=fake` and under nothing else. Records in memory, sends
 * nothing, reaches no network. What an integration suite asserting "exactly one
 * `OutboundMail` reached the sender" (AC-1b-3) reads through `app.get(MAIL_SENDER)`.
 *
 * IT IS NOT SELECTED BY THE RUNNER. Under the struck rule the fake was what `NODE_ENV=test`
 * bound; now a suite that wants it declares `fake`, and one that declares nothing gets
 * `NoopMailSender`, which has no `sent`, so a forgotten declaration is a type error in the
 * suite rather than a green assertion over an empty array (ADR-0017, "The fake sender is no
 * longer free").
 *
 * The class shares its name with the `FakeMailSender` INTERFACE in `mail-sender.ts`, which
 * is what consumers type against; this file implements it under the same name so
 * `mail-sender.md`'s class table and its interface block name one thing.
 */
import type { FakeMailSender as FakeMailSenderPort, OutboundMail } from '../mail-sender';

export class FakeMailSender implements FakeMailSenderPort {
  private readonly recorded: OutboundMail[] = [];

  get sent(): ReadonlyArray<OutboundMail> {
    return this.recorded;
  }

  async send(message: OutboundMail): Promise<void> {
    this.recorded.push(message);
  }

  clear(): void {
    this.recorded.length = 0;
  }

  /** The most recent message addressed to `email`, exact match on `to`. */
  lastTo(email: string): OutboundMail | undefined {
    for (let index = this.recorded.length - 1; index >= 0; index -= 1) {
      const message = this.recorded[index];

      if (message !== undefined && message.to === email) {
        return message;
      }
    }

    return undefined;
  }
}
