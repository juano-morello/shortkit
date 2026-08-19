---
id: ADR-0056
slug: identity-membership
title: The betterAuthDatabase caller list is asserted by four scans in wave 2, and ADR-0046 keeps the rule while losing the deferral
status: accepted
supersedes: null
amends: ADR-0046
date: 2026-08-14
---

## Context

ADR-0046 decided that `betterAuthDatabase` may appear in exactly two files under
`apps/api/src`, `db/client.ts` and `auth/auth.config.ts`, and deferred the assertion to
TASK-056. TASK-056 is not in this initiative. Juano pulled the control into TASK-003 as
F-108.

The reason the deferral stopped being acceptable is in the card and is worth repeating,
because it is the same shape as F-024 and ADR-0054. When ADR-0046 accepted the deferral, the
handle sat on the same pool as `databaseTransaction`, as `shortkit_app`. ADR-0050 moved it to
`shortkit_auth`, the one role that can read plaintext `session.token` and the `account`
password hashes, and migration `0001` revoked `shortkit_app` on all five. A security auditor
read another user's plaintext `session.token` through the handle from a bare script. The
exposure changed from tenant-scoped rows to session credentials, and the price was never
revisited.

Two facts about the shipped code, both grepped rather than assumed.

**`betterAuthDatabase` appears twice today, both in `db/client.ts`:** the definition at
`:259` and one mention in a docblock at `:60`. Zero external callers. TASK-003 is the first.
(The wave-2 scout report says the mentions are at `:60` and `:247`; `:247` is a reference to
ADR-0046 in prose and does not contain the identifier. Two occurrences, not three.)

**The type narrowing ADR-0046 relied on is not in the shipped code.** ADR-0046's decision
block writes `export function betterAuthDatabase(): NodePgDatabase<typeof betterAuthSchema>`
and its Positive section says an author who reads `workspaces` through it "gets a compile
error rather than a silent empty result". `client.ts:259` returns `NodePgDatabase<typeof
schema>`, built with `drizzle(authPool, { schema })` over the full schema barrel. That is
the alternative ADR-0046's own table rejected as "makes 'reaches only auth tables' a comment
instead of a type". So the narrowing is absent and the file list is not one of two bounds on
this handle. It is the only one.

**Re-priced 2026-08-16 after the wave-2 security pass, downward.** The first version of this
ADR let that read as a cross-tenant reach. It is not one. Measured as `shortkit_auth` against
the migrated schema, `SELECT count(*) FROM tenants` and `FROM tenant_memberships` both answer
`permission denied for table ...`, and enumerating `role_table_grants` confirms
`shortkit_auth` holds DML on exactly the five auth tables and nothing else, because it never
received a default privilege. **The absent narrowing is a missing compile-time guard over a
path the database already refuses.** It is worth fixing so ADR-0046's stated consequence
becomes true, and nobody should spend a blocker on it. The reach that matters is the five
tables the role legitimately holds, which carry no RLS at all, and the accepted-cost section
below now prices that correctly.

The precedent for the control is `apps/api/src/db/context-flag-owners.spec.ts`: a text scan
over `apps/api/src`, `readdirSync` recursive, `.ts` and not `.spec.ts`, regex over the source
text, `toEqual([])` on the rejected set, with a canary test asserting the scan reached the
one real call site. It is deliberately not an AST walk, and an AST rewrite of it has been
ruled against twice.

The tier trap the card names is real and was checked. `apps/api/vitest.config.ts:10` includes
`src/**/*.spec.ts` and nothing else. `apps/api/vitest.integration.config.ts` includes
`**/*.int-spec.ts`. A file named `*.spec.ts` under `apps/api/test/` matches neither and
passes by never running.

## Decision

**`apps/api/src/db/better-auth-database-callers.spec.ts` asserts by equality that the set of
files under `apps/api/src` containing the identifier `betterAuthDatabase` is exactly
`db/client.ts` and `auth/auth.config.ts`. ADR-0046 keeps its rule and loses its deferral;
this ADR amends it on that one point.**

**That is scan 1. Three more scans were added in rounds 2 and 3 — see the direction table
below: scans 1, 3 and 4 are equalities and scan 2 is a subset.** Scan 1 alone bounds an
identifier rather than the role, which is what the rest exist to close.

### The shape

Copy `context-flag-owners.spec.ts`'s idiom verbatim: `readdirSync(apiSource, { recursive:
true, encoding: 'utf8' })`, filter `.ts` and exclude `.spec.ts`, read each file, match
`/\bbetterAuthDatabase\b/`, collect repository-relative forward-slashed paths.

```ts
const PERMITTED = [
  'apps/api/src/auth/auth.config.ts',
  'apps/api/src/db/client.ts',
] as const;

expect([...new Set(files)].sort()).toEqual([...PERMITTED]);
```

**Equality, not the subset direction the precedent uses.** The precedent asserts subset only
because `CONTEXT_FLAG_OWNERS` names two files that deferred TASKs create, so equality would
be red on the day it lands. That constraint does not exist here: `client.ts` is shipped and
`auth.config.ts` is created by the card that ships this spec. Both permitted files exist when
the assertion runs, so equality is available and it is strictly stronger. It catches a
removal as well as an addition, which matters because deleting the call from
`auth.config.ts` and reaching the pool another way is a diff this control should not pass.

**Equality is its own canary.** `context-flag-owners.spec.ts` needs a separate canary test
because `toEqual([])` is satisfied by a scan that read nothing. `toEqual(PERMITTED)` is not:
a scan that walked a moved directory produces `[]` and fails. No second test is needed and
adding one would be cargo.

**A text scan, and it stays one.** Same reasoning the precedent records: a commented-out
call is one uncomment away from being real, and the two permitted files carry the identifier
in their own header comments and match harmlessly because they are the permitted ones. It
matches the bare identifier, so an import, a re-export, a call and a mention all count. That
is deliberate: a re-export is the cheapest way to defeat a caller list.

**Scope is `apps/api/src`,** which is ADR-0042's ruling on what "the API source tree" means
and is the bound ADR-0046 wrote. `apps/api/test/**` and `apps/api/scripts/**` are outside it.
That residual is stated below rather than closed.

### Two more assertions, because the identifier is not the capability

Added 2026-08-16 after the wave-2 security pass. The scan bounds one identifier. The auditor
demonstrated that reaching the role needs no identifier at all: `DATABASE_AUTH_URL` is in the
API process environment (`docker-compose.yml`), so any file under `apps/api/src` can write
`new pg.Pool({ connectionString: process.env.DATABASE_AUTH_URL })` and hold `shortkit_auth`
without the string `betterAuthDatabase` appearing anywhere. The equality scan passes.

The same spec therefore carries four scans, and **they differ in both direction and weight**.
Revised 2026-08-16 after round 2, which found the first draft of this section both
scheduled to break and weaker than it read.

| # | Scan | Permitted set | Direction | Weight |
|---|---|---|---|---|
| 1 | `betterAuthDatabase` | `db/client.ts`, `auth/auth.config.ts` | **equality** | the ADR's original rule |
| 2 | `DATABASE_AUTH_URL`, **the bare identifier, anywhere** | `db/client.ts`, `main.ts`, `auth/boot-assertions.ts` | **subset** | tripwire on the file set |
| 3 | `process.env.DATABASE_AUTH_URL` and its bracket forms, **the use** | `db/client.ts` | **equality** | **load-bearing** |
| 4 | the module specifiers `'pg'` and `'drizzle-orm/node-postgres'`, in any import, `require` or dynamic `import` position | `db/client.ts` | **equality** | second-order tripwire |

**Scan 2 is the one direction that cannot be an equality, and the reason is this ADR's own.**
Corrected 2026-08-16 after round 3, which caught the contradiction. The section below
pre-authorises `main.ts` and `auth/boot-assertions.ts` because TASK-004 will put
`AUTH_VERDICT_PREFIX = 'DATABASE_AUTH_URL connect'` in the first and a refusal message naming
the variable in the second. **Neither contains the string today and neither will after
TASK-003**: verified against the tree, `DATABASE_AUTH_URL` occurs in `apps/api/src/db/client.ts`
and nowhere else, `main.ts` gains only the assertion calls and an `instanceof` branch, and the
wave-2 `boot-assertions.ts` stub contains it zero times. An equality would compare one entry
against three and **fail on the day TASK-003 lands**.

That is precisely the constraint recorded three paragraphs up for `CONTEXT_FLAG_OWNERS`: a
permitted set naming files that a later TASK creates cannot be asserted by equality, because it
is red before the files exist. The first version of this section said the constraint does not
apply here. It does not apply to scans 1, 3 and 4, whose permitted sets are green against the
tree today. It applies to scan 2 exactly, because scan 2 is the only one whose permitted set is
deliberately ahead of the tree.

**A red gate on a control is a security event, not a scheduling one.** The cheapest way to
green a red equality is to trim `PERMITTED` to what the tree contains, which deletes the
wave-3 pre-authorisation this section exists to add, and R2-1's collision returns in wave 3
with nobody remembering why the entries were there.

**Subset costs the removal direction and nothing else.** Scan 2 no longer notices if
`db/client.ts` stops naming the variable, which is a change that cannot reach the auth role and
which scan 3's equality catches anyway. Every addition still fails, and additions are the
direction carrying the security claim.

**Why 2 and 3 are separate scans of one variable.** They answer different questions and each
one alone is wrong.

Scan 2 matches every spelling, including `const { DATABASE_AUTH_URL } = process.env`, which a
`process.env.`-anchored regex misses. But it is a text scan, so it also matches a mention.
**ADR-0050:272 and TASK-004's card at `:150-152` both require `main.ts` to gain
`AUTH_VERDICT_PREFIX = 'DATABASE_AUTH_URL connect'`**, deliberately that literal so it cannot
collide with `RLS_VERDICT_PREFIX = 'DATABASE_URL connect'` (`main.ts:48`), and
`assertAuthRoleSeparation`'s refusal message will name the variable too. So a
`db/client.ts`-only permitted set for scan 2 goes red in wave 3, on a card that opens no pool
and holds no handle, and the cheapest way to green a red gate is to widen `PERMITTED` to
whatever the tree contains. **The wave-3 shape is therefore decided here rather than at the
point it is red**: `main.ts` and `auth/boot-assertions.ts` are in scan 2's permitted set from
the day it lands, with the reason written beside them in the spec — *they name the variable,
they do not connect with it*.

Scan 3 is what enforces that reason. It matches the use and not the mention, so `main.ts`
holding a verdict prefix passes it and `main.ts` holding
`new pg.Pool({ connectionString: process.env.DATABASE_AUTH_URL })` does not. It is the
load-bearing one of the four: it is the only thing standing between a convenience commit and
the `shortkit_auth` role.

One measured piece of good news bounds scan 3's evasion surface. **The "assemble the DSN from
parts" evasion is not available in-process**: `docker-compose.yml:273` interpolates
`SHORTKIT_AUTH_PASSWORD` at Compose parse time into `DATABASE_AUTH_URL`, and the parts
themselves are not in the `api` service's environment. The DSN literal is the only spelling
that reaches the role.

**Scan 4 is a tripwire and this ADR no longer claims it closes the pool-construction path.**
Corrected 2026-08-16. `drizzle-orm/node-postgres`'s own driver builds the pool:
`driver.js:60-65` is `new pg.Pool({ connectionString: params[0] })` when `drizzle()` is handed
a string. So `import { drizzle } from 'drizzle-orm/node-postgres'; const db = drizzle(dsn);`
holds `shortkit_auth` in one line with no `betterAuthDatabase`, no `new pg.Pool` and no
`from 'pg'` in it, using an import four sanctioned files already carry. Matching the **module
specifier** rather than `new pg.Pool` is what covers it, and it also covers `from "pg"` and
`await import('pg')`, which the first draft's quoted spelling missed. Even so, a file that
obtains a client from somewhere else defeats scan 4 and not scan 3, which is why scan 3 is the
one to keep if any is ever dropped.

**What the four still do not catch**, stated because a table of four greps reads stronger than
it is:

- an env key built at runtime, `process.env['DATABASE_' + 'AUTH_URL']`, which defeats 2 and 3;
- a DSN read from a file or fetched, rather than from the environment;
- a client obtained from a transitive dependency that neither specifier names;
- a connection opened from `main.ts` or `auth/boot-assertions.ts` through a helper, which
  passes scan 2 by permission and scan 3 only if it never names `process.env`;
- anything at all outside `apps/api/src`.

**A fifth scan was added 2026-08-16 (F-207), and the list above was written when there were
four.** The implement-phase security audit measured what none of the four bounded: the composed
`auth` this card exports is **itself a second handle on `shortkit_auth`** — through
`auth.$context.adapter` it reads plaintext session tokens, the `account` password hashes and
`jwks.private_key`, and it created a session row for another user. **All four scans were green
throughout.** Scans 1–4 bound the construction of a *new* pool; scan 5 bounds importing the
*existing* one. It is a **subset**, for scan 2's reason: its permitted set is ahead of the tree.

**One spelling scan 5 does not catch, and it is not a bypass:** `import './auth.config';`, the
side-effect form. It binds no name, so it reaches no adapter. Recorded here because the test
architect found it by planting twelve spellings against the implementer's seven, and a gap
found by measurement belongs in the list rather than in a memory.

**The non-vacuity argument for scan 5 was wrong as first stated, which is worth more than the
scan.** It was proposed on the grounds that `main.ts` already matches — but that match is a
**comment** at `main.ts:138` quoting the import TASK-004 must write, and **no file under
`apps/api/src` imports `auth.config.ts` at all` today**. On a subset assertion, rewording that
one comment would leave scan 5 matching nothing and passing silently — a control defeated by an
edit to prose. It therefore ships with a **positive control on the pattern itself**, over
planted text that no prose edit can reach, and was mutation-checked: a planted importer turns it
red.

These are floors against the direct spelling, which is the spelling a convenience commit
actually uses. They are not a proof about statements, and ADR-0050's boot assertion is not
either; the behavioural proof stays the integration tier's.

### What happens to ADR-0046

**Amended, not superseded.** Its decision is unchanged: two files, named the same two files,
for the same reason. What changes is one sentence, "TASK-056 asserts it the same way", and
one follow-up bullet, "TASK-056 (deferred)". Both now read TASK-003, wave 2. Superseding an
ADR whose decision survives intact would make a reader look for a changed decision and not
find one.

ADR-0046's front matter gains `amended_by: ADR-0056`. Its Follow-ups list gains a dated line
pointing here. **Those two edits to ADR-0046 are the only edits this ADR asks for, and they
are Juano's to apply**, because ADR-0046 is an accepted ADR of this initiative and editing
one in place is a gate action rather than a design action.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Leave the deferral to TASK-056 as ADR-0046 wrote it | No new file. The rule is still recorded, and a rule with a late control is not a rule with no control | TASK-056 is in no wave of this initiative, so the handle sits unbounded on `shortkit_auth` from wave 2 with nothing enforcing anything. That is the state F-108 was filed against, and it is the deferral's original pricing applied to a model where the handle now reaches session tokens | Reversed by Juano's ruling on F-108. The price changed and the deferral was not re-priced |
| An ESLint rule, `no-restricted-imports` with an allow-list of files | Runs in the `quality` job, fires in the editor, no test file. Lint is where import bans live in this repository already (`eslint.config.mjs:98-124`) | `no-restricted-imports` bans a module, not a named export, so it would have to ban importing `db/client` entirely, which four sanctioned callers do. `no-restricted-syntax` on the identifier is possible and needs a per-file `files`/`ignores` split that encodes the permitted list in the lint config, a third place the list lives. It also cannot see a re-export by another name | The list would live in `eslint.config.mjs` rather than beside the thing it bounds, and the rule cannot express "this export, in these two files" without contortion |
| An AST walk with the TypeScript compiler, as `logging-opt-out.spec.ts` does | Distinguishes code from comments, so no false positive from a docblock. Resolves re-exports properly | The precedent explicitly rejects this shape for this class of control, twice, and the reason applies here: a commented-out call is one uncomment from real and should fail. Comment matches are not false positives, they are the design | Consistency with a ruling already made, and the looser scan is the stronger assertion here |
| Scan `apps/api` rather than `apps/api/src` | Closes the residual: a test helper or a script could otherwise hold the handle | `apps/api/test/support/auth-fixture.ts` legitimately reads Better Auth tables, today through `psql` on the migrator DSN. If a later fixture reaches for `betterAuthDatabase` the control should have an opinion, but ADR-0042 fixed "the API source tree" as `src` and widening it here decides ADR-0042's question as a side effect of a different decision | Right question, wrong ADR. Named in the follow-ups |
| Assert the type narrowing instead, so the handle reaches five tables | Restores what ADR-0046 actually decided. A type is checked by the compiler on every build, with no scan | It is a change to `db/client.ts`, which is not in TASK-003's `paths` and belongs to TASK-002's shipped work. It also does not bound *who* holds the handle, which is the property F-108 is about: a narrowed handle still reads `session.token` | Out of this card's write surface, and it closes a different hole. Escalated below |

## Consequences

### Positive

- The one export that reaches plaintext session tokens and password hashes has an executing
  control in the wave that first uses it, rather than a rule in an ADR and a deferred TASK.
- Equality catches removals and additions, and needs no separate canary.
- The scan is fifteen lines of an idiom this repository already runs and reviews.
- A re-export under a different name still matches, because the scan reads the identifier
  wherever it appears.

### Negative / accepted cost

- **`apps/api/test/**` and `apps/api/scripts/**` are not scanned.** A test helper or a
  one-off script can import `betterAuthDatabase` and read every session token, and this
  control says nothing. That is the exact capability the auditor demonstrated, from a bare
  script. Accepted because widening the scope decides ADR-0042's question sideways, and named
  as a follow-up.
- **A text scan matches comments,** so a file that merely discusses `betterAuthDatabase` in
  prose fails the assertion. That is deliberate and it will cost someone a confusing five
  minutes the first time they write a docblock about it in a third file.
- **The permitted list is now written in three places**: ADR-0046, this ADR, and the spec.
  Nothing makes them agree. The spec is the one that executes, and the other two are prose
  that can drift from it, which is the same list-staleness cost ADR-0051 has accepted twice.
- **The control bounds an identifier, not the role.** Corrected 2026-08-16 after the wave-2
  security pass. `process.env.DATABASE_AUTH_URL` plus a pool reaches `shortkit_auth` from any
  file in the scanned tree without naming `betterAuthDatabase` at all. The three extra
  equalities close the direct spelling of that bypass and no more; a runtime-built env key
  defeats scans 2 and 3.
- **Four scans read as more coverage than they are, and one of them carries almost all
  of the weight.** Added 2026-08-16 after round 2. Scan 3, the use of
  `process.env.DATABASE_AUTH_URL`, is the load-bearing one. Scan 4 was written believing it
  closed pool construction and does not: `drizzle(<string>)` builds a pool inside a
  dependency four sanctioned files already import. The table above now says which is which,
  because a control that reads as coverage and is not is worse than no control at all.
- **Scan 2's permitted set contains two files that may name the variable and must not connect
  with it, and only scan 3 enforces the distinction.** If scan 3 is ever dropped or narrowed,
  `main.ts` and `auth/boot-assertions.ts` become two files with an unenforced promise.
- **Pre-authorising wave 3's files is a list written against a card that has not been
  implemented.** If TASK-004 puts `AUTH_VERDICT_PREFIX` somewhere other than `main.ts`, the
  permitted set is wrong in the other direction: it permits a file that turned out not to need
  it. That is the safe direction and it is still a list maintained by nobody.
- **Scan 2 is a subset, so it cannot see a removal**, including `db/client.ts` ceasing to name
  the variable. Accepted 2026-08-16: a removal cannot reach the auth role, and scan 3's
  equality over the use catches the case that can. It does mean the four scans are not
  uniform, and a reader who assumes they are will misread scan 2. The table states the
  direction per scan for that reason.
- **Two of the three files in scan 2's permitted set are permitted for a reason nothing
  verifies.** They may name the variable and must not connect with it, and only scan 3
  enforces the second half. Until TASK-004 lands, scan 2's permitted set describes an
  intention rather than the tree.
- **The capability is read AND write on five tables that carry no RLS, which is account
  takeover rather than disclosure.** Corrected 2026-08-16; the first version of this ADR
  priced it as "plaintext session tokens and password hashes", which is the read half only.
  Measured as `shortkit_auth` on the migrated schema in a rolled-back transaction:
  `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)` with an
  attacker-chosen token and another user's id **succeeded**, because `relrowsecurity` is
  false on all five (confirmed). So the holder forges a working session for any user, rewrites
  any password hash, and reads `jwks.private_key`. `process.env.BETTER_AUTH_SECRET` is in the
  same process, so the holder also decrypts that key and mints any `tid` for any user. This
  is ADR-0050's own measured attack, reachable from inside `apps/api` rather than from a SQL
  defect.
- **The control does not bound what the handle does, only who holds it.** Both permitted
  files can read and write every row in the five auth tables with no transaction and no
  context flag. ADR-0046's narrowing was meant to be the other half of this and is absent
  from the shipped code.
- **TASK-003 now ships two greps and a boot assertion in a card whose intent is composing an
  auth instance.** The card's surface has grown four times. This is the fourth.

### Follow-ups this creates

- **Escalated to Juano: ADR-0046 needs two edits**, `amended_by: ADR-0056` in its front
  matter and a dated line in its Follow-ups replacing "TASK-056 (deferred)" with TASK-003,
  wave 2. The decision itself is untouched.
- **Escalated to Juano: `db/client.ts:259` returns `NodePgDatabase<typeof schema>`, not
  `NodePgDatabase<typeof betterAuthSchema>`.** ADR-0046's decision block specifies the
  second, its Alternatives table rejects the first by name, and its Positive section claims a
  compile error that the shipped code does not produce. Either ADR-0046's consequence is
  wrong or `client.ts` is, and both are shipped. **Priority is low, and measured**:
  `shortkit_auth` cannot read `tenants` or `tenant_memberships` at all, so this is a missing
  compile-time guard over a path the database refuses, not an open reach. Functionally the
  adapter is unaffected,
  checked: `drizzleAdapter` resolves models through `config.schema` when it is passed
  (`@better-auth/drizzle-adapter/dist/index.mjs:90-92`) and the `db.query` fallback runs only
  under `options.experimental.joins`, which nothing sets. **TASK-003 must still pass `schema:
  betterAuthSchema` explicitly**, because without it the adapter falls back to
  `db._.fullSchema`, whose keys are `authUser` and `authSession` rather than `user` and
  `session`, and every model lookup raises `BetterAuthError`.
- **Unscheduled: whether the caller list should cover `apps/api/test` and `apps/api/scripts`.**
  It decides ADR-0042's boundary for a second mechanism and needs its own ruling.
- **TASK-004 inherits scan 2's permitted set and scan 3's prohibition, and this is the
  sentence it inherits them from.** It may write `DATABASE_AUTH_URL` into
  `AUTH_VERDICT_PREFIX` in `main.ts` and into `assertAuthRoleSeparation`'s refusal message in
  `auth/boot-assertions.ts`. It **may not** write `process.env.DATABASE_AUTH_URL` in either:
  `assertAuthRoleSeparation` reaches the auth pool through `db/client.ts`, which is what
  ADR-0050 already requires and what scan 3 now enforces.
- TASK-004 must not add an occurrence of `betterAuthDatabase`. It imports `auth` from
  `auth.config.ts` and reaches no pool of its own.
