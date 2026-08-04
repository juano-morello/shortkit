# Shortkit

Shortkit is a multi-tenant URL shortener for agencies. An agency signs up once,
creates a workspace per client, points that client's branded domain at the
workspace, and invites teammates scoped to the clients they work on. Visitors
never see the product. They get one redirect that resolves fast or does not.

Three rules shape the codebase:

- **Postgres enforces tenant isolation.** Every tenant-scoped query runs inside a
  transaction that has bound the tenant to the connection, and row-level security
  backs that up. Isolation gets proven by a suite that runs against a real
  database, not asserted in a comment.
- **The redirect path stays isolated.** It reads a cache, falls back to one
  parameterised statement, and imports nothing from the management API. No ORM
  runs on it.
- **One set of contracts.** `packages/contracts` holds zod schemas that the API
  validates against and the web app compiles against, so a shape change breaks
  the typecheck in the same commit.

## Layout

| Workspace | Package | What it is |
| --- | --- | --- |
| `apps/api` | `@shortkit/api` | NestJS. Management API under `/api`, `GET /health` at the root, and the redirect |
| `apps/web` | `@shortkit/web` | Next.js App Router dashboard |
| `packages/contracts` | `@shortkit/contracts` | Shared zod schemas and the types inferred from them |

## Requirements

- Node 22.12 or newer
- pnpm 11.20.0, pinned in `packageManager`

## Commands

Run these from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm install` | Installs every workspace from `pnpm-lock.yaml` |
| `pnpm lint` | ESLint across all three workspaces |
| `pnpm typecheck` | TypeScript with no emit, per workspace |
| `pnpm test` | Vitest across all three workspaces, with no database and no network |
| `pnpm build` | Compiles the API to `dist/` and builds the Next.js app |
| `pnpm test:integration` | API suites that need a live Postgres |

`pnpm test` and `pnpm test:integration` are separate on purpose. The first runs
anywhere, on a clone with nothing installed but the workspace. The second needs a
database, so it stays off the loop a contributor runs on every save.
