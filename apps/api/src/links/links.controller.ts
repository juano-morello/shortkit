/**
 * Contract: docs/contracts/workspace-authorization.md ("Minimum role per surface", the link
 *           rows; "The two enforcement forms"), error-envelope.md, slug.md,
 *           logging-and-headers.md (the route PATTERN, never a concrete path, is what may
 *           appear on a log line)
 * ADR: adr-0006 (everything answers under `/api`), adr-0024, adr-0025, adr-0038
 * Produced by: TASK-2-05
 *
 * The five link routes, all under the `/api` global prefix `main.ts` sets, all behind the
 * global `AuthGuard`, all inside the tenant transaction the global
 * `TenantTransactionInterceptor` opens. Nothing here says so, which is the point of the two
 * being global. No `@Public()`, no `@NoTenantTransaction()`.
 *
 *   POST   /api/links                  @RequireWorkspaceRole(member)  { workspaceId, … }  201 Link
 *   GET    /api/links?workspaceId=     @RequireWorkspaceRole(viewer)  ?limit&cursor        200 Paginated<Link>
 *   GET    /api/links/:linkId          Form B in the service (viewer) (no body)            200 Link
 *   PATCH  /api/links/:linkId          Form B in the service (member) { … }                200 Link
 *   DELETE /api/links/:linkId          Form B in the service (member) (no body)            200 Link
 *
 * ============================================================================
 * WHY THE THREE BY-ID ROUTES CARRY NO DECORATOR, AND WHY THAT IS NOT AN OMISSION.
 * ============================================================================
 *
 * Form A resolves the workspace id from `params.workspaceId`, then `body.workspaceId`,
 * then `query.workspaceId`. A link route has the LINK's id in the path and the workspace
 * nowhere, so a `@RequireWorkspaceRole` here would resolve nothing and answer 400
 * `workspace_id_required` on every request. `workspace-authorization.md` names exactly this
 * case as Form B's ("resource routes such as `/api/links/:id`, where the workspace is a
 * property of the resource and cannot be known before loading it"): the service loads the
 * link through the tenant-scoped repository, which answers 404 for another tenant's id
 * before any role is read, and then calls `authorizer.assert(link.workspaceId, min)`.
 *
 * ============================================================================
 * DELETE ANSWERS 200 WITH THE ROW IT REMOVED, NOT 204 (ruled 2026-08-19, TASK-2-05).
 * ============================================================================
 *
 * The card's approach line says 204. Three shipped artifacts say otherwise and they agree
 * with each other: `packages/contracts/src/links/link.ts`'s route table, written by
 * TASK-2-01, declares `DELETE /api/links/:linkId (no body) -> 200 linkContract`;
 * `DELETE /api/invitations/:id`, the only other delete route in the system, answers 200
 * with the affected resource; and TASK-2-13, building the web client in this same wave,
 * narrows every response with the 2-01 contracts, which a 204 would leave nothing to
 * narrow. A body also carries the pre-image the operator just destroyed, which is the one
 * moment it is worth anything. Recorded here rather than settled quietly.
 *
 * REQUESTS ARE PARSED THROUGH THE CONTRACTS INSIDE THE HANDLER, by `parseOrThrow`. No
 * `ZodValidationPipe` exists (ADR-0025, "Follow-ups") and `apps/api` declares no `zod`
 * dependency, so the schema is called by hand and its `ZodError` becomes 400
 * `validation_failed` with the flattened field errors.
 *
 * `:linkId` IS NOT VALIDATED HERE, ON PURPOSE. A malformed id is 404 `not_found` exactly
 * like an id from another tenant and an id that never existed (`LinkRepository.findById`
 * answers `null` for a non-uuid without reaching Postgres): answering 400 for one shape
 * and 404 for another would let a caller tell a well-formed miss from a malformed one.
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
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createLinkContract,
  paginationQueryContract,
  updateLinkContract,
  WORKSPACE_ROLE,
} from '@shortkit/contracts';
import type { Link, Paginated } from '@shortkit/contracts';

import { currentActor } from '../common/authorization/actor-context';
import { RequireWorkspaceRole } from '../common/authorization/roles';
import { parseOrThrow } from '../common/errors/parse-or-throw';

import { LinksService } from './links.service';

@Controller('links')
export class LinksController {
  /** `@Inject(...)` written out for the reason `workspaces.service.ts` gives. */
  constructor(@Inject(LinksService) private readonly service: LinksService) {}

  /** Form A on `body.workspaceId`: the interceptor decides 400/404/403 before this runs. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireWorkspaceRole(WORKSPACE_ROLE.member)
  create(@Body() body: unknown): Promise<Link> {
    return this.service.create(currentActor(), parseOrThrow(createLinkContract, body));
  }

  /**
   * Form A on `query.workspaceId`. The id itself is read off the query rather than parsed
   * by `paginationQueryContract`, which declares `limit` and `cursor` and strips the rest:
   * a non-uuid there is the interceptor's 404, the same answer a workspace the caller is
   * not a member of gets.
   */
  @Get()
  @RequireWorkspaceRole(WORKSPACE_ROLE.viewer)
  list(
    @Query('workspaceId') workspaceId: string,
    @Query() query: unknown,
  ): Promise<Paginated<Link>> {
    return this.service.list(workspaceId, parseOrThrow(paginationQueryContract, query));
  }

  /** Form B, `viewer`, in the service. */
  @Get(':linkId')
  get(@Param('linkId') linkId: string): Promise<Link> {
    return this.service.get(linkId);
  }

  /** Form B, `member`. An empty patch is valid: 200, and `onLinkMutated` still fires. */
  @Patch(':linkId')
  @HttpCode(HttpStatus.OK)
  update(@Param('linkId') linkId: string, @Body() body: unknown): Promise<Link> {
    return this.service.update(currentActor(), linkId, parseOrThrow(updateLinkContract, body));
  }

  /** Form B, `member`. Hard delete; the click rows cascade (D-2-03). */
  @Delete(':linkId')
  @HttpCode(HttpStatus.OK)
  delete(@Param('linkId') linkId: string): Promise<Link> {
    return this.service.delete(currentActor(), linkId);
  }
}
