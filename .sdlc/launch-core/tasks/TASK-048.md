---
id: TASK-048
story: STORY-017
epic: EPIC-005
title: Audit log schema and writes on link mutation
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-025, TASK-011]
paths: ["apps/api/src/db/schema/**", "apps/api/drizzle/**", "apps/api/src/audit/**"]
contracts: [design/contracts/link-mutation-events.md, design/contracts/rls-policy-template.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-79, AC-80, AC-82]
rework_count: 0
---

## Intent

Make every destination change attributable.

## Approach

**GC-5** — RLS applied; append-only, with no mutating method exposed (AC-82); **the audit row is written inside the same transaction as the mutation**, so a successful change without an audit entry is impossible; driven by the `onLinkMutated` hook rather than by editing link handlers; **GC-9** — no PII beyond the actor id in the row body.

## Out of scope for this TASK

The query endpoint (TASK-049), UI (TASK-050), auditing non-link entities.

## Interfaces

**Consumes**

`onLinkMutated` (TASK-025); `RequestContext` (TASK-011); RLS template (TASK-013).

**Produces**

`audit_entries` table — `id`, `tenant_id`, `link_id`, `actor_id`, `action`, `previous_value`, `new_value`, `occurred_at`, RLS enabled, no update or delete method; `auditWriter.record(entry)`; `auditReader.listForLink(linkId)`.
