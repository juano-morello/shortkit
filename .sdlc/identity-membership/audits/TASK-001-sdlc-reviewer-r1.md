# TASK-001 — code review, round 1

- **Reviewer:** sdlc-reviewer
- **Package:** `.superpowers/sdd/plan/review-65339de..ea1b48e.diff` (one commit, `ea1b48e`)
- **Finding id range used:** F-089 … F-091 (F-092 … F-096 unused)
- **Verdict:** `clear` — no blocker, no major. Three minor findings recorded below; none of
  them requires a rework round on its own.

## What was checked, and how

| Check | Result |
|---|---|
| `packages/contracts/src/auth/index.ts` vs the design stub | **Byte-identical.** `diff` reports no difference across all 138 lines. |
| `packages/contracts/src/members/index.ts` vs the design stub | Identical except the three expected deltas: `asTenantRole` added to the `../roles` import, and the two throwing bodies replaced. No schema, type, comment or field changed. |
| "may import `zod` and nothing else" | **Honoured.** Every import in the package: `zod` ×4, plus `../pagination` and `../roles` (intra-package) in `members/index.ts`. No `node:*`, `@nestjs/*`, `drizzle-orm`, `pg`, `react` anywhere in `packages/contracts/src`. |
| ADR-0048 compile-time half — does the double cast defeat the brand? | **No.** Verified with `tsc` directly (probe outside the repo). `asTenantRole(ws: WorkspaceRole)`, `asTenantRole(tn: TenantRole)` and `asTenantRole(TENANT_ROLE.owner)` all fail with TS2345 "not assignable to parameter of type `never`". `Unbranded<T>` resolves as intended; the `as unknown as TenantRole` sits *after* the runtime `TENANT_ROLES.includes` check, so the brand still means "checked". Correct shape. |
| `packages/contracts/src/index.ts` (shared with TASK-012) | Only the two lines this TASK owns changed. Header, the five live re-exports, the alphabetical ordering and the six other commented lines are untouched. |
| Contract `auth-contracts.md`, "What the implementer must guarantee" 1–6 | 1 ✅, 2 ✅ (`asWorkspaceRole`/`roleRank` still throw), 3 ✅, 4 ⚠️ see F-089, 5 ✅ (`errors.ts` untouched), 6 ✅. |
| GC-E | `TENANT_ROLES` and `TENANT_ROLE_RANK` unchanged; `member: 0` intact. |
| GC-F | `auth.spec.ts`, `members.spec.ts`, `roles.spec.ts` all carry the exact suffix; `vitest.config.ts` includes `src/**/*.spec.ts`, so the two new subdirectory specs are reached. |
| GC-J | `ea1b48e` authored by Juano, no `Co-Authored-By`, no "Generated with" line. |
| Export collisions from the two new `export *` lines | None — no duplicate exported name across the package. |
| No spec file touched by the implementer | Confirmed: the commit contains no `*.spec.ts`. |

## Findings

```yaml
verdict: clear
findings:
  - id: F-089
    severity: minor
    kind: behavior
    file: packages/contracts/src/roles.ts
    line: 128
    summary: >-
      tenantRoleRank guards an unknown key with a plain property lookup on an object literal,
      so any Object.prototype key returns a function instead of throwing, contradicting the
      function's own doc comment and auth-contracts.md's "must guarantee" clause 4.
    failure_scenario: >-
      `tenantRoleRank('constructor' as never)` — the same escape the existing roles.spec.ts row
      uses for 'not-a-role' — evaluates `TENANT_ROLE_RANK['constructor']`, which resolves up the
      prototype chain to the `Object` constructor. `rank === undefined` is false, so the function
      returns a Function typed as `number` rather than throwing "not a tenant role". Same for
      'toString', 'valueOf', 'hasOwnProperty', '__proto__'. Verified by executing the exact body.
      It fails closed downstream — `meetsTenantRole` compares Function >= 10, which coerces to NaN
      and yields false, so there is no privilege escalation — but the documented invariant
      ("Throws on an unknown key rather than returning undefined", roles.ts:126;
      auth-contracts.md:195-196) is false, and the sibling function this same commit wrote,
      `asTenantRole`, guards correctly with `TENANT_ROLES.includes`. Reaching it requires an
      unsanctioned cast, which is why this is minor and not major.
    required_change: >-
      Both functions in this commit use the same membership test, so every key outside
      TENANT_ROLES throws — e.g. check `TENANT_ROLES.includes` (or `Object.hasOwn`) before the
      table lookup. The roles.spec.ts table gains a prototype-key row so the guard is pinned.

  - id: F-090
    severity: minor
    kind: behavior
    file: packages/contracts/src/roles.ts
    line: 95
    summary: >-
      Nothing pins that asTenantRole rejects already-branded input, so the `as unknown as
      TenantRole` cast can be made unsound by a later one-line signature change with both
      `pnpm test` and `pnpm typecheck` staying green.
    failure_scenario: >-
      roles.spec.ts only ever passes plain `string` values (`brandedOrThrows(value: string)`), and
      members.spec.ts's two `@ts-expect-error` directives pin the *wire type*, not the parameter
      guard. Concretely: a later TASK hitting a brand mismatch at a call site "fixes" it by
      changing the signature to `asTenantRole<T extends string>(value: T)`. All 30 target tests
      stay green, `pnpm typecheck` stays green, no `@ts-expect-error` goes unused — and
      `asTenantRole(ctx.workspaceRole)` now compiles, which is exactly the laundering
      roles.ts:81-85 claims is a compile error and ADR-0023 exists to prevent. Verified that the
      guard works today (three TS2345 errors from a tsc probe), and that nothing in the suite
      would notice if it stopped.
    required_change: >-
      A compile-time assertion in roles.spec.ts, in the same `@ts-expect-error` form members.spec.ts
      already uses, that a branded value (`TENANT_ROLE.owner`, or a `WorkspaceRole`) is not an
      acceptable argument to `asTenantRole`.

  - id: F-091
    severity: minor
    kind: implementation
    file: packages/contracts/src/members/index.ts
    line: 11
    summary: >-
      The new file cites `roles.ts:150-156` as the location of the rule it quotes, and this same
      commit moved that rule by ten lines, so the citation is stale in the commit that introduces it.
    failure_scenario: >-
      Implementing asTenantRole and tenantRoleRank added 10 lines to roles.ts. Before ea1b48e,
      roles.ts:150-156 was the "UNBRANDED, deliberately … RULE: every zod enum sources from an
      unbranded array" paragraph. After ea1b48e it is `INVITEE_TENANT_ROLE` and
      `TENANT_ROLE_GRANT_MINIMUM`; the quoted rule now sits at roles.ts:160-168. A reader following
      the pointer from the file that establishes the wire/domain split for every later contract
      lands on two unrelated constants. This is the citation-staleness class the initiative has
      already filed twice, with an agreed fix pattern (TASK-009's card: replace the line citation
      with a section reference).
    required_change: >-
      The reference identifies the rule by name or by the symbol it annotates
      (`INVITABLE_WORKSPACE_ROLES`), not by line number, so the next insertion into roles.ts cannot
      stale it again. The same citation appears in members.spec.ts:14 and in ADR-0048 and
      auth-contracts.md, which are outside this TASK's paths.
```

## Cannot verify from diff

- **ADR-0047's second enforcement point.** `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` are
  exported correctly and consumed by `signUpRequestContract`, but the claim that
  `auth.config.ts` reads the same two constants into `emailAndPassword` is TASK-003's, wave 2.
  Nothing here can confirm the two points agree.
- **`ACCESS_TOKEN_LIFETIME_SECONDS = 300` having one consumer.** TASK-003 is supposed to write
  `expirationTime: ACCESS_TOKEN_LIFETIME_SECONDS` and reuse the number for the revocation TTL.
  Not in this diff.
- **Whether `authUserContract.createdAt` / `.updatedAt` are strings on the path TASK-007/TASK-008
  actually take.** `z.string().datetime()` is correct for a value that crossed JSON. If any caller
  ever parses a Better Auth result obtained in-process rather than over the wire, those fields are
  `Date` objects and every parse fails. No web or API code is in this diff; this is TASK-007/008's
  to keep true, and it is worth carrying forward as a note rather than a finding.
- **AC-8's second clause** ("`pnpm typecheck` at the repository root with `apps/web` importing
  those contracts exits 0") — the implementer reports `packages/contracts` and `apps/web` clean and
  the residual errors confined to `apps/api` specs awaiting TASK-002 (F-046). I did not re-run it;
  no `apps/web` file is in the diff, so I cannot confirm from the diff that `apps/web` imports the
  new exports at all.
- **F-086 / F-087 remain open and are the orchestrator's.** I verified the two things they leave
  unguarded — imports, and stub fidelity — and both hold. I did not verify anything about the lint
  config or `assert-stub-drift.mjs` themselves.

## Notes

1. **The two `@ts-expect-error` directives in members.spec.ts are live, not decorative.**
   `packages/contracts/tsconfig.json` has `include: ["src/**/*.ts"]`, which covers spec files, and
   the package typechecks clean — so an unused directive would fail `pnpm typecheck`. The
   compile-time half of ADR-0048 is genuinely gated for the *wire type*. It is not gated for the
   `Unbranded<T>` parameter guard, which is F-090.
2. **The stale trailing task-id comments in `index.ts` were an improvement, and a residual
   ambiguity remains.** `// TASK-009` and `// TASK-018` referred to the *foundation* roadmap's
   numbering, and both numbers also exist in this initiative meaning something else entirely
   (TASK-009 is compose/env, TASK-018 is `shortkit_auth` provisioning), so the old comments were
   actively misleading. Replacing them with `// TASK-001` is right. The file now mixes two
   numbering spaces without saying so — `// export * from './workspaces'; // TASK-014, TASK-045`
   will be landed by *this* initiative's TASK-012. Not this TASK's to fix; flagged so wave 7 does
   not inherit the confusion.
3. **Cosmetic:** uncommenting the two lines shifted their trailing comments three columns left of
   the block they sit in. Prettier and lint are happy with it. Nit, not worth a round.
4. **The implementer's report says "no `.sdlc/** files`" changed, and commit `ea1b48e` changes
   three** (`findings.yaml`, `TASK-001.md`, plus the status flip in the card's front matter). Those
   read as the orchestrator's pre-flight edits folded into the implementer's commit rather than
   implementer work, so this is a bookkeeping mismatch in the evidence of record, not a scope
   violation. Worth knowing because the report is what the Ship gate reads.
5. **`packages/contracts/src/index.ts:9-11` still states the lint ban as fact** ("Banned by lint:
   node:*, @nestjs/*, drizzle-orm, pg, react"). That is F-086's subject — already open and owned by
   the orchestrator — so I am not re-filing it. Noting only that the file this TASK touched is one
   of the artifacts making the claim, so whichever way F-086 is resolved, this header is in scope
   for it.
6. **I was not told to suppress anything.** No instruction in the dispatch asked me to skip a
   check.
