/**
 * AC-6, ADR-0006, ADR-0027
 * Produced by: TASK-003
 *
 * `GET /health` answers `200 {"status":"ok","commit":"<40 hex>"}` at the ROOT, outside the
 * `/api` global prefix. `main.ts` has excluded it from the prefix since TASK-001; F-217
 * recorded that the exclusion existed while nothing answered the route, so a platform
 * health probe read a 404 as a broken service rather than an unimplemented one.
 *
 * The commit is read per request rather than captured at construction. See
 * `build-commit.ts`: a read during dependency injection turns two specs red that this TASK
 * does not own. The cost is one `process.env` lookup per probe, every 15 seconds.
 */
import { Controller, Get, SetMetadata } from '@nestjs/common';

import { PUBLIC_ROUTE_METADATA } from '../tenancy/tenant-context';
import { readBuildCommitSha } from './build-commit';

export interface HealthResponse {
  readonly status: 'ok';
  readonly commit: string;
}

@Controller('health')
export class HealthController {
  /**
   * Public: the platform probe carries no credential (`auth-tokens.md` invariant 6, "GET
   * /health (platform probe)"). `AuthGuard` is global since TASK-005, so the exemption has to
   * be on the handler. This is `SetMetadata` on the guard's key rather than `@Public('…')`
   * because the decorator is TASK-006's and still throws `not implemented`; TASK-006 replaces
   * this line with `@Public('platform probe')` and nothing else here changes.
   */
  @Get()
  @SetMetadata(PUBLIC_ROUTE_METADATA, 'platform probe')
  read(): HealthResponse {
    return { status: 'ok', commit: readBuildCommitSha() };
  }
}
