/**
 * Produced by: TASK-1b-08; debt sweep D1 (2026-08-19, finding 1b-W3-08)
 *
 * The invitation feature: `InvitationRepository` (TASK-1b-04), `InvitationsService`, the
 * five routes, the mail port (`MailModule`, TASK-1b-02) and the authorizer
 * (`AuthorizationModule`, TASK-1b-05). A module rather than a controller on `AppModule`, for
 * the reason `workspaces.module.ts` gives.
 *
 * `WorkspaceRepository` — which the service needs for `findById` on each named workspace's
 * name and archive state — comes from `WorkspacesModule`, which exports it. Item 1b shipped
 * it PROVIDED here a second time because `WorkspacesModule` did not export it then, and
 * noted the double registration for close (1b-W3-08); one provider, one instance, is the
 * rule `AuthorizationModule`'s `MembershipRepository` already follows and the shape TASK-056's
 * discovery expects (each `@TenantScopedRepository()` registered once).
 */
import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../common/authorization/authorization.module';
import { MailModule } from '../mail/mail.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

import { InvitationRepository } from './invitation.repository';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [MailModule, AuthorizationModule, WorkspacesModule],
  controllers: [InvitationsController],
  providers: [InvitationRepository, InvitationsService],
})
export class InvitationsModule {}
