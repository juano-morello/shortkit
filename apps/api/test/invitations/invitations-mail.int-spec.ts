import { createHash } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { invitationContract, workspaceContract } from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { closeDatabase } from '../../src/db/client';
import { MAIL_SENDER } from '../../src/mail/mail-sender';
import type { FakeMailSender, MailSender, OutboundMail } from '../../src/mail/mail-sender';
import { NoopMailSender, readMailSuppressedCount } from '../../src/mail/senders/noop-mail-sender';
import { logger } from '../../src/observability/logger';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  authServerEnv,
  clearSignupState,
  jwtClaims,
  mintToken,
  signIn,
  signUp,
  tenantRow,
  usersFor,
} from '../support/auth-fixture';
import { execSql, querySql } from '../support/psql';
import { assertAppRoleCannotBypassRls, migrationDsn } from '../support/rls-fixture';

/**
 * STORY-1b-01 — AC-1b-3, AC-1b-4, AC-1b-5: the mail leaves through the port, after commit,
 * exactly once per 201 and never for a non-2xx; with no transport bound the request still
 * answers 201 and the process writes one `mail_suppressed` warn line carrying `template`
 * and nothing else. TASK-1b-08, wave 3.
 *
 * Contract: `docs/contracts/mail-sender.md` (`FakeMailSender`, `NoopMailSender`, the warn
 * line), `tenant-context.md` (invariant 6), `logging-and-headers.md` (GC-G: no `to`, no URL,
 * no token on any line). ADR-0002, ADR-0017, ADR-0028.
 *
 * TWO IN-PROCESS APPLICATIONS FROM ONE `AppModule`, ONE CHILD. `MailModule`'s factory reads
 * `MAIL_TRANSPORT` when the module compiles, so the transport is chosen per application:
 * `fake` for AC-1b-3 and AC-1b-5 (`app.get(MAIL_SENDER)` is the recorder), unset for AC-1b-4
 * (`NoopMailSender`; the warn line is asserted on the shared pino instance with
 * `vi.spyOn(logger, 'warn')`, the way `senders.spec.ts` does, and the suppressed counter is
 * read through `readMailSuppressedCount()`). The child booted by `api-server.ts` only signs
 * up, signs in and mints; it sends nothing.
 *
 * `test/invitations/invitations.int-spec.ts` carries the route behaviour; this file carries
 * only what needs two transports.
 */

const EMAIL_A = 'wave3-mail-a@example.com';
const INVITEE = 'wave3-mail-invitee@example.com';
const WEB_ORIGIN = 'http://localhost:3000';

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

let fakeApp: INestApplication | undefined;
let fakeBaseUrl: string;
let fake: FakeMailSender;

let noopApp: INestApplication | undefined;
let noopBaseUrl: string;

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

async function request(origin: string, path: string, options: { method?: 'GET' | 'POST'; token?: string; body?: unknown } = {}): Promise<Probe> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { body: payload }),
  });
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, body, raw };
}

interface Principal {
  readonly token: string;
  readonly tenantId: string;
  readonly userId: string;
}

async function principalFor(email: string): Promise<Principal> {
  const signedUp = await signUp(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);
  const signedIn = await signIn(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);
  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  const token = (minted.body as { token?: unknown }).token as string;
  const claims = jwtClaims(token);
  const [user] = usersFor(email);
  expect(user?.id).toBe(claims.sub);

  return { token, tenantId: claims.tid as string, userId: claims.sub as string };
}

async function createWorkspace(origin: string, principal: Principal, name: string): Promise<string> {
  const created = await request(origin, '/api/workspaces', { method: 'POST', token: principal.token, body: { name } });
  expect(created.status, created.raw).toBe(201);

  return workspaceContract.parse(created.body).id;
}

function seedMembership(tenantId: string, workspaceId: string, userId: string, role: string): void {
  execSql(
    migrationDsn(),
    `INSERT INTO memberships (tenant_id, workspace_id, user_id, role)
     VALUES (:'tenant_id'::uuid, :'workspace_id'::uuid, :'user_id', :'role'::workspace_role)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    { tenantId, variables: { tenant_id: tenantId, workspace_id: workspaceId, user_id: userId, role } },
  );
}

interface InvitationDbRow extends Record<string, unknown> {
  id: string;
  digest_hex: string;
  expires_at: string;
}

function invitationsIn(tenantId: string): InvitationDbRow[] {
  return querySql<InvitationDbRow>(
    migrationDsn(),
    `SELECT id, encode(token_digest, 'hex') AS digest_hex, expires_at FROM invitations WHERE tenant_id = :'tenant'::uuid ORDER BY created_at`,
    { tenantId, variables: { tenant: tenantId } },
  );
}

/** AC-1b-1's caller with two admin workspaces (W1, W3) and one archived admin workspace (WX). */
async function fixture(origin: string): Promise<{ a: Principal; W1: string; W3: string; WX: string }> {
  const a = await principalFor(EMAIL_A);
  const W1 = await createWorkspace(origin, a, 'Alpha');
  const W3 = await createWorkspace(origin, a, 'Gamma');
  const WX = await createWorkspace(origin, a, 'Archived');
  seedMembership(a.tenantId, W1, a.userId, 'workspace_admin');
  seedMembership(a.tenantId, W3, a.userId, 'workspace_admin');
  seedMembership(a.tenantId, WX, a.userId, 'workspace_admin');
  const archived = await request(origin, `/api/workspaces/${WX}/archive`, { method: 'POST', token: a.token });
  expect(archived.status, archived.raw).toBe(200);

  return { a, W1, W3, WX };
}

async function buildApp(): Promise<{ app: INestApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
  await app.listen(0, '127.0.0.1');
  (app.getHttpServer() as Server).keepAliveTimeout = 0;

  return { app, baseUrl: await app.getUrl() };
}

beforeAll(() => {
  assertAppRoleCannotBypassRls();
  serverBoot = startApiServer({ env: authServerEnv });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;

  if (fakeApp === undefined) {
    vi.stubEnv('BETTER_AUTH_URL', server.baseUrl);
    vi.stubEnv('WEB_APP_ORIGINS', WEB_ORIGIN);

    vi.stubEnv('MAIL_TRANSPORT', 'fake');
    const fakeBuilt = await buildApp();
    fakeApp = fakeBuilt.app;
    fakeBaseUrl = fakeBuilt.baseUrl;
    fake = fakeApp.get<FakeMailSender>(MAIL_SENDER);

    vi.stubEnv('MAIL_TRANSPORT', undefined);
    const noopBuilt = await buildApp();
    noopApp = noopBuilt.app;
    noopBaseUrl = noopBuilt.baseUrl;
    expect(noopApp.get<MailSender>(MAIL_SENDER)).toBeInstanceOf(NoopMailSender);
  }

  fake.clear();
  clearSignupState(EMAIL_A);
}, 180_000);

afterAll(async () => {
  await fakeApp?.close();
  await noopApp?.close();
  await closeDatabase();
  vi.unstubAllEnvs();
  clearSignupState(EMAIL_A);
  await server?.stop();
});

describe('AC-1b-3: MAIL_TRANSPORT=fake — exactly one OutboundMail per 201, handed to the sender after commit', () => {
  it('one workspace_invitation to the invitee with the workspaces, the inviter, the tenant name, the row’s expiry and a fragment link whose token verifies against the stored digest', async () => {
    const { a, W1, W3 } = await fixture(fakeBaseUrl);
    const tenantName = tenantRow(a.tenantId)?.name;

    const created = await request(fakeBaseUrl, '/api/invitations', {
      method: 'POST',
      token: a.token,
      body: { email: INVITEE, workspaces: [{ workspaceId: W1, workspaceRole: 'member' }, { workspaceId: W3, workspaceRole: 'viewer' }] },
    });
    expect(created.status, created.raw).toBe(201);
    const invitation = invitationContract.parse(created.body);
    const [row] = invitationsIn(a.tenantId);
    expect(row).toBeDefined();

    expect(fake.sent).toHaveLength(1);
    const [message] = fake.sent as [Extract<OutboundMail, { template: 'workspace_invitation' }>];
    const url = new URL(message.data.inviteUrl);
    const raw = url.hash.slice('#token='.length);

    expect({
      template: message.template,
      to: message.to,
      workspaces: message.data.workspaces,
      inviterEmail: message.data.inviterEmail,
      tenantName: message.data.tenantName,
      expiresAt: message.data.expiresAt.toISOString(),
      link: `${url.origin}${url.pathname}${url.search}`,
      hashKey: url.hash.slice(0, '#token='.length),
      tokenLength: raw.length,
      tokenPrefix: raw.slice(0, 36),
      digestMatches: createHash('sha256').update(raw.slice(37), 'utf8').digest('hex') === row?.digest_hex,
      // The token is in the mail and nowhere in the response.
      tokenInResponse: created.raw.includes(raw.slice(37)),
    }).toEqual({
      template: 'workspace_invitation',
      to: INVITEE,
      workspaces: [
        { name: 'Alpha', role: 'member' },
        { name: 'Gamma', role: 'viewer' },
      ],
      inviterEmail: EMAIL_A,
      tenantName,
      expiresAt: invitation.expiresAt,
      link: `${WEB_ORIGIN}/invitations/accept`,
      hashKey: '#token=',
      tokenLength: 80,
      tokenPrefix: a.tenantId,
      digestMatches: true,
      tokenInResponse: false,
    });
  }, 60_000);
});

describe('AC-1b-5: a request that does not answer 2xx hands the sender nothing', () => {
  it('a 404 (a workspace the caller cannot administer) and a 400 (an archived workspace) leave the recorder empty and the table without a row', async () => {
    const { a, W1, WX } = await fixture(fakeBaseUrl);
    const post = (workspaces: unknown): Promise<Probe> =>
      request(fakeBaseUrl, '/api/invitations', { method: 'POST', token: a.token, body: { email: INVITEE, workspaces } });

    const notFound = await post([{ workspaceId: W1, workspaceRole: 'member' }, { workspaceId: '00000000-0000-4000-8000-000000000000', workspaceRole: 'member' }]);
    const archived = await post([{ workspaceId: W1, workspaceRole: 'member' }, { workspaceId: WX, workspaceRole: 'member' }]);

    expect({
      statuses: [notFound.status, archived.status],
      sent: fake.sent.length,
      rows: invitationsIn(a.tenantId).length,
    }).toEqual({ statuses: [404, 400], sent: 0, rows: 0 });
  }, 60_000);
});

describe('AC-1b-4: MAIL_TRANSPORT unset — the request still answers 201, nothing is sent, one warn line', () => {
  it('writes one mail_suppressed warn line with template workspace_invitation and no other field — no to, no URL, no token — and increments the suppressed counter', async () => {
    const { a, W1 } = await fixture(noopBaseUrl);
    const warn = vi.spyOn(logger, 'warn');
    const suppressedBefore = readMailSuppressedCount();

    try {
      const created = await request(noopBaseUrl, '/api/invitations', {
        method: 'POST',
        token: a.token,
        body: { email: INVITEE, workspaces: [{ workspaceId: W1, workspaceRole: 'member' }] },
      });
      expect(created.status, created.raw).toBe(201);
      const [row] = invitationsIn(a.tenantId);

      const suppressedLines = warn.mock.calls.filter(([, msg]) => msg === 'mail_suppressed');
      const bytes = JSON.stringify(suppressedLines);

      expect({
        lines: suppressedLines,
        counted: readMailSuppressedCount() - suppressedBefore,
        fakeUntouched: fake.sent.length,
        rowWritten: row !== undefined,
        toOnLine: bytes.includes(INVITEE),
        urlOnLine: bytes.includes('/invitations/accept'),
        digestOnLine: row !== undefined && bytes.includes(row.digest_hex),
      }).toEqual({
        lines: [[{ template: 'workspace_invitation' }, 'mail_suppressed']],
        counted: 1,
        fakeUntouched: 0,
        rowWritten: true,
        toOnLine: false,
        urlOnLine: false,
        digestOnLine: false,
      });
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});
