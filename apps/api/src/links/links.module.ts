/**
 * Produced by: TASK-2-05
 *
 * The link feature: `LinkRepository`, `SlugGenerator` with its `RANDOM_SOURCE` binding,
 * `LinksService` and the five routes.
 *
 * `WorkspacesModule` is IMPORTED for `WorkspaceRepository` (the archive check reads the
 * named workspace) rather than providing the class a second time (the debt sweep's
 * 1b-W3-08 finding, closed there and not to be reopened here). `AuthorizationModule` is
 * imported for `WorkspaceAuthorizer`, which the three by-id routes call as Form B.
 * TASK-056's discovery enumerates `@TenantScopedRepository()` providers wherever they are
 * registered, so it finds `LinkRepository` here, once.
 *
 * `RANDOM_SOURCE` IS A BINDING, NOT AN IMPORT INSIDE THE GENERATOR, and that is what makes
 * AC-2-10 deterministic: production binds `cryptoRandomSource` here, and a suite overrides
 * the token with a scripted source to force a slug collision on demand. A generator that
 * reached for `crypto.randomFillSync` itself could only be tested against chance.
 *
 * `LinkRepository` is EXPORTED: TASK-2-09's clicks module reads a link to answer
 * `GET /api/links/:linkId/clicks`, and importing this module is how it gets the class
 * rather than registering a second copy.
 */
import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../common/authorization/authorization.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

import { cryptoRandomSource, RANDOM_SOURCE, SlugGenerator } from './codes/slug-generator';
import { LinkRepository } from './link.repository';
import { LinksController } from './links.controller';
import { LinksService } from './links.service';

@Module({
  imports: [AuthorizationModule, WorkspacesModule],
  controllers: [LinksController],
  providers: [
    { provide: RANDOM_SOURCE, useValue: cryptoRandomSource },
    SlugGenerator,
    LinkRepository,
    LinksService,
  ],
  exports: [LinkRepository],
})
export class LinksModule {}
