---
id: ADR-0002
slug: launch-core
title: Bind tenant context with AsyncLocalStorage, an interceptor, and an accessor that throws
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

GC-5 says every tenant-scoped read or write runs inside a transaction that has
issued `SET LOCAL app.tenant_id`, and no query path may bypass it. SC-1 rests on
that holding across 57 TASKs written by subagents in 13 waves, none of which sees
the others' code. Discipline will not hold it. The framework has to.

`SET LOCAL` is transaction-scoped, so the transaction and the tenant setting are the
same unit. Something has to open that transaction before a handler runs and make the
open transaction reachable from a repository three call frames down.

NestJS runs guards before interceptors, so the guard that authenticates the request
runs before anything can open a transaction. The guard therefore cannot read the
database to discover the caller's tenant, or it would read outside tenant context
and create the hole GC-5 forbids.

TASK-011 makes this structural. TASK-029 needs one deliberate way out for the
anonymous redirect path, and TASK-054 needs another for GDPR erasure. Those two are
the only exclusions SC-1 records.

## Decision

Three layers, each of which alone would be insufficient.

**Layer 1: the database.** Every tenant-scoped table carries RLS with
`FORCE ROW LEVEL SECURITY` and a policy comparing `tenant_id` to
`current_setting('app.tenant_id', true)`. With the setting absent the comparison is
NULL, so the policy denies and the query returns zero rows. AC-10 asserts exactly
that. See ADR-0003 for the policy and role definitions.

**Layer 2: `AsyncLocalStorage`.** `apps/api/src/tenancy/` owns a module-private
`AsyncLocalStorage<TenantContext>`. `withTenantTransaction(tenantId, fn)` opens a
`pg` transaction, issues `SET LOCAL app.tenant_id = $1`, and runs `fn` inside
`als.run({ tenantId, tx }, ...)`. It commits when `fn` resolves and rolls back when
it throws. `tenantDb()` reads the store and throws `TenantContextMissingError` when
it is empty. The unwrapped Drizzle client is never exported from `apps/api/src/db`;
`tenantDb()` is the only way a repository reaches a connection.

**Layer 3: the interceptor.** `TenantTransactionInterceptor` is registered as
`APP_INTERCEPTOR` in `AppModule`. It reads `tenantId` from the `RequestContext` that
`AuthGuard` populated, calls `withTenantTransaction`, and runs the rest of the
handler chain inside it. Routes marked `@Public()` skip it, which is how the
redirect module and the invitation-accept route stay outside.

**`AuthGuard` never queries the database.** The JWT carries the tenant id in a `tid`
claim (ADR-0013). The guard verifies the signature against cached JWKS and populates
`RequestContext` from claims alone.

**Driver.** `pg` (node-postgres) with `drizzle-orm/node-postgres`, against Neon's
pooled endpoint. Not `@neondatabase/serverless`: its HTTP driver takes a transaction
as an array of statements decided up front, and GC-5 needs an interactive
transaction whose statements the application code chooses as it runs.

**No third-party network call inside a tenant transaction.** The transaction holds a
pooled connection for its whole lifetime. Email dispatch, Fly API calls and DNS
lookups happen after the transaction commits, from the caller. `withTenantTransaction`
takes an optional `afterCommit` callback for work that must follow a successful
commit.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| NestJS request-scoped providers (`Scope.REQUEST`) | Idiomatic Nest; the transaction is a first-class injectable; no async-context machinery | Request scope bubbles upward through the whole injection graph, so every provider that touches a repository becomes request-scoped, including anything the redirect module shares. A provider also cannot wrap the handler, so an interceptor is still needed to commit or roll back | It pollutes the hot path with per-request instantiation and still does not solve the wrapping problem it was chosen for |
| Explicit `tx` parameter threaded through every repository method | The type system enforces it; no hidden state; trivially testable | Every call site and every signature carries it, across 57 TASKs; a caller can still pass a transaction bound to the wrong tenant, so the types prove a transaction exists but not that it is the right one | Verbosity is survivable; the fact that it does not actually prove the property GC-5 cares about is not. Kept partially: the transaction handle is a distinct type, and the accessor is the only source of it |
| Connection-per-request with `SET` instead of `SET LOCAL` | No transaction needed for reads | `SET` survives the connection's return to the pool, so the next borrower inherits the previous tenant's context. AC-11 exists because this failure mode is the obvious one | Directly contradicts GC-5 and AC-11 |
| Postgres session-level `SET ROLE` per tenant | RLS by role is a well-known pattern | Needs one database role per tenant, created at signup. Neon's free tier and any pooler make that impractical, and role creation on the signup path is a privileged operation | Cost and blast radius far exceed the benefit at this scale |

## Consequences

### Positive

- A repository method called outside a tenant transaction throws in development and
  returns zero rows in production. Both failure modes are loud and safe.
- The guard runs no query, so authenticated requests cost one round trip fewer and
  the ordering problem disappears.
- Rollback semantics come free: AC-11's "throws and rolls back" is the same code path
  as an ordinary error.
- The two GC-5 exclusions become visible as the only two places that set a Postgres
  context variable other than `app.tenant_id` (ADR-0003).

### Negative / accepted cost

- A pooled database connection is held for the entire request, including handler
  time spent doing nothing. Under load the connection pool, not CPU, becomes the
  limit on API concurrency. The redirect path is exempt, so GC-1 is unaffected, but
  the dashboard API will saturate earlier than a connection-per-query design would.
- The ban on third-party calls inside a transaction is a rule, not a mechanism. A
  future TASK can violate it and nothing fails immediately; it shows up as pool
  exhaustion under load.
- `AsyncLocalStorage` costs measurable overhead per request and makes stack traces
  from inside a repository harder to read.
- The tenant id in a JWT claim means a tenant change requires a new token. Nothing
  in `launch-core` changes a user's tenant (ADR-0015), so this costs nothing now and
  becomes a migration if multi-tenant membership ever arrives.

### Follow-ups this creates

- TASK-005 owns `withTenantTransaction`, `tenantDb`, `TenantContextMissingError` and
  the ban on exporting the raw client.
- TASK-011 owns `TenantTransactionInterceptor` and `@Public()`.
- TASK-010 and TASK-021 dispatch mail from `afterCommit`, not from inside the
  handler transaction.
- TASK-056 asserts that `tenantDb` has exactly one definition and that no file
  outside `apps/api/src/db/client.ts` imports the unwrapped Drizzle client.
