// NestJS dependency injection reads metadata written by the decorator
// transform; `reflect-metadata` installs the registry it reads from.
import 'reflect-metadata';

import { MAIL_TEST_GUARD_MESSAGE } from './src/mail/mail-transport';

// ============================================================================
// GUARD 1 OF 2: NO TEST PROCESS MAY BE ABLE TO SEND MAIL (ADR-0017, F-386).
// ============================================================================
//
// Thrown at import, before any spec runs, in both the unit and the integration tier (both
// configs name this file). Guard 2 is `ResendMailSender`'s constructor refusing unless
// `MAIL_TRANSPORT` is `resend`. A test would have to defeat both to reach the network, and
// defeating both means setting two variables on purpose. NEITHER GUARD READS `NODE_ENV`:
// vitest sets it, and a `tsx` script or a child process with an explicit `env` does not,
// which is why the previous guards were not guards (`docs/contracts/mail-sender.md`).
//
// "Set" is set and non-empty. `RESEND_API_KEY=` is what an env file produces for an absent
// variable, and it cannot authenticate anything.
if (
  (process.env.RESEND_API_KEY !== undefined && process.env.RESEND_API_KEY !== '') ||
  process.env.MAIL_TRANSPORT === 'resend'
) {
  throw new Error(MAIL_TEST_GUARD_MESSAGE);
}
