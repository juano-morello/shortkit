# Contract: the `onLinkMutated` hook

- **Boundary:** the link mutation transaction, and every subscriber that must react to it.
- **Normative form:** `apps/api/src/links/link-mutation.events.ts`. ~~Not yet written. The design stub at `design/stubs/apps/api/src/links/link-mutation.events.ts` stands in until TASK-025 lands the file and is retired then (ADR-0039).~~ **Amended 2026-08-19 (TASK-2-05, item 2's renumbering of TASK-025): the file is written and the stub is retired under ADR-0039.** It exports the types below verbatim, plus three functions the types above do not name: `clearLinkMutationSubscribers()` (tests only), and the two dispatchers the link service calls, `runInTransactionSubscribers(mutation, db)`, which lets a throw propagate, and `runAfterCommitSubscribers(mutation)`, which logs one and continues. Splitting the dispatch out of the registry is what lets both phases be measured with no database (`apps/api/src/links/link-mutation.events.spec.ts`); the service is still the only caller, as "dispatched by the link service" requires.
- **Produced by:** TASK-025, **renumbered TASK-2-05 at delivery (2026-08-19)**.
- **Consumed by:** TASK-027, TASK-031 (cache invalidation), **renumbered TASK-2-08 at delivery**; TASK-048 (audit).
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

> **Added 2026-08-19 (TASK-2-05), three properties the shipped registry has that the types
> above do not state.** (a) Subscriber NAMES are unique: a second registration under a name
> already held throws, because two registrations of the invalidator would delete the same
> key twice and hide the second failure. (b) Within a phase the subscribers run one at a
> time, awaited in order, never `Promise.all`: the first phase's subscribers share the
> transaction's one connection. (c) A throw in `after-commit` is logged as `code:
> 'link_mutation_subscriber_failed'` WITHOUT the error's message (`includeMessage: false`;
> a cache failure's message names an internal host) and the subscribers registered after it
> still run; the subscriber with something specific to say (`cache_invalidation_failed`
> with `link_id` and `attempts`, D-2-15) says it itself before throwing.

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
