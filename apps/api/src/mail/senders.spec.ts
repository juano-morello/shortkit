import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKSPACE_ROLE } from '@shortkit/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { logger } from '../observability/logger';

import type { OutboundMail } from './mail-sender';
import { MailBindingError, RESEND_SENDER_NOT_DECLARED_MESSAGE } from './mail-transport';
import { CONSOLE_MAIL_FOOTER, CONSOLE_MAIL_HEADER, ConsoleMailSender, formatConsoleMail } from './senders/console-mail-sender';
import { FakeMailSender } from './senders/fake-mail-sender';
import { NoopMailSender, readMailSuppressedCount } from './senders/noop-mail-sender';
import { RESEND_EMAILS_URL, ResendMailSender } from './senders/resend-mail-sender';
import { renderMail } from './templates/render-mail';

/**
 * STORY-1b-01 — AC-1b-4 (the suppressed line), AC-1b-3 (the fake records). TASK-1b-02.
 *
 * Contract: `docs/contracts/mail-sender.md` (the class table, "Signal", "No test sends
 * mail", invariants 2–5). ADR-0017, ADR-0028, ADR-0029, GC-K.
 *
 * Every sender is exercised against a fixed invitation whose URL carries a recognisable
 * token marker and whose recipient is a recognisable address, so "never on a log line" is
 * asserted by searching every logged field for those bytes rather than by trusting a
 * field's name. `ResendMailSender` is driven through a fake `fetch`; nothing here opens a
 * socket, and the resend guard's own test is the one that proves a construction from a
 * non-resend environment refuses.
 */

const TOKEN_MARKER = 'TOKENMARKER_5x9Qb2vR8pL0mN4kJ7hG3fD1sA6zX2cV9bN8mQ';
const RECIPIENT = 'invitee-marker@example.test';
const INVITER = 'inviter-marker@example.test';
const API_KEY = 're_KEYMARKER_0123456789';
const FROM = 'Shortkit <from-marker@example.test>';

const INVITATION: OutboundMail = {
  template: 'workspace_invitation',
  to: RECIPIENT,
  data: {
    inviteUrl: `https://app.example.test/invitations/accept#token=${TOKEN_MARKER}`,
    inviterEmail: INVITER,
    tenantName: 'Acme Agency',
    workspaces: [
      { name: 'Campaigns', role: WORKSPACE_ROLE.member },
      { name: 'Reporting', role: WORKSPACE_ROLE.viewer },
    ],
    expiresAt: new Date('2026-08-25T15:04:00Z'),
  },
};

const VERIFICATION: OutboundMail = {
  template: 'email_verification',
  to: RECIPIENT,
  data: { verificationUrl: `https://app.example.test/verify#token=${TOKEN_MARKER}`, expiresAt: new Date('2026-08-19T00:00:00Z') },
};

/** Every string reachable from a logger call's record and message, for the "never logged" checks. */
function loggedBytes(calls: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return JSON.stringify(calls);
}

const RESEND_ENV = { MAIL_TRANSPORT: 'resend' } as const;

describe('NoopMailSender', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-1b-4: send resolves, counts, and writes one warn line with msg mail_suppressed and field template only', async () => {
    const before = readMailSuppressedCount();
    const sender = new NoopMailSender();

    await expect(sender.send(INVITATION)).resolves.toBeUndefined();
    await expect(sender.send(VERIFICATION)).resolves.toBeUndefined();

    expect({
      counted: readMailSuppressedCount() - before,
      lines: vi.mocked(logger.warn).mock.calls,
    }).toEqual({
      counted: 2,
      lines: [
        [{ template: 'workspace_invitation' }, 'mail_suppressed'],
        [{ template: 'email_verification' }, 'mail_suppressed'],
      ],
    });
  });

  it('GC-K: the suppressed line carries no address, no URL and no token', async () => {
    await new NoopMailSender().send(INVITATION);

    const bytes = loggedBytes(vi.mocked(logger.warn).mock.calls);

    expect({
      recipient: bytes.includes(RECIPIENT),
      inviter: bytes.includes(INVITER),
      token: bytes.includes(TOKEN_MARKER),
      url: bytes.includes('/invitations/accept'),
    }).toEqual({ recipient: false, inviter: false, token: false, url: false });
  });

  it('records nothing: there is no sent array on the noop sender', () => {
    // A long-lived process must not accumulate suppressed messages; `FakeMailSender` is
    // the one that records, and only under an explicit `fake` declaration.
    expect('sent' in new NoopMailSender()).toBe(false);
  });
});

describe('FakeMailSender', () => {
  it('records every message in order, answers lastTo by exact address, and clear empties it', async () => {
    const sender = new FakeMailSender();
    const other: OutboundMail = { ...INVITATION, to: 'someone-else@example.test' };

    await sender.send(INVITATION);
    await sender.send(other);
    await sender.send(VERIFICATION);

    const recorded = { sent: [...sender.sent], last: sender.lastTo(RECIPIENT), none: sender.lastTo('nobody@example.test') };

    sender.clear();

    expect({ ...recorded, afterClear: sender.sent.length }).toEqual({
      sent: [INVITATION, other, VERIFICATION],
      last: VERIFICATION,
      none: undefined,
      afterClear: 0,
    });
  });
});

describe('ConsoleMailSender', () => {
  // The spy is held rather than re-read through `console.log`, which the API-wide
  // `no-console` rule flags even in a spec; the sender's own file carries the one carve-out.
  let log: MockInstance<(...data: unknown[]) => void>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invariant 4: writes exactly the documented block, once, with the text part and the URL on its own line', async () => {
    await new ConsoleMailSender().send(INVITATION);

    const rendered = renderMail(INVITATION);
    const calls = log.mock.calls;

    expect(calls).toEqual([[formatConsoleMail(INVITATION)]]);
    expect(calls[0]?.[0]).toBe(
      [CONSOLE_MAIL_HEADER, `To: ${RECIPIENT}`, `Subject: ${rendered.subject}`, '', rendered.text, CONSOLE_MAIL_FOOTER].join('\n'),
    );
    expect(String(calls[0]?.[0]).split('\n')).toContain(INVITATION.data.inviteUrl);
  });

  it('prints the text part, never the HTML part', async () => {
    await new ConsoleMailSender().send(INVITATION);

    expect(String(log.mock.calls[0]?.[0])).not.toContain('<html');
  });
});

describe('ResendMailSender', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A fetch that answers the given statuses in order, or throws where a status is an Error. */
  function fakeFetch(answers: ReadonlyArray<number | Error>): { readonly fetch: typeof fetch; readonly requests: Array<{ url: string; init: RequestInit }> } {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let index = 0;

    const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), init: init ?? {} });
      const answer = answers[index] ?? new Error('fake fetch: more requests than answers');
      index += 1;

      if (answer instanceof Error) {
        throw answer;
      }

      return new Response('{"id":"resend-id"}', { status: answer });
    });

    return { fetch: impl as unknown as typeof fetch, requests };
  }

  it('guard 2: construction refuses unless the environment it is handed resolves to resend', () => {
    const outcomes = [{}, { MAIL_TRANSPORT: 'none' }, { MAIL_TRANSPORT: 'console' }, { MAIL_TRANSPORT: 'fake' }].map((env) => {
      try {
        new ResendMailSender(API_KEY, FROM, env);
        return 'constructed';
      } catch (error) {
        return error instanceof MailBindingError ? error.message : String(error);
      }
    });

    expect(outcomes).toEqual(Array<string>(4).fill(RESEND_SENDER_NOT_DECLARED_MESSAGE));
    expect(() => new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch: fakeFetch([]).fetch })).not.toThrow();
  });

  it('builds the documented request: POST /emails, bearer key, JSON body with from, to, subject, text, html', async () => {
    const { fetch, requests } = fakeFetch([200]);
    const rendered = renderMail(INVITATION);

    await new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch, replyTo: 'reply-marker@example.test' }).send(INVITATION);

    const [request] = requests;
    const headers = request?.init.headers as Record<string, string>;

    expect({
      count: requests.length,
      url: request?.url,
      method: request?.init.method,
      authorization: headers['authorization'],
      contentType: headers['content-type'],
      body: JSON.parse(String(request?.init.body)) as unknown,
    }).toEqual({
      count: 1,
      url: RESEND_EMAILS_URL,
      method: 'POST',
      authorization: `Bearer ${API_KEY}`,
      contentType: 'application/json',
      body: {
        from: FROM,
        to: [RECIPIENT],
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        reply_to: 'reply-marker@example.test',
      },
    });
  });

  it('omits reply_to when none is declared', async () => {
    const { fetch, requests } = fakeFetch([200]);

    await new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(INVITATION);

    expect(JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>).not.toHaveProperty('reply_to');
  });

  describe('Idempotency-Key (debt sweep 2026-08-19, ledger 1b-W1-08)', () => {
    /** The invitation dispatch sets the key to the invitation row's id — a uuid, not a secret. */
    const KEYED: OutboundMail = { ...INVITATION, idempotencyKey: 'f6b2b1e2-0f6a-4bb0-9d5f-2f4f4b6f8a10' };

    function sentKeys(requests: ReadonlyArray<{ init: RequestInit }>): Array<string | undefined> {
      return requests.map((request) => (request.init.headers as Record<string, string>)['Idempotency-Key']);
    }

    it('is sent on the first attempt and IDENTICAL on the 5xx retry, so a retry after a lost response cannot double-send', async () => {
      const { fetch, requests } = fakeFetch([503, 200]);

      await new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(KEYED);

      expect(sentKeys(requests)).toEqual([KEYED.idempotencyKey, KEYED.idempotencyKey]);
    });

    it('rides the network-error retry the same way — the lost-response case the ledger names', async () => {
      const { fetch, requests } = fakeFetch([new TypeError('fetch failed'), 200]);

      await new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(KEYED);

      expect(sentKeys(requests)).toEqual([KEYED.idempotencyKey, KEYED.idempotencyKey]);
    });

    it('is absent when the message carries no key: exactly the two documented headers go out', async () => {
      const { fetch, requests } = fakeFetch([200]);

      await new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(INVITATION);

      expect(Object.keys((requests[0]?.init.headers ?? {}) as Record<string, string>).sort()).toEqual([
        'authorization',
        'content-type',
      ]);
    });
  });

  it('invariant 2: a 2xx is accepted on the first attempt, no retry, no error line', async () => {
    const { fetch, requests } = fakeFetch([200]);

    await new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(INVITATION);

    expect({ requests: requests.length, errors: vi.mocked(logger.error).mock.calls.length }).toEqual({ requests: 1, errors: 0 });
  });

  it('retries once on a 5xx and succeeds silently when the retry is accepted', async () => {
    const { fetch, requests } = fakeFetch([503, 200]);

    await new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(INVITATION);

    expect({ requests: requests.length, errors: vi.mocked(logger.error).mock.calls.length }).toEqual({ requests: 2, errors: 0 });
  });

  it('retries once on a network error and succeeds silently when the retry is accepted', async () => {
    const { fetch, requests } = fakeFetch([new TypeError('fetch failed'), 200]);

    await new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(INVITATION);

    expect({ requests: requests.length, errors: vi.mocked(logger.error).mock.calls.length }).toEqual({ requests: 2, errors: 0 });
  });

  it('never retries a 4xx: one request, one mail_dispatch_failed line naming the status, and send still resolves', async () => {
    const { fetch, requests } = fakeFetch([422, 200]);

    await expect(new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(INVITATION)).resolves.toBeUndefined();

    const [call] = vi.mocked(logger.error).mock.calls;
    const fields = call?.[0] as Record<string, unknown>;

    expect({
      requests: requests.length,
      msg: call?.[1],
      template: fields['template'],
      err_name: fields['err_name'],
      err_message: fields['err_message'],
    }).toEqual({
      requests: 1,
      msg: 'mail_dispatch_failed',
      template: 'workspace_invitation',
      err_name: 'ResendRejectedError',
      err_message: 'Resend answered HTTP 422',
    });
  });

  it('invariant 3: two 5xx in a row is the final failure — two requests, one error line, send resolves', async () => {
    const { fetch, requests } = fakeFetch([500, 502, 200]);

    await expect(new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(INVITATION)).resolves.toBeUndefined();

    expect({
      requests: requests.length,
      errors: vi.mocked(logger.error).mock.calls.map(([fields, msg]) => [(fields as Record<string, unknown>)['err_message'], msg]),
    }).toEqual({ requests: 2, errors: [['Resend answered HTTP 502', 'mail_dispatch_failed']] });
  });

  it('invariant 3: a network error twice is reported with the platform error name and send resolves', async () => {
    const { fetch } = fakeFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]);

    await expect(new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(INVITATION)).resolves.toBeUndefined();

    const fields = vi.mocked(logger.error).mock.calls[0]?.[0] as Record<string, unknown>;

    expect({ err_name: fields['err_name'], err_message: fields['err_message'], template: fields['template'] }).toEqual({
      err_name: 'TypeError',
      err_message: 'fetch failed',
      template: 'workspace_invitation',
    });
  });

  it('invariant 3: a renderer throw (an invalid expiresAt) is a dispatch failure, not a throw into the caller', async () => {
    const { fetch, requests } = fakeFetch([200]);
    const broken: OutboundMail = { ...INVITATION, data: { ...INVITATION.data, expiresAt: new Date(Number.NaN) } };

    await expect(new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(broken)).resolves.toBeUndefined();

    expect({ requests: requests.length, msg: vi.mocked(logger.error).mock.calls[0]?.[1] }).toEqual({ requests: 0, msg: 'mail_dispatch_failed' });
  });

  it('ADR-0029 / GC-K: on every failure path no logged field carries the key, the From address, the recipient, the URL or the token', async () => {
    const paths = [
      fakeFetch([422]),
      fakeFetch([500, 500]),
      fakeFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]),
    ];

    for (const { fetch } of paths) {
      await new ResendMailSender(API_KEY, FROM, RESEND_ENV, { fetch }).send(INVITATION);
    }

    const bytes = loggedBytes([...vi.mocked(logger.error).mock.calls, ...vi.mocked(logger.warn).mock.calls]);

    expect({
      lines: vi.mocked(logger.error).mock.calls.length,
      key: bytes.includes(API_KEY),
      from: bytes.includes('from-marker'),
      recipient: bytes.includes(RECIPIENT),
      token: bytes.includes(TOKEN_MARKER),
      url: bytes.includes('/invitations/accept'),
    }).toEqual({ lines: 3, key: false, from: false, recipient: false, token: false, url: false });
  });
});

describe('who constructs ResendMailSender', () => {
  /**
   * The contract's "the factory is the only construction site for `ResendMailSender` in
   * shipped code". Comments and strings stripped, specs excluded, the same stripper the
   * other scans use.
   */
  const apiSource = fileURLToPath(new URL('../', import.meta.url));
  const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

  const constructing = readdirSync(apiSource, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.int-spec.ts'))
    .map((entry) => join(apiSource, entry))
    .filter((path) => {
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

      return /\bnew ResendMailSender\b/.test(code);
    })
    .map((path) => relative(repositoryRoot, path).split(sep).join('/'))
    .sort();

  it('mail-sender.md: exactly mail/mail.module.ts', () => {
    expect(constructing).toEqual(['apps/api/src/mail/mail.module.ts']);
  });
});
