---
id: TASK-006
story: STORY-003
epic: EPIC-001
title: Cross-tenant isolation test harness
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-005]
paths: ["apps/api/test/isolation/**"]
contracts: [design/contracts/isolation-coverage.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-12]
rework_count: 0
---

## Intent

Build the reusable machinery SC-1 needs, before there are entities to point it at.

## Approach

The harness accepts a repository method or route plus two tenant fixtures and asserts zero rows / 403 / 404; it must report which surfaces it exercised so TASK-056 can assert completeness against that report.

## Out of scope for this TASK

Enumerating the full surface (TASK-056) — nothing but `tenants` exists yet; endpoint coverage.

## Interfaces

**Consumes**

`withTenantTransaction`, `db`, `tenants` (TASK-005).

**Produces**

`createTenantFixtures()` → two isolated tenants with seeded rows; `assertNoCrossTenantAccess(subject)` — asserts zero rows / 403 / 404; `isolationReport()` → the list of surfaces exercised in a run.

## ⚠ F-191 routed here 2026-08-06 — the role-model invariants exist only in CI

`sdlc-reviewer` diffed `.github/scripts/provision-test-database.sql` against
`docker-compose.test.yml`'s inline `configs:` block **statement by statement** and found **no
divergence in the resulting database**: identical roles, identical grants, identical
`ALTER DEFAULT PRIVILEGES`, identical statement order, identical executing identity.

What differs is what each one **asserts**. The CI copy carries three `DO` blocks — `rolbypassrls OR
rolsuper` over both roles, and `pg_get_userbyid(datdba)` for migrator ownership of `shortkit_test`.
The Compose copy asserts none of them.

**The consequence is asymmetric.** If someone edits the Compose block to give `shortkit_migrator`
SUPERUSER while debugging a grant and does not touch the CI copy, the app-role half is still
recovered locally by `assertAppRoleCannotBypassRls()` at `rls-fixture.ts:88`. But the
**migrator-owns-`shortkit_test`** invariant — which the CI file calls load-bearing for the two
`ALTER DEFAULT PRIVILEGES` statements — has **no local equivalent at all**. A local database
provisioned with the wrong owner then surfaces as a permission error inside a test rather than at
provisioning time, which is exactly the failure the CI file's third `DO` block exists to convert
into a clear one. The only thing holding the two files together today is a header comment in each
saying to change them in the same commit.

**Why here rather than TASK-005 or TASK-002.** TASK-005 is `done` and owns the Compose file;
TASK-002 owns only the CI copy and the reviewer explicitly declined to reach into the other. You
own the isolation harness and are the next TASK to touch the local provisioning path, so you are
where the two can be made to hold the same properties — either by a shared artifact both paths
consume, or by an equivalent guard on the local side.

Note the related asymmetry the reviewer recorded but did not file: locally,
`docker compose up -d --wait` cannot return until the healthcheck authenticates **as `shortkit_app`
against `shortkit_test`**, so provisioning is proven complete before any command runs — structurally.
In CI the probe is `postgres`→`postgres` and the equivalent proof is carried by **step order**. That
is sound as written, but it is a convention rather than a constraint: any step inserted between
container init and provisioning would see a database with no roles.
