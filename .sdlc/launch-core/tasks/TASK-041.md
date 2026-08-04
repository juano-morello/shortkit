---
id: TASK-041
story: STORY-014
epic: EPIC-004
title: Web domain add, instructions, and status
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-026, TASK-040]
paths: ["apps/web/app/(app)/domains/**", "apps/web/src/components/domains/**"]
contracts: [design/contracts/domain-provisioning.md, design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-65, AC-66, AC-68]
rework_count: 0
---

## Intent

The screen where SC-4's "the UI names the exact DNS record that is wrong" is satisfied.

## Approach

**SC-4** — on failure the UI displays record type, name, expected value, **and observed value**; records are copyable; instruction copy is human-facing prose (GC-12); the domain is selectable when creating a link.

**Not apex-blocked** — testable against `FakeDnsResolver`.

## Out of scope for this TASK

Certificate status display (TASK-044), branding settings (TASK-047).

## Interfaces

**Consumes**

`domainContract` (TASK-040); `<LinkForm />` and `/links` routes (TASK-026); `useCurrentWorkspace` (TASK-015).

**Produces**

Route `/domains`; `<DnsInstructions />`; `<DomainStateBadge />` extended by TASK-044; domain selector wired into `<LinkForm />`.
