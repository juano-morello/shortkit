---
id: ADR-0005
slug: launch-core
title: The web app imports the zod contracts directly; no generated client
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

AC-14 requires an incompatible change in `packages/contracts` to make `pnpm typecheck`
exit non-zero because `apps/web` stops compiling. AC-4 requires the same at the
workspace level. TASK-007 produces the contracts package and TASK-008 produces the web
client; both are dispatched before any feature TASK, so the answer constrains fifteen
frontend TASKs that follow.

zod is already fixed as the contract language. `config.yaml` records
`packages/**` as backend-owned, with a comment saying the web app "consumes generated
types from it". That comment predates this decision and describes an option, not a
ruling.

## Decision

`apps/web` imports `@shortkit/contracts` directly. No code generation, no OpenAPI
document, no published artifact.

**The package ships TypeScript source.** `packages/contracts/package.json` declares
`"exports": { ".": "./src/index.ts", "./*": "./src/*/index.ts" }` and no build step.
`apps/api` and `apps/web` compile it as part of their own typecheck through
`tsconfig` path mapping. Changing a schema changes the type both sides see in the same
edit, which is what makes AC-14 true by construction rather than by a CI step someone
has to remember to run.

**The package stays isomorphic.** It may import `zod` and nothing else. An ESLint
`no-restricted-imports` rule in `packages/contracts/.eslintrc` bans `node:*`,
`@nestjs/*`, `drizzle-orm`, `pg` and `react`. Next.js bundles this source into client
components; a Node-only import there is a build failure with a confusing message, so
the lint rule catches it earlier and says why.

**Every contract exports the schema and its inferred type.**

```ts
export const linkContract = z.object({ /* ... */ });
export type Link = z.infer<typeof linkContract>;
```

The API validates request bodies with the schema through a `ZodValidationPipe` and
declares responses with the inferred type. The web client validates responses with
the schema (TASK-008), which is where AC-15's `ContractViolationError` comes from.

**Ownership stands.** `packages/contracts` remains backend-owned. Frontend TASKs
import from it and never write to it. A frontend TASK needing a contract change is an
escalation, not an edit.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| NestJS emits OpenAPI, `openapi-typescript` generates a client into `apps/web` | Standard REST tooling; the spec doubles as documentation; the future MCP server could consume the same spec | The generated client is either committed, in which case a contract change does not break typecheck until someone regenerates, or generated during build, in which case `pnpm typecheck` from a clean clone needs a running API. Both break AC-14 or AC-1 | AC-14 is the requirement. A generation step between the change and the type error is exactly the staleness window it forbids |
| tRPC | End-to-end inference with no schema duplication; excellent DX | Replaces the REST surface the future MCP server and any third-party integration would use, and the refinement keeps API keys reserved for an MCP server. It also couples the web app to NestJS internals rather than to an HTTP contract | Trades away the API shape the roadmap depends on for a convenience the direct import already delivers |
| Build `packages/contracts` to `dist` and import the build output | Matches how a published package behaves; faster incremental typecheck for `apps/web` | Adds a build ordering constraint to `pnpm typecheck` and a stale-`dist` failure mode, and pnpm workspaces plus TS path mapping make the build unnecessary | Cost with no benefit inside one repository |

## Consequences

### Positive

- AC-14 needs no CI plumbing. Changing `linkContract`'s shape breaks the web build in
  the same commit.
- One definition of every shape, validated on both ends by the same object. A response
  that drifts from the contract fails validation in the client rather than rendering
  as `undefined`.
- Nothing to regenerate, so no reviewer has to check whether generated output matches
  its source.

### Negative / accepted cost

- No OpenAPI document exists. Anyone integrating from outside TypeScript reads the zod
  schemas. If the MCP server or a public API arrives, generating a spec from the same
  schemas becomes work that does not exist today.
- `apps/web`'s typecheck compiles the contracts source every run, so contract changes
  invalidate the web app's incremental build. At this size that costs seconds.
- Bundling zod schemas into client components ships the validation code to the
  browser. zod is roughly 14 kB gzipped and already a dependency; response validation
  in the client is what AC-15 asks for, so it is not dead weight.
- The isomorphism rule is enforced by a lint rule that someone can disable with an
  inline comment.

### Follow-ups this creates

- TASK-007 sets up the exports map, the tsconfig paths in both apps, and the
  `no-restricted-imports` rule.
- TASK-001 verifies AC-4 with a deliberate incompatible change and a reverted commit.
- `config.yaml`'s ownership comment saying the web app consumes generated types is
  now wrong. Correct it when `init` is re-run after TASK-001.
