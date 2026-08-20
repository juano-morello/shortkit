import { describe, expect, it } from 'vitest';

import { startApiServer } from '../support/api-server';
import { authServerEnv } from '../support/auth-fixture';

/**
 * STORY-1b-01: AC-1b-6. TASK-1b-02, wave 1.
 *
 * Contract: `docs/contracts/mail-sender.md` ("The boot assertion", "Error strings").
 * ADR-0017 (F-386), ADR-0040 (declared bindings), GC-B.
 *
 * ============================================================================
 * THIS BOOTS THE COMPOSITION ROOT, BECAUSE THE PROPERTY IS `main.ts`'S.
 * ============================================================================
 *
 * `mail-transport.spec.ts` proves the predicate and text-scans the call site; what neither
 * can prove is that a refusal crosses the process boundary as ONE labelled pino line
 * carrying `boot_precondition: 'mail_transport'`, which is what F-210's dynamic-import
 * arrangement in `main.ts` protects and what an operator reads. So, as
 * `auth-mount.int-spec.ts` does for the auth bindings and the trust boundaries, each case
 * builds and boots its own child through `api-server.ts` and asserts on its output.
 *
 * `authServerEnv()` sets no mail variable, which is the compose stack's state and the
 * repository's: every existing integration boot resolves `none`. The refusals here set the
 * variables ON THE CHILD ONLY. This vitest process never carries `MAIL_TRANSPORT=resend` or
 * a `RESEND_API_KEY` (`vitest.setup.ts` would have refused to import if it did), and no
 * case below declares a COMPLETE `resend` binding, so no child ever constructs the live
 * sender. A refusal is quick, but the build in front of it is not free; each case has a
 * budget of its own.
 */

const BOOT_TIMEOUT_MS = 90_000;

/** One pino line, parsed, for the assertions on the boot warn. */
function linesOf(output: string): ReadonlyArray<Record<string, unknown>> {
  return output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

describe('the mail transport boot assertion (AC-1b-6)', () => {
  it(
    'unset boots, serves, and writes exactly one warn line carrying boot_precondition mail_transport and no other field',
    async () => {
      const server = await startApiServer({ env: (baseUrl) => authServerEnv(baseUrl) });

      try {
        const response = await fetch(`${server.baseUrl}/api/auth/ok`);
        const mailLines = linesOf(server.output()).filter((line) => line['boot_precondition'] === 'mail_transport');

        expect({
          status: response.status,
          count: mailLines.length,
          level: mailLines[0]?.['level'],
          // pino's own base fields and the message; nothing about a transport, a key, an
          // address or a From. `msg` is a fixed string.
          keys: Object.keys(mailLines[0] ?? {}).sort(),
        }).toEqual({
          status: 200,
          count: 1,
          level: 'warn',
          keys: ['boot_precondition', 'env', 'level', 'msg', 'service', 'time'],
        });
      } finally {
        await server.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it.each([
    ['MAIL_TRANSPORT holds the wrong case (Resend)', { MAIL_TRANSPORT: 'Resend' }, /"boot_precondition":"mail_transport".*MAIL_TRANSPORT must be/],
    ['MAIL_TRANSPORT is a boolean-ish value (true)', { MAIL_TRANSPORT: 'true' }, /"boot_precondition":"mail_transport".*MAIL_TRANSPORT must be/],
    ['MAIL_TRANSPORT is resend and RESEND_API_KEY is unset', { MAIL_TRANSPORT: 'resend', MAIL_FROM: 'onboarding@resend.dev' }, /"boot_precondition":"mail_transport".*RESEND_API_KEY is not set/],
    ['MAIL_TRANSPORT is resend and MAIL_FROM is unset', { MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_fixture_not_a_real_key' }, /"boot_precondition":"mail_transport".*MAIL_FROM is not set/],
  ])(
    'AC-1b-6: boot refuses when %s',
    async (_case, override, expected) => {
      // The child inherits nothing mail-related from this process; the override is the
      // whole declaration. `startApiServer` puts the child's entire output in its rejection.
      await expect(
        startApiServer({ env: (baseUrl) => ({ ...authServerEnv(baseUrl), ...override }) }),
      ).rejects.toThrow(expected);
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'ADR-0029: a refusal never echoes the configured values back',
    async () => {
      const key = 're_MARKER_value_that_must_not_appear';

      const failure: unknown = await startApiServer({
        env: (baseUrl) => ({ ...authServerEnv(baseUrl), MAIL_TRANSPORT: 'resend', RESEND_API_KEY: key }),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      const message = failure instanceof Error ? failure.message : 'the boot did not refuse';

      // The child's whole output is in the message: the labelled refusal is there, the
      // key is not. (MAIL_FROM is what is missing, so the key was read and could have leaked.)
      expect({ refused: /"boot_precondition":"mail_transport".*MAIL_FROM is not set/.test(message), leaked: message.includes(key) }).toEqual({
        refused: true,
        leaked: false,
      });
    },
    BOOT_TIMEOUT_MS,
  );
});
