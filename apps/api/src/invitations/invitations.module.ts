/**
 * Produced by: TASK-1b-08
 *
 * The invitation feature: `InvitationRepository` (TASK-1b-04), `InvitationsService`, the
 * five routes, the mail port (`MailModule`, TASK-1b-02) and the authorizer
 * (`AuthorizationModule`, TASK-1b-05). A module rather than a controller on `AppModule`, for
 * the reason `workspaces.module.ts` gives.
 *
 * `WorkspaceRepository` IS PROVIDED HERE AS WELL AS IN `WorkspacesModule`. It is stateless
 * (`tenantDb()` and nothing else) and `WorkspacesModule` does not export it; the service
 * needs `findById` for each named workspace's name and archive state. The isolation harness
 * registers repositories by hand (`test/isolation/registrations.ts`), so a second provider
 * of the same class is not a second subject.
 */
import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../common/authorization/authorization.module';
import { MailModule } from '../mail/mail.module';
import { WorkspaceRepository } from '../workspaces/workspace.repository';

import { InvitationRepository } from './invitation.repository';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [MailModule, AuthorizationModule],
  controllers: [InvitationsController],
  providers: [InvitationRepository, WorkspaceRepository, InvitationsService],
})
export class InvitationsModule {}
