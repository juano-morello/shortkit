/**
 * Contract: docs/contracts/error-envelope.md (shared primitives)
 * Produced by: TASK-007
 */
import { z } from 'zod';

export const idContract = z.string().uuid();
export type Id = z.infer<typeof idContract>;

/** Cursor pagination. Offset pagination is not offered; cursors are stable under insert. */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The bound on `cursor` is not decoration. A cursor is caller supplied, and until item 2
 * gave it a consumer nothing rejected an absurd one: `limit` carried a bound and `cursor`
 * did not, so the only ceiling was whatever the transport happened to allow. Every cursor
 * this repository issues is base64url of an ISO timestamp, a separator and a uuid, about
 * eighty four characters, so 512 leaves room for a cursor shape nobody has written yet
 * while refusing input that could only be an attack or a bug.
 */
export const CURSOR_MAX_LENGTH = 512;

export const paginationQueryContract = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(CURSOR_MAX_LENGTH).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQueryContract>;
