---
id: ADR-0038
slug: foundation
title: Anything that is not GET or HEAD is a mutating method
status: accepted
supersedes: null
date: 2026-08-11
accepted_at: 2026-08-11
---

## Context

`isMutatingMethod` decides two things for the BFF proxy: whether a request must carry an
`Origin` equal to the deployment origin or be refused with 403, and whether that `Origin` is
forwarded to Fly. It is the CSRF control for every authenticated mutation the product makes,
and it is three lines in `apps/web/src/lib/api/client.ts`.

`web-api-client.md` answered the question twice and differently. `MUTATING_METHODS` named
four methods, `POST`, `PATCH`, `PUT` and `DELETE`, and `isMutatingMethod` consulted that list,
so `OPTIONS` was not mutating. The `Origin` section stated the rule as
`method !== 'GET' && method !== 'HEAD'`, so `OPTIONS` was. Both passages are in the same
document, TASK-008's implementer had to pick one to ship, and the test architect tested only
the six spellings both readings agree on and said so rather than picking a side (F-305).

The predicate also compared verbatim. Measured by the security auditor:
`isMutatingMethod('patch') === false`, `('post') === false`, `('PoSt') === false`. **The case
difference is reachable from a browser**, which is the part that is not obvious and was
measured against a real Fetch implementation: `new Request(u, { method: 'post' }).method`
normalises to `POST`, but `new Request(u, { method: 'patch' }).method` stays `patch`, because
PATCH is absent from the Fetch spec's normalise list. `PATCH` is one of the four methods
`ApiRequest.method` allows (F-311).

Two things constrain the answer.

**F-233 is the failure this surface already has a scar from.** `better-auth@1.6.26` answers
`403 {"code":"MISSING_OR_NULL_ORIGIN"}` to a state-changing request to `/api/auth/*` carrying
no `Origin`, and a server-side `fetch` from a Vercel route handler carries none. A method the
predicate does not recognise as mutating loses its `Origin`, and every signup, sign-in and
sign-out through the proxy returns 403 in production while every test that speaks to the API
directly passes.

**F-288 is why the export exists at all.** `web-api-client.md` names `client.ts` as its
normative form, so the proxy implementer reads the file and not the document. The file must
carry the rule, and the names `MUTATING_METHODS` and `isMutatingMethod` are already committed
to by the contract's implementer-guarantee section.

Nothing here is exploitable today. TASK-012's proxy route is deferred with EPIC-002 and does
not exist, `apiClient` has no callers, and a cross-origin lowercase `patch` carrying a JSON
content-type is not a simple request: it triggers a preflight the BFF route will not answer,
and the browser blocks it before the proxy sees anything. CORS is the control that actually
holds for the case the auditor measured. What is left is a security predicate that fails
**open** on unexpected input, in a file no non-deferred TASK can write after TASK-008 closes.
That is the same trap F-288 was about, and it is the reason to settle it now rather than when
a consumer exists.

## Alternatives

### 1. The four-item allowlist is the definition, and the `Origin` section is corrected to match

`isMutatingMethod` keeps reading `MUTATING_METHODS`, `OPTIONS` is not mutating, and the
`method !== 'GET' && method !== 'HEAD'` phrasing is deleted as the loser.

- **Pros.** The smallest edit. No new export, no change to the shipped behaviour, no test
  moves. An exhaustive list of four is easier to read and to reason about than a negation, and
  it says exactly which methods this design uses. It also matches the header rules on either
  side of it, which are allowlists for good reasons this repository has stated many times.
- **Cons.** It fails open, and it fails open silently. Every method added to the API later,
  every spelling the platform does not normalise, and every token that is not one of four
  literals defaults to non-mutating: no CSRF check, no `Origin`, and F-233's 403 in
  production. No test in `apps/web` can see that, because the symptom needs a real Better Auth
  mount. The list has to be right forever and nothing checks that it is.
- **Why it lost.** The two failure directions are not symmetric, and this alternative can only
  fail in the expensive one.

### 2. Keep the allowlist and require the caller to normalise

`isMutatingMethod` stays a membership test, and its docblock states that the proxy must
uppercase `request.method` before calling it and refuse anything outside the union.

- **Pros.** Also small. It keeps the predicate a pure lookup with no hidden behaviour, which
  is easier to reason about in isolation, and it puts the decision about malformed methods at
  the route handler, where a 405 is available and more informative than a 403.
- **Cons.** It is a rule enforced by nobody. The call site is in TASK-012, which is deferred,
  written later, by someone reading the file rather than this ADR. F-288 is the finding about
  exactly this: a docblock instruction that a future implementer in another TASK has to obey
  for the security property to hold, with no gate between them. The rework report already
  called the uppercase-normalisation argument an inference about TASK-012's call site, and it
  is one.
- **Why it lost.** It answers a fail-open predicate with a comment.

### 3. Refuse unknown methods at the route handler instead of classifying them

The proxy answers 405 to any method outside a closed set, so the predicate never sees an
unexpected input and its behaviour on one does not matter.

- **Pros.** The strongest control of the three, and partly free: a Next.js route handler
  already answers 405 to any method it does not export, so this is close to the default.
- **Cons.** It moves the question rather than answering it. The predicate still has to be
  right for the methods the handler does export, and lowercase `patch` is one of those, since
  Next.js dispatches on the normalised method while `request.method` keeps the wire spelling.
  It also puts the guarantee in a deferred TASK's route handler rather than in the file that
  TASK is told to read.
- **Why it lost.** It is a complementary control, not a substitute. It is worth doing in
  TASK-012 and it is noted below as follow-up, but it cannot be what this ADR decides.

## Decision

**A method is mutating unless it is `GET` or `HEAD`, compared after uppercasing.**

```ts
/** The only methods the proxy neither CSRF-checks nor forwards `Origin` on. */
export const NON_MUTATING_METHODS = ['GET', 'HEAD'] as const;

export function isMutatingMethod(method: string): boolean {
  return !(NON_MUTATING_METHODS as readonly string[]).includes(method.toUpperCase());
}
```

Four consequences of that, each specific enough to implement against:

1. **The predicate is the definition and the `Origin` block calls it.** The line in
   `web-api-client.md`'s `Origin` section becomes `if (isMutatingMethod(request.method))`. The
   rule is stated in one place and read from one place.
2. **`OPTIONS` is mutating.** So is `TRACE`, so is a method this design does not use, so is a
   garbage token. Each gets the CSRF check and is refused with 403 unless it carries the
   deployment origin.
3. **`isMutatingMethod` normalises its own input.** The proxy passes `request.method` straight
   in and is not asked to prepare it.
4. **`MUTATING_METHODS` keeps its name, keeps its value `['POST', 'PATCH', 'PUT', 'DELETE']`,
   and loses its authority.** It describes the mutating methods this design uses.
   `isMutatingMethod` does not read it. Adding a method to it changes no behaviour and
   omitting one changes no behaviour.

The normative rule and the exact code live in `web-api-client.md`, "Which methods are
mutating". This ADR holds the reasoning. They are not duplicated on purpose: the contract is
what an implementer reads under time pressure, and a rule restated in two documents is a rule
that can diverge in two documents, which is the defect this ADR exists to close.

## Consequences

**Positive.**

- The predicate fails closed. No spelling, no method added later, and no malformed token can
  skip the CSRF check by not being recognised. The F-233 direction, which is silent in
  production and invisible to every test in `apps/web`, is unreachable by construction rather
  than by keeping a list current.
- The document stops contradicting itself, and it stops by deleting one of the two statements
  rather than by adding a third that reconciles them.
- The case bug goes away as a side effect of the same three lines, which is why F-305 and
  F-311 were ruled together. Normalising inside the predicate means TASK-012 cannot get it
  wrong at the call site, and TASK-012 is not written yet.
- One test discriminates the two readings and it is one line: `isMutatingMethod('OPTIONS')`.
  Before this ADR, nothing in the spec could tell them apart.

**The cost accepted.**

- **The CSRF check now runs on methods nobody sends.** A request with a garbage method and no
  `Origin` gets a 403 from the proxy rather than whatever the API would have answered, so the
  response to a malformed method is decided at Vercel and the API never sees it. That is a
  loss of fidelity, and it is accepted because the alternative is deciding which unknown
  methods are safe.
- **`MUTATING_METHODS` becomes a constant that documents rather than controls.** This
  initiative rejected that shape before: ADR-0029's alternative 2 lost partly because a field
  carrying information nothing reads goes stale. The same criticism applies here and is not
  waved away. It is kept because F-288 named it as an export the proxy implementer reads, and
  because a constant that controls nothing costs nothing at runtime when it drifts. Deleting
  it is available later and costs a spec change, a stub change and a source change.
- **A denylist is harder to read than an allowlist**, and it reads as the loose option to
  someone skimming, which is the opposite of what it is. The docblock has to carry the
  argument, so the file grows.
- **`method.toUpperCase()` runs on every proxied request.** Not measurable, listed because the
  honest cost of a runtime check is the code and not the time.
- **`isMutatingMethod('PUT')` and `MUTATING_METHODS` now agree by coincidence rather than by
  construction.** Anyone verifying the predicate against the list will find them consistent
  today and must not conclude the list is load-bearing.

**Follow-up work this creates.**

- **TASK-012 decides which methods its route handler exports**, and alternative 3 stays worth
  doing there: a 405 for a method the proxy does not serve is more informative than a 403 and
  it is close to free, because Next.js answers 405 to an unexported method already. That
  decision is the route handler's and is not made here.
- **The test architect adds the assertions that discriminate this ruling**:
  `isMutatingMethod('OPTIONS') === true`, `('patch') === true`, `('PoSt') === true`,
  `('') === true`, `('get') === false`, `('head') === false`, and `NON_MUTATING_METHODS`
  exported as `['GET', 'HEAD']`. The six existing assertions in
  `F-288: isMutatingMethod is true for a mutating method and false for GET and HEAD` all still
  hold and do not move.
- **The `MUTATING_METHODS` export earns a decision the day something reads it.** If TASK-012
  reaches for it instead of the predicate, that is the drift this ADR paid for, and deleting
  the constant is the answer.
- **No gate compares `client.ts` to its design stub**, verified 2026-08-10 and again
  2026-08-11. This ADR adds an export to both, so it adds surface to that gap. ADR-0029's
  follow-up section already names the missing gate and the TASK that would own it does not
  exist.
