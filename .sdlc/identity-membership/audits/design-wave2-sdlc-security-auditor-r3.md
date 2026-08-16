# Design-mode security audit — identity-membership wave 2 (TASK-003), round 3 (final scoped re-review)

verdict: changes-requested — all four round-2 findings ADDRESSED; three major and one minor
new, two of them created by this revision and one by a ruling that closes less than it claims.

Scope: the four round-2 findings, the two rulings, and breakage introduced. Nothing cleared in
r1 or r2 is re-opened; I checked that no revision disturbs it and none does. Claims marked
**executed** were run against the pinned `better-auth@1.6.26`; the four scans were run against
the real tree. No database work was needed this round, the round-1 forged row remains absent,
the compose stack is up as found, scratch scripts deleted.

## Round-2 findings

| # | Round-2 finding | Verdict |
|---|---|---|
| R2-1 | `DATABASE_AUTH_URL` equality collides with TASK-004's `AUTH_VERDICT_PREFIX` | **ADDRESSED** — the collision is gone and the naming/connecting split is sound. It introduces a new break in the opposite direction: **R3-1**. |
| R2-2 | Origins predicate admits `https://*.vercel.app`; `?` unhandled | **ADDRESSED** — verified below, refusals warranted, passes not over-matching, residual real and correctly placed. |
| R2-3 | pg scan defeated by `drizzle(dsn)`; demote it | **ADDRESSED** — demotion is honest and nothing still describes scan 4 as coverage. |
| R2-4 | `'error'` still stated in the card and ADR-0052 | **ADDRESSED** — including the follow-up you asked me to check. |

**R2-1, what I verified.** The four permitted sets against the real tree: scan 1
(`betterAuthDatabase`) → `db/client.ts` today plus `auth.config.ts` from this card; scan 3
(`process.env.DATABASE_AUTH_URL`) → `db/client.ts` only; scan 4 (`'pg'`,
`'drizzle-orm/node-postgres'`) → `db/client.ts` only among non-spec files (the two
`await import('pg')` hits are in `.spec.ts` files, which the idiom excludes). The split does
what it claims: a `main.ts` holding `AUTH_VERDICT_PREFIX = 'DATABASE_AUTH_URL connect'` passes
scan 2 by permission and passes scan 3 because it never names `process.env`, while the same
file holding a connection fails scan 3. Naming and connecting are genuinely separated, and the
wave-3 shape matches what TASK-004:150-152 and ADR-0050:271-272 actually require.

**R2-2, what I executed.** Every entry rule 1 or rule 2 refuses is warranted — `*`,
`https://*`, `https://*.vercel.app`, `https://?.example.com`, `https://shortkit-*.app` and
`https://app.example.co?` each match an origin the operator does not own. The documented
preview form is not over-broad: `https://shortkit-*.vercel.app` matches
`https://shortkit-git-x.vercel.app` and does **not** match `https://evil.vercel.app` or
`https://shortkit-x.vercel.app.evil.test`. The volunteered residual is real: `https://ex*.co.uk`
passes both rules and trusts `https://exfiltrate-evil.co.uk`, a host anyone can register. It is
stated in the stub, in ADR-0059 twice and in the contract at `:110-111` — the right three
places. See R3-4, which exists so you can park it in writing.

**R2-4, the one you asked about.** ADR-0052 carries `amended_by: ADR-0060` in front matter, a
banner at `:12-13`, `level: 'warn'` in the code block at `:87` with the struck note, and the
strikes at `:118-119` and `:155`. **The follow-up at `:192` now reads `level === 'warn'`** —
that is the line that instructs the spec's assertion and the one that would have carried the
old value into the test. `TASK-003.md` has no remaining `level: 'error'` and now names
`baseURL`, `trustedOrigins`, `useSecureCookies` and `autoSignIn`. Nothing left at `'error'`.

## The two rulings

**Ruling 1, `autoSignIn: false` — one half verified, one half not.** Executed on a composed
instance with `emailAndPassword: { enabled: true, autoSignIn: false }`:

- **ADR-0054's residue drop is real.** A successful sign-up returns **no `Set-Cookie`** and
  creates **zero session rows**. The provisioning-failure 500 likewise carries no `Set-Cookie`,
  and the surviving rows are `user=1 account=1 session=0`. The 30-day-credential-on-a-500 half
  of my round-1 finding 6 is now closed at the source rather than described.
- **The enumeration oracle is not closed. It moved.** A duplicate address now answers 200
  instead of 422, so the status-code oracle is gone — and the response body still tells the
  attacker. See R3-3.
- **The `emailAndPassword.enabled` catch is correct.** Executed: omitting it answers
  `400 EMAIL_PASSWORD_SIGN_UP_DISABLED`. Adding the key was necessary.

**Ruling 2, compose defaults — the "not a credential" argument is sound and is not the argument
that matters.** Publishing `http://localhost:3001` really does disclose nothing, and
`BETTER_AUTH_SECRET` really does stay the only variable in that file with no default. But the
property `BETTER_AUTH_URL` carries is not confidentiality, it is that its **scheme silently
decides whether the session cookie is `Secure`**, and the predicate accepts `http://` for any
host at all. See R3-2. ADR-0059's own line 78 — "a default would be a default for both" — is
still in the file and is the sentence the ruling reverses.

## New findings

```yaml
findings:
  - id: R3-1
    task: TASK-003
    source: sdlc-security-auditor
    round: 3
    severity: major
    kind: design
    file: .sdlc/identity-membership/design/adr-0056-better-auth-database-caller-list-is-asserted-in-wave-2.md
    line: 118
    summary: >-
      Scan 2 pre-authorises two files that will not contain the string until wave 3, under an
      assertion the ADR defines as equality, so the spec is red the day TASK-003 lands.
    failure_scenario: >-
      Scan 2's permitted set is `db/client.ts`, `main.ts`, `auth/boot-assertions.ts`. Verified
      against the tree: `DATABASE_AUTH_URL` occurs in `apps/api/src/db/client.ts` and nowhere
      else, and it will still occur nowhere else after TASK-003 — `main.ts` gains only the
      assertion calls and the `instanceof` branch, and the wave-2 `boot-assertions.ts` stub
      contains the string zero times (grepped). `AUTH_VERDICT_PREFIX` arrives in wave 3 with
      TASK-004. So `toEqual(PERMITTED)` compares `['apps/api/src/db/client.ts']` against three
      entries and fails on landing. ADR-0056 states all four scans as equalities (`:118`, `:67`,
      and the contract's invariant 11 at `:244`), and its own `:87-89` describes exactly this
      failure — "the precedent asserts subset only because `CONTEXT_FLAG_OWNERS` names two files
      that deferred TASKs create, so equality would be red on the day it lands" — and then
      asserts the constraint does not apply here. It applies to scan 2 precisely. This is a
      security finding rather than a correctness one because of what a red gate on a control
      costs: the cheapest green is to trim `PERMITTED` to what the tree contains, which deletes
      the wave-3 pre-authorisation this revision was written to add, and the collision returns.
    required_change: >-
      Make scan 2 a subset assertion — every file containing the identifier is in the permitted
      set — and say in the ADR that scan 2 is the one direction that cannot be an equality,
      because its permitted set is deliberately ahead of the tree. Scans 1, 3 and 4 stay
      equalities; all three are green against the tree today. Alternatively keep equality and
      let TASK-004 add the two files to `PERMITTED` in the same commit that adds the prefix, but
      then say so in TASK-004's card, because nothing else will carry it.

  - id: R3-2
    task: TASK-003
    source: sdlc-security-auditor
    round: 3
    severity: major
    kind: design
    file: .sdlc/identity-membership/design/stubs/apps/api/src/auth/boot-assertions.ts
    line: 84
    summary: >-
      `betterAuthUrl` accepts `http://` for any host, so the binding that exists to stop a
      non-Secure session cookie permits one, and the compose default normalises the scheme that
      produces it.
    failure_scenario: >-
      The predicate refuses unset, empty, unparseable, a scheme other than `http:`/`https:`, and
      a path, query or fragment. It has no rule about the host. EXECUTED on the composed
      instance: `BETTER_AUTH_URL=http://api.example.com` yields
      `better-auth.session_token`, `secure: false`, no `__Secure-` prefix — identical to the
      round-1 finding this ADR was written to close — while `https://api.example.com` yields
      `__Secure-better-auth.session_token`, `secure: true`. Every assertion passes in both
      cases, because a value is set. The compose default `${BETTER_AUTH_URL:-http://localhost:3001}`
      is correct for the local stack and is also the thing that teaches the value's shape: the
      operator who copies it to a real host keeps the scheme, and the session credential travels
      in the clear with the boot assertion green, the unit test green and the `compose` job
      green. `useSecureCookies` is derived from this one string, so nothing else can catch it.
      ADR-0059 already reasons this way at `:78` — "a default would be a default for both" — and
      the ruling at `:194-211` reverses it on a confidentiality argument that does not reach the
      scheme.
    required_change: >-
      Add one rule to the predicate, in both the accessor and the assertion: `http:` is
      permitted only when the host is a loopback literal — `localhost`, a `127.0.0.0/8`
      address, or `[::1]` — and `https:` is permitted for any host. It reads no `NODE_ENV`, so
      GC-B holds; it leaves the compose default and every local flow working unchanged; and it
      turns `http://api.example.com` into a boot refusal naming the rule. State it in the
      binding table and have `boot-assertions.spec.ts` cover the loopback-http accept and the
      non-loopback-http refusal.

  - id: R3-3
    task: TASK-003
    source: sdlc-security-auditor
    round: 3
    severity: major
    kind: design
    file: .sdlc/identity-membership/design/adr-0061-signup-is-an-enumeration-oracle.md
    line: 44
    summary: >-
      `autoSignIn: false` closes the status-code oracle and leaves a response-shape one, so the
      decision that supersedes the acceptance does not deliver what it claims.
    failure_scenario: >-
      EXECUTED with `emailAndPassword: { enabled: true, autoSignIn: false }`. A duplicate
      address now answers 200 rather than 422 — that half works. But the two 200s are not the
      same shape. For an address that already has an account the `user` object's keys are
      `["name","email","emailVerified","image","createdAt","updatedAt","id"]`; for a fresh
      address they are `["name","email","emailVerified","createdAt","updatedAt","id"]`. The
      `image` key is present if and only if the address exists, deterministically, on every
      request, with no timing analysis. An unauthenticated attacker walks an address list
      against `POST /api/auth/sign-up/email` and reads one JSON key. The generic branch does not
      leak the victim's own data — `name` is the attacker's own value and `id` is a fresh id,
      both checked — so the disclosure is existence only, which is the same disclosure the 422
      made and the one ADR-0061 now says is closed. Measured on the in-memory adapter; the
      mechanism is adapter-independent, because one branch serialises a row read back from the
      store and the other serialises the object it just built, and `user.image` is a nullable
      column in migration `0001` so a stored row always has the key.
    required_change: >-
      Do not re-open the ruling; keep `autoSignIn: false`, which earns its place on the residue
      alone. Correct ADR-0061's claim to what it actually buys — the status code, not the
      oracle — and either close the shape gap or accept it explicitly in the same sentence. The
      test that decides it belongs in the integration tier against the real adapter:
      `signup-creates-tenant.int-spec.ts` should assert that a duplicate-address response and a
      fresh-address response are **byte-identical after normalising `id`, `createdAt` and
      `updatedAt`**, which is the assertion that would have caught this and is the only one that
      stays true if the library changes either branch.

  - id: R3-4
    task: TASK-003
    source: sdlc-security-auditor
    round: 3
    severity: minor
    kind: design
    file: .sdlc/identity-membership/design/contracts/auth-config-surface.md
    line: 110
    summary: >-
      The volunteered public-suffix residual is real and measured; filed so it can be parked
      with a written reason rather than inherited silently.
    failure_scenario: >-
      EXECUTED: `https://ex*.co.uk` passes both wildcard rules and
      `matchesOriginPattern('https://exfiltrate-evil.co.uk', 'https://ex*.co.uk')` is `true`, so
      an entry that looks like a narrow prefix wildcard over one company's domain trusts any
      registrable domain under `.co.uk` that starts with `ex`. Reaching it needs an operator to
      write such an entry, which needs a multi-label public suffix, which this repository does
      not use — the documented deployment is `vercel.app`. The self-report is accurate and is in
      all three artifacts. It becomes real the day a `.co.uk`, `.com.au` or `.github.io` origin
      is added to `WEB_APP_ORIGINS`, and the cost of that day is a trusted origin an attacker
      can register.
    required_change: >-
      Parking this with a written reason is a legitimate outcome and my recommendation. If it is
      narrowed instead, the cheap form is not a public-suffix list: require every entry
      containing a metacharacter to be matched against a short literal allowlist of documented
      forms in the contract, so a new wildcard shape is an ADR rather than an env edit. Whichever
      you choose, record it as a decision rather than leaving the residual as an observation.
```

## Notes

**Two stale sentences the revision left behind, both harmless and both worth one edit.**
`contracts/auth-config-surface.md:343` still lists as an open conflict that "`ADR-0052` and
`TASK-003.md` still state `logger.level: 'error'`", and `ADR-0060:113-117` still lists the same
two as pending follow-ups. Both were applied; a reader of either list is told two artifacts
disagree when they no longer do. No security consequence, so no finding.

**What this revision got right that I would not want lost in a list of four new findings.**
The naming-versus-connecting split in ADR-0056 is a better answer than the one I asked for — I
proposed permitting the literal or scanning the use, and it did both and stated which one
carries the weight. The origins predicate is now correct against the frozen contract, tested by
name rather than by shape, and honest about the case it cannot decide. The `autoSignIn: false`
ruling removes a live 7-day credential from a 500 response, which is a real reduction in blast
radius that no amount of documentation would have bought. And `emailAndPassword.enabled` was
found by the architect, not by me; it is the kind of key whose absence answers 400 in the
integration tier and would have been read as a test-fixture problem.

**The one thing I would put in front of Juano first.** R3-2 and ruling 2 are the same question:
whether a value that ships in a compose file may decide a security property. The loopback rule
is small, costs the local stack nothing, and is the difference between "the default is safe
where it is" and "the default is safe wherever it goes". Of the four, it is the one whose
absence is invisible until a deployment exists, which is exactly the class this initiative has
already paid for twice.
