/**
 * Contract: docs/contracts/invitation-tokens.md ("Where the raw token actually travels"),
 *           workspace-authorization.md (the five invitation rows), rate-limit.md (the
 *           `@Public()` per-IP bucket), error-envelope.md, logging-and-headers.md (the route
 *           PATTERN, never a concrete path, is what may appear on a log line)
 * ADR: adr-0006 (everything answers under `/api`), adr-0021 (the capability token is the
 *      authorisation of the one public route), adr-0024, adr-0025, adr-0038
 * Produced by: TASK-1b-08
 *
 * The five invitation routes, all under the `/api` global prefix `main.ts` sets:
 *
 *   POST   /api/invitations              authenticated; Form B in the handler   201 Invitation
 *   GET    /api/invitations?workspaceId= @RequireWorkspaceRole(workspace_admin) 200 { items }
 *   DELETE /api/invitations/:id          authenticated; Form B in the handler   200 Invitation
 *   POST   /api/invitations/lookup       @Public(); the token authorises        200 InvitationPreview
 *   POST   /api/invitations/accept       authenticated; the token authorises   200 { workspaces }
 *
 * ============================================================================
 * THE TOKEN TRAVELS IN A BODY. THERE IS NO `:token` ROUTE PARAM AND NEVER WILL BE (D-03).
 * ============================================================================
 *
 * `GET /api/invitations/:token` and `POST /api/invitations/:token/accept` are NOT built. A
 * path segment lands in the address bar, in browser history, in `Referer` and in platform
 * access logs; a JSON body lands in none of them (F-300, F-362). Both token legs are `POST`
 * with `{ token }`, and the two route PATTERNS above carry no value at all, so the request
 * log line — which records the pattern — cannot carry one either.
 *
 * ============================================================================
 * THE TOKEN BODIES ARE PARSED LENIENTLY, ON PURPOSE (AC-1b-28, invitation-tokens.md).
 * ============================================================================
 *
 * `invitationLookupRequestContract` refuses any string that is not `<uuid>.<43 base64url>`,
 * which is right for a client building a request and wrong here: the contract's promise is
 * that malformed, unknown and prefix-swapped tokens all answer 404 with ONE body, and a 400
 * for the first would separate "not shaped like a token" from "not a token we issued". So
 * these two handlers require only that `token` is a string and hand it to the entry
 * functions, whose step 1 answers a malformed one exactly as an unknown one. A body with no
 * string `token` is a shape error and answers 400 `validation_failed` under `token`, which
 * discloses nothing about any invitation.
 *
 * ============================================================================
 * `@Public()` MEANS: NO GUARD, NO TENANT TRANSACTION, THE IP BUCKET INSTEAD.
 * ============================================================================
 *
 * The lookup carries `@Public()` and so skips `AuthGuard` and `TenantTransactionInterceptor`;
 * `RateLimitGuard`'s public branch charges the client address before the handler runs and
 * before the body is read (F-018, 30/60 s where a trusted header is declared). The handler
 * therefore runs with NO ambient tenant context, and `findInvitationByCapabilityToken` opens
 * the token's own — the only sanctioned way a public route reaches tenant data (GC-L). The
 * accept route is NOT public: it runs under the caller's transaction, and a token for another
 * tenant is 409 before any statement (D-04).
 *
 * `:id` on the DELETE is not validated here, for the reason `workspaces.controller.ts` gives:
 * a non-uuid is the same 404 as another tenant's id and an id nobody issued.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { createInvitationRequestContract, listInvitationsQueryContract, WORKSPACE_ROLE } from '@shortkit/contracts';
import type {
  AcceptInvitationResponse,
  Invitation,
  InvitationListResponse,
  InvitationPreview,
} from '@shortkit/contracts';

import { RequireWorkspaceRole } from '../common/authorization/roles';
import { DomainError } from '../common/errors/domain-error';
import { parseOrThrow, VALIDATION_FAILED_MESSAGE } from '../common/errors/parse-or-throw';
import { Public } from '../tenancy/tenant-context';
import { InvitationsService } from './invitations.service';

/** The one issue a token body can raise here. Fixed text; the value is never quoted. */
const TOKEN_REQUIRED_MESSAGE = 'A token is required.';

/**
 * `{ token: string }` and nothing stricter — see the header. Anything else is 400 under
 * `token`; the string itself is judged by the entry functions only.
 */
function tokenFrom(body: unknown): string {
  const token = typeof body === 'object' && body !== null ? (body as { token?: unknown }).token : undefined;

  if (typeof token !== 'string' || token === '') {
    throw new DomainError('validation_failed', VALIDATION_FAILED_MESSAGE, {
      details: { fieldErrors: { token: [TOKEN_REQUIRED_MESSAGE] } },
    });
  }

  return token;
}

@Controller('invitations')
export class InvitationsController {
  /** `@Inject(...)` written out for the reason `workspaces.service.ts` gives. */
  constructor(@Inject(InvitationsService) private readonly service: InvitationsService) {}

  /** Form B inside the service, on every named workspace, before any write (D-09). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: unknown): Promise<Invitation> {
    return this.service.create(parseOrThrow(createInvitationRequestContract, body));
  }

  /** Form A on `query.workspaceId`: the interceptor decides 400/404/403 before this runs. */
  @Get()
  @RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)
  list(@Query() query: unknown): Promise<InvitationListResponse> {
    return this.service.list(parseOrThrow(listInvitationsQueryContract, query));
  }

  /** Form B inside the service, on every workspace the invitation names. Idempotent on `revoked`. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  revoke(@Param('id') id: string): Promise<Invitation> {
    return this.service.revoke(id);
  }

  /** The one public route. The bucket runs first; the token is judged by the entry function. */
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @Public('the invitee holds no account yet; the capability token is the authorisation (ADR-0021)')
  lookup(@Body() body: unknown): Promise<InvitationPreview> {
    return this.service.lookup(tokenFrom(body));
  }

  /** Authenticated, no role decorator: the token authorises; the caller's tenant must be the token's (D-04). */
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  accept(@Body() body: unknown): Promise<AcceptInvitationResponse> {
    return this.service.accept(tokenFrom(body));
  }
}
