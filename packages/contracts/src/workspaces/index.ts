/**
 * Contract: docs/contracts/workspaces.md ("Endpoints"), error-envelope.md
 * ADR: adr-0005-contract-distribution.md, adr-0006-http-surface-partitioning.md,
 *      adr-0025-zod-error-recognition-in-contracts.md
 * Produced by: TASK-012
 *
 * The four workspace endpoints, declared once and read by both deployables:
 *
 *   POST  /api/workspaces               createWorkspaceRequestContract  -> 201 workspaceContract
 *   GET   /api/workspaces               listWorkspacesQueryContract     -> 200 workspaceListResponseContract
 *   PATCH /api/workspaces/:id           renameWorkspaceRequestContract  -> 200 workspaceContract
 *   POST  /api/workspaces/:id/archive   (no body)                       -> 200 workspaceContract
 *
 * THIS PACKAGE MAY IMPORT `zod` AND NOTHING ELSE (ADR-0005).
 *
 * `workspaceContract` MIRRORS THE REPOSITORY ROW MINUS `tenantId`. The caller is inside
 * their own tenant — the guard put them there and the transaction interceptor bound every
 * statement to it — so returning the id tells them nothing they can act on and puts a
 * tenant id on the wire for no reason. The three timestamps are ISO strings because they
 * crossed JSON; in the row they are `Date`, in the database `timestamptz`.
 *
 * `archivedAt` null means active (docs/contracts/workspaces.md, "Rulings"). AC-23's
 * observable — leaves the default list, present with the archived state set when archived
 * workspaces are requested — is what `listWorkspacesQueryContract.includeArchived` selects.
 *
 * NO PAGINATION IN THIS INITIATIVE. `workspaceListResponseContract` is `{ items }` and
 * deliberately not `paginated(workspaceContract)`: a tenant holds a handful of workspaces,
 * no AC asks for a cursor, and adding one later is an additive change to this shape.
 * `pagination.ts`'s `paginated()` stays the shape for lists that grow without bound.
 */
import { z } from 'zod';

import { idContract } from '../pagination';

/**
 * The name rule: trimmed, then 1 to 100 characters. THE TRIM RUNS FIRST, so `'   '` is
 * refused as empty and a hundred characters wrapped in whitespace is accepted; what the
 * endpoints store and return is the trimmed value. Input and output types are both
 * `string`, so `apps/web` can build a request body from `z.infer` and parse a response into
 * it (the rule `auth/index.ts` states for every shape here).
 */
export const WORKSPACE_NAME_MIN_LENGTH = 1;
export const WORKSPACE_NAME_MAX_LENGTH = 100;

export const workspaceNameContract = z
  .string()
  .trim()
  .min(WORKSPACE_NAME_MIN_LENGTH)
  .max(WORKSPACE_NAME_MAX_LENGTH);

/** The client shape of one workspace. `tenantId` is absent by decision (see the header). */
export const workspaceContract = z.object({
  id: idContract,
  name: z.string(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Workspace = z.infer<typeof workspaceContract>;

/** `POST /api/workspaces`. */
export const createWorkspaceRequestContract = z.object({
  name: workspaceNameContract,
});

export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestContract>;

/** `PATCH /api/workspaces/:id`. Same name rule as create; the id is a path parameter. */
export const renameWorkspaceRequestContract = z.object({
  name: workspaceNameContract,
});

export type RenameWorkspaceRequest = z.infer<typeof renameWorkspaceRequestContract>;

/**
 * `GET /api/workspaces?includeArchived=true|false`. A query string arrives as text, so the
 * two spellings `'true'` and `'false'` are parsed EXPLICITLY into the boolean they name and
 * nothing else is admitted — not `'1'`, not `'yes'`, not `'TRUE'` — so a typo answers 400
 * `validation_failed` rather than silently listing the wrong set. A real boolean is
 * accepted too, for a caller that builds the query as an object before serialising it.
 *
 * Absent means false: the default list is the active workspaces (AC-23). The default is
 * applied by the caller, not by this schema, so `z.infer` keeps the field optional and a
 * client can send nothing for the common case.
 */
export const listWorkspacesQueryContract = z.object({
  includeArchived: z
    .union([
      z.boolean(),
      z.literal('true').transform(() => true),
      z.literal('false').transform(() => false),
    ])
    .optional(),
});

export type ListWorkspacesQuery = z.infer<typeof listWorkspacesQueryContract>;

/** `GET /api/workspaces` answers this. Unpaginated in this initiative (see the header). */
export const workspaceListResponseContract = z.object({
  items: z.array(workspaceContract),
});

export type WorkspaceListResponse = z.infer<typeof workspaceListResponseContract>;
