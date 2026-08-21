/**
 * TASK-1b-08: the invitation mail: link shape, link base, and after-commit dispatch.
 *
 * Contract: docs/contracts/invitation-tokens.md ("Where the raw token actually travels",
 * mechanism A, D-03), mail-sender.md, tenant-context.md (invariants 5, 6), GC-G, GC-K.
 *
 *   1. `inviteUrlFor` / `renderInvitationMail`: `<origin>/invitations/accept#token=<raw>`:
 *      the token is in the FRAGMENT, not the path, not the query; the message is the
 *      `workspace_invitation` arm with the data the template needs.
 *   2. `inviteLinkOrigin`: the first concrete `WEB_APP_ORIGINS` entry, wildcards skipped,
 *      `InviteUrlOriginMissing` when none; read per call, not at import.
 *   3. `dispatchInvitationMailAfterCommit`: registers the send as an `afterCommit` hook on
 *      the ambient tenant transaction (a nested `withTenantTransaction`); the message is
 *      built INSIDE the hook; a throwing sender or a missing origin is ONE `mail_dispatch_failed`
 *      line with `template` and `err_name` and no address, URL or token, and does not
 *      propagate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MailSender, OutboundMail } from '../mail/mail-sender';
import { logger } from '../observability/logger';
import type * as TenantContext from '../tenancy/tenant-context';

import {
  dispatchInvitationMailAfterCommit,
  INVITATION_ACCEPT_PATH,
  InviteUrlOriginMissing,
  inviteLinkOrigin,
  inviteUrlFor,
  renderInvitationMail,
} from './invitation-mail';
import { issueCapabilityToken } from './tokens/capability-token';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EXPIRES_AT = new Date('2026-08-25T10:00:00.000Z');
const RAW = issueCapabilityToken(TENANT).raw;

/** What the fake `withTenantTransaction` saw: bodies run, hooks queued, in order. */
const events: string[] = [];
const queuedHooks: Array<() => Promise<void> | void> = [];

vi.mock('../tenancy/tenant-context', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantContext>();

  return {
    ...actual,
    withTenantTransaction: async <T>(
      tenantId: string,
      fn: (db: unknown) => Promise<T>,
      options?: TenantContext.TenantTransactionOptions,
    ): Promise<T> => {
      events.push(`body:${tenantId}`);
      const result = await fn({});
      if (options?.afterCommit !== undefined) {
        events.push('queued');
        queuedHooks.push(options.afterCommit);
      }
      return result;
    },
  };
});

class RecordingSender implements MailSender {
  readonly sent: OutboundMail[] = [];
  constructor(private readonly failWith?: unknown) {}
  async send(message: OutboundMail): Promise<void> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    this.sent.push(message);
  }
}

function message(webOrigin?: string): OutboundMail {
  return renderInvitationMail({
    raw: RAW,
    to: 'x@example.com',
    inviterEmail: 'owner@example.com',
    tenantName: 'Acme',
    workspaces: [
      { name: 'Design', role: 'member' as never },
      { name: 'Ops', role: 'viewer' as never },
    ],
    expiresAt: EXPIRES_AT,
    ...(webOrigin === undefined ? {} : { webOrigin }),
  });
}

async function runQueuedHooks(): Promise<void> {
  for (const hook of queuedHooks.splice(0)) {
    await hook();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  events.length = 0;
  queuedHooks.length = 0;
});

describe('the link (D-03, mechanism A)', () => {
  it('is <origin>/invitations/accept#token=<raw>: the token is the fragment and appears in neither path nor query', () => {
    const url = new URL(inviteUrlFor('http://localhost:3000', RAW));

    expect({
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      acceptPath: INVITATION_ACCEPT_PATH,
    }).toEqual({
      origin: 'http://localhost:3000',
      pathname: '/invitations/accept',
      search: '',
      hash: `#token=${RAW}`,
      acceptPath: '/invitations/accept',
    });
  });

  it('renderInvitationMail is the workspace_invitation arm with the data the template needs, in the inviter’s order', () => {
    expect(message('https://app.example.com')).toEqual({
      template: 'workspace_invitation',
      to: 'x@example.com',
      data: {
        inviteUrl: `https://app.example.com/invitations/accept#token=${RAW}`,
        inviterEmail: 'owner@example.com',
        tenantName: 'Acme',
        workspaces: [
          { name: 'Design', role: 'member' },
          { name: 'Ops', role: 'viewer' },
        ],
        expiresAt: EXPIRES_AT,
      },
    });
  });
});

describe('the link base is WEB_APP_ORIGINS’ first concrete entry', () => {
  it('takes the first entry, normalised, and reads the variable per call', () => {
    vi.stubEnv('WEB_APP_ORIGINS', 'https://app.example.com/, https://second.example.com');
    expect(inviteLinkOrigin()).toBe('https://app.example.com');
    expect(JSON.stringify(message().data)).toContain('https://app.example.com/invitations/accept#token=');

    vi.stubEnv('WEB_APP_ORIGINS', 'http://localhost:3000');
    expect(inviteLinkOrigin()).toBe('http://localhost:3000');
  });

  it('skips a wildcard entry: a pattern is not an address a browser can open', () => {
    vi.stubEnv('WEB_APP_ORIGINS', 'https://shortkit-*.vercel.app, https://app.example.com');
    expect(inviteLinkOrigin()).toBe('https://app.example.com');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['only a wildcard', 'https://shortkit-*.vercel.app'],
  ])('throws InviteUrlOriginMissing when the variable is %s, naming the variable and no value', (_label, value) => {
    vi.stubEnv('WEB_APP_ORIGINS', value);
    let thrown: unknown;
    try {
      inviteLinkOrigin();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InviteUrlOriginMissing);
    expect((thrown as Error).name).toBe('InviteUrlOriginMissing');
    expect((thrown as Error).message).toContain('WEB_APP_ORIGINS');
    expect((thrown as Error).message).not.toContain(RAW);
  });
});

describe('dispatchInvitationMailAfterCommit (GC-H, invariants 5 and 6)', () => {
  it('nests a withTenantTransaction on the tenant, sends NOTHING in the body, and sends exactly the built message once the hook runs', async () => {
    const sender = new RecordingSender();
    let built = 0;

    await dispatchInvitationMailAfterCommit(TENANT, sender, () => {
      built += 1;
      return message('http://localhost:3000');
    });

    // The body ran and the hook is queued; the message is not built and nothing is sent yet.
    expect({ events, built, sent: sender.sent.length }).toEqual({ events: [`body:${TENANT}`, 'queued'], built: 0, sent: 0 });

    await runQueuedHooks();

    expect({ built, sent: sender.sent }).toEqual({ built: 1, sent: [message('http://localhost:3000')] });
  });

  it('a sender that throws is one mail_dispatch_failed error line carrying template and err_name only, and the hook resolves', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const sender = new RecordingSender(new Error(`provider said no for ${RAW} to x@example.com`));

    await dispatchInvitationMailAfterCommit(TENANT, sender, () => message('http://localhost:3000'));
    await expect(runQueuedHooks()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    const [fields, msg] = error.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe('mail_dispatch_failed');
    expect(fields.template).toBe('workspace_invitation');
    expect(fields.err_name).toBe('Error');
    // The message (the field that could carry the address or the URL) is not on the record.
    expect(Object.keys(fields).sort()).toEqual(['err_name', 'err_stack', 'template']);
    const bytes = JSON.stringify(error.mock.calls);
    expect(bytes).not.toContain(RAW);
    expect(bytes).not.toContain('x@example.com');
    expect(bytes).not.toContain('/invitations/accept');
  });

  it('a missing origin is decided inside the hook: the row committed, the send is skipped, one line with err_name InviteUrlOriginMissing', async () => {
    vi.stubEnv('WEB_APP_ORIGINS', '');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const sender = new RecordingSender();

    await dispatchInvitationMailAfterCommit(TENANT, sender, () => message());
    await runQueuedHooks();

    expect({
      sent: sender.sent.length,
      lines: error.mock.calls.map(([fields, msg]) => [(fields as Record<string, unknown>).err_name, (fields as Record<string, unknown>).template, msg]),
    }).toEqual({ sent: 0, lines: [['InviteUrlOriginMissing', 'workspace_invitation', 'mail_dispatch_failed']] });
  });
});
