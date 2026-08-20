/**
 * Produced by: TASK-012; TASK-1b-06 (imports `AuthorizationModule`); debt sweep D1
 * (2026-08-19, finding 1b-W3-08: exports `WorkspaceRepository`)
 *
 * The workspace feature: `WorkspaceRepository` (TASK-011), `WorkspacesService` and the five
 * routes. A module rather than a controller registered straight on `AppModule`, for the
 * reason `health.module.ts` gives: the composition root keeps naming feature modules and
 * nothing else.
 *
 * `WorkspaceRepository` is a provider HERE and nowhere else, and it is EXPORTED so
 * `InvitationsModule` — whose service needs `findById` for each named workspace — imports it
 * rather than providing the class a second time (1b-W3-08; item 1b shipped the double
 * registration and noted it for close). TASK-056's discovery enumerates
 * `@TenantScopedRepository()` providers wherever they are registered, so it finds this one
 * here, once. `MembershipRepository` — which `WorkspacesService` injects for the creator's
 * `workspace_admin` row (D-10) — is `AuthorizationModule`'s provider and is IMPORTED rather
 * than provided again, for the same reason.
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
  exports: [WorkspaceRepository],
})
export class WorkspacesModule {}
