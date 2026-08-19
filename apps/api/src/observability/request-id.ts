/**
 * Contract: docs/contracts/logging-and-headers.md ("Required fields": `request_id` on every
 *           line inside a request — the `x-request-id` header, or a generated uuid)
 * Produced by: TASK-016 (wave 8). Consumed by `request-log.interceptor.ts`, which chooses the
 * id for a request and leaves it on the request, and by `common/errors/exception-filter.ts`,
 * which reads the same id onto its error line.
 *
 * ONE READING OF THE HEADER, IN ONE PLACE. Before this module the filter had its own copy of
 * "header, trimmed, capped, else uuid", and the interceptor would have needed a second; two
 * copies of a parser agree until one is edited. This is the one copy, and it is deliberately
 * a module with no dependency but `node:crypto`: the filter must not import the interceptor
 * (that would pull the auth guard's subtree into the one component that answers for every
 * throwable) and the interceptor must not import the filter.
 *
 * THE ORDER IS: THE ID ALREADY CHOSEN FOR THIS REQUEST, THEN THE HEADER, THEN A UUID. The
 * interceptor runs first and stores what it chose under `REQUEST_ID_KEY`; the filter, running
 * later on the error path, finds it there and the two lines for one failed request share an
 * id. Where the interceptor did not run — a request the guard refused, a path no route
 * matched, a body-parser 400 — the filter falls through to the header and then to a fresh
 * uuid, which is exactly what it did before.
 */
import { randomUUID } from 'node:crypto';

/**
 * Where the id chosen for a request is left on the request. A registered symbol for the
 * reason `REQUEST_CONTEXT_KEY` is one: it survives a duplicated module instance.
 */
export const REQUEST_ID_KEY: unique symbol = Symbol.for('shortkit.requestId');

/** `logging-and-headers.md`, "Required fields": the `x-request-id` header, or a generated uuid. */
const REQUEST_ID_HEADER = 'x-request-id';

/**
 * A caller-supplied `x-request-id` is untrusted input on its way into a log aggregator.
 * pino JSON-encodes it, so a newline cannot split the record, but nothing bounds its
 * length — 128 characters is longer than any correlation id anyone issues and short enough
 * that a megabyte header cannot be replayed into the log on every request.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/** What both readers see of a request: the header bag, and the slot one of them wrote. */
export interface RequestIdCarrier {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  [REQUEST_ID_KEY]?: string;
}

/**
 * The id for this request: the one already stored under `REQUEST_ID_KEY`, else the caller's
 * `x-request-id` (trimmed, capped), else a fresh uuid. Optional throughout, because
 * `getRequest()` is a cast and the filter calls this before the try/catch F-092 wrapped its
 * `write` in — a throw here would escape the one component that answers for every throwable.
 */
export function requestIdFor(request: RequestIdCarrier | undefined): string {
  const chosen = request?.[REQUEST_ID_KEY];

  if (typeof chosen === 'string' && chosen !== '') {
    return chosen;
  }

  const supplied = request?.headers?.[REQUEST_ID_HEADER];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;

  if (typeof value !== 'string' || value.trim() === '') {
    return randomUUID();
  }

  return value.trim().slice(0, MAX_REQUEST_ID_LENGTH);
}
