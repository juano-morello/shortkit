# Contract: the `onLinkMutated` hook

- **Boundary:** the link mutation transaction, and every subscriber that must react to it.
- **Normative form:** `apps/api/src/links/link-mutation.events.ts` (stub: `design/stubs/apps/api/src/links/link-mutation.events.ts`).
- **Produced by:** TASK-025.
- **Consumed by:** TASK-027, TASK-031 (cache invalidation), TASK-048 (audit).
- **ADRs:** ADR-0008, ADR-0002.

## Normative types

```ts
export type LinkMutationAction = 'created' | 'updated' | 'deleted';

/** Snapshot of the fields any subscriber may need. Never the Drizzle row object. */
export interface LinkSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly domainId: string;
  readonly hostname: string;        // denormalised so subscribers need no domain lookup
  readonly slug: string;
  readonly destinationUrl: string;
  readonly expiresAt: Date | null;
  readonly activatesAt: Date | null;
}

export interface LinkMutation {
  readonly action: LinkMutationAction;
  readonly linkId: string;
  readonly actorId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly before: LinkSnapshot | null;   // null when action === 'created'
  readonly after:  LinkSnapshot | null;   // null when action === 'deleted'
}

export type LinkMutationPhase = 'in-transaction' | 'after-commit';

export interface LinkMutationSubscriber {
  readonly name: string;
  readonly phase: LinkMutationPhase;
  handle(mutation: LinkMutation, db: TenantDb | null): Promise<void>;
}

export declare function onLinkMutated(subscriber: LinkMutationSubscriber): void;
```

## Two phases, and which subscriber uses which

| Subscriber | Phase | Why |
|---|---|---|
| `auditWriter` (TASK-048) | `in-transaction` | AC-79, AC-80: a committed change without an audit row must be impossible. A throw here rolls the mutation back. Receives the live `TenantDb`. |
| `cacheInvalidator` (TASK-031) | `after-commit` | Deleting a cache key before commit would let a concurrent read repopulate it from the pre-commit state. A throw here is logged and does not affect the committed mutation. `db` is `null`. |

Both phases are dispatched by the link service, in registration order within a phase.
`in-transaction` subscribers run before `COMMIT`; `after-commit` subscribers run from
`withTenantTransaction`'s `afterCommit` (`tenant-context.md`).

## Firing rules

Normative. TASK-025 fires exactly one mutation per successful operation.

| Operation | `action` | `before` | `after` |
|---|---|---|---|
| `POST /api/links` | `created` | `null` | the created row |
| `PATCH /api/links/:id` | `updated` | pre-image | post-image |
| `DELETE /api/links/:id` | `deleted` | pre-image | `null` |
| expiry set via `PATCH` (TASK-027) | `updated` | pre-image | post-image |

- A `PATCH` that changes nothing still fires with `before` deep-equal to `after`.
  Subscribers decide whether to act; the audit writer skips a no-op, the cache
  invalidator does not.
- A failed mutation fires nothing. `hostname` is resolved once by the link service and
  passed in, so no subscriber issues a query to find it.

## Invariants a caller may rely on

1. `after.hostname` is the hostname the link is reachable on, so
   `cacheInvalidator` can build `rdr:v1:{hostname}:{slug}` with no lookup.
2. On a slug or domain change, `before` and `after` carry different
   `(hostname, slug)` pairs, and the invalidator deletes both keys.
3. `actorId` is `RequestContext.userId`. For a mutation with no request actor there is
   none; nothing in `launch-core` mutates a link outside a request.
4. `in-transaction` subscribers receive a `TenantDb` already scoped to `tenantId`, so
   an audit insert is under RLS like any other write.
5. An `after-commit` subscriber throwing never surfaces to the API caller. The
   operator's write succeeded.

## What the implementer must guarantee

- TASK-031 and TASK-048 register subscribers. **Neither modifies the link handlers.**
  That is why the hook exists.
- The audit subscriber writing to `audit_entries` uses the passed `db`, not
  `tenantDb()`, so it joins the mutation's transaction rather than opening a nested one.
- The snapshot is a plain object built by the link service. Passing a Drizzle row would
  couple subscribers to the schema.

## Versioning

Adding a field to `LinkSnapshot` is additive. Adding an `action` value requires every
subscriber to handle it, so the union is exhaustively switched with a `never` check in
both subscribers.
