/**
 * Contract: docs/contracts/mail-sender.md ("What the implementer must guarantee": the
 *           `MAIL_SENDER` provider is a `useFactory` over `resolveMailTransport(process.env)`,
 *           the only construction site of `ResendMailSender` in shipped code)
 * ADR: adr-0017-email-provider.md
 * Produced by: TASK-1b-02
 * Consumed by: `InvitationsModule` (TASK-1b-08) imports this module and injects
 *              `@Inject(MAIL_SENDER) sender: MailSender`.
 *
 * One provider, one export. The factory runs when the module compiles, not when this file
 * is imported, so `AppModule` can be compiled in the unit tier with no mail variables set —
 * it resolves `none` and binds `NoopMailSender` — and the environment is read at
 * `NestFactory.create`, after `assertBootPreconditions()` has already refused an invalid or
 * incomplete declaration in `main.ts`. `mailSenderFor` is exported so `mail.module.spec.ts`
 * can drive the selection with an explicit environment; shipped code calls it with
 * `process.env` and nowhere else.
 */
import { Module } from '@nestjs/common';

import { MAIL_SENDER } from './mail-sender';
import type { MailSender } from './mail-sender';
import { readResendBinding, resolveMailTransport } from './mail-transport';
import { ConsoleMailSender } from './senders/console-mail-sender';
import { FakeMailSender } from './senders/fake-mail-sender';
import { NoopMailSender } from './senders/noop-mail-sender';
import { ResendMailSender } from './senders/resend-mail-sender';

/**
 * The bound sender for an environment. Exhaustive over `MailTransport`, so a fifth value in
 * `MAIL_TRANSPORTS` without a class here is a compile error — `mail-sender.md`'s "one value
 * per implementation" rule, held by the type checker rather than by review.
 *
 * `resolveMailTransport` throws on an unrecognised value rather than returning `none`, so a
 * module compiled without `main.ts`'s assertion (a testing module) still cannot turn a typo
 * into a silently suppressed sender.
 */
export function mailSenderFor(env: NodeJS.ProcessEnv): MailSender {
  const transport = resolveMailTransport(env);

  switch (transport) {
    case 'resend': {
      const binding = readResendBinding(env);

      return new ResendMailSender(binding.apiKey, binding.from, env, { replyTo: binding.replyTo });
    }
    case 'console':
      return new ConsoleMailSender();
    case 'fake':
      return new FakeMailSender();
    case 'none':
      return new NoopMailSender();
  }
}

@Module({
  providers: [{ provide: MAIL_SENDER, useFactory: (): MailSender => mailSenderFor(process.env) }],
  exports: [MAIL_SENDER],
})
export class MailModule {}
