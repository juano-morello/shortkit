import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../observability/logger';

import { MAIL_SENDER } from './mail-sender';
import type { MailSender } from './mail-sender';
import { MAIL_TRANSPORT_INVALID_MESSAGE, MailBindingError, RESEND_API_KEY_UNSET_MESSAGE } from './mail-transport';
import { MailModule, mailSenderFor } from './mail.module';
import { ConsoleMailSender } from './senders/console-mail-sender';
import { FakeMailSender } from './senders/fake-mail-sender';
import { NoopMailSender } from './senders/noop-mail-sender';
import { ResendMailSender } from './senders/resend-mail-sender';

/**
 * STORY-1b-01 — TASK-1b-02. The transport-to-class table in `docs/contracts/mail-sender.md`
 * ("The mail transport"), and the provider shape ("What the implementer must guarantee").
 *
 * `mailSenderFor` is the factory the module's `useFactory` calls with `process.env`; it is
 * driven here with explicit environments so the unit tier never sets `MAIL_TRANSPORT`. The
 * one compile of the module itself runs with the tier's own environment, which declares
 * nothing, and proves the token resolves to the noop sender in an undeclared process.
 */

describe('mailSenderFor', () => {
  it('binds the class the contract table names for each value, and NoopMailSender for unset', () => {
    expect({
      resend: mailSenderFor({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.test' }),
      console: mailSenderFor({ MAIL_TRANSPORT: 'console' }),
      fake: mailSenderFor({ MAIL_TRANSPORT: 'fake' }),
      none: mailSenderFor({ MAIL_TRANSPORT: 'none' }),
      unset: mailSenderFor({}),
    }).toEqual({
      resend: expect.any(ResendMailSender),
      console: expect.any(ConsoleMailSender),
      fake: expect.any(FakeMailSender),
      none: expect.any(NoopMailSender),
      unset: expect.any(NoopMailSender),
    });
  });

  it('refuses an unrecognised value rather than falling back to the noop sender', () => {
    // A testing module compiled without `main.ts` still cannot turn a typo into silence.
    expect(() => mailSenderFor({ MAIL_TRANSPORT: 'Resend' })).toThrow(new MailBindingError(MAIL_TRANSPORT_INVALID_MESSAGE));
  });

  it('refuses resend without its credential, so a factory reached past the boot assertion still cannot bind a keyless live sender', () => {
    expect(() => mailSenderFor({ MAIL_TRANSPORT: 'resend', MAIL_FROM: 'a@b.test' })).toThrow(
      new MailBindingError(RESEND_API_KEY_UNSET_MESSAGE),
    );
  });
});

describe('MailModule', () => {
  let moduleRef: TestingModule | null = null;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = null;
    vi.restoreAllMocks();
  });

  it('exports MAIL_SENDER, bound by the factory over process.env — NoopMailSender in a tier that declares nothing', async () => {
    // Guard 1 in `vitest.setup.ts` already refused this process if it declared `resend`.
    // The class is compared with what the factory resolves for THIS process rather than
    // hard-coded, so a developer running the tier under `MAIL_TRANSPORT=console` sees a
    // green test that measured the same thing; the repository's own runs declare nothing
    // and land on the noop sender, which the last expectation states for that case.
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    moduleRef = await Test.createTestingModule({ imports: [MailModule] }).compile();

    const sender = moduleRef.get<MailSender>(MAIL_SENDER);

    await expect(
      sender.send({ template: 'email_verification', to: 'a@b.test', data: { verificationUrl: 'https://x.test/#t', expiresAt: new Date(0) } }),
    ).resolves.toBeUndefined();

    expect(sender.constructor).toBe(mailSenderFor(process.env).constructor);

    if (process.env.MAIL_TRANSPORT === undefined) {
      expect(sender).toBeInstanceOf(NoopMailSender);
    }
  });
});
