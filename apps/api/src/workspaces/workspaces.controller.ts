/**
 * Contract: docs/contracts/workspaces.md ("Endpoints"), error-envelope.md,
 *           logging-and-headers.md (the route PATTERN, never a concrete path, is what may
 *           appear on a log line)
 * ADR: adr-0006-http-surface-partitioning.md (everything answers under `/api`),
 *      adr-0024-domain-error-transport.md, adr-0025-zod-error-recognition-in-contracts.md,
 *      adr-0038-anything-not-get-or-head-is-mutating.md
 * Produced by: TASK-012
 *
 * The first authenticated routes shortkit has had. All four sit under the `/api` global
 * prefix `main.ts` sets (ADR-0006), all four are guarded by the global `AuthGuard` and run
 * inside the tenant transaction the global `TenantTransactionInterceptor` opens — nothing
 * here says so, which is the point of the two being global. No `@Public()`, no
 * `@NoTenantTransaction()`.
 *
 *   POST  /api/workspaces               { name }            201 Workspace
 *   GET   /api/workspaces               ?includeArchived    200 { items: Workspace[] }
 *   PATCH /api/workspaces/:id           { name }            200 Workspace
 *   POST  /api/workspaces/:id/archive   (no body)           200 Workspace, idempotent
 *
 * REQUESTS ARE PARSED THROUGH THE CONTRACTS INSIDE THE HANDLER. No `ZodValidationPipe`
 * exists yet (ADR-0025, "Follow-ups"), and `apps/api` declares no `zod` dependency, so the
 * schema is called by hand and the `ZodError` it throws is turned into a `DomainError`
 * carrying `validation_failed` and `toValidationDetails(error)` — the same shape the filter's
 * own branch 2 would build, produced here so the route decides its code where it decides
 * everything else. `isZodError` and `toValidationDetails` come from `@shortkit/contracts`;
 * zod is imported nowhere in this file, value or type.
 *
 * A BODY THAT IS NOT JSON NEVER REACHES THESE HANDLERS. body-parser raises before the route,
 * Nest maps it to a `BadRequestException`, and the filter's branch 3 answers 400
 * `validation_failed` with the issue under `_form` and a fixed message
 * (`error-envelope.md`, "Branch 3"; measured in `framework-400-request-body.spec.ts`).
 *
 * `:id` IS NOT VALIDATED HERE, ON PURPOSE. A malformed id is a 404 `not_found` exactly like
 * an id from another tenant and an id that never existed: the repository answers
 * `WorkspaceNotFoundError` for a non-uuid without reaching Postgres, and answering 400 for
 * one shape and 404 for another would let a caller tell a well-formed miss from a malformed
 * one — a small oracle, and one `docs/contracts/workspaces.md` rules out.
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
  toValidationDetails,
} from '@shortkit/contracts';
import type { Workspace, WorkspaceListResponse } from '@shortkit/contracts';

import { DomainError } from '../common/errors/domain-error';
import { WorkspacesService } from './workspaces.service';

/**
 * The same text the filter's own validation branches carry (`error-envelope.md`, "Message
 * constants"): a client renders per code and never branches on a message, and the failing
 * fields are in `details`. Restated rather than imported because the filter keeps its
 * constants module-private, and F-098's point — no third string — holds as long as the value
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

  /** 201 is Nest's default for `@Post()`; written out so the ruling is on the handler. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: unknown): Promise<Workspace> {
    return this.service.create(parseOrThrow(createWorkspaceRequestContract, body));
  }

  @Get()
  list(@Query() query: unknown): Promise<WorkspaceListResponse> {
    return this.service.list(parseOrThrow(listWorkspacesQueryContract, query));
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  rename(@Param('id') id: string, @Body() body: unknown): Promise<Workspace> {
    return this.service.rename(id, parseOrThrow(renameWorkspaceRequestContract, body));
  }

  /** `POST` rather than `PATCH { archived: true }`: an action, idempotent, with no body. */
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  archive(@Param('id') id: string): Promise<Workspace> {
    return this.service.archive(id);
  }
}
