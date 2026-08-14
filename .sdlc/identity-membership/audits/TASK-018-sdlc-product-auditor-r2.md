# TASK-018 — product audit, round 2 (scoped re-review of fix round 1)

- **Auditor:** sdlc-product-auditor
- **Mode:** per-TASK, scoped re-review
- **Range audited:** `4cfa57f..60afdeb` (single commit `60afdeb`), via
  `.superpowers/sdd/plan/review-4cfa57f..60afdeb.diff`
- **Date:** 2026-08-14
- **Verdict:** clear

## Scope of this pass

Seven findings verdicted (F-064, F-065, F-066, F-068, F-069, F-071 mine; F-049 the
reviewer's). Every hunk in the fix diff traced to a filed finding or to a declared
carve-out. Tests, lint, build and the `ci.yml` DSN were verified by the orchestrator and
were **not** re-run here, per the dispatch.

**Discrepancy to record:** the dispatch describes the fix as "34KB across eight files".
The diff package and `git diff --stat 4cfa57f..60afdeb` both show **seven** files. There
is no eighth file in the commit, and `git status --porcelain` shows no uncommitted
non-`.sdlc/**` change that could be it. If an eighth file was expected, it did not ship —
I can only verify the seven.

```yaml
verdict: clear
ac_verification:
  - id: F-064   # blocker (mine) — docker-compose.test.yml header export lines
    status: met
    evidence: docker-compose.test.yml:10 — `export DATABASE_AUTH_URL='postgres://shortkit_auth:auth@127.0.0.1:55433/shortkit_test'`
    note: |
      ADDRESSED. Same port (55433), same database (shortkit_test), same quoting and
      position as the two lines beside it. The remedy string that auth-fixture.ts throws
      now points at a header that actually documents the variable — verified both ends,
      not just the header: auth-fixture.ts:110-113 says "see that file's header for the
      exact export lines" and the header has them.
  - id: F-065   # major (mine) — ci.yml unowned, no DATABASE_AUTH_URL
    status: met
    evidence: |
      .github/workflows/ci.yml:206 (DATABASE_AUTH_URL, byte-identical to the compose
      header's DSN — diffed both strings); .sdlc/identity-membership/tasks/TASK-018.md:8
      (paths gains .github/workflows/ci.yml) and :9-15 (the dated ruling note).
    note: |
      ADDRESSED, and the card's framing is HONEST — this was the specific thing I was
      asked to verdict. The note says in as many words: "NOTE the gap is closed for this
      variable, NOT for ci.yml generally - the file still has no long-term owner and the
      next TASK needing it will find none." That is exactly the residual. It does not
      claim the ownership problem is solved, it does not quietly make TASK-018 the
      file's owner by implication, and it records who ruled and when. F-065's own
      required_change asked for "a card owns .github/workflows/ci.yml and adds
      DATABASE_AUTH_URL"; the ruling delivered the second half and explicitly declined
      the first, on the record. Nothing to re-open.
  - id: F-066   # minor (mine) — two-role prose, four named sites
    status: met
    evidence: |
      docker-compose.test.yml:33 and :56-58; docker-compose.yml:25 and :82-83.
      All four rewritten to the three-role model.
    note: |
      ADDRESSED, and slightly wider than "widen the four comment lines": the ":25"/":33"
      bullet gained a clause stating shortkit_auth owns nothing and receives no default
      privilege. That is the same correction, not a new claim — the bullet described a
      two-role grant model, and widening the count without the grant asymmetry would
      have left the copy-me list wrong in the other direction.
  - id: F-049   # minor (reviewer's, wider than F-066) — six sites incl. the CI SQL
    status: met
    evidence: |
      The two extra sites I missed are both fixed:
      docker-compose.yml:90-94 ("Both survive into the running server's environment" →
      "All three survive…"), and .github/scripts/provision-test-database.sql:50-51.
    note: |
      ADDRESSED, and I checked the one that could have gone wrong. The SQL site quotes a
      contract sentence; the new text reads "Neither shortkit_app nor shortkit_auth may
      hold BYPASSRLS, SUPERUSER, CREATEROLE or table ownership." I read
      rls-policy-template.md:63-64 directly — it is a verbatim match including the role
      order. A transcription that had paraphrased here would have been F-050's defect
      inside F-049's fix.
  - id: F-068   # minor (mine) — invented BETTER_AUTH_SECRET default, comment stated 2 of 4
    status: met
    evidence: docker-compose.yml:255-260 — "set, non-empty, 55 characters (>= 32), and not equal to better-auth's published default 'better-auth-secret-12345678901234567890'".
    note: |
      ADDRESSED for the part inside paths. All four rejections now stated. I re-measured
      the value rather than trusting the comment: len() = 55, so ">= 32" and "55
      characters" are both true as written. I also verified the one new factual claim the
      comment makes — "Dockerfile:83 sets NODE_ENV=production unconditionally" — against
      Dockerfile:83, which reads `ENV NODE_ENV=production`. Correct, and it is a
      *sharper* statement than the one it replaced ("a development-only value"), which
      was the misleading half.
      The optional TASK-003 test half is correctly deferred and declared: no
      boot-assertions module exists yet. Not counted against this round.
  - id: F-069   # minor (mine) — no down -v note for an existing dev volume
    status: met
    evidence: docker-compose.yml:242-247 — the "EXISTING VOLUME?" paragraph, immediately above DATABASE_AUTH_URL.
    note: |
      ADDRESSED at the location my own required_change named. See F-078: one clause of it
      states a wave-1 fact in the present tense.
  - id: F-071   # minor (mine) — seed.mts docblock tense
    status: met
    evidence: apps/api/scripts/seed.mts:33-40 — "EXCEPTION, FROM TASK-002's migration `0001` (ADR-0050), not yet applied at wave 0: … will also be created … will be immediately `REVOKE`d …".
    note: |
      ADDRESSED, and better than the minimum I asked for: the paragraph now names the
      owning TASK, states the wave-0 status explicitly, and moves every verb to the
      future rather than adding a bare qualifier to a present-tense claim.

findings:
  - severity: minor
    kind: behavior
    id: F-078
    file: docker-compose.yml
    line: 244
    summary: |
      The F-069 fix states a wave-1 fact in the present tense — F-071's exact class,
      reintroduced by the same round that fixed F-071.
    failure_scenario: |
      The note reads: "`migrate` fails with `role \"shortkit_auth\" does not exist` and,
      from wave 2, so does `api` against this DSN." The `api` half carries its wave
      qualifier; the `migrate` half does not, and it is not true today. VERIFIED: the
      only migration on disk is apps/api/drizzle/0000_odd_betty_ross.sql, and
      `grep -rn shortkit_auth --include=*.sql apps/api` returns NOTHING. `migrate`
      connects as shortkit_migrator and issues no statement naming shortkit_auth until
      TASK-002's migration 0001 lands in wave 1.
      The consequence is the opposite of alarming and is why this is minor rather than
      cosmetic: a developer with a stale `shortkit-dev_pgdata` volume today gets a
      COMPLETELY GREEN `up` — migrate passes, seed passes, api boots — with
      DATABASE_AUTH_URL pointing at a role that does not exist. The note tells them to
      expect a loud failure that will not arrive for a wave, which is a reason to
      believe a silent stack is a correct one.
    required_change: |
      Qualify the migrate clause the way the api clause beside it already is: from
      wave 1, when TASK-002's migration 0001 GRANTs to the role. Deferrable — per
      implement.md this is a minor that does not extend the loop.

  - severity: minor
    kind: behavior
    id: F-079
    file: docker-compose.test.yml
    line: 14
    summary: |
      This round edited both ends of a documented coupling and left the sentence between
      them pointing at a third card. The header now contradicts ci.yml, which cites it.
    failure_scenario: |
      docker-compose.test.yml:14-15 still says "The CI equivalent is a `services:`
      container in the `integration` job and belongs to TASK-002 (F-039), not here" —
      three lines below the DATABASE_AUTH_URL export this round added. Meanwhile
      ci.yml:204-205, also added this round, says "see docker-compose.test.yml's header,
      which this block stays identical to". A reader following either pointer lands on
      the other, and the header tells them the CI half is TASK-002's future work when
      TASK-018 has just done it and the `services:` container has existed in ci.yml all
      along. Pre-existing text, but this round is what made it self-contradicting.
    required_change: |
      The header sentence reflects that the CI DSN block exists and was set by TASK-018
      (F-065), and stops attributing it to TASK-002. Deferrable.

  - severity: minor
    kind: behavior
    id: F-080
    file: apps/api/test/support/rls-fixture.ts
    line: 106
    summary: |
      F-052's fix unified the two remedy messages inside auth-fixture.ts; the third
      copy — rls-fixture.ts's `dsn()` — still tells the developer the suite needs two
      DSNs, and it is the one the isolation suite throws from.
    failure_scenario: |
      VERIFIED by reading both: rls-fixture.ts:110-113 throws "…export DATABASE_URL
      (shortkit_app) and DATABASE_MIGRATION_URL (shortkit_migrator)." auth-fixture.ts:
      109-114 now throws "…export DATABASE_URL (shortkit_app), DATABASE_MIGRATION_URL
      (shortkit_migrator) and DATABASE_AUTH_URL (shortkit_auth)". A developer starting
      cold hits rls-fixture's message first (it fires on the two variables every
      integration spec needs), exports the two it names, gets past it, and from wave 2
      hits auth-fixture's message asking for a third. Two-step remedy chase — the same
      defect F-064 fixed in the compose header, one file over.
      F-052 is nonetheless ADDRESSED as written: its failure_scenario named "TWO
      MESSAGES IN ONE FILE", and that file is now consistent.
    required_change: |
      rls-fixture.ts's message names all three DSNs, or defers to the compose header the
      way auth-fixture.ts's now does. NOTE the card resolved rls-fixture.ts as
      no-change — that resolution was scoped to role-agnosticism in
      `assertAppRoleCannotBypassRls()` and the DSN memoisation, and says nothing about
      the remedy text. Deferrable.
```

## Shipped but not asked for

**Three hunks trace to no filed finding. All three are disclosed in the fix report, all
three are inside `paths`, all three correct text that is or becomes false. None is a
feature. No change requested on any of them — recorded so the deviation is on the record.**

I traced every hunk in the diff. The full map:

| Hunk | Traces to |
|---|---|
| `provision-test-database.sql` guard comment rewrite | F-050 (reviewer) + F-049's SQL site |
| `provision-test-database.sql` ALTER DEFAULT PRIVILEGES comment | F-059 (security) |
| `ci.yml` DATABASE_AUTH_URL + comment | F-065, by Juano's ruling |
| **`ci.yml` "one of the two → three NOBYPASSRLS roles"** | **no finding — F-049's class, fourth artifact** |
| **`ci.yml` step rename, "the migrator and app roles" → "the migrator, app and auth roles"** | **no finding** |
| `TASK-018.md` paths + note | F-065, by Juano's ruling |
| `seed.mts` tense | F-071 |
| **`seed.mts` "turns that into" → "turns a bad migration identity into"** | **no finding — disclosed as a pronoun the F-071 edit made ambiguous** |
| `auth-fixture.ts` `dsnOrThrow` collapse | F-052 (reviewer) |
| `docker-compose.test.yml` header export | F-064 |
| `docker-compose.test.yml` :33, :56 prose | F-066 / F-049 |
| `docker-compose.test.yml` configs ADP comment | F-059 |
| `docker-compose.yml` :25, :82, :90-94 prose | F-066 / F-049 |
| `docker-compose.yml` DATABASE_AUTH_URL comment expansion | F-056 (security), "the asymmetry is stated" |
| `docker-compose.yml` EXISTING VOLUME? note | F-069 |
| `docker-compose.yml` BETTER_AUTH_SECRET banner + comment | F-056 + F-068 |
| `docker-compose.yml` configs ADP comment | F-059 |

On the three:

1. **The two `ci.yml` prose edits.** F-049's required_change says "all three provisioning
   artifacts"; `ci.yml` is a fourth, and it was not in anyone's paths when F-049 was
   written. Both edits correct text that is false from wave 2 by the same argument the
   reviewer used to promote `docker-compose.yml:82` — and the file came into this card's
   paths mid-round by ruling. Correct to fix while there.
2. **The `seed.mts` sentence.** "Connecting as the runtime role and writing turns *that*
   into `permission denied`" — the referent of "that" was the paragraph F-071's fix moved
   into the future tense. Repairing the referent is part of the F-071 fix, not beside it.

Nothing else. No application code, no schema, no policy, no migration, no test spec, no
`.env.example`, no README, no `check-compose-stack.sh`. The `auth-fixture.ts` change is a
net **deletion** of 19 lines.

**One process note, not a finding.** The commit contains a `.sdlc/**` edit
(`tasks/TASK-018.md`) while its own report declines F-056's primary change on the grounds
that `.sdlc/**` "is outside every implementer's paths". The card carries an in-file
attribution — "ci.yml ADDED 2026-08-14 by Juano" — so the two are reconcilable, and the
dispatch confirms the ruling. Flagging only because the F-056 deferral rests on that claim
and the same commit appears to contradict it; anyone auditing the deferral later should
read the attribution line first.

## Out-of-scope items that got built

**None.** Re-checked each named exclusion against the fix diff, not against round 1's
answer:

| Excluded item | Owner | State in the fix diff |
|---|---|---|
| `check-compose-stack.sh` contaminant guard | TASK-017 | Not in the diff. |
| Migration `REVOKE`/`GRANT`, grant matrix, second pool | TASK-002 | Not in the diff. Referenced in comments only, now with wave qualifiers. |
| `assertAuthRoleSeparation` | TASK-004 | Not in the diff. Named in a comment with "TASK-004, wave 3". |
| `assertBetterAuthSecretConfigured()` test | TASK-003 | Not in the diff; declared deferred. |
| `.env.example`, README | TASK-009 | Untouched. |
| `rls-fixture.ts` | resolved as no-change | Untouched (see F-080). |
| ADR-0051 / `rls-policy-template.md` value pinning | F-056's primary, `.sdlc/**` | Not done, declared. The carve-out the dispatch named. |
| `rls-policy-template.md:15-18` two-role guard paragraph | F-070, orchestrator | Still stale — confirmed on disk. Correctly untouched. |

## Residual risk carried out of this round

Both halves of the F-064/F-065 pair are **unasserted configuration**. The nine tests
execute the three role-provisioning scripts; nothing executes or compares the
`docker-compose.test.yml` header export block against `ci.yml`'s `env:` block, and the
comment in each says it "stays identical to" the other. The two are correct today — I
diffed the DSN strings, they match character for character — and they will drift the way
they just did, silently, with the suite green. This is F-067's class (the net, not the
code) at the documentation tier. Not a finding against this round, which fixed both ends;
a scheduling fact for whoever owns `ci.yml` next, which per the card's own note is nobody.

## Summary

All seven findings ADDRESSED. Two of the fixes are meaningfully better than what was
asked: F-071's paragraph now names the owning TASK and the wave rather than adding a bare
qualifier, and F-068's comment replaced a false claim ("a development-only value") with a
verified one about `Dockerfile:83` rather than only adding the two missing rejections.
F-065's card note is honest — it closes one variable and says out loud that `ci.yml` still
has no owner, which is the part that would have been easy to leave implied.

On the scope question the dispatch sharpened: **the fix round did not creep.** 34KB of
diff for comment corrections looks like a lot until it is traced, and seventeen of twenty
hunks map to a named finding. The three that do not are one adjacent sentence and two
lines in a file that entered `paths` mid-round, all three disclosed by the implementer
before I looked. There is no behavior in this diff that nobody asked for.

The three new findings are all minors and all of a kind: text that is true one wave from
now stated as true today (F-078), a pointer left stale by fixing both ends of what it
points at (F-079), and a remedy message that survived a de-duplication because it lives in
the third file (F-080). None blocks. Per implement.md they are deferrable to the ledger
and do not extend the loop.
