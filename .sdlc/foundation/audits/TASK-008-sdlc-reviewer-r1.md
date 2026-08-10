# TASK-008 — code review, round 1 (first audit)

- Reviewer: `sdlc-reviewer` | 2026-08-10 | HEAD `ecc9275`
- Package: `work/TASK-008-review-audit.diff` (empty tree → HEAD, 2 files, 472 lines)
- Normative: `web-api-client.md`, `error-envelope.md`, `auth-tokens.md`, `adr-0014`, `adr-0013`,
  `design/stubs/apps/web/src/lib/api/client.ts`

> TRANSCRIPTION NOTE (orchestrator). The reviewer had no write tool and my dispatch also
> forbade writing inside the repo, so it returned the report inline. Second time today the
> same defective constraint blocked an auditor's own report. Mine, not theirs.

## verdict: changes-requested — 1 blocker, 5 major, 5 minor, 3 nit

**The thing the TASK exists to get right is right.** The contract-violation / API-error split is
structural exactly as claimed: `ContractViolationError` is constructed at `:210` and `:216`, both
AFTER `if (!response.ok) throw toApiError(...)` at `:196-198`, so it is unreachable from any
non-2xx; `toApiError` (`:129-146`) returns `ApiError` on both arms and has no other exit. It
survives an adversarial read.

**What blocks `done`** is that this commit is the LAST NON-DEFERRED WRITER of
`apps/web/src/lib/api/**` and `apps/web/src/components/errors/**` — verified: only `TASK-008.md`
and `TASK-052.md` list those paths, and TASK-052 is `status: deferred`. It closes with a
normative block silently dropped, three ADR-assigned functions still throwing, and
`<ErrorMessage />` unbuilt. Marking it `done` makes all of that ownerless.

### BLOCKER — the F-233 `Origin`-on-mutating-methods block is absent from the shipped file
`apps/web/src/lib/api/client.ts:277`

`design/stubs/apps/web/src/lib/api/client.ts:135-167` declares
`FORWARDED_REQUEST_HEADERS_MUTATING_ONLY = ['origin']`, `MUTATING_METHODS` and
`isMutatingMethod()`, under a docblock titled "F-233. `Origin` on mutating requests, and why
dropping it breaks all of auth". A full stub-vs-shipped diff shows **this is the only structural
divergence** — every other line is present.

The shipped file therefore offers exactly one header allowlist,
`FORWARDED_REQUEST_HEADERS = ['content-type','accept','x-request-id']`, under a docblock that
enumerates what is deliberately absent (cookie, set-cookie, x-shortkit-*) and never mentions
`origin`. TASK-012's proxy implementer builds `upstreamHeaders` by iterating that exported
allowlist — the file being the normative form is the reason to read it — and ships. **Every
signup, sign-in and sign-out through `/api/bff/auth/*` then answers
`403 {"code":"MISSING_OR_NULL_ORIGIN"}` in production** (`auth-tokens.md:192`) while every test
that speaks to the API directly passes.

That is verbatim the failure F-233 documents, and `web-api-client.md:246-248` warns it is "one an
implementer can drop while every other proxy test still passes". No gate catches it: the drift
gate is AC-14 contract-mutation-vs-typecheck, not stub-vs-source.

### MAJOR — Better Auth error mapping unimplemented, and the stated reason is false
`client.ts:237`. `mapBetterAuthError` is a throwing stub `apiClient` never calls.

A user submits a wrong password. Better Auth answers
`401 {"message":"Invalid email or password","code":"INVALID_EMAIL_OR_PASSWORD"}`
(`auth-tokens.md:191`), which is not an `ErrorEnvelope`, so `toApiError` falls to `:141` and the
login screen receives `ApiError{code:'internal_error', status:401}`. **The screen shows an
internal-error message for a wrong password**, and AC-20's behaviour is unreachable. Same for
duplicate signup (422 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, which the contract explicitly
warns "a caller branching on status alone will miss").

The implementer's reason — "Better Auth's documented shapes are not specified in any contract I
can read" — is **incorrect**: `auth-tokens.md:180-193` is a table of eight probed shapes,
introduced with "Recorded 2026-08-08 so TASK-008's mapping and TASK-012's screens have exact
shapes rather than inferred ones". The mapping is assigned to TASK-008 by name in
`web-api-client.md:65-68`, `error-envelope.md` invariant 1, `auth-tokens.md:55` and `adr-0014:220`.

Open design question either way: 422 has no row in `ERROR_CODE_STATUS`.

### MAJOR — `<ErrorMessage />` does not exist
`apps/web/src/components/errors/` is absent. It is in the card's `Produces` and `paths`, and both
TASK-012 and TASK-052 list it under **Consumes**. `error-envelope.md` §Versioning states its
behaviour normatively (generic fallback for an unknown `code`). TASK-012 resumes, imports it, and
the module does not exist — a build failure at the first consumer with no owner able to fix it.

*The reviewer agrees the implementer was right not to write untested production code.*

### MAJOR — `serverApiClient` throws, and two documents disagree on its owner
`client.ts:229`. `adr-0014:220` assigns it to TASK-008 by name. TASK-008's card excludes it
("Out of scope: Authentication token handling (TASK-012)"), and TASK-012's `paths` are
`apps/web/app/(auth)/**` and `apps/web/src/lib/session/**` — which do **not** include this file,
so TASK-012 cannot implement it. Under ADR-0014 every dashboard route is a server component; the
first to call it throws at render. Compounding: F-157 routes `experimental_taintUniqueValue` on
the `sk_at` read site to TASK-012, and that read site is inside this function, inside a file
TASK-012 may not touch. Same question covers `buildUpstreamUrl` (`:261`).

### MAJOR — a caller-initiated abort is classified as a transport failure
`client.ts:182`. `signal?: AbortSignal` is in the frozen `ApiRequest`, so cancellation is an
anticipated path. On abort, `fetch` rejects with `AbortError`, the catch-all swallows the
distinction, and the caller gets `NetworkError`. A search screen aborting on each keystroke
renders a network-failure state for a cancellation it initiated, and any retry wrapper keyed on
`NetworkError` re-issues a request the caller deliberately cancelled. The original survives on
`.cause` — which is exactly the "distinguishable without inspecting internals" property AC-15
exists to establish for the other three cases.

### MAJOR — the frozen spec never inspects what was handed to `fetch`
`client.spec.ts:104`. `networkAnswers` installs a `fetch` mock that ignores its arguments, and no
test asserts on the spy's calls. **Three mutations keep all six tests green:** change
`BFF_PATH_PREFIX` from `/api/bff` to `/api`, so every request bypasses the proxy and arrives with
no `Authorization`; delete the `req.body === undefined` branch so every POST/PATCH body is
dropped; drop `signal` so nothing is cancellable.

Separately, both `ApiError` tests assert only `toBeInstanceOf`, so collapsing `toApiError` to a
single `internal_error` arm for every non-2xx also stays green — meaning normative step 2, the
half every screen branches on (`slug_taken` to a field error, `email_not_verified` to a prompt),
is verified by nothing.

### MINOR
- **A body-less 2xx raises `ContractViolationError`** (`:202`). Verified: `Response(null,{status:204})`
  has `ok === true`, `text() === ''`, and `JSON.parse('')` throws. A `void` Nest handler for
  `DELETE /api/links/:id` succeeds server-side and the client reports a contract violation for a
  completed deletion, possibly inviting a retry of an applied mutation.
- **The transport `try` wraps `requestUrl` and `requestInit`** (`:180`), so a `JSON.stringify`
  failure on a circular body is reported as `NetworkError` — and a retry layer keyed on that
  retries forever something that can never succeed.
- **`NetworkError` never sets `this.name`** (`:65`), so it reports `name === 'Error'` while
  `instanceof NetworkError` is true. Every other error class in the repo sets it.
- **The 2xx `SyntaxError` is swallowed with no `cause`** (`:204`); `issues: []` is an undocumented
  discriminator between two very different failures.
- **No guard against calling the browser client server-side** (`:177`): Node's `fetch` rejects a
  relative URL, which surfaces as `NetworkError` rather than naming the cause.

### NIT
- `ApiError`'s constructor parameter is named `_init` although it is used; the underscore prefix is
  this file's marker for a deliberately unused parameter (`:36`).
- `UNEXPECTED_RESPONSE_MESSAGE` duplicates the API's `INTERNAL_ERROR_MESSAGE` with no drift gate (`:84`).
- `requestInit` never sends `accept: application/json` (`:107`), though the proxy allowlists it.

## Could not verify
- Ownership of `serverApiClient` / `buildUpstreamUrl` / `mapBetterAuthError` — a cross-TASK question
  only the orchestrator can resolve. **No card's `paths` cover `apps/web/app/api/bff/**` at all.**
- Whether any `/api` route returns a body-less 2xx — no route exists, no contract states DELETE shapes.
- Real browser behaviour — jsdom with `fetch` stubbed, no BFF route in the tree.
- Gate results — relied on the orchestrator's run rather than re-running. **None of the findings
  contradict a green suite; that is the point of the spec finding.**

## Notes
- Considered `blocker` for the Better Auth mapping and settled on `major`: the `Origin` block's fix
  is mechanical and its omission invisible to every gate, whereas the mapping needs a design ruling
  (the 422 code) the orchestrator may bundle with TASK-012's un-deferral. **Both must be answered
  before `done`.**
- The 429 seam is narrower than its docblock implies: `toApiError(status, raw)` takes the status and
  body text, not the `Response`, and `Retry-After` is a header — so TASK-052 cannot implement
  invariant 3 without changing that signature.
- Redirects are inert *today* because `RETURNED_RESPONSE_HEADERS` omits `location`; the risk
  materialises only if TASK-012 adds it. A note for the proxy TASK's review, not a defect here.
- Stale elsewhere, not this TASK's: `.github/scripts/assert-contract-drift.mjs:17-18` says
  "`apps/web`'s only `@shortkit/contracts` import anywhere is `ERROR_CODE_STATUS`"; `client.ts:9,11`
  now also imports `isErrorEnvelope` and `ErrorCode`. The check functions; its docblock is inaccurate.
- **Test-file quality, positive:** the two premise guards (`spec:70-93`) fail loudly if a future edit
  makes a fixture valid, so the violation assertions cannot silently start asserting nothing.
- The implementer's report is unusually honest; three of its four "could not verify" entries match
  what the reviewer found independently. Neither inaccuracy reads as concealment.
