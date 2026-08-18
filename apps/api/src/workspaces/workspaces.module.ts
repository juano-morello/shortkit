/**
 * Produced by: TASK-012
 *
 * The workspace feature: `WorkspaceRepository` (TASK-011), `WorkspacesService` and the four
 * routes. A module rather than a controller registered straight on `AppModule`, for the
 * reason `health.module.ts` gives: the composition root keeps naming feature modules and
 * nothing else.
 *
 * The repository is a provider HERE and nowhere else today. TASK-056's discovery enumerates
 * `@TenantScopedRepository()` providers wherever they are registered, so this is where it
 * will find this one.
 */
import { Module } from '@nestjs/common';

import { WorkspaceRepository } from './workspace.repository';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  controllers: [WorkspacesController],
  providers: [WorkspaceRepository, WorkspacesService],
})
export class WorkspacesModule {}
