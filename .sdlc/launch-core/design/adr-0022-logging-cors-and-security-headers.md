---
id: ADR-0022
slug: launch-core
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

```ts
pino({
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'req.headers["fly-client-ip"]',
      'req.headers["x-forwarded-for"]', 'req.headers["x-shortkit-client-ip"]',
      'req.headers["x-shortkit-proxy-auth"]', 'res.headers["set-cookie"]',
      '*.password', '*.token', '*.secret', '*.rawToken', '*.tokenDigest',
      '*.verificationToken', '*.ip', '*.ipHash',
      'req.body.password', 'req.body.confirmation',
    ],
    censor: '[redacted]',
  },
  base: { service: 'shortkit-api' },
})
```

`*.ip` and the two IP headers are redacted because GC-9 says click events store
`ip_hash` and never a raw IP, and a log line carrying the raw IP defeats that. `ipHash`
is redacted too: it is pseudonymous per tenant (ADR-0010, F-009) and a log aggregator is
a weaker boundary than the database.

The two `x-shortkit-*` entries were added 2026-08-04 (F-032). `x-shortkit-client-ip` is
a raw client IP on every browser-originated request, and `x-shortkit-proxy-auth`
carries `BFF_PROXY_SECRET` verbatim; the `'*.secret'` wildcard matches a property one
level deep and does not reach a header key. TASK-003 ships both entries in wave 1,
before TASK-009 and TASK-012 introduce the headers, because a later append would have
no owner.

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
| `Content-Security-Policy` | helmet default | API responses |

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
  thing someone disables when serving anything else from the API.

### Follow-ups this creates

- TASK-003 configures pino with the redact list and registers helmet plus HSTS.
- TASK-003 also asserts, in a test, that a log line built from a request carrying an
  `Authorization` header does not contain the token.
- No TASK calls `enableCors`. A cross-origin need escalates.
- Contract: `design/contracts/logging-and-headers.md`.
