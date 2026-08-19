/**
 * Contract: docs/contracts/click-events.md (the tenant-facing read surface),
 *           workspace-authorization.md ("Minimum role per surface": the clicks row, `viewer`;
 *           Form B), error-envelope.md
 * ADR: adr-0006 (everything answers under `/api`), adr-0024, adr-0025, adr-0038
 * Decision: D-2-12, D-2-19
 * Produced by: TASK-2-09 (item 2, wave 4).
 *
 *   GET /api/links/:linkId/clicks   Form B in the service (viewer)   200 Paginated<ClickEvent>
 *
 * ONE ROUTE, AND IT IS A GET. This controller is the tenant's whole surface on
 * `click_events`: no POST (the buffer is the only writer, and it is not reachable over
 * HTTP), no PATCH, no DELETE (AC-2-39: append-only is enforced by the absence of methods,
 * and the enumeration test asserts this class declares one handler and that it is a GET).
 *
 * IT SHARES THE `links` PREFIX AND THAT IS NOT AN ORDERING HAZARD: `links/:linkId/clicks` is
 * three segments and `links/:linkId` is two, so no registration order can make one shadow
 * the other. It lives here rather than on `LinksController` because the module boundary is
 * the point: the clicks module owns the store, and `LinksModule` (wave 2) must not grow a
 * dependency on it.
 *
 * `:linkId` IS NOT VALIDATED HERE, ON PURPOSE, exactly as on the link routes: a malformed id
 * is 404 `not_found` like an id from another tenant and an id that never existed, because
 * answering 400 for one shape and 404 for another lets a caller tell a well-formed miss from
 * a malformed one.
 *
 * No `@Public()`, no `@NoTenantTransaction()`: the global `AuthGuard` and the global
 * `TenantTransactionInterceptor` apply, which is what puts the whole handler inside the
 * caller's tenant transaction and under RLS.
 */
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { clickQueryContract } from '@shortkit/contracts';
import type { ClickEvent, Paginated } from '@shortkit/contracts';

import { parseOrThrow } from '../common/errors/parse-or-throw';

import { ClicksService } from './clicks.service';

@Controller('links')
export class ClicksController {
  /** `@Inject(...)` written out for the reason `workspaces.service.ts` gives. */
  constructor(@Inject(ClicksService) private readonly service: ClicksService) {}

  /** Form B, `viewer`, in the service. `from`/`to`/`limit`/`cursor` off the query string. */
  @Get(':linkId/clicks')
  list(@Param('linkId') linkId: string, @Query() query: unknown): Promise<Paginated<ClickEvent>> {
    return this.service.list(linkId, parseOrThrow(clickQueryContract, query));
  }
}
