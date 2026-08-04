---
id: ADR-0001
slug: launch-core
title: Vitest across all three workspaces, with integration tests on a separate command
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

`config.yaml` carries `testing.framework: null` because the repository was empty at
init. TASK-001 cannot dispatch until the value is filled, and TASK-001 blocks every
other TASK. AC-3 requires at least one passing test in each of `apps/api`,
`apps/web` and `packages/contracts` under a single `pnpm test`. AC-1 requires that
command to exit 0 from a clean clone, with nothing running but `pnpm install`.

NestJS generates jest configuration by default. Next.js has no default; its
ecosystem settled on Vitest, and `next/jest` handles App Router and React Server
Components badly. `packages/contracts` is plain TypeScript and runs under either.

SC-1 needs tests that exercise real row-level security. RLS cannot be faked in a
mock, so the isolation suite needs a live Postgres with a non-`BYPASSRLS` role.
That conflicts with AC-1's clean-clone requirement if both live behind one command.

## Decision

**Vitest 3 in all three workspaces.** One root `vitest.config.ts` declaring
`test.projects` for `apps/api`, `apps/web` and `packages/contracts` (on Vitest
below 3.2, use `vitest.workspace.ts` instead).

`apps/api` compiles through `unplugin-swc` rather than esbuild, because esbuild does
not emit `emitDecoratorMetadata` and NestJS dependency injection reads it:

```ts
// apps/api/vitest.config.ts
import swc from 'unplugin-swc';
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.spec.ts'] },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
```

`apps/web` uses `@vitejs/plugin-react` with `environment: 'jsdom'`.

**Two commands, not one.**

| Command | Scope | Needs Postgres | Runs in CI |
|---|---|---|---|
| `pnpm test` | `**/*.spec.ts` in all three workspaces | no | job `quality` |
| `pnpm test:integration` | `apps/api/test/**/*.int-spec.ts` | yes | job `integration` |

`pnpm test` stays free of external services so AC-1 holds from a clean clone.
`pnpm test:integration` runs migrations then the suite against `postgres:17-alpine`,
supplied by a `services:` container in CI and by `docker-compose.test.yml` locally.
The SC-1 isolation suite (TASK-056) is an integration suite and runs in the
`integration` job.

`config.yaml` gets `framework: vitest`, `unit: pnpm test`,
`integration: pnpm test:integration`, `command: pnpm test`.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Jest in `apps/api`, Vitest in `apps/web` | Each framework gets its ecosystem default; NestJS docs and generators work unmodified | Two runners, two config idioms, two mocking APIs, two watch modes; the root `pnpm test` becomes a shell script fanning out to both; a contributor moving between workspaces relearns the API | Solo developer at 25 hours a week (GC-14). The cost of two runners is paid on every test written for the next several months, against a one-time cost of configuring swc |
| Jest everywhere | NestJS default; the largest body of prior art | Next.js App Router support through `next/jest` is weak, React Server Components need workarounds, and ESM handling stays awkward; `packages/contracts` would need a transform it does not otherwise need | The web app is a real dashboard, not a stub. Fighting jest on the Next side costs more than configuring swc on the Nest side |
| Node's built-in test runner | Zero dependencies | No jsdom integration, weak watch mode, no built-in coverage story matching `coverage_gate` | Would cost time on tooling rather than on the product |

## Consequences

### Positive

- One runner, one assertion API, one watch mode, one coverage report.
- `pnpm test` runs anywhere with no Docker and no network, which keeps AC-1 true.
- Vitest reads the same `tsconfig` paths the app uses, so the `packages/contracts`
  import in AC-4 resolves in tests without a second module-resolution setup.

### Negative / accepted cost

- NestJS's own documentation, generators and most Stack Overflow answers assume
  jest. Every `Test.createTestingModule` example needs translating, and the
  `unplugin-swc` step is a piece of configuration a jest setup would not need. When
  it breaks after a NestJS or swc upgrade, nobody else in the project can fix it.
- Splitting unit from integration means a developer can pass `pnpm test` locally
  and still break the isolation suite. CI catches it; the local loop does not.
- Async React Server Components cannot be rendered by Vitest. Coverage for those
  comes from testing their data functions plus browser-level checks, not from
  component render tests.

### Follow-ups this creates

- TASK-001 sets up both commands and both configs, and ships one DB-free test per
  workspace.
- TASK-002 adds a second CI job `integration` with a `postgres:17-alpine` service.
  AC-5 covers the four quality commands; the integration job is additional and must
  also fail the workflow on non-zero exit.
- `/juano-sdlc init` re-run after TASK-001 records `unit` and `integration`
  separately. If it writes a single `command`, correct it by hand to `pnpm test`.
