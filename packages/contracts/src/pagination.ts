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

export const paginationQueryContract = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof paginationQueryContract>;
