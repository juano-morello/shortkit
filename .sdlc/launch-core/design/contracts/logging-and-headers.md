# Contract: structured logging, redaction, CORS, and security headers

- **Boundary:** every log line the API emits; every response header it sets.
- **Normative form:** `apps/api/src/observability/logger.ts` and `apps/api/src/main.ts` (stub: `design/stubs/apps/api/src/observability/logger.ts`).
- **Produced by:** TASK-003.
- **Consumed by:** every API TASK. Nothing may opt out.
- **ADRs:** ADR-0022. Enforces GC-9.

## Logger

```ts
import pino from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["fly-client-ip"]',
  'req.headers["x-forwarded-for"]',
  'req.headers["x-shortkit-client-ip"]',
  'req.headers["x-shortkit-proxy-auth"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.rawToken',
  '*.tokenDigest',
  '*.verificationToken',
  '*.ip',
  '*.ipHash',
  'req.body.password',
  'req.body.confirmation',
] as const;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
  base: { service: 'shortkit-api', env: process.env.NODE_ENV },
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
});
```

## Required fields

| Field | On | Source |
|---|---|---|
| `request_id` | every line inside a request | `x-request-id` header, or a generated uuid |
| `tenant_id` | every line inside a tenant transaction | `currentTenantId()` |
| `route` | request completion | the matched route pattern, not the raw path |
| `status`, `duration_ms` | request completion | |

`route` is the pattern (`/api/links/:id`), never the concrete path. A concrete path
carries a slug or an id, and the redirect path's concrete paths are the entire click
stream in plain text.

## What may never appear in a log line

Normative. GC-9.

- A raw IP address, in any field, from any header.
- A JWT, a session token, a capability token, an invitation token, a verification token,
  or any digest of one.
- A password, in any form.
- `ip_hash`. It is pseudonymous per tenant and a log aggregator is a weaker boundary than
  the database.
- A request or response body, unless an explicit reviewed call logs named fields from it.
- A `tenant_id` other than the one the request is scoped to.

The redact list is the mechanism. **It is an allowlist of paths and it does not reach
arbitrary nesting**: `*.token` matches one level, so `payload.data.credentials.token` is
not covered. A TASK introducing a nested secret adds a path in the same commit.

**The two `x-shortkit-*` entries are in the list now, ahead of the headers existing**
(F-032). `x-shortkit-client-ip` carries a raw client IP on every browser-originated API
request (GC-9 forbids a raw IP in any field from any header), and
`x-shortkit-proxy-auth` carries `BFF_PROXY_SECRET` verbatim — a leaked log line would
let anyone forge `X-Shortkit-Client-IP` against Fly directly and defeat every IP-keyed
auth bucket. The `'*.secret'` wildcard matches a property one level deep and **does not
reach a header key**. **TASK-003 owns these entries** and ships them in wave 1 with the
rest of the list, eight waves before TASK-009 introduces the headers; redacting a
not-yet-sent header is free, and appending later would have no owner. The
`BFF_PROXY_SECRET` value is never logged on the Vercel side either
(`web-api-client.md`).

### The exception filter's error line

Added 2026-08-05 (F-106). `apps/api/src/common/errors/exception-filter.ts` is the only
place in the API that writes an arbitrary error into a log line, and TASK-003 owns that
file as of the F-090 ruling. Today it logs the error's name and message as one
concatenated string through Nest's `Logger`, with no stack and no `request_id`.

**Before moving that line onto pino, read `error-envelope.md`, "What the 500 log line
carries, and who owns changing it".** It states what the filter does now, why the stack
came out, and the argument for putting the frames back and treating the message as the
risky field instead. The decision is TASK-003's, and until it lands this line sits
outside the pipeline this contract says nothing may opt out of. `REDACT_PATHS` cannot
help either way: it matches paths, and neither a message nor a stack has one.

## CORS

**Disabled. `app.enableCors()` is never called.**

The browser never reaches the API cross-origin: ADR-0014 routes every browser request
through the Next.js BFF, same-origin with the page. The redirect path is reached by
navigation rather than by `fetch`, so it needs no CORS header either.

A future cross-origin consumer, such as the MCP server, gets its own ADR. It does not
inherit a permissive default set here. **A frontend TASK meeting a cross-origin error
escalates rather than enabling CORS**: the error means something is bypassing the BFF,
which is the actual defect.

## Security headers

`helmet()` with defaults, plus HSTS, registered in `main.ts` before the global prefix.

| Header | Value | Scope |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | every response |
| `X-Content-Type-Options` | `nosniff` | every response |
| `X-Frame-Options` | `DENY` | every response |
| `Referrer-Policy` | `no-referrer` | every response except the redirect 302 |
| `Content-Security-Policy` | helmet default | API responses |

`preload` is **not** set on HSTS: submission is close to irreversible and the apex domain
is unregistered.

### Two deliberate exceptions on the redirect path

Both already normative in `redirect-resolution.md`. They override the defaults above.

| Response | Header | Value | Why |
|---|---|---|---|
| redirect 302 | `Referrer-Policy` | `unsafe-url` | passing the short URL to the destination is the point of an attribution referrer, and the link is public |
| branded 404 | `Content-Security-Policy` | `default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'` | tighter than helmet's default; the page interpolates tenant-controlled branding (F-006) |

## Invariants a caller may rely on

1. Logging a whole request or response object never emits a credential, an IP, or a
   cookie. The redaction is at the logger, so no call site has to remember.
2. Every line inside a request carries `request_id`; every line inside a tenant
   transaction carries `tenant_id`.
3. The API sends no `Access-Control-Allow-Origin` header, for any origin, on any route.
4. HSTS, `nosniff` and `DENY` are present on every API response including errors.

## What the implementer must guarantee

- **A test asserts redaction works**: build a log line from a request carrying
  `Authorization: Bearer x.y.z` and `Cookie: sk_at=...`, and assert the serialised output
  contains neither value and contains `[redacted]`.
- A test asserts no response carries `Access-Control-Allow-Origin`.
- Adding a field that could carry a secret means adding its path to `REDACT_PATHS` in the
  same commit.
- Never log `error.request` or `error.config` from an HTTP client. Both carry headers.

## Versioning

`REDACT_PATHS` is append-only. Removing a path needs a reason in the commit message.
Changing the header table requires amending ADR-0022.
