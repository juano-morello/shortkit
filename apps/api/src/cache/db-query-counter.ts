/**
 * Contract: docs/contracts/redirect-cache.md ("What the implementer must guarantee":
 *           `dbQueryCounter` increments on every Postgres query issued by the redirect path
 *           and is readable by tests). AC-49, AC-54, AC-2-29, AC-2-31.
 * Produced by: TASK-2-03 (item 2, wave 1).
 * Consumed by: TASK-2-06 / TASK-2-07 (`withRedirectRead` increments it), and the suites
 *              that assert a cache hit costs zero Postgres queries.
 *
 * ============================================================================
 * THE OBSERVABLE FOR "A CACHE HIT PERFORMS ZERO POSTGRES QUERIES" (invariant 4).
 * ============================================================================
 *
 * A test cannot see the difference between a hit and a miss from the response — both are the
 * same 302 with the same `Location`. This counter is the difference, which is why it is a
 * shipped export rather than test scaffolding: `withRedirectRead` increments it on every
 * statement it issues, and the assertion is `read()` before and after one request.
 *
 * PROCESS-GLOBAL, NOT PER-REQUEST-ISOLATED, AND STATED RATHER THAN IMPLIED. An
 * `AsyncLocalStorage` per request would isolate concurrent requests from each other and cost
 * a store lookup per query on the path GC-1 constrains. What the ACs need is "this request
 * issued N queries", and the suites that assert it drive one request at a time and `reset()`
 * before it. Two concurrent requests share the count; a load test therefore reads a total
 * rather than a per-request number, which is all it wants anyway.
 *
 * NOT A METRIC. There is no metrics facility in `apps/api/src` (the same absence ADR-0053
 * records for `auth_revocation_degraded_total`), and this is not a substitute for one: it is
 * unbounded, never exported, and nothing scrapes it.
 */

let queries = 0;

export const dbQueryCounter = {
  /** Called once per statement the redirect read path issues against Postgres. */
  increment(): void {
    queries += 1;
  },

  /** What a test compares. Monotonic between `reset()` calls. */
  read(): number {
    return queries;
  },

  /** What a test calls before the request it is measuring. */
  reset(): void {
    queries = 0;
  },
};
