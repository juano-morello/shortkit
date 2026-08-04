---
id: TASK-015
story: STORY-006
epic: EPIC-002
title: Web app shell, workspace list, create, and switcher
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-012, TASK-014]
paths: ["apps/web/app/(app)/**", "apps/web/src/components/shell/**", "apps/web/src/lib/workspace/**"]
contracts: []
test_files: []
acceptance: [AC-23, AC-26]
rework_count: 0
---

## Intent

The authenticated shell every later screen mounts inside, plus workspace selection.

## Approach

The selected workspace persists across navigation and is readable by every child screen; the shell owns the navigation region so later screens add routes without editing each other's files. **Workspace scoping here is display context, never a security control** — the API remains the enforcement point.

## Out of scope for this TASK

Members (TASK-019), links (TASK-026), domains (TASK-041), branding (TASK-047), settings (TASK-055).

## Interfaces

**Consumes**

`useSession`, `requireAuth` (TASK-012); `workspaceContract`, `createWorkspaceContract` (TASK-014); `apiClient` (TASK-008).

**Produces**

Authenticated layout at `apps/web/app/(app)/layout.tsx`; `useCurrentWorkspace()` → `{ workspace, setWorkspace }`; a navigation registry that later screens append entries to; routes `/workspaces`, `/workspaces/new`.
