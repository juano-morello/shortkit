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
import { Controller, Get } from '@nestjs/common';

import { readBuildCommitSha } from './build-commit';

export interface HealthResponse {
  readonly status: 'ok';
  readonly commit: string;
}

@Controller('health')
export class HealthController {
  @Get()
  read(): HealthResponse {
    return { status: 'ok', commit: readBuildCommitSha() };
  }
}
