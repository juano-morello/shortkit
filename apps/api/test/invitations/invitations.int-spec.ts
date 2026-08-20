import { createHash } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  acceptInvitationResponseContract,
  INVITATION_TTL_SECONDS,
  invitationContract,
  invitationListResponseContract,
  invitationPreviewContract,
  workspaceContract,
} from '@shortkit/contracts';
import type { Invitation } from '@shortkit/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { closeDatabase } from '../../src/db/client';
import { InvitationNotFoundError } from '../../src/invitations/errors';
import { INVITATION_ACCEPT_PATH } from '../../src/invitations/invitation-mail';
import { MAIL_SENDER } from '../../src/mail/mail-sender';
import type { FakeMailSender, OutboundMail } from '../../src/mail/mail-sender';
import { WorkspaceNotFoundError } from '../../src/workspaces/workspace-not-found.error';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  authServerEnv,
  clearSignupState,
  deleteMembershipFor,
  eraseTenant,
  jwtClaims,
  membershipsFor,
  mintToken,
  signIn,
  signUp,
  tenantRow,
  usersFor,
} from '../support/auth-fixture';
import { execSql, querySql } from '../support/psql';
import { assertAppRoleCannotBypassRls, migrationDsn } from '../support/rls-fixture';

/**
 * STORY-1b-01 / 03 / 05: AC-1b-1, 2, 13, 14, 15, 23, 24, 28, plus AC-1b-37's bucket on the
 * one `@Public()` route, against a live database. TASK-1b-08, wave 3.
 *
 * Contract: `docs/contracts/invitation-tokens.md`, `workspace-authorization.md` (the five
 * invitation rows; status rules), `mail-sender.md`, `rate-limit.md`, `error-envelope.md`.
 * D-01, D-03, D-04, D-09, D-11, D-12.
 *
 * ============================================================================
 * THE SAME TWO-PROCESS SHAPE AS `test/authorization/workspace-authorization.int-spec.ts`.
 * ============================================================================
 *
 * The child booted by `api-server.ts` signs users up, signs them in and mints real tokens
 * against a real `/api/auth/jwks`. The application under test is built from `AppModule` in
 * this process (the real guards, the three interceptors in the ruled order, the filter, the
 * real repositories and the real entry functions), with `MAIL_TRANSPORT=fake` so the ONE
 * place the raw token may be read from is `app.get(MAIL_SENDER).sent[i].data.inviteUrl`'s
 * fragment. That is how the lookup and accept legs get their token: the way a real invitee
 * does, out of the mail, and never out of a table (there is nothing there but a digest).
 *
 * THREE PRINCIPALS. `A` is the signup owner of tenant T and, once seeded, `workspace_admin`
 * of W1 and W3 and `member` of W2 (AC-1b-1's caller). `A2` signed up on its own and is then
 * MOVED into T as a tenant `member` (its own tenant erased) before it signs in and mints:
 * the existing same-tenant account STORY-1b-03 is about, which no shipped route can produce
 * yet. `B` is the owner of another tenant U with its own workspace WB.
 *
 * Workspaces are created through the real `POST /api/workspaces`; `memberships` rows are
 * seeded through the migrator under the tenant's flag with an UPSERT, so the fixture holds
 * whether or not the route already creates the creator's `workspace_admin` row (TASK-1b-06,
 * same wave).
 */

/**
 * ONE ADDRESS PER SIGN-UP, NEVER REUSED. The child charges sign-ins per address (5 per 15 min,
 * `signInPerEmail`, TASK-1b-09) and every test here signs in afresh, so a fixed address would
 * be refused from the sixth test on. Every address handed out is recorded so `clearSignupState`
 * can find the tenants it led to.
 */
const usedEmails = new Set<string>();
let addressCounter = 0;

function freshEmail(label: string): string {
  addressCounter += 1;
  const email = `wave3-inv-${label}-${String(addressCounter)}@example.com`;
  usedEmails.add(email);

  return email;
}

const INVITEE = 'wave3-invitee@example.com';

const NEVER_ISSUED = '00000000-0000-4000-8000-000000000000';
const WEB_ORIGIN = 'http://localhost:3000';
const TRUSTED_HEADER = 'x-test-client-ip';
const PUBLIC_IP_LIMIT = 30;

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

let app: INestApplication | undefined;
let baseUrl: string;
let mail: FakeMailSender;

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
  readonly retryAfter: string | null;
}

interface ProbeOptions {
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly token?: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

async function api(path: string, options: ProbeOptions = {}): Promise<Probe> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers ?? {}),
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

  return { status: response.status, body, raw, retryAfter: response.headers.get('retry-after') };
}

interface Principal {
  readonly token: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
}

async function signInAndMint(email: string): Promise<Principal> {
  const signedIn = await signIn(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);

  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  const token = (minted.body as { token?: unknown }).token;
  expect(typeof token).toBe('string');

  const claims = jwtClaims(token as string);
  const [user] = usersFor(email);
  expect(user, `no user row for ${email}`).toBeDefined();
  expect(user.id).toBe(claims.sub);

  return { token: token as string, tenantId: claims.tid as string, userId: claims.sub as string, email };
}

/** Sign up, sign in, mint: the signup owner of a fresh tenant. */
async function principalFor(label: string): Promise<Principal> {
  const email = freshEmail(label);
  const signedUp = await signUp(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);

  return signInAndMint(email);
}

/**
 * Sign up, then move the user into `tenantId` as a tenant `member` (its own tenant erased,
 * its `tenant_memberships` row re-created under the target's flag), and only THEN sign in
 * and mint, so the `tid` claim names the target. The state STORY-1b-03 is about.
 */
async function memberOf(label: string, tenantId: string): Promise<Principal> {
  const email = freshEmail(label);
  const signedUp = await signUp(server, email, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);
  const [user] = usersFor(email);
  expect(user).toBeDefined();

  for (const membership of membershipsFor(user.id)) {
    deleteMembershipFor(user.id, membership.tenantId);
    eraseTenant(membership.tenantId);
  }

  execSql(
    migrationDsn(),
    `INSERT INTO tenant_memberships (tenant_id, user_id, role)
     VALUES (:'tenant_id'::uuid, :'user_id', 'member'::tenant_role)`,
    { tenantId, variables: { tenant_id: tenantId, user_id: user.id } },
  );

  const principal = await signInAndMint(email);
  expect(principal.tenantId).toBe(tenantId);

  return principal;
}

async function createWorkspace(principal: Principal, name: string): Promise<string> {
  const created = await api('/api/workspaces', { method: 'POST', token: principal.token, body: { name } });
  expect(created.status, created.raw).toBe(201);

  return workspaceContract.parse(created.body).id;
}

/** UPSERT: holds whether or not `POST /api/workspaces` already wrote the creator's row. */
function seedMembership(tenantId: string, workspaceId: string, userId: string, role: string): void {
  execSql(
    migrationDsn(),
    `INSERT INTO memberships (tenant_id, workspace_id, user_id, role)
     VALUES (:'tenant_id'::uuid, :'workspace_id'::uuid, :'user_id', :'role'::workspace_role)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    { tenantId, variables: { tenant_id: tenantId, workspace_id: workspaceId, user_id: userId, role } },
  );
}

interface MembershipRow extends Record<string, unknown> {
  workspace_id: string;
  role: string;
}

function workspaceMembershipsOf(tenantId: string, userId: string): MembershipRow[] {
  return querySql<MembershipRow>(
    migrationDsn(),
    `SELECT workspace_id, role FROM memberships WHERE tenant_id = :'tenant'::uuid AND user_id = :'user' ORDER BY workspace_id`,
    { tenantId, variables: { tenant: tenantId, user: userId } },
  );
}

function membershipCountIn(tenantId: string): number {
  return (
    querySql<{ n: number }>(migrationDsn(), `SELECT count(*)::int AS n FROM memberships WHERE tenant_id = :'tenant'::uuid`, {
      tenantId,
      variables: { tenant: tenantId },
    })[0]?.n ?? -1
  );
}

interface InvitationDbRow extends Record<string, unknown> {
  id: string;
  state: string;
  digest_hex: string;
  accepted_by_user_id: string | null;
  grants: number;
}

function invitationsIn(tenantId: string): InvitationDbRow[] {
  return querySql<InvitationDbRow>(
    migrationDsn(),
    `SELECT i.id, i.state, encode(i.token_digest, 'hex') AS digest_hex, i.accepted_by_user_id,
            (SELECT count(*)::int FROM invitation_workspaces w WHERE w.invitation_id = i.id AND w.tenant_id = i.tenant_id) AS grants
       FROM invitations i WHERE i.tenant_id = :'tenant'::uuid ORDER BY i.created_at, i.id`,
    { tenantId, variables: { tenant: tenantId } },
  );
}

/** The one place the token may be read from: the fragment of the mail's link (D-03). */
function tokenInLastMailTo(email: string): { readonly raw: string; readonly message: OutboundMail } {
  const message = mail.lastTo(email);
  expect(message, `no mail was sent to ${email}`).toBeDefined();
  expect(message?.template).toBe('workspace_invitation');
  const url = new URL((message as Extract<OutboundMail, { template: 'workspace_invitation' }>).data.inviteUrl);
  expect({ origin: url.origin, pathname: url.pathname, search: url.search }).toEqual({
    origin: WEB_ORIGIN,
    pathname: INVITATION_ACCEPT_PATH,
    search: '',
  });
  expect(url.hash.startsWith('#token=')).toBe(true);
  const raw = url.hash.slice('#token='.length);
  expect(raw).toHaveLength(80);

  return { raw, message: message as OutboundMail };
}

async function invite(
  principal: Principal,
  workspaces: ReadonlyArray<{ workspaceId: string; workspaceRole: string }>,
  email = INVITEE,
): Promise<{ readonly invitation: Invitation; readonly raw: string; readonly probe: Probe }> {
  const sentBefore = mail.sent.length;
  const probe = await api('/api/invitations', { method: 'POST', token: principal.token, body: { email, workspaces } });
  expect(probe.status, probe.raw).toBe(201);
  const invitation = invitationContract.parse(probe.body);
  expect(mail.sent.length).toBe(sentBefore + 1);
  const { raw } = tokenInLastMailTo(email);

  return { invitation, raw, probe };
}

function lookup(token: unknown, headers: Readonly<Record<string, string>> = {}): Promise<Probe> {
  return api('/api/invitations/lookup', { method: 'POST', body: { token }, headers });
}

function accept(principal: Principal, token: unknown): Promise<Probe> {
  return api('/api/invitations/accept', { method: 'POST', token: principal.token, body: { token } });
}

const INVITATION_NOT_FOUND_BODY = new InvitationNotFoundError().toEnvelope();
const WORKSPACE_NOT_FOUND_BODY = new WorkspaceNotFoundError().toEnvelope();

function code(probe: Probe): unknown {
  return (probe.body as { code?: unknown }).code;
}

function fieldErrorKeys(probe: Probe): string[] {
  return Object.keys(((probe.body as { details?: { fieldErrors?: Record<string, unknown> } }).details?.fieldErrors ?? {})).sort();
}

beforeAll(() => {
  assertAppRoleCannotBypassRls();
  serverBoot = startApiServer({ env: authServerEnv });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;

  if (app === undefined) {
    vi.stubEnv('BETTER_AUTH_URL', server.baseUrl);
    // Read by `MailModule`'s factory at compile time and by `inviteLinkOrigin()` per send.
    vi.stubEnv('MAIL_TRANSPORT', 'fake');
    vi.stubEnv('WEB_APP_ORIGINS', WEB_ORIGIN);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    (app.getHttpServer() as Server).keepAliveTimeout = 0;
    mail = app.get<FakeMailSender>(MAIL_SENDER);
  }

  mail.clear();
  clearSignupState(...usedEmails);
}, 180_000);

// 60 s, not vitest's 10 s default: `clearSignupState` shells out to psql once per address
// (a `docker run` each where no local psql exists), and this file signs up ~15 of them.
afterAll(async () => {
  await app?.close();
  await closeDatabase();
  vi.unstubAllEnvs();
  clearSignupState(...usedEmails);
  await server?.stop();
}, 60_000);

/** AC-1b-1's caller: owner of T, workspace_admin of W1 and W3, member of W2. */
async function tenantWithThreeWorkspaces(): Promise<{ a: Principal; W1: string; W2: string; W3: string }> {
  const a = await principalFor('a');
  const W1 = await createWorkspace(a, 'Alpha');
  const W2 = await createWorkspace(a, 'Beta');
  const W3 = await createWorkspace(a, 'Gamma');
  seedMembership(a.tenantId, W1, a.userId, 'workspace_admin');
  seedMembership(a.tenantId, W2, a.userId, 'member');
  seedMembership(a.tenantId, W3, a.userId, 'workspace_admin');

  return { a, W1, W2, W3 };
}

describe('AC-1b-1, AC-1b-3, AC-1b-28, AC-1b-13, AC-1b-15: invite, one mail, public preview, signed-in accept', () => {
  it('a workspace_admin of W1 and W3 invites to both: 201 without a token, one row and two grants, one mail whose fragment token verifies against the digest; lookup needs no Authorization; a same-tenant member accepts and gains exactly the named rows', async () => {
    const { a, W1, W2, W3 } = await tenantWithThreeWorkspaces();
    const a2 = await memberOf('a2', a.tenantId);
    seedMembership(a.tenantId, W2, a2.userId, 'member');
    const tenantName = tenantRow(a.tenantId)?.name;
    expect(tenantName).toBeDefined();

    // --- create (AC-1b-1) ---
    const before = Date.now();
    const { invitation, raw, probe } = await invite(a, [
      { workspaceId: W1, workspaceRole: 'member' },
      { workspaceId: W3, workspaceRole: 'viewer' },
    ]);
    const ttl = (new Date(invitation.expiresAt).getTime() - new Date(invitation.createdAt).getTime()) / 1000;

    expect({
      state: invitation.state,
      email: invitation.email,
      workspaces: invitation.workspaces,
      ttlWithinFiveSeconds: Math.abs(ttl - INVITATION_TTL_SECONDS) <= 5,
      createdRecently: Math.abs(new Date(invitation.createdAt).getTime() - before) < 30_000,
      invitedByUserId: invitation.invitedByUserId,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt,
      hasTokenField: 'token' in (probe.body as object),
      rawInResponse: probe.raw.includes(raw) || probe.raw.includes(raw.slice(37)),
    }).toEqual({
      state: 'pending',
      email: INVITEE,
      workspaces: [
        { workspaceId: W1, workspaceName: 'Alpha', workspaceRole: 'member' },
        { workspaceId: W3, workspaceName: 'Gamma', workspaceRole: 'viewer' },
      ],
      ttlWithinFiveSeconds: true,
      createdRecently: true,
      invitedByUserId: a.userId,
      acceptedAt: null,
      revokedAt: null,
      hasTokenField: false,
      rawInResponse: false,
    });

    const rows = invitationsIn(a.tenantId);
    expect(rows).toHaveLength(1);
    expect({ id: rows[0]?.id, state: rows[0]?.state, grants: rows[0]?.grants, digestLength: rows[0]?.digest_hex.length }).toEqual({
      id: invitation.id,
      state: 'pending',
      grants: 2,
      digestLength: 64,
    });

    // --- the mail (AC-1b-3): after commit, through the port, and the token verifies against the digest ---
    const { message } = tokenInLastMailTo(INVITEE);
    const secret = raw.slice(37);
    expect(createHash('sha256').update(secret, 'utf8').digest('hex')).toBe(rows[0]?.digest_hex);
    expect(message.template === 'workspace_invitation' ? { ...message.data, inviteUrl: '<checked>' } : message).toEqual({
      inviteUrl: '<checked>',
      inviterEmail: a.email,
      tenantName,
      workspaces: [
        { name: 'Alpha', role: 'member' },
        { name: 'Gamma', role: 'viewer' },
      ],
      expiresAt: new Date(invitation.expiresAt),
    });
    expect(message.to).toBe(INVITEE);

    // --- the public preview (AC-1b-28): no Authorization header, no token in the answer ---
    const preview = await lookup(raw);
    expect(preview.status, preview.raw).toBe(200);
    expect(invitationPreviewContract.parse(preview.body)).toEqual({
      email: INVITEE,
      tenantName,
      inviterEmail: a.email,
      workspaces: [
        { workspaceName: 'Alpha', workspaceRole: 'member' },
        { workspaceName: 'Gamma', workspaceRole: 'viewer' },
      ],
      expiresAt: invitation.expiresAt,
    });
    expect(preview.raw).not.toContain(secret);
    expect(preview.raw).not.toContain(invitation.id);

    // --- the signed-in accept (AC-1b-13, AC-1b-15): a2 is member of W2 only, then gains W1 and W3 ---
    const tenantMembershipsBefore = membershipsFor(a2.userId);
    const accepted = await accept(a2, raw);
    expect(accepted.status, accepted.raw).toBe(200);
    expect(acceptInvitationResponseContract.parse(accepted.body)).toEqual({
      workspaces: [
        { workspaceId: W1, workspaceRole: 'member' },
        { workspaceId: W3, workspaceRole: 'viewer' },
      ].sort((x, y) => x.workspaceId.localeCompare(y.workspaceId)),
    });
    expect({
      memberships: workspaceMembershipsOf(a.tenantId, a2.userId),
      tenantMemberships: membershipsFor(a2.userId),
      state: invitationsIn(a.tenantId)[0]?.state,
      acceptedBy: invitationsIn(a.tenantId)[0]?.accepted_by_user_id,
    }).toEqual({
      memberships: [
        { workspace_id: W1, role: 'member' },
        { workspace_id: W2, role: 'member' },
        { workspace_id: W3, role: 'viewer' },
      ].sort((x, y) => x.workspace_id.localeCompare(y.workspace_id)),
      tenantMemberships: tenantMembershipsBefore,
      state: 'accepted',
      acceptedBy: a2.userId,
    });

    // Single use: the same token again is 409 and writes nothing.
    const rowsBefore = membershipCountIn(a.tenantId);
    const again = await accept(a2, raw);
    expect({ status: again.status, code: code(again), rows: membershipCountIn(a.tenantId) }).toEqual({
      status: 409,
      code: 'invitation_already_accepted',
      rows: rowsBefore,
    });
  }, 60_000);

  it('AC-1b-15: an existing workspace_admin membership wins over the invitation’s member (D-12), and the response still lists the workspace', async () => {
    const { a, W1 } = await tenantWithThreeWorkspaces();
    const a2 = await memberOf('a2', a.tenantId);
    seedMembership(a.tenantId, W1, a2.userId, 'workspace_admin');
    const { raw } = await invite(a, [{ workspaceId: W1, workspaceRole: 'member' }]);

    const accepted = await accept(a2, raw);

    expect(accepted.status, accepted.raw).toBe(200);
    expect({
      body: accepted.body,
      memberships: workspaceMembershipsOf(a.tenantId, a2.userId),
    }).toEqual({
      body: { workspaces: [{ workspaceId: W1, workspaceRole: 'member' }] },
      memberships: [{ workspace_id: W1, role: 'workspace_admin' }],
    });
  }, 60_000);
});

describe('AC-1b-28: malformed, unknown and prefix-swapped tokens are one 404; the token bodies are shape-checked and nothing more', () => {
  it('lookup answers the same body for garbage, a well-formed unknown token and a prefix swapped to another tenant, and reads nothing in that tenant', async () => {
    const { a, W1 } = await tenantWithThreeWorkspaces();
    const b = await principalFor('b');
    const { raw } = await invite(a, [{ workspaceId: W1, workspaceRole: 'member' }]);
    const swapped = `${b.tenantId}.${raw.slice(37)}`;
    const unknown = `${a.tenantId}.${'A'.repeat(43)}`;

    const results = await Promise.all([lookup('garbage'), lookup(unknown), lookup(swapped), lookup(`${NEVER_ISSUED}.${raw.slice(37)}`)]);

    expect(results.map((r) => [r.status, r.body])).toEqual(results.map(() => [404, INVITATION_NOT_FOUND_BODY]));
    // The real token still answers, so the four 404s were decisions, not a broken route.
    expect((await lookup(raw)).status).toBe(200);
    // Tenant U holds no invitation for the swapped prefix to have found.
    expect(invitationsIn(b.tenantId)).toEqual([]);
  }, 60_000);

  it('a body without a string token is 400 validation_failed under token, on both legs; accept with an unknown token is 404', async () => {
    const { a } = await tenantWithThreeWorkspaces();

    const [noBody, numberToken, emptyToken, acceptNoToken, acceptUnknown] = await Promise.all([
      api('/api/invitations/lookup', { method: 'POST', body: {} }),
      lookup(12345),
      lookup(''),
      api('/api/invitations/accept', { method: 'POST', token: a.token, body: {} }),
      accept(a, `${a.tenantId}.${'B'.repeat(43)}`),
    ]);

    expect([noBody, numberToken, emptyToken, acceptNoToken].map((r) => [r.status, code(r), fieldErrorKeys(r)])).toEqual([
      [400, 'validation_failed', ['token']],
      [400, 'validation_failed', ['token']],
      [400, 'validation_failed', ['token']],
      [400, 'validation_failed', ['token']],
    ]);
    expect([acceptUnknown.status, acceptUnknown.body]).toEqual([404, INVITATION_NOT_FOUND_BODY]);
  }, 60_000);
});

describe('AC-1b-2: what create refuses, and that it writes nothing when it does', () => {
  it('a workspace the caller is only member of is 403; another tenant’s and an unissued id are the same 404 as a missing workspace; an archived one is 400 under workspaces; the contract’s 400s key email and workspaces, and no row is written for any of them', async () => {
    const { a, W1, W2, W3 } = await tenantWithThreeWorkspaces();
    const b = await principalFor('b');
    const WB = await createWorkspace(b, 'B’s workspace');
    seedMembership(b.tenantId, WB, b.userId, 'workspace_admin');
    const archived = await api(`/api/workspaces/${W3}/archive`, { method: 'POST', token: a.token });
    expect(archived.status, archived.raw).toBe(200);

    const post = (body: unknown): Promise<Probe> => api('/api/invitations', { method: 'POST', token: a.token, body });
    const grants = (...workspaceIds: string[]): unknown[] => workspaceIds.map((workspaceId) => ({ workspaceId, workspaceRole: 'member' }));

    const asMember = await post({ email: INVITEE, workspaces: grants(W1, W2) });
    const otherTenant = await post({ email: INVITEE, workspaces: grants(W1, WB) });
    const neverIssued = await post({ email: INVITEE, workspaces: grants(NEVER_ISSUED, W1) });
    const archivedGrant = await post({ email: INVITEE, workspaces: grants(W1, W3) });
    const empty = await post({ email: INVITEE, workspaces: [] });
    const twentyOne = await post({
      email: INVITEE,
      workspaces: Array.from({ length: 21 }, (_, i) => ({ workspaceId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, workspaceRole: 'member' })),
    });
    const repeated = await post({ email: INVITEE, workspaces: grants(W1, W1) });
    const notUuid = await post({ email: INVITEE, workspaces: grants('not-a-uuid') });
    const badEmail = await post({ email: 'not-an-address', workspaces: grants(W1) });

    expect({
      asMember: [asMember.status, code(asMember)],
      otherTenant: [otherTenant.status, otherTenant.body],
      neverIssued: [neverIssued.status, neverIssued.body],
      archivedGrant: [archivedGrant.status, code(archivedGrant), fieldErrorKeys(archivedGrant)],
      empty: [empty.status, code(empty), fieldErrorKeys(empty)],
      twentyOne: [twentyOne.status, code(twentyOne), fieldErrorKeys(twentyOne)],
      repeated: [repeated.status, code(repeated), fieldErrorKeys(repeated)],
      notUuid: [notUuid.status, code(notUuid), fieldErrorKeys(notUuid)],
      badEmail: [badEmail.status, code(badEmail), fieldErrorKeys(badEmail)],
      rowsInT: invitationsIn(a.tenantId),
      rowsInU: invitationsIn(b.tenantId),
      mailsSent: mail.sent.length,
    }).toEqual({
      asMember: [403, 'insufficient_workspace_role'],
      otherTenant: [404, WORKSPACE_NOT_FOUND_BODY],
      neverIssued: [404, WORKSPACE_NOT_FOUND_BODY],
      archivedGrant: [400, 'validation_failed', ['workspaces']],
      empty: [400, 'validation_failed', ['workspaces']],
      twentyOne: [400, 'validation_failed', ['workspaces']],
      repeated: [400, 'validation_failed', ['workspaces']],
      notUuid: [400, 'validation_failed', ['workspaces']],
      badEmail: [400, 'validation_failed', ['email']],
      rowsInT: [],
      rowsInU: [],
      mailsSent: 0,
    });
  }, 60_000);
});

describe('AC-1b-14: a signed-in account of another tenant meets a 409 before any statement in T', () => {
  it('B accepting A’s token is 409 invitation_tenant_conflict; the invitation stays pending; no membership row anywhere for B', async () => {
    const { a, W1 } = await tenantWithThreeWorkspaces();
    const b = await principalFor('b');
    const { raw, invitation } = await invite(a, [{ workspaceId: W1, workspaceRole: 'member' }]);
    const rowsInT = membershipCountIn(a.tenantId);

    const conflict = await accept(b, raw);

    expect({
      status: conflict.status,
      code: code(conflict),
      state: invitationsIn(a.tenantId).find((row) => row.id === invitation.id)?.state,
      rowsInT: membershipCountIn(a.tenantId),
      rowsInU: membershipCountIn(b.tenantId),
      bTenantMemberships: membershipsFor(b.userId).map((row) => row.tenantId),
      rawInBody: conflict.raw.includes(raw.slice(37)),
    }).toEqual({
      status: 409,
      code: 'invitation_tenant_conflict',
      state: 'pending',
      rowsInT,
      rowsInU: 0,
      bTenantMemberships: [b.tenantId],
      rawInBody: false,
    });
  }, 60_000);
});

describe('AC-1b-23: the list is Form A on query.workspaceId', () => {
  it('workspace_admin of W1 sees every invitation naming W1, newest first, without a token; member is 403; another tenant’s admin and an unissued id are 404; no workspaceId is 400 workspace_id_required', async () => {
    const { a, W1, W3 } = await tenantWithThreeWorkspaces();
    const a2 = await memberOf('a2', a.tenantId);
    seedMembership(a.tenantId, W1, a2.userId, 'member');
    const b = await principalFor('b');

    const first = await invite(a, [{ workspaceId: W1, workspaceRole: 'member' }], 'first@example.com');
    const onlyW3 = await invite(a, [{ workspaceId: W3, workspaceRole: 'viewer' }], 'w3@example.com');
    const second = await invite(a, [{ workspaceId: W1, workspaceRole: 'viewer' }, { workspaceId: W3, workspaceRole: 'member' }], 'second@example.com');
    const revoked = await api(`/api/invitations/${first.invitation.id}`, { method: 'DELETE', token: a.token });
    expect(revoked.status, revoked.raw).toBe(200);

    const listed = await api(`/api/invitations?workspaceId=${W1}`, { token: a.token });
    expect(listed.status, listed.raw).toBe(200);
    const items = invitationListResponseContract.parse(listed.body).items;

    expect({
      ids: items.map((item) => item.id),
      states: items.map((item) => item.state),
      keys: [...new Set(items.flatMap((item) => Object.keys(item)))].sort(),
      onlyW3Listed: items.some((item) => item.id === onlyW3.invitation.id),
      secretsInBody: [first.raw, onlyW3.raw, second.raw].some((raw) => listed.raw.includes(raw.slice(37))),
    }).toEqual({
      ids: [second.invitation.id, first.invitation.id],
      states: ['pending', 'revoked'],
      keys: ['acceptedAt', 'acceptedByUserId', 'createdAt', 'email', 'expiresAt', 'id', 'invitedByUserId', 'revokedAt', 'state', 'workspaces'],
      onlyW3Listed: false,
      secretsInBody: false,
    });

    const [asMember, asOtherTenant, unissued, noWorkspace] = await Promise.all([
      api(`/api/invitations?workspaceId=${W1}`, { token: a2.token }),
      api(`/api/invitations?workspaceId=${W1}`, { token: b.token }),
      api(`/api/invitations?workspaceId=${NEVER_ISSUED}`, { token: a.token }),
      api('/api/invitations', { token: a.token }),
    ]);

    expect([
      [asMember.status, code(asMember)],
      [asOtherTenant.status, asOtherTenant.body],
      [unissued.status, unissued.body],
      [noWorkspace.status, code(noWorkspace)],
    ]).toEqual([
      [403, 'insufficient_workspace_role'],
      [404, WORKSPACE_NOT_FOUND_BODY],
      [404, WORKSPACE_NOT_FOUND_BODY],
      [400, 'workspace_id_required'],
    ]);
  }, 60_000);
});

describe('AC-1b-24, AC-1b-25: revoke is Form B on every named workspace, idempotent, and closes the token', () => {
  it('a workspace_admin of both revokes: 200 revoked with revokedAt; again is 200 with the same revokedAt; the token then answers 410 invitation_revoked on lookup and accept; an admin of W1 only and another tenant’s admin get 404; an accepted invitation is 409', async () => {
    const { a, W1, W3 } = await tenantWithThreeWorkspaces();
    const a2 = await memberOf('a2', a.tenantId);
    seedMembership(a.tenantId, W1, a2.userId, 'workspace_admin');
    const b = await principalFor('b');

    const both = await invite(a, [{ workspaceId: W1, workspaceRole: 'member' }, { workspaceId: W3, workspaceRole: 'viewer' }]);
    const other = await invite(a, [{ workspaceId: W1, workspaceRole: 'member' }, { workspaceId: W3, workspaceRole: 'viewer' }], 'other@example.com');
    // Names W1, where a2 already holds workspace_admin (D-12: the existing role wins), so a2
    // still has NO membership in W3 for the 404 below.
    const toAccept = await invite(a, [{ workspaceId: W1, workspaceRole: 'member' }], 'accepted@example.com');
    expect((await accept(a2, toAccept.raw)).status).toBe(200);

    const revoked = await api(`/api/invitations/${both.invitation.id}`, { method: 'DELETE', token: a.token });
    expect(revoked.status, revoked.raw).toBe(200);
    const revokedBody = invitationContract.parse(revoked.body);
    const again = await api(`/api/invitations/${both.invitation.id}`, { method: 'DELETE', token: a.token });
    const [lookedUp, accepted, byW1Admin, byOtherTenant, ofAccepted, unknownId, notUuid] = await Promise.all([
      lookup(both.raw),
      accept(a2, both.raw),
      api(`/api/invitations/${other.invitation.id}`, { method: 'DELETE', token: a2.token }),
      api(`/api/invitations/${other.invitation.id}`, { method: 'DELETE', token: b.token }),
      api(`/api/invitations/${toAccept.invitation.id}`, { method: 'DELETE', token: a.token }),
      api(`/api/invitations/${NEVER_ISSUED}`, { method: 'DELETE', token: a.token }),
      api('/api/invitations/not-a-uuid', { method: 'DELETE', token: a.token }),
    ]);

    expect({
      state: revokedBody.state,
      revokedAtSet: revokedBody.revokedAt !== null,
      againStatus: again.status,
      againRevokedAt: (again.body as Invitation).revokedAt,
      lookedUp: [lookedUp.status, code(lookedUp)],
      accepted: [accepted.status, code(accepted)],
      byW1Admin: [byW1Admin.status, byW1Admin.body],
      byOtherTenant: [byOtherTenant.status, byOtherTenant.body],
      ofAccepted: [ofAccepted.status, code(ofAccepted)],
      unknownId: [unknownId.status, unknownId.body],
      notUuid: [notUuid.status, notUuid.body],
      otherStillPending: invitationsIn(a.tenantId).find((row) => row.id === other.invitation.id)?.state,
    }).toEqual({
      state: 'revoked',
      revokedAtSet: true,
      againStatus: 200,
      againRevokedAt: revokedBody.revokedAt,
      lookedUp: [410, 'invitation_revoked'],
      accepted: [410, 'invitation_revoked'],
      byW1Admin: [404, WORKSPACE_NOT_FOUND_BODY],
      byOtherTenant: [404, INVITATION_NOT_FOUND_BODY],
      ofAccepted: [409, 'invitation_already_accepted'],
      unknownId: [404, INVITATION_NOT_FOUND_BODY],
      notUuid: [404, INVITATION_NOT_FOUND_BODY],
      otherStillPending: 'pending',
    });
  }, 60_000);
});

describe('AC-1b-37 on the real route: the @Public() lookup is charged per client address where a trusted header is declared', () => {
  it('the 31st POST /api/invitations/lookup from one address is 429 rate_limited with Retry-After; the same token from another address still answers', async () => {
    vi.stubEnv('CLIENT_TRUST_BOUNDARY', 'proxy');
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', TRUSTED_HEADER);
    try {
      const { a, W1 } = await tenantWithThreeWorkspaces();
      const { raw } = await invite(a, [{ workspaceId: W1, workspaceRole: 'member' }]);

      const results: Probe[] = [];
      for (let i = 0; i < PUBLIC_IP_LIMIT + 1; i += 1) {
        results.push(await lookup(raw, { [TRUSTED_HEADER]: '203.0.113.77' }));
      }
      const refused = results[PUBLIC_IP_LIMIT] as Probe;
      const other = await lookup(raw, { [TRUSTED_HEADER]: '203.0.113.78' });

      expect({
        admitted: new Set(results.slice(0, PUBLIC_IP_LIMIT).map((r) => r.status)),
        refused: [refused.status, code(refused)],
        retryAfter: Number.isInteger(Number(refused.retryAfter)) && Number(refused.retryAfter) >= 1,
        other: other.status,
      }).toEqual({ admitted: new Set([200]), refused: [429, 'rate_limited'], retryAfter: true, other: 200 });
    } finally {
      vi.stubEnv('CLIENT_TRUST_BOUNDARY', undefined);
      vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', undefined);
    }
  }, 60_000);
});
