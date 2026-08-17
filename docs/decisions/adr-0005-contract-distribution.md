---
id: ADR-0005
slug: foundation
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

**The package ships TypeScript source.** `packages/contracts/package.json` declares no
build step. `apps/api` and `apps/web` compile it as part of their own typecheck through
`tsconfig` path mapping. Changing a schema changes the type both sides see in the same
edit, which is what makes AC-14 true by construction rather than by a CI step someone
has to remember to run.

**One entry point: the root specifier.** Amended 2026-08-04 (F-045). The original
wording declared `"./*": "./src/*/index.ts"`, which resolves `@shortkit/contracts/slug`
to `src/slug/index.ts`. The stubs are flat files, so that path and every other subpath
the map advertised were dead, and `import { RESERVED_SLUGS } from
'@shortkit/contracts/slug'` gives TS2307. Nothing in the design imported a subpath: all
six stub consumers and `docs/contracts/slug.md` use the root specifier already. The
subpath entry goes away rather than getting repaired.

Three places carry this and they have to agree, because `apps/web` resolves through the
exports map at bundle time while both apps resolve through `paths` at typecheck.

`packages/contracts/package.json`:

```json
"exports": { ".": "./src/index.ts" },
"sideEffects": false
```

`apps/api/tsconfig.json` and `apps/web/tsconfig.json`, `compilerOptions.paths`. Both
apps sit one level under `apps/`, so the block is byte-identical in the two files:

```json
"paths": {
  "@shortkit/contracts": ["../../packages/contracts/src/index.ts"]
}
```

The `"@shortkit/contracts/*"` key is deleted from both, not rewritten. A subpath import
must then fail at typecheck rather than resolve one way in the bundler and another way
in `tsc`.

`design/stubs/packages/contracts/src/**` already matches this shape and needs no
relaying. `src/index.ts` re-exports `errors`, `pagination`, `roles`, `slug` and
`domains/reserved-hostnames`, and its append protocol of one re-export line per
producing TASK is what keeps a wave conflict to one line.

`sideEffects: false` is what lets the web bundler drop the re-exports a page does not
use. Without it a top-level `z.object(...)` call reads as a side effect and the whole
barrel ships to the browser.

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

On the export shape, decided 2026-08-04 (F-045):

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Flat subpath mirror, `"./*": "./src/*.ts"` | `@shortkit/contracts/slug` works; a file that imports one module pulls a smaller graph | Needs a second nested pattern for `src/domains/reserved-hostnames.ts` or that file has to move up. Every file in `src/` becomes public API, so splitting `roles.ts` in two is a breaking change for consumers | Buys a second way to reach symbols the barrel already exports, and freezes the internal file layout to pay for it |
| Directory-per-module, `src/slug/index.ts` | Matches the map TASK-001 shipped; a module can grow to several files without moving its consumers | Turns a five-module package into five directories and five barrels, and the root `index.ts` still has to re-export each one, so the append protocol is unchanged | Structure sized for a package that does not exist yet |
| Root specifier only, subpath entry removed | One resolution path under `tsc`, Bundler resolution and esbuild alike. Nothing in the design imports a subpath, so no consumer changes | A file that needs one constant compiles the whole barrel, and `apps/web` needs `sideEffects: false` for the bundler to drop the rest | Chosen |

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
- With one entry point, `src/index.ts` is a merge point every contract-producing TASK
  touches. The append protocol keeps each conflict to one line; it does not remove the
  conflicts.
- `sideEffects: false` is an assertion nothing checks. A contract module that ever runs
  code at import time gets dropped from the web bundle, and the symptom is a missing
  behaviour rather than an error.
- No consumer can import a single module, so a change anywhere in `packages/contracts`
  invalidates every consumer's incremental build. At five modules that costs nothing
  measurable. Reintroducing subpaths later means adding an exports pattern and a
  `paths` key in both apps, which is the same three-file edit as removing them.
- **The alternatives table above says a build is unnecessary because "pnpm workspaces
  plus TS path mapping" cover it. That was false for `apps/api`.** Recorded 2026-08-04
  (F-042). Path mapping carries typecheck and Vitest, and both stayed green, but
  `tsc -p tsconfig.build.json` with `rootDir: src` exits 2 with TS6059 on the first
  `apps/api/src` file that imports `@shortkit/contracts`, and the failed run emits
  `.js` and `.js.map` files into `packages/contracts/src/`. Juano's fix is a bundler
  build for `apps/api` (swc/tsup, inlining the workspace source), not a `dist` for
  contracts. The decision stands; the reason given for it was incomplete.

### Follow-ups this creates

- TASK-007 sets up the exports map, the tsconfig paths in both apps, and the
  `no-restricted-imports` rule.
- The exports map, both `paths` blocks and `sideEffects: false` land together or not at
  all. Editing one without the others is what produced F-045.
- TASK-001 verifies AC-4 with a deliberate incompatible change and a reverted commit.
- `config.yaml`'s ownership comment saying the web app consumes generated types is
  now wrong. Correct it when `init` is re-run after TASK-001.
