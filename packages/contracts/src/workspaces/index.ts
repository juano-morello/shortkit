/**
 * Contract: docs/contracts/workspaces.md ("Endpoints"), error-envelope.md
 * ADR: adr-0005-contract-distribution.md, adr-0006-http-surface-partitioning.md,
 *      adr-0025-zod-error-recognition-in-contracts.md
 * Produced by: TASK-012; TASK-1b-06 (`workspaceRole`, `GET /api/workspaces/:workspaceId`)
 *
 * The five workspace endpoints, declared once and read by both deployables:
 *
 *   POST  /api/workspaces                        createWorkspaceRequestContract  -> 201 workspaceContract
 *   GET   /api/workspaces                        listWorkspacesQueryContract     -> 200 workspaceListResponseContract
 *   GET   /api/workspaces/:workspaceId           (no body)                       -> 200 workspaceContract
 *   PATCH /api/workspaces/:workspaceId           renameWorkspaceRequestContract  -> 200 workspaceContract
 *   POST  /api/workspaces/:workspaceId/archive   (no body)                       -> 200 workspaceContract
 *
 * THIS PACKAGE MAY IMPORT `zod` AND NOTHING ELSE (ADR-0005).
 *
 * `workspaceContract` MIRRORS THE REPOSITORY ROW MINUS `tenantId`, PLUS THE CALLER'S ROLE.
 * The caller is inside their own tenant — the guard put them there and the transaction
 * interceptor bound every statement to it — so returning the id tells them nothing they
 * can act on and puts a tenant id on the wire for no reason. The three timestamps are ISO
 * strings because they crossed JSON; in the row they are `Date`, in the database
 * `timestamptz`.
 *
 * `workspaceRole` (TASK-1b-06, D-07/D-10) IS THE CALLER'S OWN ROLE IN THAT WORKSPACE —
 * `workspace_admin` for the creator on `POST`, the joined `memberships.role` on the list,
 * the role the authorization interceptor found on the single-row routes. Named
 * `workspaceRole` and never `role`, per `workspace-authorization.md` (a wire field naming a
 * role says which enum). Unbranded on the wire (`z.enum(WORKSPACE_ROLES)`, ADR-0048); a
 * consumer that needs the brand goes through `asWorkspaceRole`. The API sends it on every
 * response; the schema admits its absence for the one reason `Versioning` in
 * `workspaces.md` gives — an additive field must not break a client parsing the pre-1b
 * shape (the web's workspaces screen and its fixtures, rewritten by TASK-1b-14) — and the
 * `.optional()` is what that card removes.
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
import { WORKSPACE_ROLES } from '../roles';

/**
 * The name rule: trimmed, then 1 to 100 characters, then no control character (2026-08-19,
 * see below). THE TRIM RUNS FIRST, so `'   '` is refused as empty and a hundred characters
 * wrapped in whitespace is accepted; what the endpoints store and return is the trimmed
 * value. Input and output types are both
 * `string`, so `apps/web` can build a request body from `z.infer` and parse a response into
 * it (the rule `auth/index.ts` states for every shape here).
 */
export const WORKSPACE_NAME_MIN_LENGTH = 1;
export const WORKSPACE_NAME_MAX_LENGTH = 100;

/**
 * Added 2026-08-19 (debt sweep, ledger 1b-W1-09): NO CONTROL CHARACTER IN A NAME. A name
 * containing any code point below U+0020, or U+007F (DEL), is refused with the fixed
 * message below. The finding: a newline in a workspace or tenant name forges the console
 * mail transport's block boundary (`console-mail-sender.ts` frames its output with fixed
 * header/footer lines), and control characters have no place in a display name anyway.
 * The refine runs AFTER the trim, so leading/trailing whitespace — including `\n` and
 * `\t`, which the trim removes — never triggers it; only an interior control character
 * refuses. `signUpRequestContract.name` (`../auth`) applies the same rule with the same
 * message, and through it `tenants.name`, which `on-user-created.ts` copies verbatim from
 * the signup name (F-198). The predicate and the message live here because the first name
 * contract does; they are name-generic, not workspace-specific. A code-point scan rather
 * than a regex, deliberately: eslint's `no-control-regex` exists because control
 * characters in a regex are usually an accident, and a rule carve-out for the one
 * intentional case costs more than the loop.
 */
export const NAME_CONTROL_CHARACTERS_MESSAGE = 'Control characters are not allowed in a name.';

/** True when `value` contains any code point below U+0020, or U+007F (DEL). */
export function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      return true;
    }
  }

  return false;
}

export const workspaceNameContract = z
  .string()
  .trim()
  .min(WORKSPACE_NAME_MIN_LENGTH)
  .max(WORKSPACE_NAME_MAX_LENGTH)
  .refine((name) => !containsControlCharacter(name), NAME_CONTROL_CHARACTERS_MESSAGE);

/**
 * The client shape of one workspace. `tenantId` is absent by decision (see the header);
 * `workspaceRole` is the caller's own role in it, sent on every response, admitted absent
 * for the additive-versioning reason the header gives (TASK-1b-14 removes the `.optional()`).
 */
export const workspaceContract = z.object({
  id: idContract,
  name: z.string(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workspaceRole: z.enum(WORKSPACE_ROLES).optional(),
});

export type Workspace = z.infer<typeof workspaceContract>;

/** `POST /api/workspaces`. */
export const createWorkspaceRequestContract = z.object({
  name: workspaceNameContract,
});

export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestContract>;

/** `PATCH /api/workspaces/:workspaceId`. Same name rule as create; the id is a path parameter. */
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
