/**
 * Contract: docs/contracts/workspace-authorization.md
 * ADR: adr-0020 (both repositories carry `@TenantScopedRepository()` so discovery finds them)
 * Produced by: TASK-1b-05
 *
 * The providers the authorization surface needs, exported so that `AppModule` can bind
 * `WorkspaceAuthorizationInterceptor` as a global interceptor (its constructor injects the two
 * repositories, resolved in the root context) and so that a feature module — `WorkspacesModule`
 * (TASK-1b-06), `InvitationsModule` (TASK-1b-08) — imports this one and injects
 * `WorkspaceAuthorizer` for Form B, or `MembershipRepository` for the creator's row.
 *
 * The interceptor is NOT provided here as `APP_INTERCEPTOR`. Its position is a ruling —
 * third, after `TenantTransactionInterceptor` — and `app.module.ts` is where the three are
 * registered in order and where `app.module.spec.ts` asserts it. A second registration here
 * would run the check twice.
 */
import { Module } from '@nestjs/common';

import { MembershipRepository } from '../../memberships/membership.repository';
import { TenantMembershipRepository } from '../../memberships/tenant-membership.repository';
import { WorkspaceAuthorizer } from './workspace-authorizer';

@Module({
  providers: [MembershipRepository, TenantMembershipRepository, WorkspaceAuthorizer],
  exports: [MembershipRepository, TenantMembershipRepository, WorkspaceAuthorizer],
})
export class AuthorizationModule {}
