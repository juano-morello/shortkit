---
id: ADR-0022
slug: foundation
title: Redaction by allowlist, CORS off, helmet on
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

Twenty-one ADRs and nineteen contracts said nothing about pino's configuration, CORS, or
security headers. GC-9 requires structured logs with no PII in log bodies, and until now
nothing enforced it.

The gap has a predictable shape. The first implementer who wants to debug a request logs
the request object, which carries `Authorization` and `Cookie`, and nothing in the frozen
artifacts contradicts them. NestJS defaults CORS to off, which happens to be right for
the BFF topology in ADR-0014, but it is a default nobody wrote down, so the first
frontend TASK that meets a cross-origin error fixes it with
`app.enableCors({ origin: true, credentials: true })` and gets that past review because
no artifact says otherwise.

This costs nothing now and three TASK reworks later.

## Decision

**Redaction is an allowlist of paths, applied at the logger, not at each call site.**

> **Amended 2026-08-08 (F-250).** This block used to fence the pino configuration itself: a
> 17-path `redact` list, no serialisers, no hook, no formatters. That copy went stale the day
> F-244 added the `err` serialiser, and a TASK re-deriving the logger from it would have
> reintroduced a credential leak with every gate green. The literal is **removed rather than
> synced**. Three copies of one configuration in three artifacts is what produced F-244,
> F-248, F-249 and F-250 in sequence, so the remedy deletes the third copy instead of adding
> a fourth thing to keep in step.
>
> **`docs/contracts/logging-and-headers.md` § "Logger" is the single normative source for
> the logger's configuration, and it wins any disagreement with this ADR.** It carries the
> redact list, the `err` serialiser, the `logMethod` hook, the error-replacing `log`
> formatter and the two bindings wrappers, each with its reasoning, and a drift test compares
> its fenced block against `apps/api/src/observability/logger.ts`.
>
> What this ADR still decides is below and is unchanged: redaction is an allowlist of paths
> applied at the logger, the list is append-only, and which classes of value are on it.
>
> **Amended 2026-08-09 (F-272). Wave claims in this ADR's body are superseded by the TASK
> cards.** The paragraph below said TASK-003 ships the `x-shortkit-*` entries "in wave 1,
> before TASK-009"; `TASK-003.md:55` corrected that on 2026-08-06 (TASK-003 and TASK-009 are
> both in wave 2 and run concurrently), and the sentence is corrected in place below. The
> general rule is the point: this ADR records decisions, and when it names a wave, the TASK
> card wins.
>
> **Superseded 2026-08-09 by ADR-0028, in the redaction clause only.** CORS, the header
> table and the HSTS decision stand unchanged. What ADR-0028 replaces is the mechanism:
> "redaction is an allowlist of paths" means an allowlist of paths *to censor*, which is a
> denylist of key names, and it failed three audit rounds by covering only the spellings
> someone thought of. Under ADR-0028 a field reaches a log line only if its key is named.
> The alternative this ADR rejected as "an explicit whitelist of loggable fields" is the one
> ADR-0028 adopts, and it answers the rejection's reason rather than ignoring it.

`*.ip` and the two IP headers are redacted because GC-9 says click events store
`ip_hash` and never a raw IP, and a log line carrying the raw IP defeats that. `ipHash`
is redacted too: it is pseudonymous per tenant (ADR-0010, F-009) and a log aggregator is
a weaker boundary than the database.

The two `x-shortkit-*` entries were added 2026-08-04 (F-032). `x-shortkit-client-ip` is
a raw client IP on every browser-originated request, and `x-shortkit-proxy-auth`
carries `BFF_PROXY_SECRET` verbatim; the `'*.secret'` wildcard matches a property one
level deep and does not reach a header key. TASK-003 ships both entries with the rest of
the list. TASK-003 and TASK-009 are both in wave 2 and run concurrently (`TASK-003.md`,
corrected 2026-08-06), so the entries land before or beside the headers themselves;
redacting a not-yet-sent header is free, and a later append would have no owner.

**Every log line carries `request_id`, and nothing carries a body by default.** The
request logger emits method, path, status and duration. Logging a request or response
body needs an explicit, reviewed call.

**CORS stays off on the API.** No `enableCors` anywhere. The browser never calls the API
cross-origin: ADR-0014 routes every browser request through the Next.js BFF on the same
origin as the page. The redirect path is reached by navigation, not by `fetch`, so it
needs no CORS either. A future MCP server or public API gets its own decision and its
own ADR; it does not inherit a permissive default set here.

**`helmet` with its defaults, plus HSTS, on the API.**

| Header | Value | Applied to |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | every response |
| `X-Content-Type-Options` | `nosniff` | every response |
| `X-Frame-Options` | `DENY` | every response |
| `Referrer-Policy` | `no-referrer` | every response **except** the redirect 302 |
| `Content-Security-Policy` | helmet default, **with `frame-ancestors 'none'`** (amended 2026-08-10, F-280) | API responses |

> **Amended 2026-08-10 (F-280): the CSP overrides `frame-ancestors`, and the two framing
> headers now agree.**
>
> helmet 8.3.0's default directives include `frame-ancestors 'self'`
> (`helmet/index.cjs:19`). CSP Level 2 requires a user agent that supports `frame-ancestors`
> to ignore `X-Frame-Options` entirely, so the one option this ADR deliberately overrode was
> the one every browser discarded. Measured on `node dist/main.js`: `GET /health` and the
> branded 404 both answer with `X-Frame-Options: DENY` and a CSP carrying
> `frame-ancestors 'self'`, and what a browser enforces is `'self'`.
>
> **Decision. `main.ts` passes one more override to helmet:**
>
> ```ts
> app.use(
>   helmet({
>     frameguard: { action: 'deny' },
>     contentSecurityPolicy: { useDefaults: true, directives: { 'frame-ancestors': ["'none'"] } },
>   }),
> );
> ```
>
> `useDefaults` is helmet's own default and is written out because this call now names two
> policies and the reader has to see that the other ten directives are untouched. Measured by
> `sdlc-test-architect` as a throwaway candidate: `security-headers.int-spec.ts` 8/8 green,
> including the pre-existing `X-Frame-Options: DENY` row.
>
> **The alternative was documentation: declare CSP the governing mechanism, `X-Frame-Options`
> the legacy fallback, and leave `'self'`.** It is cheaper and it is honest about what the
> browser does. It lost on three counts. The header table above says `DENY` and has said so
> since 2026-08-04, so the doc route means weakening a stated security property to match an
> accident of helmet's defaults rather than a decision anyone made. Same-origin framing of a
> JSON API is close to harmless today and stops being harmless the moment the branded 404
> renders tenant-controlled markup on the same origin (F-006), which is a route this product
> is committed to building. And a header the deployed bytes carry and the browser discards is
> the worst of the three states available.
>
> **Cost accepted.** helmet's defaults are now overridden in two places rather than one, so
> "helmet with its defaults" is no longer literally true and a helmet upgrade that changes
> `frame-ancestors` needs reading against this row. The alternative kept the call shorter and
> the policy weaker.
>
> **Consequence for the branded 404, which belongs to `redirect-resolution.md` and is not
> changed here.** That page sets its own tighter CSP, `default-src 'none'; img-src https:;
> style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`. **`frame-ancestors` does
> not fall back to `default-src`**, so a policy without it leaves framing to whatever else is
> on the response. The TASK that builds that page adds `frame-ancestors 'none'` to its
> directive list explicitly. Flagged here, owned there.

Two deliberate exceptions on the redirect path, both already in
`redirect-resolution.md`: `Referrer-Policy: unsafe-url` on the 302, because passing the
short URL to the destination is the point of an attribution referrer and the link is
public; and a tighter hand-written CSP on the branded 404 that allows no script at all
(F-006).

`preload` is **not** set on HSTS. Submitting to the preload list is close to
irreversible and the apex domain is not registered yet.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Redact by denylist: log everything, strip known-bad keys at each call site | No central configuration; each site knows its own data | A new field carrying a token is logged until someone notices. The failure is silent and the artifact is a log aggregator nobody audits | Puts the burden on every future call site instead of on one configuration |
| Structured logging with an explicit whitelist of loggable fields | Strongest guarantee: nothing is logged unless named | Every log call becomes a schema change, which people route around by stringifying an object into the message field, defeating it entirely | The stricter mechanism produces worse behaviour in practice |
| Enable CORS for the Vercel origin with credentials | Lets the browser call the API directly, saving the BFF hop | ADR-0014 chose the BFF specifically because the two deployables sit on different registrable domains and the apex is unresolved, and because a token in a cross-site cookie is the thing TASK-012 forbids. Enabling CORS would create a second, weaker path to the same API | Contradicts ADR-0014, and a second path is the one that gets used |
| Skip helmet, set the three headers we care about by hand | Fewer dependencies; nothing hidden | Three headers today, and the fourth arrives after an audit finds it missing | helmet is small, maintained, and its defaults are the reviewed set |

## Consequences

### Positive

- An implementer logging a whole request object gets `[redacted]` where the credential
  would have been, without knowing this ADR exists.
- CORS being off is now a decision with a reason, so a future TASK meeting a
  cross-origin error escalates instead of enabling it.
- GC-9 has an enforcing artifact rather than a constraint nobody implements.

### Negative / accepted cost

- Redaction by path means a token nested somewhere the wildcards do not reach is logged.
  `*.token` matches one level; a token inside
  `payload.data.credentials.token` is not covered, and nothing detects that.
- Redacting `*.ip` and `x-forwarded-for` removes the field most useful for diagnosing an
  abusive client. Investigating a scan means correlating on `request_id` and hostname
  rather than on the source address, which is slower and sometimes not possible.
- `X-Frame-Options: DENY` applies to the branded 404 too, so a customer cannot embed
  their own 404 page in an iframe. Nobody has asked to.
- helmet's default CSP on API responses is irrelevant to JSON and will be the first
  thing someone disables when serving anything else from the API. **Amended 2026-08-10
  (F-280): one directive of it is not irrelevant.** `frame-ancestors` is what a browser
  actually enforces for framing, and it now carries `'none'`. Disabling the CSP disables the
  framing policy and leaves `X-Frame-Options: DENY` as the only thing standing, which is the
  state this amendment exists to get out of.

### Follow-ups this creates

- TASK-003 configures pino with the redact list and registers helmet plus HSTS.
- TASK-003 also asserts, in a test, that a log line built from a request carrying an
  `Authorization` header does not contain the token.
- No TASK calls `enableCors`. A cross-origin need escalates.
- Contract: `docs/contracts/logging-and-headers.md`.
