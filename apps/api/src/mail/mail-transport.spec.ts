import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../observability/logger';

import {
  MAIL_FROM_UNSET_MESSAGE,
  MAIL_TRANSPORTS,
  MAIL_TRANSPORT_INVALID_MESSAGE,
  MailBindingError,
  RESEND_API_KEY_UNSET_MESSAGE,
  assertMailTransportConfigured,
  readResendBinding,
  resolveMailTransport,
} from './mail-transport';

/**
 * STORY-1b-01: AC-1b-6. TASK-1b-02, wave 1.
 *
 * Contract: `docs/contracts/mail-sender.md` ("The mail transport", "The boot assertion",
 * "Error strings", "What the implementer must guarantee"). ADR-0017 (F-386), ADR-0040 (the
 * declared-binding shape), ADR-0029 (no configured value in error text), GC-B.
 *
 * THE PREDICATE IS TESTED HERE; THE BOOT IS TESTED IN `test/mail/mail-transport-boot.int-spec.ts`.
 * The same split `boot-assertions.spec.ts` records for the auth bindings, for the same
 * reason: a predicate that reads an env record and returns does not need a child process,
 * and the one thing that does (that `main.ts` calls it, unconditionally, before it listens)
 * is a text scan at the bottom of this file, in the idiom `boot-assertions.spec.ts` and
 * `context-flag-owners.spec.ts` already use (importing `main.ts` boots the API).
 *
 * The scans at the end are the ones GC-B asks for: `MAIL_TRANSPORT` is read in exactly one
 * file, and nothing under `mail/` names `NODE_ENV` in code.
 */

type Outcome = { readonly returned: unknown } | { readonly refusedWith: string; readonly binding: unknown };

/**
 * A refusal is reported by its class and its `binding`, and by the exact message: the
 * messages here are the contract's own five constants, exact by contract, so unlike the
 * auth bindings' prose they ARE part of the assertion. Anything that is not a
 * `MailBindingError` stringifies and fails the comparison loudly.
 */
function outcomeOf(run: () => unknown): Outcome {
  try {
    return { returned: run() };
  } catch (error) {
    return error instanceof MailBindingError
      ? { refusedWith: error.message, binding: error.binding }
      : { refusedWith: String(error), binding: undefined };
  }
}

const refused = (message: string): Outcome => ({ refusedWith: message, binding: 'mail_transport' });

describe('resolveMailTransport', () => {
  it('mail-sender.md: unset and empty resolve to none, and each declared value resolves to itself', () => {
    expect({
      unset: resolveMailTransport({}),
      empty: resolveMailTransport({ MAIL_TRANSPORT: '' }),
      ...Object.fromEntries(MAIL_TRANSPORTS.map((value) => [value, resolveMailTransport({ MAIL_TRANSPORT: value })])),
    }).toEqual({ unset: 'none', empty: 'none', resend: 'resend', console: 'console', fake: 'fake', none: 'none' });
  });

  it.each([['Resend'], ['RESEND'], [' resend'], ['resend '], ['prod'], ['production'], ['true'], ['1'], ['noop'], ['smtp']])(
    'mail-sender.md check 1: %j refuses rather than falling back to none; exact match, no trimming, no case folding',
    (value) => {
      expect(outcomeOf(() => resolveMailTransport({ MAIL_TRANSPORT: value }))).toEqual(
        refused(MAIL_TRANSPORT_INVALID_MESSAGE),
      );
    },
  );
});

describe('assertMailTransportConfigured', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('check 1 is unconditional: an unrecognised value refuses whatever else is set', () => {
    // A key and a From address beside the typo must not rescue it: the typo is the defect.
    expect(
      outcomeOf(() =>
        assertMailTransportConfigured({ MAIL_TRANSPORT: 'Resend', RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.test' }),
      ),
    ).toEqual(refused(MAIL_TRANSPORT_INVALID_MESSAGE));
  });

  it('check 2 is conditional: resend refuses without the key, then without the From address, and passes with both', () => {
    expect({
      noKey: outcomeOf(() => assertMailTransportConfigured({ MAIL_TRANSPORT: 'resend', MAIL_FROM: 'a@b.test' })),
      emptyKey: outcomeOf(() =>
        assertMailTransportConfigured({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: ' ', MAIL_FROM: 'a@b.test' }),
      ),
      noFrom: outcomeOf(() => assertMailTransportConfigured({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_x' })),
      emptyFrom: outcomeOf(() =>
        assertMailTransportConfigured({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_x', MAIL_FROM: '' }),
      ),
      both: outcomeOf(() =>
        assertMailTransportConfigured({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.test' }),
      ),
    }).toEqual({
      noKey: refused(RESEND_API_KEY_UNSET_MESSAGE),
      emptyKey: refused(RESEND_API_KEY_UNSET_MESSAGE),
      noFrom: refused(MAIL_FROM_UNSET_MESSAGE),
      emptyFrom: refused(MAIL_FROM_UNSET_MESSAGE),
      both: { returned: undefined },
    });
  });

  it('check 3: console, fake, none and unset assert nothing, whatever the resend variables hold', () => {
    // A stray key in a `console` environment is not an error: the requirement is
    // conditional on the value, and only `resend` reads the credential.
    expect(
      ['console', 'fake', 'none', undefined].map((value) =>
        outcomeOf(() => assertMailTransportConfigured({ MAIL_TRANSPORT: value, RESEND_API_KEY: '', MAIL_FROM: '' })),
      ),
    ).toEqual([{ returned: undefined }, { returned: undefined }, { returned: undefined }, { returned: undefined }]);
  });

  it('AC-1b-6: none (explicit or by absence) writes exactly one warn line carrying boot_precondition and no other field', () => {
    const warn = vi.mocked(logger.warn);

    assertMailTransportConfigured({});
    assertMailTransportConfigured({ MAIL_TRANSPORT: 'none' });

    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
      { boot_precondition: 'mail_transport' },
      { boot_precondition: 'mail_transport' },
    ]);
  });

  it('the warn line fires for none only: console, fake and a complete resend write nothing at boot', () => {
    const warn = vi.mocked(logger.warn);

    assertMailTransportConfigured({ MAIL_TRANSPORT: 'console' });
    assertMailTransportConfigured({ MAIL_TRANSPORT: 'fake' });
    assertMailTransportConfigured({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.test' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('ADR-0029: no refusal interpolates a configured value', () => {
    const key = 're_SECRET_VALUE_9f8e7d';
    const from = 'operator-secret-from@example.test';
    const typo = 'Resend-with-a-marker-value';

    const messages = [
      outcomeOf(() => assertMailTransportConfigured({ MAIL_TRANSPORT: typo, RESEND_API_KEY: key, MAIL_FROM: from })),
      outcomeOf(() => assertMailTransportConfigured({ MAIL_TRANSPORT: 'resend', MAIL_FROM: from })),
      outcomeOf(() => assertMailTransportConfigured({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: key })),
    ].map((outcome) => ('refusedWith' in outcome ? outcome.refusedWith : ''));

    expect(messages.some((message) => message.includes(key) || message.includes(from) || message.includes(typo))).toBe(false);
  });
});

describe('readResendBinding', () => {
  it('returns the key, the From address and an optional reply-to, with empty reply-to read as absent', () => {
    expect({
      withReplyTo: readResendBinding({ RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.test', MAIL_REPLY_TO: 'r@b.test' }),
      emptyReplyTo: readResendBinding({ RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.test', MAIL_REPLY_TO: '' }),
      noReplyTo: readResendBinding({ RESEND_API_KEY: 're_x', MAIL_FROM: 'a@b.test' }),
    }).toEqual({
      withReplyTo: { apiKey: 're_x', from: 'a@b.test', replyTo: 'r@b.test' },
      emptyReplyTo: { apiKey: 're_x', from: 'a@b.test', replyTo: undefined },
      noReplyTo: { apiKey: 're_x', from: 'a@b.test', replyTo: undefined },
    });
  });
});

/**
 * Comments and string literals stripped, so a docblock saying "never reads NODE_ENV" and
 * the contract's own refusal text ("It is not NODE_ENV and it is not a boolean", carried
 * verbatim as a constant) do not satisfy or fail the scan. What is left is code, and a read
 * is `process.env.X`, `env.X`, `env['X']` or a destructuring: the bare token is what is
 * scanned for. The same stripper `boot-assertions.spec.ts` uses.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}

const apiSource = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Every shipped `.ts` under `apps/api/src`, repository-relative with forward slashes. */
function shippedSources(): ReadonlyArray<{ readonly path: string; readonly code: string }> {
  return readdirSync(apiSource, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.int-spec.ts'))
    .map((entry) => join(apiSource, entry))
    .map((path) => ({
      path: relative(repositoryRoot, path).split(sep).join('/'),
      code: codeOnly(readFileSync(path, 'utf8')),
    }));
}

describe('who reads the mail variables (GC-B, mail-sender.md "What the implementer must guarantee")', () => {
  it('MAIL_TRANSPORT is named in code by exactly mail/mail-transport.ts', () => {
    // The two functions the contract names both live there, and `resolveMailTransport` is
    // the one read; every other module (the resend guard, the module factory, `main.ts`)
    // reaches the value through a call whose identifier does not contain the token.
    // A SUBSTRING match on purpose: `MAIL_TRANSPORT_ENV`, `MAIL_TRANSPORTS` and the message
    // constants all carry the token, and any of them imported into a second file is that
    // file taking an interest in the variable, which is what this test is for.
    const naming = shippedSources()
      .filter(({ code }) => code.includes('MAIL_TRANSPORT'))
      .map(({ path }) => path)
      .sort();

    expect(naming).toEqual(['apps/api/src/mail/mail-transport.ts']);
  });

  it('nothing under apps/api/src/mail/** names NODE_ENV in code', () => {
    // GC-B and F-386. The struck rule keyed the live provider on the build flag
    // `Dockerfile:83` sets unconditionally; no file under `mail/` may reintroduce a read.
    const offenders = shippedSources()
      .filter(({ path }) => path.startsWith('apps/api/src/mail/'))
      .filter(({ code }) => /\bNODE_ENV\b/.test(code))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('there are files under apps/api/src/mail/** for the scan to cover', () => {
    // A rename that empties the directory would make the test above vacuously green.
    expect(shippedSources().filter(({ path }) => path.startsWith('apps/api/src/mail/')).length).toBeGreaterThan(5);
  });
});

describe('the call site in main.ts', () => {
  /**
   * A TEXT SCAN, AND THE LOAD-BEARING TEST IN THIS FILE, for the reason
   * `boot-assertions.spec.ts` gives: nothing above executes the boot path, and a perfect
   * predicate nobody calls is the shape F-116 found. It reads `main.ts` rather than
   * importing it because importing it runs `bootstrap()`.
   */
  const main = readFileSync(fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8');
  const code = codeOnly(main);

  it('mail-sender.md: main.ts calls assertMailTransportConfigured before it listens', () => {
    const called = code.indexOf('assertMailTransportConfigured(');
    const listen = code.indexOf('.listen(');

    expect({ called: called !== -1, beforeListen: called !== -1 && called < listen }).toEqual({
      called: true,
      beforeListen: true,
    });
  });

  it('mail-sender.md: the call is unconditional, not wrapped in an `if` on the same line', () => {
    // The gating is inside the function. A caller that guards it on any variable would
    // reintroduce a way to skip check 1 in some environment.
    const line = code.split('\n').find((candidate) => candidate.includes('assertMailTransportConfigured('));

    expect(line?.trim()).toBe('assertMailTransportConfigured(process.env);');
  });

  it('F-245: bootstrap().catch maps MailBindingError.binding onto boot_precondition', () => {
    // The refusal is only useful if it crosses the process boundary as the labelled line the
    // integration boot suite greps for. `AuthBindingError` is mapped the same way.
    expect(code).toContain('error instanceof MailBindingError ? { boot_precondition: error.binding }');
  });
});
