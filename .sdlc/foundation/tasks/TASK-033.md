---
id: TASK-033
story: STORY-012
epic: EPIC-003
title: Append-only click event store
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-023]
paths: ["apps/api/src/db/schema/**", "apps/api/drizzle/**", "apps/api/src/clicks/**"]
contracts: [design/contracts/click-events.md, design/contracts/rls-policy-template.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-57, AC-58, AC-60]
rework_count: 0
---

## Intent

The write side of a stream a later initiative reads.

## Approach

**GC-9** — stores `ip_hash`, **never the raw IP**; **GC-5** — carries `tenant_id` with RLS applied; queryable by link id and time range.

**Append-only is enforced on the tenant-facing interface** (Amendment A-2): `clickEventWriter` and `clickEventReader` expose no update or delete. The table itself is mutable by the privileged path in TASK-054. **Do not add a row-level immutability trigger** — it would block that path.

## Out of scope for this TASK

Emitting events from the redirect path (TASK-034), any dashboard or aggregation (SP3, out of scope), reading the stream.

## Interfaces

**Consumes**

`links`, `domains`, RLS template (TASK-023).

**Produces**

`click_events` table — `id`, `tenant_id`, `link_id`, `domain_id`, `occurred_at`, `ip_hash`, `user_agent`, RLS enabled; `clickEventWriter.append(event)`; `clickEventReader.query({ linkId, from, to })`. These two are the **only** tenant-facing surfaces on `click_events`; both are enumerated by TASK-056.
