/**
 * Produced by: TASK-012; TASK-1b-06 (imports `AuthorizationModule`)
 *
 * The workspace feature: `WorkspaceRepository` (TASK-011), `WorkspacesService` and the five
 * routes. A module rather than a controller registered straight on `AppModule`, for the
 * reason `health.module.ts` gives: the composition root keeps naming feature modules and
 * nothing else.
 *
 * `WorkspaceRepository` is a provider HERE and nowhere else today. TASK-056's discovery
 * enumerates `@TenantScopedRepository()` providers wherever they are registered, so this is
 * where it will find this one. `MembershipRepository` — which `WorkspacesService` injects for
 * the creator's `workspace_admin` row (D-10) — is `AuthorizationModule`'s provider and is
 * IMPORTED rather than provided again, so discovery finds it once.
 */
import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../common/authorization/authorization.module';
import { WorkspaceRepository } from './workspace.repository';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [AuthorizationModule],
  controllers: [WorkspacesController],
  providers: [WorkspaceRepository, WorkspacesService],
})
export class WorkspacesModule {}
