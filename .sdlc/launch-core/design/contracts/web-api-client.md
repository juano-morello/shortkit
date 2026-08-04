# Contract: the web API client and the BFF proxy

- **Boundary:** browser to Next.js, and Next.js to NestJS. Every frontend TASK calls the API through this.
- **Normative form:** `apps/web/src/lib/api/client.ts` (stub: `design/stubs/apps/web/src/lib/api/client.ts`).
- **Produced by:** TASK-008 (client), TASK-012 (proxy route, cookies, session).
- **Consumed by:** TASK-012, 015, 019, 022, 026, 028, 041, 044, 047, 050, 052, 055, 057.
- **ADRs:** ADR-0014, ADR-0005, ADR-0013.

## Topology

```
browser --(same-origin, httpOnly cookies)--> Next.js /api/bff/* --(Bearer JWT)--> NestJS /api/*
server component ------------------------- serverApiClient() --(Bearer JWT)--> NestJS /api/*
```

The browser never holds a token and never calls Fly directly.

## Client

```ts
export interface ApiRequest<TRes, TBody = unknown> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;                 // API path without /api, e.g. '/links/abc'
  contract: z.ZodType<TRes>;    // response schema; the response IS validated
  body?: TBody;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export declare function apiClient<TRes>(req: ApiRequest<TRes>): Promise<TRes>;
export declare function serverApiClient<TRes>(req: ApiRequest<TRes>): Promise<TRes>;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;   // present when code === 'rate_limited'
}

export class ContractViolationError extends Error {
  readonly path: string;
  readonly issues: z.ZodIssue[];
}

export class NetworkError extends Error {}
```

## Response handling

Ordered. Normative.

1. Status 2xx: parse JSON, `contract.safeParse`. Failure throws
   `ContractViolationError` and **never returns the malformed data** (AC-15).
2. Status 4xx or 5xx with a body validating against `errorEnvelopeContract`: throw
   `ApiError` carrying `code`, `status`, `details`.
3. Status 401 with `code: 'token_expired'`: the **proxy** refreshes and retries once
   before the client sees anything. Two consecutive failures clear both cookies and
   return 401 `unauthenticated`.
4. Status 429: `ApiError` with `retryAfterSeconds` taken from the `Retry-After` header
   **and, when that header is absent, from a `retryAfterSeconds` field in the body**.
   `/api/auth/*` is mounted outside Nest, so a 429 from the email rate limiter carries
   the value in the body rather than the header (F-027, `rate-limit.md`). Normalising
   both here is what lets TASK-052's central rendering work on the login screen, which
   is the 429 a user is most likely to see. No screen reimplements it.
5. Body not matching the envelope, including Better Auth's native errors from
   `/api/auth/*` (ADR-0013): mapped to `ApiError` with `code: 'internal_error'` and the
   original status, except Better Auth's documented shapes which TASK-008 maps
   explicitly.
6. Transport failure: `NetworkError`.

**No screen calls `fetch` directly.** Every request goes through one of the two clients.

## The proxy route

`apps/web/app/api/bff/[...path]/route.ts`

| Behaviour | Rule |
|---|---|
| upstream URL | see the normative construction below |
| auth | `Authorization: Bearer <sk_at cookie>` |
| cookies upstream | **never forwarded** |
| request headers forwarded | `content-type`, `accept`, `x-request-id` only. **Inbound `x-shortkit-*` headers are never forwarded**; the proxy sets both of its own afresh on every request |
| headers the proxy **adds** | `x-shortkit-client-ip` (the browser's address — see the rule below) and `x-shortkit-proxy-auth` (`BFF_PROXY_SECRET`) |
| response headers returned | `content-type`, `retry-after`, `x-request-id` only |
| CSRF | mutating methods require `Origin` to equal the deployment origin, else 403 |
| redirects | `redirect: 'manual'` on the upstream fetch. A 3xx is returned to the caller, never followed |
| refresh | on upstream 401 `token_expired`, mint from `sk_rt`, set `sk_at`, retry once |
| concurrent refresh | collapsed by an in-flight map keyed on the session |

### Upstream URL construction

Normative. Revised 2026-08-04 (F-008): the rule was `${API_BASE_URL}/api/${path}` with
`path` the decoded `[...path]` catch-all. Next.js decodes route params, so
`%2e%2e%2f` yielded `../` and escaped the `/api` prefix; and an implementer reaching for
`new URL(path, API_BASE_URL)` would let a path beginning `//evil.example/` resolve
protocol-relative, sending `Authorization: Bearer` with a live tenant credential to an
attacker-chosen origin, from a same-origin request the victim's browser makes.

```ts
const base = new URL(API_BASE_URL);                    // server-only env var

// 1. Reject any unsafe segment AFTER Next.js has decoded it.
for (const seg of segments) {
  if (seg === '' || seg === '.' || seg === '..') return badRequest();
  if (/[/\\:]/.test(seg)) return badRequest();
}

// 2. Re-encode and join. Never interpolate the raw catch-all.
const upstream = new URL(`/api/${segments.map(encodeURIComponent).join('/')}`, base);

// 3. Assert the origin. This is the load-bearing line.
if (upstream.origin !== base.origin) return badRequest();

// 4. Query string is rebuilt from the parsed searchParams, never concatenated.
```

Step 1 runs on the **decoded** segments, because that is the form traversal arrives in.
Step 3 is not redundant with steps 1 and 2; it is the assertion that makes any future
change to them safe.

### The browser address the proxy forwards

Added 2026-08-04 (F-035). The source of `x-shortkit-client-ip` is normative:
**`x-vercel-forwarded-for`**, read whole. It is set by Vercel to the connecting
client's public address, a client cannot spoof it because Vercel overwrites inbound
forwarding headers on non-Enterprise plans, and unlike `x-forwarded-for` it is not
rewritten by a proxy stacked on top of Vercel.

- **Never** `x-forwarded-for` split on commas, and **never the leftmost entry of any
  multi-valued list** — that is the construct F-009 exists to forbid, moved one hop
  upstream.
- When the header is absent (local `next dev`), the proxy **omits**
  `x-shortkit-client-ip` entirely; the API then falls back to `Fly-Client-IP`
  (`rate-limit.md`). It never substitutes another header.
- **This assumption holds only while requests reach Vercel directly.** Putting any
  proxy in front of Vercel (Cloudflare, a corporate gateway, a Vercel Enterprise
  trusted-proxy configuration) changes who controls the client address and invalidates
  it; that change requires revisiting this section, not just DNS.

`BFF_PROXY_SECRET` is a **required, server-only** environment variable on Vercel,
registered by TASK-004 alongside `API_BASE_URL` (never `NEXT_PUBLIC_*`). Its value is
**never logged on the Vercel side** — not in route-handler logs, not in error paths
that serialise headers — mirroring the API-side redaction (`logging-and-headers.md`,
F-032). On the Fly side the variable is required at boot in production
(`rate-limit.md`, F-033).

## Cookies

Set by the proxy on the Vercel origin. Both `HttpOnly; Secure; SameSite=Lax; Path=/`.
Details in `auth-tokens.md`. **Client JavaScript can read neither** (TASK-012's
constraint).

## Session

```ts
export declare function useSession(): { user: SessionUser | null; status: 'loading' | 'authenticated' | 'unauthenticated' };
export declare function requireAuth(): Promise<SessionUser>;   // redirects to /login

export interface SessionUser { id: string; email: string; emailVerified: boolean; }
```

`useSession` reads `GET /api/bff/session`, which returns the projection above. **No
token is ever exposed to the client**, in any form.

## Invariants a caller may rely on

1. A resolved `apiClient` promise carries data that validated against `contract`.
   Malformed data throws (AC-15).
2. An incompatible change in `packages/contracts` breaks `pnpm typecheck` because
   `apps/web` compiles the contract source (AC-14, ADR-0005).
3. 429 handling and `Retry-After` are applied centrally. Form state survives a 429;
   the client throws rather than resetting anything (AC-87).
4. Token refresh is invisible to the caller. A screen never sees `token_expired`.
5. `serverApiClient` cannot set cookies during render, so on `token_expired` it throws a
   redirect to a refresh route handler that bounces back.
6. **The proxy never sends `Authorization` to any origin other than `API_BASE_URL`'s.**
   No path, query string, header or upstream redirect can cause it to. The origin
   assertion runs on every request, and `redirect: 'manual'` stops an upstream 3xx from
   carrying the header somewhere else.
7. The proxy cannot reach any upstream path outside `/api/`. Traversal segments are
   rejected before the URL is built.
8. **The API sees the browser's address, not Vercel's.** The proxy adds
   `x-shortkit-client-ip` — sourced from `x-vercel-forwarded-for` only, never a
   leftmost list entry (F-035) — and authenticates it with `x-shortkit-proxy-auth`.
   Without this every IP-keyed rate limit would collapse into one bucket shared by
   every user (`rate-limit.md`). A client-supplied `x-shortkit-client-ip` arriving
   without a valid secret is ignored, so this does not reintroduce F-009's trust
   problem, and inbound `x-shortkit-*` headers are never forwarded upstream.

## What the implementer must guarantee

- The header allowlists are allowlists. Forwarding `cookie` upstream, or returning
  `set-cookie` from upstream, leaks the Fly origin's session into the Vercel origin.
- **Tests for the URL construction, not just the happy path.** At minimum:
  `/api/bff/x/%2e%2e%2f%2e%2e%2fhealth` returns 400; `/api/bff//evil.example/x` returns
  400; and a stubbed upstream returning a 302 to another origin does not cause a second
  request carrying `Authorization`.
- Do not replace the construction with `new URL(path, base)`. It looks equivalent and
  resolves protocol-relative paths off-origin.
- Workspace scoping in the UI is display context, never a security control. The API is
  the enforcement point (TASK-015).
- `NEXT_PUBLIC_API_BASE_URL` is not used for anything authenticated. Authenticated
  traffic uses the same-origin `/api/bff` path or the server-only `API_BASE_URL`.

## Versioning

The `/api/bff/*` surface is internal to `apps/web` and shipped from the same commit as
its callers, so it has no compatibility obligation. `ApiError` and
`ContractViolationError` are public to every frontend TASK; adding a field is additive,
changing `code`'s type is not.
