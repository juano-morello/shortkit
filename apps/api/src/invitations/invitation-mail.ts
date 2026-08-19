/**
 * Contract: docs/contracts/mail-sender.md (`OutboundMail`, the `workspace_invitation` arm),
 *           invitation-tokens.md ("Where the raw token actually travels" — mechanism A),
 *           tenant-context.md (invariants 5 and 6), logging-and-headers.md (GC-G)
 * ADR: adr-0002-tenant-context-binding.md (third-party I/O in `afterCommit`),
 *      adr-0021-tenant-routing-capability-tokens.md, adr-0028 (the field allowlist),
 *      adr-0029 (no credential in error text)
 * Produced by: TASK-1b-08
 * Consumed by: `invitations.service.ts`
 *
 * The invitation mail: what the message says, where its link points, and when it leaves.
 *
 * ============================================================================
 * THE LINK. `<webOrigin>/invitations/accept#token=<raw>` — THE FRAGMENT, AND NOTHING ELSE (D-03).
 * ============================================================================
 *
 * The raw token rides in the URL FRAGMENT. A fragment is never sent to any server, never
 * appears in a `Referer`, and never reaches a platform access log; the accept page reads
 * `location.hash`, drops it with `history.replaceState`, and posts the token in a request
 * body (`POST /api/invitations/lookup`, `POST /api/invitations/accept`). Putting it in the
 * path or the query is F-300 all over again and is the one thing this file must never do.
 *
 * `webOrigin` IS THE FIRST CONCRETE ENTRY OF `WEB_APP_ORIGINS`. `webAppOrigins()` returns
 * every origin the dashboard is served from, in the operator's order, normalised — except
 * wildcard entries (`https://shortkit-*.vercel.app`), which come back verbatim because a
 * pattern is not an address a browser can open. The link's base is therefore the first
 * entry that carries no wildcard metacharacter. When there is none — the variable is unset,
 * or holds only patterns — no link can be built and `InviteUrlOriginMissing` is thrown from
 * the render, which the dispatch hook below turns into one `mail_dispatch_failed` line
 * carrying `err_name: 'InviteUrlOriginMissing'` and `template`, and nothing else. The
 * invitation row is already committed by then and the request already answered 201: the
 * operator's misconfiguration costs one email, not one invitation. `BETTER_AUTH_URL` is NOT
 * a fallback: an API-origin link cannot land on the web page. The compose stack and every
 * documented deployment set `WEB_APP_ORIGINS`, so this branch is a bare-`pnpm dev` case.
 *
 * ============================================================================
 * THE SEND HAPPENS IN `afterCommit`, ENQUEUED BY A NESTED `withTenantTransaction` (GC-H).
 * ============================================================================
 *
 * The create route runs inside the transaction `TenantTransactionInterceptor` opened. Third-
 * party network I/O may not run inside it (ADR-0002: the transaction holds a pooled
 * connection for its whole life), so the send is registered as an `afterCommit` hook, and
 * the way a callee registers one on the ambient transaction is to nest
 * `withTenantTransaction(<same tenant>, fn, { afterCommit })`: nesting with the same id joins
 * the outer transaction (invariant 5) and, once `fn` resolves, appends the hook to the
 * OUTER frame's list, where it runs exactly once after the outer COMMIT (invariant 6). A
 * throw in the handler after this call rolls the whole transaction back and no hook runs, so
 * no mail ever announces an invitation that was not committed (AC-1b-5).
 *
 * THIS FILE IMPORTS NOTHING FROM `./tokens/`. `capability-lookup.spec.ts` (GC-L) asserts that
 * the only file importing from `invitations/tokens/` AND calling `withTenantTransaction(` is
 * `capability-lookup.ts`; the service imports `issueCapabilityToken` and therefore cannot
 * make the nested call itself. The split is what keeps that grep meaningful: this file
 * knows how to enqueue after-commit work and knows nothing about tokens beyond an opaque
 * string it puts in a URL.
 *
 * ============================================================================
 * THE TOKEN IS IN THE MESSAGE AND IN NO LOG LINE (GC-K).
 * ============================================================================
 *
 * `renderInvitationMail` returns an `OutboundMail` whose `data.inviteUrl` carries the token;
 * that object goes to the bound `MailSender` and nowhere else. The dispatch hook logs on
 * failure only, with `template` and the error's name and stack — never `to`, never the URL,
 * never the message. `errorLogFields(…, { includeMessage: false })`: whatever a sender throws
 * is reduced to `err_name` and `err_stack`, and the message — the one field that could quote
 * an address or a URL — is dropped. `mail_dispatch_failed` is the same fixed `msg`
 * `ResendMailSender` uses for a provider failure, so an operator greps for one string.
 */
import type { WorkspaceRole } from '@shortkit/contracts';

import { webAppOrigins } from '../auth/boot-assertions';
import type { MailSender, OutboundMail } from '../mail/mail-sender';
import { errorLogFields, logger } from '../observability/logger';
import { withTenantTransaction } from '../tenancy/tenant-context';

/** The path of the accept page under `app/(auth)/` (D-14). Fixed; the web owns the page. */
export const INVITATION_ACCEPT_PATH = '/invitations/accept';

/** The fragment key the accept page reads (`invitations-api.ts`, `tokenFromFragment`). */
export const INVITATION_TOKEN_FRAGMENT_KEY = 'token';

/** The two metacharacters `boot-assertions.ts` treats as a wildcard entry; a pattern is not a link base. */
const WILDCARD_METACHARACTERS = /[*?]/;

/**
 * No concrete `WEB_APP_ORIGINS` entry to build the link on. A plain `Error` on purpose: it is
 * an operator's configuration, not a caller's condition, and it is thrown after commit
 * where no HTTP status is left to decide. Its message names the variable and no value.
 */
export class InviteUrlOriginMissing extends Error {
  constructor() {
    super(
      'WEB_APP_ORIGINS holds no concrete origin to build the invitation link on. Set it to ' +
        'the dashboard origin (a wildcard entry cannot be a link base). See docs/contracts/mail-sender.md.',
    );
    this.name = 'InviteUrlOriginMissing';
  }
}

/**
 * The first entry of `WEB_APP_ORIGINS` that is an origin rather than a pattern. Read per
 * call, never at import: the integration tier stubs the variable after the module loaded.
 */
export function inviteLinkOrigin(): string {
  const origin = webAppOrigins().find((entry) => !WILDCARD_METACHARACTERS.test(entry));

  if (origin === undefined) {
    throw new InviteUrlOriginMissing();
  }

  return origin;
}

/**
 * `<origin>/invitations/accept#token=<raw>`. The token is the whole of the fragment's value
 * and is not percent-encoded: `<uuid>.<base64url>` contains nothing a fragment reserves, and
 * the page compares the value against `capabilityTokenContract` verbatim.
 */
export function inviteUrlFor(origin: string, rawToken: string): string {
  return `${origin}${INVITATION_ACCEPT_PATH}#${INVITATION_TOKEN_FRAGMENT_KEY}=${rawToken}`;
}

export interface InvitationMailInput {
  /** The raw capability token. Enters the message and nothing else. */
  readonly raw: string;
  /** The recipient — `invitations.email`, already normalised by the contract. */
  readonly to: string;
  readonly inviterEmail: string;
  readonly tenantName: string;
  /** In the inviter's order: the workspaces the invitation names, with each one's role. */
  readonly workspaces: ReadonlyArray<{ readonly name: string; readonly role: WorkspaceRole }>;
  /** The row's `expires_at`. */
  readonly expiresAt: Date;
  /** The link's base. Defaults to `inviteLinkOrigin()`; a test hands one in. */
  readonly webOrigin?: string;
}

/** The `workspace_invitation` message. Pure: no I/O, no log, no clock. */
export function renderInvitationMail(input: InvitationMailInput): OutboundMail {
  const origin = input.webOrigin ?? inviteLinkOrigin();

  return {
    template: 'workspace_invitation',
    to: input.to,
    data: {
      inviteUrl: inviteUrlFor(origin, input.raw),
      inviterEmail: input.inviterEmail,
      tenantName: input.tenantName,
      workspaces: input.workspaces.map((workspace) => ({ name: workspace.name, role: workspace.role })),
      expiresAt: input.expiresAt,
    },
  };
}

/**
 * Registers `send(build())` to run after the AMBIENT tenant transaction commits.
 *
 * `build` runs inside the hook, after COMMIT, so the `OutboundMail` — the only object that
 * carries the token — is constructed at the last moment and lives only for the send. A
 * failure of either step is logged as `mail_dispatch_failed` and swallowed: the row is
 * committed and the response is already decided (invariant 6). Nothing here throws to the
 * caller, and nothing here runs before COMMIT.
 */
export async function dispatchInvitationMailAfterCommit(
  tenantId: string,
  sender: MailSender,
  build: () => OutboundMail,
): Promise<void> {
  await withTenantTransaction(tenantId, async () => undefined, {
    afterCommit: async () => {
      try {
        await sender.send(build());
      } catch (error: unknown) {
        logger.error(
          { template: 'workspace_invitation', ...errorLogFields(error, { includeMessage: false }) },
          'mail_dispatch_failed',
        );
      }
    },
  });
}
