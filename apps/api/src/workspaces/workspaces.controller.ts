/**
 * Contract: docs/contracts/workspaces.md ("Endpoints"), error-envelope.md,
 *           workspace-authorization.md ("Minimum role per surface", "Status rules"),
 *           logging-and-headers.md (the route PATTERN, never a concrete path, is what may
 *           appear on a log line)
 * ADR: adr-0006-http-surface-partitioning.md (everything answers under `/api`),
 *      adr-0024-domain-error-transport.md, adr-0025-zod-error-recognition-in-contracts.md,
 *      adr-0038-anything-not-get-or-head-is-mutating.md, adr-0062 (membership is a table
 *      the interceptor reads; the routes declare a minimum and nothing else)
 * Produced by: TASK-012; TASK-1b-06 (roles, `:workspaceId`, `GET` by id)
 *
 * The first authenticated routes shortkit has had. All five sit under the `/api` global
 * prefix `main.ts` sets (ADR-0006), all five are guarded by the global `AuthGuard` and run
 * inside the tenant transaction the global `TenantTransactionInterceptor` opens: nothing
 * here says so, which is the point of the two being global. No `@Public()`, no
 * `@NoTenantTransaction()`.
 *
 *   POST  /api/workspaces                         @RequireTenantRole(admin)                { name }   201 Workspace (+ creator membership)
 *   GET   /api/workspaces                         (membership-filtered, no decorator)      ?includeArchived  200 { items }
 *   GET   /api/workspaces/:workspaceId            @RequireWorkspaceRole(viewer)            (no body)  200 Workspace
 *   PATCH /api/workspaces/:workspaceId            @RequireWorkspaceRole(workspace_admin)   { name }   200 Workspace
 *   POST  /api/workspaces/:workspaceId/archive    @RequireWorkspaceRole(workspace_admin)   (no body)  200 Workspace, idempotent
 *
 * THE MINIMUM ROLE IS DECLARED HERE AND ENFORCED IN `WorkspaceAuthorizationInterceptor`
 * (Form A, `workspace-authorization.md`), which runs inside the transaction, reads the
 * `memberships` row for `params.workspaceId` (hence the param NAME: it is what Form A
 * resolves first (D-07)), and answers 404 `not_found` for no membership, another tenant's id
 * or a non-uuid, 403 `insufficient_workspace_role` for a rank below the minimum, before this
 * handler runs. `POST /api/workspaces` is tenant-level: `RequireTenantRole(admin)`, which the
 * signup `owner` (rank 20) passes and an invitee's `member` (rank 0) does not (AC-1b-17). The
 * list carries no decorator on purpose: it is filtered by membership in the statement rather
 * than gated (D-10), so a caller with no memberships gets `{ items: [] }` and not a refusal.
 *
 * WHO IS ASKING is `currentActor()`: the `RequestContext` the guard wrote, made ambient by
 * the authorization interceptor for every authenticated route, carrying `userId` (the
 * creator, the list's subject) and, on the decorated routes, `workspaceRole`, which is what
 * the response's `workspaceRole` reports. Outside a request it throws (500); it never answers
 * for nobody.
 *
 * REQUESTS ARE PARSED THROUGH THE CONTRACTS INSIDE THE HANDLER. No `ZodValidationPipe`
 * exists yet (ADR-0025, "Follow-ups"), and `apps/api` declares no `zod` dependency, so the
 * schema is called by hand and the `ZodError` it throws is turned into a `DomainError`
 * carrying `validation_failed` and `toValidationDetails(error)`: the same shape the filter's
 * own branch 2 would build, produced here so the route decides its code where it decides
 * everything else. `isZodError` and `toValidationDetails` come from `@shortkit/contracts`;
 * zod is imported nowhere in this file, value or type.
 *
 * A BODY THAT IS NOT JSON NEVER REACHES THESE HANDLERS. body-parser raises before the route,
 * Nest maps it to a `BadRequestException`, and the filter's branch 3 answers 400
 * `validation_failed` with the issue under `_form` and a fixed message
 * (`error-envelope.md`, "Branch 3"; measured in `framework-400-request-body.spec.ts`).
 *
 * `:workspaceId` IS NOT VALIDATED HERE, ON PURPOSE. A malformed id is a 404 `not_found`
 * exactly like an id from another tenant, an id that never existed and a workspace the
 * caller is not a member of: the interceptor's lookup answers "no membership" for a
 * non-uuid without reaching Postgres, with the body `WorkspaceRepository` gives a missing
 * row, and answering 400 for one shape and 404 for another would let a caller tell a
 * well-formed miss from a malformed one: a small oracle, and one `docs/contracts/workspaces.md`
 * rules out.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createWorkspaceRequestContract,
  isZodError,
  listWorkspacesQueryContract,
  renameWorkspaceRequestContract,
  TENANT_ROLE,
  toValidationDetails,
  WORKSPACE_ROLE,
} from '@shortkit/contracts';
import type { Workspace, WorkspaceListResponse } from '@shortkit/contracts';

import { currentActor } from '../common/authorization/actor-context';
import { RequireTenantRole, RequireWorkspaceRole } from '../common/authorization/roles';
import { DomainError } from '../common/errors/domain-error';
import { WorkspacesService } from './workspaces.service';

/**
 * The same text the filter's own validation branches carry (`error-envelope.md`, "Message
 * constants"): a client renders per code and never branches on a message, and the failing
 * fields are in `details`. Restated rather than imported because the filter keeps its
 * constants module-private, and F-098's point (no third string) holds as long as the value
 * is the same.
 */
const VALIDATION_FAILED_MESSAGE = 'The request could not be validated.';

/** The one shape this file needs of a contract: something with `parse`. Not a zod type. */
interface Contract<T> {
  parse(input: unknown): T;
}

/**
 * Parses `input` with `contract`; a `ZodError` becomes 400 `validation_failed` with the
 * flattened field errors as `details`, and anything else is rethrown untouched.
 */
function parseOrThrow<T>(contract: Contract<T>, input: unknown): T {
  try {
    return contract.parse(input);
  } catch (error: unknown) {
    if (isZodError(error)) {
      throw new DomainError('validation_failed', VALIDATION_FAILED_MESSAGE, {
        details: toValidationDetails(error),
      });
    }

    throw error;
  }
}

@Controller('workspaces')
export class WorkspacesController {
  /** `@Inject(...)` written out for the reason `workspaces.service.ts` gives. */
  constructor(@Inject(WorkspacesService) private readonly service: WorkspacesService) {}

  /**
   * 201 is Nest's default for `@Post()`; written out so the ruling is on the handler. Tenant
   * `admin` or above creates; the creator becomes the workspace's `workspace_admin` (D-10).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireTenantRole(TENANT_ROLE.admin)
  create(@Body() body: unknown): Promise<Workspace> {
    return this.service.create(currentActor(), parseOrThrow(createWorkspaceRequestContract, body));
  }

  /** No decorator: the statement filters by the caller's memberships (D-10). */
  @Get()
  list(@Query() query: unknown): Promise<WorkspaceListResponse> {
    return this.service.list(currentActor(), parseOrThrow(listWorkspacesQueryContract, query));
  }

  /** Any membership reads (`viewer` is the floor of the enum). */
  @Get(':workspaceId')
  @RequireWorkspaceRole(WORKSPACE_ROLE.viewer)
  get(@Param('workspaceId') workspaceId: string): Promise<Workspace> {
    return this.service.get(currentActor(), workspaceId);
  }

  @Patch(':workspaceId')
  @HttpCode(HttpStatus.OK)
  @RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)
  rename(@Param('workspaceId') workspaceId: string, @Body() body: unknown): Promise<Workspace> {
    return this.service.rename(currentActor(), workspaceId, parseOrThrow(renameWorkspaceRequestContract, body));
  }

  /** `POST` rather than `PATCH { archived: true }`: an action, idempotent, with no body. */
  @Post(':workspaceId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)
  archive(@Param('workspaceId') workspaceId: string): Promise<Workspace> {
    return this.service.archive(currentActor(), workspaceId);
  }
}
