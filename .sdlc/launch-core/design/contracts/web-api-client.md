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
4. Status 429: `ApiError` with `retryAfterSeconds` from the `Retry-After` header.
   Handled centrally so no screen reimplements it (TASK-052).
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
| upstream URL | `${API_BASE_URL}/api/${path}` (server-only env var) |
| auth | `Authorization: Bearer <sk_at cookie>` |
| cookies upstream | **never forwarded** |
| request headers forwarded | `content-type`, `accept`, `x-request-id` only |
| response headers returned | `content-type`, `retry-after`, `x-request-id` only |
| CSRF | mutating methods require `Origin` to equal the deployment origin, else 403 |
| refresh | on upstream 401 `token_expired`, mint from `sk_rt`, set `sk_at`, retry once |
| concurrent refresh | collapsed by an in-flight map keyed on the session |

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

## What the implementer must guarantee

- The header allowlists are allowlists. Forwarding `cookie` upstream, or returning
  `set-cookie` from upstream, leaks the Fly origin's session into the Vercel origin.
- Workspace scoping in the UI is display context, never a security control. The API is
  the enforcement point (TASK-015).
- `NEXT_PUBLIC_API_BASE_URL` is not used for anything authenticated. Authenticated
  traffic uses the same-origin `/api/bff` path or the server-only `API_BASE_URL`.

## Versioning

The `/api/bff/*` surface is internal to `apps/web` and shipped from the same commit as
its callers, so it has no compatibility obligation. `ApiError` and
`ContractViolationError` are public to every frontend TASK; adding a field is additive,
changing `code`'s type is not.
