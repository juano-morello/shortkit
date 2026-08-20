import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { issueCapabilityToken } from '../../src/invitations/tokens/capability-token';
import { CONSOLE_MAIL_FOOTER, CONSOLE_MAIL_HEADER } from '../../src/mail/senders/console-mail-sender';
import { LOGGABLE_FIELDS, REDACT_CENSOR } from '../../src/observability/logger';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  SIGNUP_NAME,
  authRequest,
  authServerEnv,
  clearSignupState,
  jwtClaims,
  mintToken,
  sessionTokenCookie,
  signIn,
  signUp,
  usersFor,
} from '../support/auth-fixture';
import { execSql } from '../support/psql';
import { migrationDsn } from '../support/rls-fixture';

/**
 * STORY-006: AC-33, AC-34, AC-35: SC-5, measured on the bytes the process wrote. TASK-016,
 * wave 8.
 *
 * Contract: `docs/contracts/logging-and-headers.md` ("Required fields", "What may never appear
 * in a log line", "A field reaches a line only if it is named"). ADR-0028, ADR-0013 (the auth
 * mount is outside the Nest graph), ADR-0052 / ADR-0060 (Better Auth's logger is bound to
 * pino at `warn`). Enforces GC-9.
 *
 * ============================================================================
 * THE WHOLE PROCESS'S OUTPUT, DURING A REAL SIGNUP, SIGN-IN, MINT AND WORKSPACE FLOW.
 * ============================================================================
 *
 * `api-server.ts` boots `dist/main.js` as a child and captures its stdout AND stderr into
 * one string. That is the capture AC-33 needs and the one an in-process `AppModule` cannot
 * give: Better Auth is mounted on Express outside the Nest module graph (ADR-0013), so no
 * Nest interceptor sees `/api/auth/*`, and a suite that scanned only the lines an interceptor
 * produced would report a clean result for the surface it could not see. Every request here
 * (the auth ones and the workspace ones) goes to the CHILD, and every assertion is over
 * `server.output()`.
 *
 * NON-VACUITY FIRST (F-295, the reason `foundation`'s SC-1 closed untestable). Nothing in
 * `apps/api/src` wrote a per-request line before TASK-016, and "no credential in zero lines"
 * is true of any process. So the first assertion is that the request path EMITTED lines (a
 * non-zero count, on the workspace routes, with the tenant of the signup on them), and only
 * then that the email address, the password, the session token and the JWT are absent from
 * every byte the process wrote.
 *
 * `LOG_LEVEL` is pinned to `info` in the child's environment: it is the level the deployed
 * image runs at (no `LOG_LEVEL` in the `Dockerfile`) and the level the request line is
 * written at. Left to inherit, a developer shell exporting `LOG_LEVEL=error` would silence
 * the request lines and the non-vacuity assertion would fail for a reason unrelated to the
 * code: correctly, but confusingly.
 *
 * ============================================================================
 * SINCE TASK-1b-10 THE FLOW CARRIES THE INVITATION LEGS TOO: SC-5 EXTENDED (STORY-1b-07).
 * ============================================================================
 *
 * The same child, the same capture, more requests: after the workspace routes the owner
 * creates a second (unarchived) workspace and invites an address to it through the REAL
 * `POST /api/invitations` (the token that route issued is rendered into a message and
 * dropped: `MAIL_TRANSPORT` is UNSET in this child, so `NoopMailSender` is bound:
 * `authServerEnv` declares no transport and this file keeps it that way ON PURPOSE, AC-1b-35:
 * with the transport unset the token and the address must appear NOWHERE, and the only way to
 * measure that is to run the whole flow with it unset). To then drive lookup, invited signup,
 * sign-in and accept, the test needs a raw token it HOLDS, and a token the route issued is by
 * design unrecoverable, so two more invitations are planted the way the invitation specs
 * plant them: `issueCapabilityToken` in this process, the digest inserted under the migrator
 * with the tenant flag, the raw value in a local variable and nowhere else. The invitee signs
 * up WITH the token (the Better Auth `hooks.before` + `onUserCreated` invited branch, in the
 * child, outside the Nest graph; exactly the surface an in-process app cannot see), signs
 * in, mints, lists its workspaces; the owner accepts the third invitation as an existing
 * member and is refused twice with fixed-string 409s. AC-1b-36: the `lookup` and `accept`
 * request lines carry the route PATTERN and no body-derived field.
 *
 * AC-1b-34 IS A SECOND CHILD, booted with `MAIL_TRANSPORT=console`: the raw token and the
 * invited address must appear ONLY inside the `ConsoleMailSender` block (delimited by its own
 * header and footer lines) and on no line that parses as JSON. There the token is read the
 * way a real invitee reads it (out of the rendered mail) and driven through lookup and the
 * invited signup, so the token crosses the auth mount's body parser and hooks with the console
 * transport bound.
 *
 * WHAT IS SCANNED FOR, AND WHY EACH IS A SUBSTRING RATHER THAN A FIELD. A password, a session
 * token and a JWT are not fields: they are bytes that can sit inside `msg`, inside
 * `err_message`, inside `err_stack`, inside a censored container's stringified `toJSON`
 * (F-265). So the scan is `String.includes` over the whole captured output, and for the two
 * tokens it also looks for the pieces a serialiser might have split them into: the cookie
 * value URL-decoded and its token half before the `.`, and each of the JWT's three base64url
 * segments on its own.
 */

const EMAIL = 'wave8-no-credentials-in-logs@example.com';
/** The invited address of the main (transport-unset) child; signed up WITH the held token. */
const INVITED_EMAIL = 'wave8-invited-no-credentials-in-logs@example.com';
/** The two addresses of the console-transport child (AC-1b-34). */
const CONSOLE_OWNER_EMAIL = 'wave8-console-owner-no-credentials-in-logs@example.com';
const CONSOLE_INVITED_EMAIL = 'wave8-console-invited-no-credentials-in-logs@example.com';

/**
 * A pattern for the fragment the console block carries: `#token=<uuid>.<43 base64url>`. The
 * only place this file reads a token from that it did not mint itself.
 */
const TOKEN_IN_FRAGMENT = /#token=([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/;
/** The link base the child renders invite links on; a fixture value, never fetched. */
const WEB_ORIGIN = 'http://localhost:3000';

/**
 * A malformed JSON body whose FIRST bytes are the password: the placement V8 quotes into
 * `SyntaxError.message` (`Unexpected token 'q', "quilted-ha"...`), which Nest forwards into
 * `BadRequestException(err.message)`, which the filter's framework-400 arm logs, through
 * `errorLogFields`, so the message never reaches the line. `framework-400-request-body.spec.ts`
 * measured that arm against `/api/anything`; AC-35 asks for it against this initiative's
 * routes with the initiative's credential.
 */
const MALFORMED_BODY_LEADING_WITH_THE_PASSWORD = `${POLICY_COMPLIANT_PASSWORD}=1&other=2`;

/**
 * The filter's context string for the framework-400 arm and the interceptor's `msg`,
 * hand-copied rather than imported: an expected value read out of the module under test
 * agrees with it whatever it says.
 */
const FRAMEWORK_400_CONTEXT = 'framework exception with a 400 status';
const REQUEST_COMPLETED = 'request completed';

/** The three fields `errorLogFields` builds, and an error line may carry no fourth. */
const ERROR_LOG_FIELDS = new Set(['err_name', 'err_message', 'err_stack']);

/** pino's own keys on every line: `base` is `{ service, env }`, plus `level` and `time`. */
const PINO_OWN_KEYS = new Set(['level', 'time', 'service', 'env']);

/** The one key `formatters.log` leaves to `serializers.err` (`logger.ts`, the partition). */
const ERROR_KEY = 'err';

/**
 * THE TWO WRITERS THAT ARE NOT PINO, MEASURED ON THIS RUN AND BOTH ALREADY ON RECORD. Every
 * other line the process writes is one JSON record from the shared instance; these two are
 * unstructured, ANSI-coloured, and reach the capture on their own:
 *
 *   - Nest's own bootstrap logger (`[Nest] <pid>  - <date>  LOG [InstanceLoader] …`), fourteen
 *     lines at boot. ADR-0028 "What this ADR does not decide" and `eslint.config.mjs` both
 *     name it as the question a later `app.useLogger(…)` answers; not this TASK's.
 *   - Better Auth's PACKAGE-LEVEL logger on its `onError` path (`api/index.mjs:199`,
 *     `log?.error(e.message)`), which ADR-0052's F-216 amendment records as the one exception
 *     to "exactly one censoring mechanism": the bound `log` hook is not consulted and
 *     `disableColors` does not apply. Measured here for a malformed body on the auth mount:
 *     `ERROR [Better Auth]: Invalid JSON in request body`, on stderr, coloured: a FIXED
 *     string, so nothing leaks, and the byte scan above covers it regardless.
 *
 * Anything non-JSON that is neither of these fails the suite: a third unstructured writer
 * would be a new F-278.
 */
const NEST_BOOTSTRAP_LINE = /^\[Nest\] \d+\s+- /;
const BETTER_AUTH_PACKAGE_LOGGER_LINE = /\[Better Auth\]:/;
/* eslint-disable-next-line no-control-regex -- the ANSI escape prefix those two writers use */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

/** How long the child gets to flush the last request's line into the parent's capture. */
const CAPTURE_SETTLE_MS = 5_000;

interface EmittedLine {
  readonly raw: string;
  readonly record: Record<string, unknown>;
}

interface Probe {
  readonly status: number;
  readonly raw: string;
  readonly body: unknown;
}

/** Everything the flow produced that an assertion needs, so each `it` reads and never re-runs it. */
interface FlowArtefacts {
  readonly tenantId: string;
  readonly token: string;
  readonly sessionCookieValue: string;
  readonly workspaceId: string;
  /** TASK-1b-10: the invitation legs' artefacts. */
  readonly inviteWorkspaceId: string;
  /** The two raw capability tokens this process minted and holds; never the route's. */
  readonly heldTokens: readonly string[];
  readonly inviteeToken: string;
  readonly inviteeSessionCookieValue: string;
  readonly statuses: Readonly<Record<string, number>>;
  readonly output: string;
}

/** AC-1b-34: what the console-transport child produced. */
interface ConsoleArtefacts {
  readonly tenantId: string;
  /** Read out of the rendered mail in the child's output: the way an invitee reads it. */
  readonly tokenFromMail: string;
  readonly ownerToken: string;
  readonly inviteeToken: string;
  readonly statuses: Readonly<Record<string, number>>;
  readonly output: string;
}

let serverBoot: Promise<ApiServer>;
let server: ApiServer;
let flow: Promise<FlowArtefacts> | undefined;
let artefacts: FlowArtefacts;

let consoleBoot: Promise<ApiServer>;
let consoleServer: ApiServer;
let consoleFlow: Promise<ConsoleArtefacts> | undefined;
let consoleArtefacts: ConsoleArtefacts;

async function request(
  path: string,
  options: {
    readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    readonly token?: string;
    /** JSON-encoded when an object; sent verbatim (as `application/json`) when a string. */
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
    /** Which child; the main one unless the console child is named (AC-1b-34). */
    readonly against?: ApiServer;
  } = {},
): Promise<Probe> {
  const payload =
    options.body === undefined
      ? undefined
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);

  const response = await fetch(`${(options.against ?? server).baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
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

  return { status: response.status, raw, body };
}

function emittedLines(output: string): EmittedLine[] {
  return output
    .split('\n')
    .filter((line) => line !== '')
    .map((raw) => {
      try {
        return { raw, record: JSON.parse(raw) as Record<string, unknown> };
      } catch {
        // Kept, with an empty record, so the byte scan still covers it and the "every line is
        // JSON" assertion names it.
        return { raw, record: {} };
      }
    });
}

function requestLines(output: string): EmittedLine[] {
  return emittedLines(output).filter((line) => line.record.msg === REQUEST_COMPLETED);
}

/**
 * The child writes fd 1 synchronously, but the parent reads the pipe asynchronously and the
 * client can hold a response before the server's `'finish'` listener has run, so the capture
 * is polled to a count rather than read the instant the last response arrives. Bounded.
 */
async function untilCaptured(
  condition: (output: string) => boolean,
  what: string,
  child: ApiServer = server,
): Promise<string> {
  const deadline = Date.now() + CAPTURE_SETTLE_MS;

  for (;;) {
    const output = child.output();

    if (condition(output)) {
      return output;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}. The child's output was:\n${output}`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The whole run: signup, sign-in, mint, then every workspace route the API serves, then the
 * three shapes that carry the credential somewhere other than the sign-in body. Statuses are
 * asserted here so a flow that did not actually happen cannot make the scan below vacuous.
 */
async function runFlow(): Promise<FlowArtefacts> {
  const statuses: Record<string, number> = {};

  const signedUp = await signUp(server, EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);
  statuses.signUp = signedUp.status;

  const signedIn = await signIn(server, EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);
  statuses.signIn = signedIn.status;

  const sessionCookie = sessionTokenCookie(signedIn);
  expect(sessionCookie, signedIn.setCookie.join('\n')).toBeDefined();
  const sessionCookieValue = sessionCookie?.value ?? '';
  expect(sessionCookieValue.length).toBeGreaterThan(16);

  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  statuses.mint = minted.status;
  const token = (minted.body as { token?: unknown }).token;
  expect(typeof token).toBe('string');
  const jwt = token as string;
  expect(jwt.split('.')).toHaveLength(3);
  const tenantId = jwtClaims(jwt).tid;
  expect(typeof tenantId).toBe('string');

  // The first request path: create, list, rename, archive, list: the four routes
  // `workspaces.md` names, against the child's own `/api/workspaces`.
  const listedBefore = await request('/api/workspaces', { token: jwt });
  expect(listedBefore.status, listedBefore.raw).toBe(200);
  statuses.listBefore = listedBefore.status;

  const created = await request('/api/workspaces', { method: 'POST', token: jwt, body: { name: 'Acme' } });
  expect(created.status, created.raw).toBe(201);
  statuses.create = created.status;
  const workspaceId = (created.body as { id: string }).id;

  const renamed = await request(`/api/workspaces/${workspaceId}`, { method: 'PATCH', token: jwt, body: { name: 'Acme Group' } });
  expect(renamed.status, renamed.raw).toBe(200);
  statuses.rename = renamed.status;

  const archived = await request(`/api/workspaces/${workspaceId}/archive`, { method: 'POST', token: jwt });
  expect(archived.status, archived.raw).toBe(200);
  statuses.archive = archived.status;

  const listedAfter = await request('/api/workspaces', { token: jwt });
  expect(listedAfter.status, listedAfter.raw).toBe(200);
  statuses.listAfter = listedAfter.status;

  // The password in a WRONG FIELD of a well-formed body on an authenticated route: whatever
  // the schema does with an unknown key, the request line and any error line must not carry
  // it. `createWorkspaceRequestContract` decides between 201 (key stripped) and 400 (refused);
  // both go through the interceptor, so a line is emitted either way.
  const wrongField = await request('/api/workspaces', {
    method: 'POST',
    token: jwt,
    body: { name: 'Acme Two', password: POLICY_COMPLIANT_PASSWORD },
  });
  expect([201, 400], wrongField.raw).toContain(wrongField.status);
  statuses.wrongField = wrongField.status;

  // AC-35: a malformed body LEADING with the password, on an authenticated route. body-parser
  // raises before routing, Nest maps it to `BadRequestException(err.message)` with the first
  // ten bytes quoted, and the filter's framework-400 arm logs it through `errorLogFields`.
  const malformed = await request('/api/workspaces', {
    method: 'POST',
    token: jwt,
    body: MALFORMED_BODY_LEADING_WITH_THE_PASSWORD,
  });
  expect(malformed.status, malformed.raw).toBe(400);
  statuses.malformedOnWorkspaces = malformed.status;

  // The same malformed body on the AUTH surface itself, outside the Nest graph. Whatever
  // Better Auth answers, whatever it logs through the bound pino hook (ADR-0052) or through
  // its package-level `onError` logger (the F-216 exception), lands in the same capture.
  const malformedOnAuth = await request('/api/auth/sign-in/email', {
    method: 'POST',
    body: MALFORMED_BODY_LEADING_WITH_THE_PASSWORD,
    headers: { origin: server.baseUrl },
  });
  expect(malformedOnAuth.status, malformedOnAuth.raw).toBeGreaterThanOrEqual(400);
  expect(malformedOnAuth.status, malformedOnAuth.raw).toBeLessThan(500);
  statuses.malformedOnAuth = malformedOnAuth.status;

  // A guard refusal, for coverage of the byte scan: the header carries the JWT of a stranger
  // shape (the session cookie value), and the 401's filter path must not echo it.
  const refused = await request('/api/workspaces', { token: sessionCookieValue });
  expect(refused.status, refused.raw).toBe(401);
  statuses.refused = refused.status;

  // ==========================================================================
  // TASK-1b-10: the invitation legs (STORY-1b-07). Same child, same capture.
  // ==========================================================================

  // A second, UNARCHIVED workspace: an archived one cannot be invited to (400), and the
  // creator's `workspace_admin` row (D-10) is what lets the owner invite to it.
  const inviteWorkspace = await request('/api/workspaces', { method: 'POST', token: jwt, body: { name: 'Acme Invites' } });
  expect(inviteWorkspace.status, inviteWorkspace.raw).toBe(201);
  statuses.createInviteWorkspace = inviteWorkspace.status;
  const inviteWorkspaceId = (inviteWorkspace.body as { id: string }).id;

  // The REAL route. Its token is rendered into a message and dropped by `NoopMailSender`
  // (transport unset), so nothing here can hold it, which is the point of AC-1b-35: the
  // whole render-and-drop path runs, and not one byte of it may reach the capture.
  const invited = await request('/api/invitations', {
    method: 'POST',
    token: jwt,
    body: { email: INVITED_EMAIL, workspaces: [{ workspaceId: inviteWorkspaceId, workspaceRole: 'member' }] },
  });
  expect(invited.status, invited.raw).toBe(201);
  statuses.invite = invited.status;
  // The response carries no token (GC-K).
  expect(invited.raw).not.toMatch(/[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/);

  // Two HELD tokens, planted the way the invitation specs plant them: minted here, digest
  // under the migrator with the tenant flag, the raw value in this closure and nowhere else.
  const [owner] = usersFor(EMAIL);
  expect(owner).toBeDefined();
  const heldForSignup = plantInvitation(tenantId as string, inviteWorkspaceId, owner.id, INVITED_EMAIL);
  const heldForAccept = plantInvitation(tenantId as string, inviteWorkspaceId, owner.id, INVITED_EMAIL);

  // Anonymous lookup, 200; the same secret under a swapped prefix, 404 with the fixed body.
  const lookedUp = await request('/api/invitations/lookup', { method: 'POST', body: { token: heldForSignup } });
  expect(lookedUp.status, lookedUp.raw).toBe(200);
  statuses.lookup = lookedUp.status;
  const swapped = `${'ffffffff-ffff-4fff-8fff-ffffffffffff'}.${heldForSignup.split('.')[1]}`;
  const lookedUpSwapped = await request('/api/invitations/lookup', { method: 'POST', body: { token: swapped } });
  expect(lookedUpSwapped.status, lookedUpSwapped.raw).toBe(404);
  statuses.lookupSwapped = lookedUpSwapped.status;

  // The invited signup: the token in the auth mount's body, through `hooks.before` and the
  // `onUserCreated` invited branch, in the child, outside the Nest graph.
  const inviteeSignedUp = await authRequest(server, 'POST', '/sign-up/email', {
    body: { email: INVITED_EMAIL, password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME, invitationToken: heldForSignup },
  });
  expect(inviteeSignedUp.status, inviteeSignedUp.raw).toBe(200);
  statuses.invitedSignUp = inviteeSignedUp.status;

  const inviteeSignedIn = await signIn(server, INVITED_EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(inviteeSignedIn.status, inviteeSignedIn.raw).toBe(200);
  statuses.inviteeSignIn = inviteeSignedIn.status;
  const inviteeCookie = sessionTokenCookie(inviteeSignedIn);
  expect(inviteeCookie, inviteeSignedIn.setCookie.join('\n')).toBeDefined();
  const inviteeSessionCookieValue = inviteeCookie?.value ?? '';
  expect(inviteeSessionCookieValue.length).toBeGreaterThan(16);

  const inviteeMinted = await mintToken(server, inviteeSignedIn.cookie);
  expect(inviteeMinted.status, inviteeMinted.raw).toBe(200);
  statuses.inviteeMint = inviteeMinted.status;
  const inviteeToken = (inviteeMinted.body as { token?: unknown }).token as string;
  expect(inviteeToken.split('.')).toHaveLength(3);
  // Invited INTO the owner's tenant, not a tenant of its own (SC-7).
  expect(jwtClaims(inviteeToken).tid).toBe(tenantId);

  const inviteeList = await request('/api/workspaces', { token: inviteeToken });
  expect(inviteeList.status, inviteeList.raw).toBe(200);
  statuses.inviteeList = inviteeList.status;
  expect(((inviteeList.body as { items: { id: string }[] }).items).map((item) => item.id)).toEqual([inviteWorkspaceId]);

  // Accept as an EXISTING member of the same tenant (the owner), 200; the same token again
  // is 409 `invitation_already_accepted`, and the token the signup consumed is 409 too:
  // two refusals whose messages are fixed strings and whose bodies carry no token.
  const accepted = await request('/api/invitations/accept', { method: 'POST', token: jwt, body: { token: heldForAccept } });
  expect(accepted.status, accepted.raw).toBe(200);
  statuses.accept = accepted.status;
  const acceptedTwice = await request('/api/invitations/accept', { method: 'POST', token: jwt, body: { token: heldForAccept } });
  expect(acceptedTwice.status, acceptedTwice.raw).toBe(409);
  statuses.acceptTwice = acceptedTwice.status;
  const acceptConsumed = await request('/api/invitations/accept', { method: 'POST', token: jwt, body: { token: heldForSignup } });
  expect(acceptConsumed.status, acceptConsumed.raw).toBe(409);
  statuses.acceptConsumed = acceptConsumed.status;
  for (const refusal of [acceptedTwice, acceptConsumed, lookedUpSwapped]) {
    expect(refusal.raw).not.toContain(heldForAccept.split('.')[1]);
    expect(refusal.raw).not.toContain(heldForSignup.split('.')[1]);
  }

  // Six requests went through the interceptor before the invitation legs (two lists, create,
  // rename, archive, the wrong-field create); the malformed bodies, the auth calls and the
  // 401 do not, by construction; see the interceptor's header. The invitation legs add
  // EIGHT more: the second create, the invite, two lookups, the invitee's list, three
  // accepts. Wait for all fourteen and for the AC-35 line.
  const output = await untilCaptured(
    (captured) =>
      requestLines(captured).length >= 14 &&
      emittedLines(captured).some((line) => line.record.msg === FRAMEWORK_400_CONTEXT),
    'fourteen request-log lines and the framework-400 error line',
  );

  return {
    tenantId: tenantId as string,
    token: jwt,
    sessionCookieValue,
    workspaceId,
    inviteWorkspaceId,
    heldTokens: [heldForSignup, heldForAccept],
    inviteeToken,
    inviteeSessionCookieValue,
    statuses,
    output,
  };
}

/**
 * Plants one pending invitation naming `workspaceId` at `member` and returns its RAW token:
 * minted in this process by `issueCapabilityToken`, digest inserted under the migrator with
 * the tenant flag (`invitations` and `invitation_workspaces` carry FORCE ROW LEVEL SECURITY),
 * the raw value returned to the caller's local variable and written nowhere else. The same
 * shape `test/auth/signup-invited.int-spec.ts` uses, over psql rather than the repository so
 * this file needs no in-process database client.
 */
function plantInvitation(tenantId: string, workspaceId: string, inviterUserId: string, email: string): string {
  const { raw, digest } = issueCapabilityToken(tenantId);

  execSql(
    migrationDsn(),
    `BEGIN;
     INSERT INTO invitations (id, tenant_id, email, token_digest, expires_at, invited_by_user_id, inviter_email)
       VALUES (:'id'::uuid, :'tenant'::uuid, :'email', decode(:'digest', 'hex'), now() + interval '7 days', :'inviter', :'inviter_email');
     INSERT INTO invitation_workspaces (tenant_id, invitation_id, workspace_id, role)
       VALUES (:'tenant'::uuid, :'id'::uuid, :'workspace'::uuid, 'member'::workspace_role);
     COMMIT;`,
    {
      tenantId,
      variables: {
        id: randomUUID(),
        tenant: tenantId,
        email,
        digest: digest.toString('hex'),
        inviter: inviterUserId,
        inviter_email: EMAIL,
        workspace: workspaceId,
      },
    },
  );

  return raw;
}

/**
 * AC-1b-34: the console-transport child. Owner signs up, signs in, mints, creates a workspace
 * and invites through the REAL route; the token is read OUT OF THE RENDERED MAIL in the
 * child's output: the way an invitee reads it, and the only place this function reads one
 * from, then driven through the anonymous lookup, a REFUSED invited signup (prefix swapped:
 * `hooks.before` answers a fixed-string APIError), the real invited signup, sign-in, mint and
 * the invitee's list.
 */
async function runConsoleFlow(): Promise<ConsoleArtefacts> {
  const statuses: Record<string, number> = {};
  const child = consoleServer;

  const signedUp = await signUp(child, CONSOLE_OWNER_EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);
  statuses.signUp = signedUp.status;
  const signedIn = await signIn(child, CONSOLE_OWNER_EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);
  const minted = await mintToken(child, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  const ownerToken = (minted.body as { token?: unknown }).token as string;
  const tenantId = jwtClaims(ownerToken).tid as string;

  const workspace = await request('/api/workspaces', { method: 'POST', token: ownerToken, body: { name: 'Console Acme' }, against: child });
  expect(workspace.status, workspace.raw).toBe(201);
  const workspaceId = (workspace.body as { id: string }).id;

  const invited = await request('/api/invitations', {
    method: 'POST',
    token: ownerToken,
    body: { email: CONSOLE_INVITED_EMAIL, workspaces: [{ workspaceId, workspaceRole: 'member' }] },
    against: child,
  });
  expect(invited.status, invited.raw).toBe(201);
  statuses.invite = invited.status;

  // The mail lands in the capture after commit; read the token out of its link.
  const withMail = await untilCaptured((captured) => captured.includes(CONSOLE_MAIL_FOOTER), 'the console mail block', child);
  const tokenFromMail = TOKEN_IN_FRAGMENT.exec(withMail)?.[1];
  expect(tokenFromMail, withMail).toBeDefined();
  const token = tokenFromMail as string;

  const lookedUp = await request('/api/invitations/lookup', { method: 'POST', body: { token }, against: child });
  expect(lookedUp.status, lookedUp.raw).toBe(200);
  statuses.lookup = lookedUp.status;

  // A refused invited signup: the same secret under a prefix nobody issued. `hooks.before`
  // refuses with a fixed-string APIError; whatever Better Auth logs of it lands here.
  const refusedSignUp = await authRequest(child, 'POST', '/sign-up/email', {
    body: {
      email: CONSOLE_INVITED_EMAIL,
      password: POLICY_COMPLIANT_PASSWORD,
      name: SIGNUP_NAME,
      invitationToken: `ffffffff-ffff-4fff-8fff-ffffffffffff.${token.split('.')[1]}`,
    },
  });
  expect(refusedSignUp.status, refusedSignUp.raw).toBeGreaterThanOrEqual(400);
  expect(refusedSignUp.status, refusedSignUp.raw).toBeLessThan(500);
  statuses.refusedInvitedSignUp = refusedSignUp.status;
  expect(refusedSignUp.raw).not.toContain(token.split('.')[1]);

  const inviteeSignedUp = await authRequest(child, 'POST', '/sign-up/email', {
    body: { email: CONSOLE_INVITED_EMAIL, password: POLICY_COMPLIANT_PASSWORD, name: SIGNUP_NAME, invitationToken: token },
  });
  expect(inviteeSignedUp.status, inviteeSignedUp.raw).toBe(200);
  statuses.invitedSignUp = inviteeSignedUp.status;
  const inviteeSignedIn = await signIn(child, CONSOLE_INVITED_EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(inviteeSignedIn.status, inviteeSignedIn.raw).toBe(200);
  const inviteeMinted = await mintToken(child, inviteeSignedIn.cookie);
  expect(inviteeMinted.status, inviteeMinted.raw).toBe(200);
  const inviteeToken = (inviteeMinted.body as { token?: unknown }).token as string;
  expect(jwtClaims(inviteeToken).tid).toBe(tenantId);
  const inviteeList = await request('/api/workspaces', { token: inviteeToken, against: child });
  expect(inviteeList.status, inviteeList.raw).toBe(200);
  statuses.inviteeList = inviteeList.status;

  // Four request lines: the workspace create, the invite, the lookup, the invitee's list.
  const output = await untilCaptured((captured) => requestLines(captured).length >= 4, 'four request-log lines', child);

  return { tenantId, tokenFromMail: token, ownerToken, inviteeToken, statuses, output };
}

beforeAll(() => {
  // THE MAIN CHILD: `authServerEnv` and NO `MAIL_TRANSPORT` (`none`, `NoopMailSender`) on
  // purpose (AC-1b-35, header). `WEB_APP_ORIGINS` so the invite link renders (the render
  // runs before the Noop drop; unset, `mail_dispatch_failed` would replace the drop).
  serverBoot = startApiServer({
    env: (baseUrl) => ({ ...authServerEnv(baseUrl), LOG_LEVEL: 'info', WEB_APP_ORIGINS: WEB_ORIGIN }),
  });
  serverBoot.catch(() => undefined);
  // THE CONSOLE CHILD (AC-1b-34): the one transport that prints the message, and so the
  // token, to stdout BY DESIGN: the assertion is that it appears THERE and nowhere else.
  consoleBoot = startApiServer({
    env: (baseUrl) => ({ ...authServerEnv(baseUrl), LOG_LEVEL: 'info', WEB_APP_ORIGINS: WEB_ORIGIN, MAIL_TRANSPORT: 'console' }),
  });
  consoleBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;
  consoleServer = await consoleBoot;

  if (flow === undefined) {
    clearSignupState(EMAIL, INVITED_EMAIL);
    flow = runFlow();
  }

  artefacts = await flow;

  if (consoleFlow === undefined) {
    clearSignupState(CONSOLE_OWNER_EMAIL, CONSOLE_INVITED_EMAIL);
    consoleFlow = runConsoleFlow();
  }

  consoleArtefacts = await consoleFlow;
}, 240_000);

afterAll(async () => {
  await server?.stop();
  await consoleServer?.stop();
  clearSignupState(EMAIL, INVITED_EMAIL, CONSOLE_OWNER_EMAIL, CONSOLE_INVITED_EMAIL);
});

/** ADR-0028 over one parsed line: every key is named, pino's own, the `err` seam, or censored. */
function keysNeitherNamedNorCensored(record: Record<string, unknown>, path = ''): string[] {
  const offending: string[] = [];

  for (const [key, value] of Object.entries(record)) {
    const at = `${path}${key}`;

    if (PINO_OWN_KEYS.has(key) && path === '') {
      continue;
    }

    if (key === ERROR_KEY && path === '' && typeof value === 'object' && value !== null) {
      // The serialiser's output: `errorLogFields`' three names and no fourth.
      for (const inner of Object.keys(value)) {
        if (!ERROR_LOG_FIELDS.has(inner)) {
          offending.push(`${at}.${inner}`);
        }
      }
      continue;
    }

    if (LOGGABLE_FIELDS.has(key)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        offending.push(...keysNeitherNamedNorCensored(value as Record<string, unknown>, `${at}.`));
      }
      continue;
    }

    if (value !== REDACT_CENSOR) {
      offending.push(at);
    }
  }

  return offending;
}

describe('AC-33: the request path emits lines, and no credential is among their bytes', () => {
  it('non-vacuity: the child wrote request-log lines for the workspace routes, at info, with the signup’s tenant on them', () => {
    const lines = requestLines(artefacts.output);

    // The count clause F-295 refuses to do without: zero lines would make everything below
    // true of an empty process.
    expect(lines.length, artefacts.output).toBeGreaterThanOrEqual(14);

    const routes = lines.map((line) => line.record.route);
    expect(routes).toContain('/api/workspaces');
    // `:workspaceId` since TASK-1b-06 (D-07): the log-safe pattern, never a concrete id.
    expect(routes).toContain('/api/workspaces/:workspaceId');
    expect(routes).toContain('/api/workspaces/:workspaceId/archive');

    for (const line of lines) {
      expect(line.record.level, line.raw).toBe('info');
      // Every authenticated line carries the tenant: the owner's AND the invitee's, who was
      // invited INTO it. The one `@Public()` route runs with no tenant context and carries
      // none (TASK-1b-10): a tenant id on that line would be a value read from the body.
      if (line.record.route === '/api/invitations/lookup') {
        expect(line.record, line.raw).not.toHaveProperty('tenant_id');
      } else {
        expect(line.record.tenant_id, line.raw).toBe(artefacts.tenantId);
      }
      expect(typeof line.record.request_id, line.raw).toBe('string');
      expect(typeof line.record.duration_ms, line.raw).toBe('number');
      // 404 and 409: the swapped-prefix lookup and the two refused accepts (TASK-1b-10).
      expect([200, 201, 400, 404, 409], line.raw).toContain(line.record.status);
      // The pattern, never the concrete path: no id is on any `route`.
      expect(String(line.record.route)).not.toContain(artefacts.workspaceId);
      expect(String(line.record.route)).not.toContain(artefacts.inviteWorkspaceId);
    }

    // The flow was real: every status is what the routes promise.
    expect(artefacts.statuses).toMatchObject({
      signUp: 200,
      signIn: 200,
      mint: 200,
      listBefore: 200,
      create: 201,
      rename: 200,
      archive: 200,
      listAfter: 200,
      malformedOnWorkspaces: 400,
      refused: 401,
    });
  });

  it('the email address appears zero times in every byte the process wrote', () => {
    expect(EMAIL.length).toBeGreaterThan(0);
    expect(artefacts.output).not.toContain(EMAIL);
    expect(artefacts.output.toLowerCase()).not.toContain(EMAIL.toLowerCase());
    expect(artefacts.output).not.toContain(encodeURIComponent(EMAIL));
    // The local part alone, in case an aggregator-shaped line carried it split from the domain.
    expect(artefacts.output).not.toContain(EMAIL.split('@')[0]);
  });

  it('the password appears zero times: not in a field, not in msg, not inside err_message or err_stack', () => {
    expect(POLICY_COMPLIANT_PASSWORD.length).toBeGreaterThan(0);
    expect(artefacts.output).not.toContain(POLICY_COMPLIANT_PASSWORD);
    // The fragment V8 quotes into a parse message is the first ten bytes of the body, which
    // for the AC-35 body is the start of the password.
    expect(artefacts.output).not.toContain(POLICY_COMPLIANT_PASSWORD.slice(0, 10));
  });

  it('the session token appears zero times: the cookie value, its URL-decoded form, and its token half', () => {
    const value = artefacts.sessionCookieValue;
    expect(value.length).toBeGreaterThan(16);

    const decoded = decodeURIComponent(value);
    const tokenHalf = decoded.split('.')[0];
    expect(tokenHalf.length).toBeGreaterThan(16);

    expect(artefacts.output).not.toContain(value);
    expect(artefacts.output).not.toContain(decoded);
    expect(artefacts.output).not.toContain(tokenHalf);
  });

  it('the JWT appears zero times, whole and as each of its three segments', () => {
    const segments = artefacts.token.split('.');
    expect(segments).toHaveLength(3);

    expect(artefacts.output).not.toContain(artefacts.token);
    for (const segment of segments) {
      expect(segment.length).toBeGreaterThan(8);
      expect(artefacts.output).not.toContain(segment);
    }
  });
});

describe('AC-34: every field on every line is named in LOGGABLE_FIELDS or renders as [redacted]', () => {
  it('every line the process wrote is one JSON record, save the two non-pino writers already on record', () => {
    const notJson = emittedLines(artefacts.output)
      .filter((line) => Object.keys(line.record).length === 0)
      .map((line) => line.raw.replace(ANSI_ESCAPE, ''));

    const unexplained = notJson.filter(
      (line) => !NEST_BOOTSTRAP_LINE.test(line) && !BETTER_AUTH_PACKAGE_LOGGER_LINE.test(line),
    );

    expect(unexplained).toEqual([]);

    // The F-216 path, when it fires, says its fixed string and nothing of the body.
    for (const line of notJson.filter((candidate) => BETTER_AUTH_PACKAGE_LOGGER_LINE.test(candidate))) {
      expect(line).not.toContain(POLICY_COMPLIANT_PASSWORD);
      expect(line).not.toContain(POLICY_COMPLIANT_PASSWORD.slice(0, 10));
    }
  });

  it('no key on any line carries a value under a name the allowlist does not hold', () => {
    const lines = emittedLines(artefacts.output);
    expect(lines.length).toBeGreaterThan(0);

    const offending = lines.flatMap((line) =>
      keysNeitherNamedNorCensored(line.record).map((key) => `${key} on ${line.raw}`),
    );

    expect(offending).toEqual([]);
  });

  it('the request lines carry exactly the five required fields beside msg and pino’s own keys', () => {
    for (const line of requestLines(artefacts.output)) {
      // The public lookup carries no tenant (no context to read one from); every other line
      // carries the five, and no line carries a sixth.
      const required = line.record.route === '/api/invitations/lookup'
        ? ['duration_ms', 'env', 'level', 'msg', 'request_id', 'route', 'service', 'status', 'time']
        : ['duration_ms', 'env', 'level', 'msg', 'request_id', 'route', 'service', 'status', 'tenant_id', 'time'];

      expect(Object.keys(line.record).sort(), line.raw).toEqual(required.sort());
    }
  });
});

describe('AC-35: an error carrying the request body is logged as the policy fields and nothing of the body', () => {
  it('the framework-400 line for the malformed body carries only errorLogFields output beside request_id and msg', () => {
    const lines = emittedLines(artefacts.output).filter((line) => line.record.msg === FRAMEWORK_400_CONTEXT);

    // Exactly the one the malformed POST to `/api/workspaces` produced. The auth mount's
    // malformed body is Better Auth's to answer and does not reach the filter.
    expect(lines.map((line) => line.raw)).toHaveLength(1);
    const line = lines[0];

    const fieldsBeyondTheEnvelope = Object.keys(line.record).filter(
      (key) => !PINO_OWN_KEYS.has(key) && key !== 'msg' && key !== 'request_id',
    );
    for (const key of fieldsBeyondTheEnvelope) {
      expect(ERROR_LOG_FIELDS.has(key), `unexpected field ${key} on ${line.raw}`).toBe(true);
    }
    expect(line.record.err_name).toBe('BadRequestException');
    // The message is withheld on this arm (`includeMessage` is `isDomainError(...)`), and it is
    // the field that would carry the quoted body bytes.
    expect(line.record).not.toHaveProperty('err_message');
    expect(typeof line.record.err_stack).toBe('string');
    expect(line.raw).not.toContain(POLICY_COMPLIANT_PASSWORD);
    expect(line.raw).not.toContain(POLICY_COMPLIANT_PASSWORD.slice(0, 10));
    expect(line.raw).not.toContain(MALFORMED_BODY_LEADING_WITH_THE_PASSWORD);
  });

  it('whatever Better Auth logged for the malformed body on its own mount carries the fixed code and no body bytes', () => {
    const betterAuthLines = emittedLines(artefacts.output).filter((line) => line.record.code === 'better_auth');

    // ADR-0060: `warn` and above only, and no `warn` site in 1.6.26 interpolates a value. Zero
    // lines is the expected shape; the assertion is over whatever did arrive.
    for (const line of betterAuthLines) {
      expect(Object.keys(line.record).sort(), line.raw).toEqual(['code', 'env', 'level', 'msg', 'service', 'time']);
      expect(line.raw).not.toContain(POLICY_COMPLIANT_PASSWORD);
    }
  });
});

/**
 * The lines of `output` that sit INSIDE a `ConsoleMailSender` block: from a header line to
 * the next footer line, inclusive. Everything else is "outside".
 */
function splitConsoleBlocks(output: string): { readonly inside: string[]; readonly outside: string[] } {
  const inside: string[] = [];
  const outside: string[] = [];
  let within = false;

  for (const line of output.split('\n')) {
    if (line === CONSOLE_MAIL_HEADER) {
      within = true;
    }

    (within ? inside : outside).push(line);

    if (line === CONSOLE_MAIL_FOOTER) {
      within = false;
    }
  }

  return { inside, outside };
}

describe('AC-1b-35, AC-1b-36: with the transport unset, the invite → lookup → invited signup → sign-in → accept flow leaves no token, address or credential in the process output', () => {
  it('the flow was real: every invitation leg answered what the routes promise', () => {
    expect(artefacts.statuses).toMatchObject({
      createInviteWorkspace: 201,
      invite: 201,
      lookup: 200,
      lookupSwapped: 404,
      invitedSignUp: 200,
      inviteeSignIn: 200,
      inviteeMint: 200,
      inviteeList: 200,
      accept: 200,
      acceptTwice: 409,
      acceptConsumed: 409,
    });
    expect(artefacts.heldTokens).toHaveLength(2);
  });

  it('AC-1b-35: neither held raw token nor its secret half appears anywhere in the bytes the process wrote: the console block does not exist because no transport was declared', () => {
    // The transport is UNSET in this child (`authServerEnv` declares none and this file adds
    // none): `NoopMailSender` dropped the route-issued message after it was RENDERED, and the
    // held tokens crossed the auth mount's body parser, the hooks, the lookup and the accept
    // handlers. Not one byte of any of the three may be here.
    expect(artefacts.output).not.toContain(CONSOLE_MAIL_HEADER);

    for (const raw of artefacts.heldTokens) {
      const [prefix, secret] = raw.split('.');
      expect(prefix).toBe(artefacts.tenantId);
      expect(secret.length).toBe(43);
      expect(artefacts.output).not.toContain(raw);
      expect(artefacts.output).not.toContain(secret);
      expect(artefacts.output).not.toContain(encodeURIComponent(raw));
    }

    // ...and no OTHER token-shaped string either: the route-issued token this process never
    // saw would match this and nothing else in a pino line legitimately does.
    expect(artefacts.output).not.toMatch(/[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/);
  });

  it('AC-1b-35: the invited address appears zero times: whole, lower-cased, URL-encoded, and as its local part', () => {
    expect(artefacts.output).not.toContain(INVITED_EMAIL);
    expect(artefacts.output.toLowerCase()).not.toContain(INVITED_EMAIL.toLowerCase());
    expect(artefacts.output).not.toContain(encodeURIComponent(INVITED_EMAIL));
    expect(artefacts.output).not.toContain(INVITED_EMAIL.split('@')[0]);
  });

  it('the invitee’s session token and JWT appear zero times, whole and in the pieces a serialiser could split them into', () => {
    const value = artefacts.inviteeSessionCookieValue;
    expect(value.length).toBeGreaterThan(16);
    const decoded = decodeURIComponent(value);
    const tokenHalf = decoded.split('.')[0];
    expect(artefacts.output).not.toContain(value);
    expect(artefacts.output).not.toContain(decoded);
    expect(artefacts.output).not.toContain(tokenHalf);

    const segments = artefacts.inviteeToken.split('.');
    expect(segments).toHaveLength(3);
    expect(artefacts.output).not.toContain(artefacts.inviteeToken);
    for (const segment of segments) {
      expect(artefacts.output).not.toContain(segment);
    }
  });

  it('AC-1b-36: the lookup and accept request lines carry the route PATTERN and no body-derived field; the refusal lines are fixed strings', () => {
    const lookups = requestLines(artefacts.output).filter((line) => line.record.route === '/api/invitations/lookup');
    const accepts = requestLines(artefacts.output).filter((line) => line.record.route === '/api/invitations/accept');
    const invites = requestLines(artefacts.output).filter((line) => line.record.route === '/api/invitations');

    // Two lookups (200, 404), three accepts (200, 409, 409), one invite (201): by status, so
    // a line that went missing is named by which request it was.
    expect(lookups.map((line) => line.record.status).sort()).toEqual([200, 404]);
    expect(accepts.map((line) => line.record.status).sort()).toEqual([200, 409, 409]);
    expect(invites.map((line) => line.record.status)).toEqual([201]);

    for (const line of [...lookups, ...accepts, ...invites]) {
      // No body-derived field: the keys are the request line's and nothing else: no `token`,
      // no `email`, no `invitation_id`, no `workspace_id` (GC-G).
      const beyondTheEnvelope = Object.keys(line.record).filter(
        (key) => !PINO_OWN_KEYS.has(key) && !['msg', 'request_id', 'route', 'status', 'duration_ms', 'tenant_id'].includes(key),
      );
      expect(beyondTheEnvelope, line.raw).toEqual([]);
      expect(line.raw).not.toContain(INVITED_EMAIL);
      expect(line.raw).not.toContain(artefacts.inviteWorkspaceId);
    }

    // The public route's lines carry no tenant; the authenticated ones carry the owner's.
    for (const line of lookups) {
      expect(line.record, line.raw).not.toHaveProperty('tenant_id');
    }
    for (const line of accepts) {
      expect(line.record.tenant_id, line.raw).toBe(artefacts.tenantId);
    }

    // The two 409s and the 404 are DomainErrors the filter logs: whatever it wrote of them
    // carries the fixed code and message and no token byte. Asserted over every line that
    // names an invitation code, so a `msg` interpolating a value would be caught here.
    const refusalLines = emittedLines(artefacts.output).filter((line) =>
      /invitation_(already_accepted|expired|revoked|tenant_conflict)|Invitation not found/.test(line.raw),
    );
    for (const line of refusalLines) {
      expect(keysNeitherNamedNorCensored(line.record), line.raw).toEqual([]);
      for (const raw of artefacts.heldTokens) {
        expect(line.raw).not.toContain(raw.split('.')[1]);
      }
    }
  });
});

describe('AC-1b-34: with MAIL_TRANSPORT=console the token appears ONLY inside the ConsoleMailSender block and on no JSON line', () => {
  it('the flow was real: the token was read out of the rendered mail and drove lookup, a refused and a real invited signup, and the invitee’s list', () => {
    expect(consoleArtefacts.statuses).toMatchObject({
      invite: 201,
      lookup: 200,
      invitedSignUp: 200,
      inviteeList: 200,
    });
    expect(consoleArtefacts.statuses.refusedInvitedSignUp).toBeGreaterThanOrEqual(400);
    expect(consoleArtefacts.tokenFromMail.split('.')[0]).toBe(consoleArtefacts.tenantId);
  });

  it('every line carrying the raw token or its secret half is inside a console block; no line that parses as JSON carries either', () => {
    const { inside, outside } = splitConsoleBlocks(consoleArtefacts.output);
    const secret = consoleArtefacts.tokenFromMail.split('.')[1];

    // Non-vacuity: the block exists and the token IS in it (a transport that printed nothing
    // would satisfy the negative below trivially).
    expect(inside.filter((line) => line.includes(consoleArtefacts.tokenFromMail)).length).toBeGreaterThan(0);
    expect(inside.filter((line) => line.includes(CONSOLE_INVITED_EMAIL)).length).toBeGreaterThan(0);

    // The negative, stated three ways: no line outside a block carries the token or its
    // secret; no line ANYWHERE that parses as JSON does; and no line outside a block carries
    // the invited address.
    expect(outside.filter((line) => line.includes(secret))).toEqual([]);
    expect(outside.filter((line) => line.includes(encodeURIComponent(consoleArtefacts.tokenFromMail)))).toEqual([]);
    expect(
      emittedLines(consoleArtefacts.output)
        .filter((line) => Object.keys(line.record).length > 0)
        .filter((line) => line.raw.includes(secret) || line.raw.includes(CONSOLE_INVITED_EMAIL))
        .map((line) => line.raw),
    ).toEqual([]);
    expect(outside.filter((line) => line.includes(CONSOLE_INVITED_EMAIL))).toEqual([]);
    expect(outside.filter((line) => line.includes(CONSOLE_INVITED_EMAIL.split('@')[0]))).toEqual([]);

    // The block is the console transport's own shape and nothing else prints inside it: every
    // inside line is header, footer, `To:`, `Subject:`, blank, or rendered text: no JSON.
    for (const line of inside) {
      expect(() => JSON.parse(line) as unknown, line).toThrow();
    }
  });

  it('every line outside a console block is one JSON record whose keys are allowlisted, save the two non-pino writers already on record', () => {
    const { outside } = splitConsoleBlocks(consoleArtefacts.output);
    const lines = emittedLines(outside.join('\n'));

    const notJson = lines
      .filter((line) => Object.keys(line.record).length === 0)
      .map((line) => line.raw.replace(ANSI_ESCAPE, ''));
    expect(
      notJson.filter((line) => !NEST_BOOTSTRAP_LINE.test(line) && !BETTER_AUTH_PACKAGE_LOGGER_LINE.test(line)),
    ).toEqual([]);

    const offending = lines
      .filter((line) => Object.keys(line.record).length > 0)
      .flatMap((line) => keysNeitherNamedNorCensored(line.record).map((key) => `${key} on ${line.raw}`));
    expect(offending).toEqual([]);

    // The passwords, the owner's and the invitee's JWTs: zero times, as in the main child.
    expect(consoleArtefacts.output).not.toContain(POLICY_COMPLIANT_PASSWORD);
    for (const jwt of [consoleArtefacts.ownerToken, consoleArtefacts.inviteeToken]) {
      for (const segment of jwt.split('.')) {
        expect(consoleArtefacts.output).not.toContain(segment);
      }
    }
    // The owner's address is not in the message either way (the message is addressed to the
    // invitee and names the inviter by the `inviterEmail` field, which IS the owner's
    // address, by design, inside the block only).
    expect(outside.filter((line) => line.includes(CONSOLE_OWNER_EMAIL))).toEqual([]);
  });
});
