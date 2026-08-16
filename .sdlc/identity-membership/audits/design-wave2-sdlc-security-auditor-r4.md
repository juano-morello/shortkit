# Design-mode security audit — identity-membership wave 2 (TASK-003), round 4 (final scoped re-review)

verdict: clear on the three scoped findings — two ADDRESSED, one **disproved and withdrawn by
me**; one minor and one nit remain, neither load-bearing.

Scope: F-186, F-187, F-188, plus the three checks. F-189 not revisited. Everything cleared in
r1–r3 stays cleared; no revision disturbs it.

## The adapter answer

**CONVERGE.** F-188 does not hold against the thing that ships, and the architect's objection
was correct on the exact point it raised.

Measured on a scratch database (`sec_audit_r4`, migrations `0000` and `0001` applied, dropped
afterwards — see Shared state), through a composed `betterAuth` instance on
`drizzleAdapter(drizzle(pool, { schema }), { provider: 'pg', schema: betterAuthSchema,
transaction: false })`, the pool authenticating as `shortkit_auth`, with
`emailAndPassword: { enabled: true, autoSignIn: false }`:

```
duplicate address : 200  ["name","email","emailVerified","image","createdAt","updatedAt","id"]
fresh address     : 200  ["name","email","emailVerified","image","createdAt","updatedAt","id"]
```

Setup verified before trusting the result: as `shortkit_auth` on that database,
`SELECT count(*) FROM "user"` succeeds and `SELECT count(*) FROM tenants` answers
`permission denied for table tenants`. The refusal is the role's, not a misprovisioned schema.

The key sets are identical, and I checked the values rather than stopping at the keys, because
a key comparison would hide the disclosures that would matter most:

- `id` on the duplicate response is a **fresh** id, not the existing account's.
- `createdAt` on the duplicate response is **now**, not the existing account's creation time —
  seeded 1.5 s earlier and confirmed different.
- `token` is `null` in both.
- The duplicate created **no row**: four addresses signed up, four rows, the two duplicate
  probes added none.
- The only field that differs between the two bodies is `email`, which is the attacker's own
  input echoed back.

**Why my r3 reasoning was wrong, in the architect's words rather than mine.** I argued the
divergence was adapter-independent *because* `image` is a nullable column in migration `0001`.
That is precisely the reason it converges: under the real adapter both branches serialise a row
that carries the column, so the fresh branch gains the `image` key the in-memory branch lacked.
The in-memory adapter stores only the fields it was given, which is what produced the asymmetry
I measured. Writing the question as undetermined and pre-committing both outcomes to a
byte-identity test was the right call under uncertainty, and better than either of us asserting
an answer.

**The one channel left, measured so it is not left to inference.** The duplicate branch hashes
the password to equalise timing while the fresh branch also performs two inserts, so any
residual timing signal points the wrong way for an attacker. Median of 12 over loopback:
duplicate 45.0 ms, fresh 46.3 ms — a 1.4 ms difference on a 45 ms request, with the *existing*
address answering faster. That is inside network noise and is not an oracle.

**Severity if it had diverged, since you asked:** `major` — unauthenticated, deterministic,
one JSON key, no timing analysis, against a design whose own ADR states the oracle is closed.
It did not diverge, so there is nothing to file, and ADR-0061's claim stands as written.

## The three scoped findings

| # | Finding | Verdict |
|---|---|---|
| F-186 | Scan 2 pre-authorises wave-3 files under an equality | **ADDRESSED** |
| F-187 | `http://` permitted for any host | **ADDRESSED** |
| F-188 | ADR-0061's enumeration claim | **NOT ADDRESSED — disproved. I withdraw it.** |

**F-186.** The scan table now carries a per-scan direction: scan 2 subset, scans 1, 3 and 4
equalities, with the reasoning at ADR-0056:129-153 and the cost recorded at `:274` ("Scan 2 is a
subset, so it cannot see a removal"). The contract's invariant 11 carries the same table and the
same paragraph. All four are green against the tree as they now stand, verified file by file:
scan 1 `{client.ts}` today plus `auth.config.ts` from this card; scan 2 `{client.ts}` ⊆ three
permitted; scan 3 `{client.ts}`; scan 4 `{client.ts}` among non-spec files.

On your reading of `:87` — you are right, and a reader can tell. The paragraph argues from
`client.ts` and `auth.config.ts` **by name** and sits inside "### The shape", thirty lines above
the scan table, so it is visibly scoped to scan 1. What has drifted is the surrounding prose,
not the normative table: the ADR's title, its `:259` "the three extra equalities" and `:261`
"Four equalities read as more coverage than they are", and invariant 11's lead sentence "Four
equalities … bound who can reach the auth role", all still say equality where one is now a
subset. Nit R4-2.

**F-187.** The loopback rule is exactly the required change and is stated in the binding table
(`ADR-0059:75`), the decision (`:144-145`), the stub, and a refusal message (`:277-280`). It
reads no `NODE_ENV`; the discriminator is the host in the declared value, so GC-B holds. Both
residuals are volunteered rather than found.

**Is the refused-proxy case a real operational trap? No — it is acceptable, and I would not
soften the rule.** A reverse proxy terminating TLS and speaking `http` inward is a topology
where `BETTER_AUTH_URL` must be the public `https:` origin *anyway*, for three independent
reasons that have nothing to do with this rule: `iss` and `aud` have to be the origin clients
verify against, `trustedOrigins` has to contain the browser-facing origin, and the cookie's
`Secure` flag has to describe the browser hop. An operator setting it to `http://backend:3001`
in that topology has already broken all three. The rule refuses a value that was wrong before
the rule existed, and it refuses it at boot instead of at the first cross-origin login. The one
thing that makes it acceptable rather than merely correct is that the refusal message says what
to do — `ADR-0059:277-280` names the public `https:` origin explicitly and says "even when TLS
terminates at a proxy" — because without that sentence the operator reaches for
`useSecureCookies: false`, which is the fix that reopens everything. That sentence is doing real
work and should not be trimmed.

The string-versus-resolution residual is the right trade: a resolution test would make a boot
assertion depend on DNS, which is the "could not answer" class F-245 exists to keep out of
verdicts.

## Check 3 — the two stale sentences

Both fixed. `contracts/auth-config-surface.md:375` is struck through and marked
**"Closed 2026-08-16"**. `ADR-0060:113-119` strikes both follow-ups and marks them **"Applied by
Juano, 2026-08-16"**, and names the `:192` line specifically as the one the test architect
reads. Confirmed.

## Remaining findings

```yaml
findings:
  - id: R4-1
    task: TASK-003
    source: sdlc-security-auditor
    round: 4
    severity: minor
    kind: design
    file: .sdlc/identity-membership/design/adr-0056-better-auth-database-caller-list-is-asserted-in-wave-2.md
    line: 124
    summary: >-
      Two of the four scans match innocent text under the obvious regex, so the control is red on
      the day it lands unless both patterns are anchored — and a red control invites trimming
      `PERMITTED`, which is the failure mode this whole thread exists to prevent.
    failure_scenario: >-
      Scan 4 matches "the module specifiers `'pg'` and `'drizzle-orm/node-postgres'`". The
      contract mandates `drizzleAdapter(betterAuthDatabase(), { provider: 'pg', ... })` in
      `auth.config.ts` (`auth-config-surface.md:143`), so a scan written as `/'pg'/` matches
      `auth.config.ts` and fails an equality whose permitted set is `db/client.ts` alone. Scan 3
      matches "`process.env.DATABASE_AUTH_URL` **and its bracket forms**". Written as
      `/process\.env\[/`, it matches `apps/api/src/health/build-commit.ts:39`,
      `process.env[GIT_COMMIT_SHA_ENV]`, which has nothing to do with the auth role — verified
      against the tree, that file matches today. Scan 3 is the load-bearing equality of the four,
      so it is the worst one to have red for a spurious reason. Neither trap is written down
      anywhere, and the cheapest way to green either is to widen the permitted set.
    required_change: >-
      Anchor both patterns in the ADR and the contract, and name the two false positives beside
      them so the implementer meets them as expected cases rather than as failures: scan 4 must
      match only import, `require` and dynamic-`import` positions — `from 'pg'`,
      `require('pg')`, `import('pg')` and the same three for `'drizzle-orm/node-postgres'`,
      quote-agnostic — and scan 3's bracket form must be anchored to the variable name,
      `process.env['DATABASE_AUTH_URL']` and `process.env["DATABASE_AUTH_URL"]`, not to
      `process.env[` alone. The spec should carry both as explicit negative cases:
      `provider: 'pg'` does not match scan 4, and `process.env[SOME_OTHER_CONST]` does not match
      scan 3.

  - id: R4-2
    task: TASK-003
    source: sdlc-security-auditor
    round: 4
    severity: nit
    kind: design
    file: .sdlc/identity-membership/design/adr-0056-better-auth-database-caller-list-is-asserted-in-wave-2.md
    line: 4
    summary: >-
      Four places still say "four equalities" after one of the four became a subset.
    failure_scenario: >-
      The ADR title, `:259` ("the three extra equalities"), `:261` ("Four equalities read as more
      coverage than they are") and the contract's invariant-11 lead sentence ("Four equalities …
      bound who can reach the auth role") all predate the split. The normative table two lines
      below each of them carries the correct per-scan direction, so nothing executes from the
      stale wording and no control is weakened. It costs a reader one contradiction at the exact
      point they are deciding how strict the control is.
    required_change: >-
      Say "four scans, three equalities and one subset" in those four places. No decision changes.
```

## Notes

**Shared state.** I created `sec_audit_r4` in the running container, applied both migrations
under `SET ROLE shortkit_migrator`, ran the probe, and **dropped it** — the cluster now holds
`postgres`, `shortkit_test`, `template0`, `template1`, as found. `shortkit_test` still has its
six `user` rows and was never written to this round. The round-1 forged session row remains
absent. Compose stack up as found. All scratch scripts deleted from `/tmp`.

**One incidental confirmation worth a line.** `build-commit.ts:39`'s
`process.env[GIT_COMMIT_SHA_ENV]` is shipped, innocent code that demonstrates the evasion
ADR-0056 already names in its residual list — an env key that no literal-anchored scan can see.
It is not a new finding; it is evidence the stated residual is a real shape and not a
theoretical one, which is worth knowing when the next author weighs whether scan 3 is enough.

**Closing assessment of the three-round thread.** Of my thirteen findings across four rounds,
one was wrong and it is this one; the mechanism I asserted was adapter-independent was adapter-
dependent in the direction that mattered. The rest were reproduced by the architect and the two
that changed decisions — the `iss`/`aud` derivation and the loopback rule — both came from
composing the instance rather than reading it. Nothing in the current set is load-bearing: R4-1
is a regex the implementer would hit in the first hour, R4-2 is four words.
