/**
 * AC-6, ADR-0006, ADR-0027
 * Produced by: TASK-003. `@Public('platform probe')` since TASK-006.
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
import { Controller, Get } from '@nestjs/common';

import { Public } from '../tenancy/tenant-context';
import { readBuildCommitSha } from './build-commit';

export interface HealthResponse {
  readonly status: 'ok';
  readonly commit: string;
}

@Controller('health')
export class HealthController {
  /**
   * Public: the platform probe carries no credential (`auth-tokens.md` invariant 6, "GET
   * /health (platform probe)"). `AuthGuard` is global since TASK-005 and
   * `TenantTransactionInterceptor` since TASK-006, so the exemption has to be on the handler
   * and it exempts the route from both: no token is read and no tenant transaction is
   * opened for a probe. The justification is what TASK-056's coverage report prints.
   */
  @Get()
  @Public('platform probe')
  read(): HealthResponse {
    return { status: 'ok', commit: readBuildCommitSha() };
  }
}
