# Contract: the trusted client address

- **Boundary:** every place in `apps/api` that needs to know who a request came from. Two trust domains, two resolvers, one shared read.
- **Normative form:** this document. `apps/api/src/common/net/trusted-client-address.ts` does not exist and has **no design stub** (ADR-0040 follow-up); the fenced source below is complete enough to paste, per ADR-0039's "good enough to build from" standard.
- **Produced by:** whichever of TASK-009 and TASK-033 lands first. The other imports it.
- **Consumed by:** TASK-009 (`resolveRateLimitPrincipal`, the three Express auth buckets, the boot assertion), TASK-051 (`RateLimitGuard`'s `@Public()` bucket), TASK-033 (`trustedClientIp`, `ip_hash`), TASK-034 (click emission).
- **ADRs:** ADR-0040 (the decision), ADR-0030 (why the premise broke), ADR-0012, ADR-0014, ADR-0010.

**This is the one normative home for the trust rule.** `rate-limit.md` and `click-events.md`
each keep their own function's signature, keys and buckets, and point here for the question of
which value may be trusted. ADR-0040 holds the decision and the alternatives, not the
mechanism.

Added 2026-08-11 (F-320). Before this contract, the rule "the client address comes from a
header the platform sets and strips" lived in `rate-limit.md`, `click-events.md`, ADR-0010,
ADR-0012, ADR-0014, `web-api-client.md` and three design stubs, and named `Fly-Client-IP` in
every one of them. ADR-0030 deleted the platform that set it.

## The declaration

```
TRUSTED_CLIENT_IP_HEADER
```

Names the single header whose value the operator's own infrastructure sets on every inbound
request and **strips from every inbound request before setting it**. No default. Not
`NEXT_PUBLIC_*`. Server-only, API side.

| Property | Value |
|---|---|
| format | a lowercase HTTP header name, `/^[a-z0-9][a-z0-9-]{0,63}$/` |
| forbidden values | `x-forwarded-for`, `forwarded` |
| required when | `CLIENT_TRUST_BOUNDARY=proxy`. See below |
| example, Fly | `fly-client-ip` |
| example, Cloudflare | `cf-connecting-ip` |
| example, the integration suite | `x-test-client-ip` |

`x-forwarded-for` and `forwarded` are refused by name because both are defined to be
**appended to** rather than replaced, so no hop can strip-and-set them in the sense this
variable requires. Declaring either reintroduces F-009 through the front door. This is the one
half of the property that is locally checkable, so it is checked.

**What the assertion cannot check:** that the declared header is actually stripped by the hop
in front. Nothing local can establish that, exactly as nothing local can establish that
`BFF_PROXY_SECRET` matches the BFF's copy (F-033). An operator who declares a header their
infrastructure does not strip boots cleanly and is exactly as exposed as an operator with no
proxy at all. Stated here rather than implied.

## The trust boundary

Added 2026-08-11 (F-380). **The assertion's trigger is this variable, not `NODE_ENV`.**
`Dockerfile:83` is `ENV NODE_ENV=production` in the image `docker compose` runs, so a
`NODE_ENV` gate refuses to boot `api` on a developer's laptop. ADR-0040 holds the reasoning.

```
CLIENT_TRUST_BOUNDARY = proxy | direct        # unset is read as direct
```

| Value | Meaning | Effect on `TRUSTED_CLIENT_IP_HEADER` |
|---|---|---|
| `proxy` | a hop in front terminates client connections and sets and strips the declared header | **required**. Boot fails when it is unset, empty, malformed or forbidden |
| `direct` | clients reach this process directly. No header is trusted | not required. Not read by the assertion |
| unset | read as `direct`. The default, and it asserts nothing | not required |
| any other value | **boot fails, in every environment, unconditionally** | not reached |

Two checks, one conditional and one not:

1. **Validity of `CLIENT_TRUST_BOUNDARY` is asserted unconditionally.** `Proxy`, `true`,
   `prod` and `1` all fail boot everywhere, including in tests and in CI. A typo must never
   silently mean `direct`, because "silently means the permissive thing" is the failure class
   this whole contract exists to close.
2. **The header requirement is asserted only under `proxy`.** A stack that declares no
   boundary asserts nothing, establishes no principal, and fails open with signal.

**`CLIENT_TRUST_BOUNDARY` does not affect the read.** `readTrustedClientAddress`'s four rules
below depend on `TRUSTED_CLIENT_IP_HEADER` and on nothing else. The boundary governs whether
*forgetting* the header is an error; it never governs what is read. A harness may therefore
declare the header alone.

**What this cannot check, and it is the cost of moving off `NODE_ENV`:** an operator who
declares **neither** variable in a real deployment boots cleanly with no IP-keyed limit and no
complaint. Nothing local can tell a bare process that it was supposed to be behind a proxy.
The state is observable rather than silent, and `trusted_client_ip_unresolved_total` is the
thing that makes it so, which is why that counter is load-bearing rather than decorative.

## Normative source

```ts
import { isIP } from 'node:net';

export const TRUSTED_CLIENT_IP_HEADER_ENV = 'TRUSTED_CLIENT_IP_HEADER';

/** Lowercase, as Node presents incoming header names. */
export const TRUSTED_CLIENT_IP_HEADER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Defined to be appended to, never replaced. No hop can strip-and-set them. */
export const FORBIDDEN_TRUSTED_HEADERS: readonly string[] = ['x-forwarded-for', 'forwarded'];

export const TRUSTED_CLIENT_IP_UNRESOLVED_COUNTER = 'trusted_client_ip_unresolved_total';

/** Shape-compatible with Express's req.headers (IncomingHttpHeaders). */
export type TrustedAddressHeaders = Record<string, string | string[] | undefined>;

export const CLIENT_TRUST_BOUNDARY_ENV = 'CLIENT_TRUST_BOUNDARY';

/** Unset is read as 'direct'. Anything outside this set fails boot, everywhere. */
export const CLIENT_TRUST_BOUNDARIES = ['proxy', 'direct'] as const;
export type ClientTrustBoundary = (typeof CLIENT_TRUST_BOUNDARIES)[number];

export const CLIENT_TRUST_BOUNDARY_INVALID_MESSAGE =
  'CLIENT_TRUST_BOUNDARY must be "proxy" or "direct", or unset. It is not NODE_ENV and it is not a boolean.';

export const TRUSTED_CLIENT_IP_HEADER_UNSET_MESSAGE =
  'CLIENT_TRUST_BOUNDARY is "proxy" but TRUSTED_CLIENT_IP_HEADER is not set. A proxied deployment must name the header its hop sets and strips. See design/contracts/trusted-client-address.md.';

export const TRUSTED_CLIENT_IP_HEADER_MALFORMED_MESSAGE =
  'TRUSTED_CLIENT_IP_HEADER is not a valid lowercase HTTP header name.';

export const TRUSTED_CLIENT_IP_HEADER_FORBIDDEN_MESSAGE =
  'TRUSTED_CLIENT_IP_HEADER may not name a forwarding header that is appended to rather than replaced.';

/**
 * Called UNCONDITIONALLY from main.ts. The gating is inside, and it keys on
 * CLIENT_TRUST_BOUNDARY, NEVER on NODE_ENV (F-380; Dockerfile:83 is
 * ENV NODE_ENV=production in the image docker compose runs).
 *
 *   1. ALWAYS: CLIENT_TRUST_BOUNDARY, if set, is 'proxy' or 'direct'.
 *      Otherwise throw CLIENT_TRUST_BOUNDARY_INVALID_MESSAGE.
 *   2. ONLY when it is 'proxy': TRUSTED_CLIENT_IP_HEADER is set, well formed and not
 *      forbidden. Otherwise throw the matching message of the three below.
 *   3. Unset or 'direct': assert nothing further and return.
 *
 * Does not, and cannot, assert that the named header is stripped by the hop in front, nor
 * that a deployment declaring nothing was meant to declare something.
 *
 * The message NEVER interpolates a configured value: an environment read is not eligible
 * for error text (ADR-0029).
 */
export function assertTrustedClientIpHeaderConfigured(
  env: Record<string, string | undefined>,
): void;

/**
 * The single read. Returns a value isIP() accepts, or null. Never throws.
 * Never reads x-forwarded-for or forwarded, in any position, for any purpose.
 */
export function readTrustedClientAddress(
  headers: TrustedAddressHeaders,
  env: Record<string, string | undefined>,
): string | null;
```

## The read, rule by rule

`readTrustedClientAddress` returns the header value **only when all four hold**. Each failure
returns `null`.

1. `TRUSTED_CLIENT_IP_HEADER` is set and non-empty. Unset or empty **disables the read
   unconditionally**: no header is looked up at all, and rules 2 to 4 are never reached.
2. The value matches `TRUSTED_CLIENT_IP_HEADER_PATTERN` and is not in
   `FORBIDDEN_TRUSTED_HEADERS`. Under `CLIENT_TRUST_BOUNDARY=proxy` rule 2 cannot fail,
   because the boot assertion already refused. Anywhere else it can, and it returns `null`
   rather than throwing.
3. `headers[name]` is present, is a **single** `string`, and is non-empty after `trim()`. An
   array value, which is what Node presents for a repeated header, returns `null`. A value
   containing a comma returns `null`. **No list is ever parsed, at either end.** A repeated or
   comma-joined header means something upstream appended instead of replacing, which is the
   condition rule 2 exists to prevent and which returns nothing rather than a guess.
4. `isIP(value.trim()) !== 0`. This bounds the value before it becomes a Redis key segment, a
   local limiter map key, or an HMAC message. Node accepts 16 KiB headers.

On success the return value is `value.trim()`.

## Signal

| Condition | Counter | Log |
|---|---|---|
| any request whose IP-keyed decision got `null` | `trusted_client_ip_unresolved_total` | see below |
| header declared, read still failed (rules 3 or 4) | same counter | warn, once per minute |
| no header declared (rule 1) | same counter | **silent** |

The counter increments in both cases because "how many requests got no IP-keyed limit" is the
number an operator needs, and it is the same number in both. The warn is suppressed for the
undeclared case because an environment that declares nothing is in a stated condition, and one
warn per request in `docker compose up` trains a developer to ignore the channel.

Neither header name nor value is ever logged. `LOGGABLE_FIELDS` is an allowlist (ADR-0028), so
a configured header name that nobody enumerated is censored by default. That is why the
never-allowlist in `logging-and-headers.md` needs no entry per platform.

## The two callers

Two trust domains. **Two resolvers, never merged** (F-031). They share this read and nothing
else.

| | `resolveRateLimitPrincipal` | `trustedClientIp` |
|---|---|---|
| file | `apps/api/src/auth/resolve-rate-limit-principal.ts` | `apps/api/src/clicks/click-event.types.ts` |
| contract | `rate-limit.md` | `click-events.md` |
| owner | TASK-009 | TASK-033 |
| honours `X-Shortkit-Client-IP` under an authenticated BFF match | **yes**, F-033's four rules | **never**, secret or no secret |
| falls through to `readTrustedClientAddress` | yes | yes, and only this |
| on `null` | returns `null` | returns `UNKNOWN_IP_SENTINEL` |

The redirect path is reached by custom domains that CNAME straight to the API's origin and
never traverse the BFF, so honouring a forwarded address there would put an attacker-settable
value into `ip_hash` and reopen F-009 on the append-only store. That is why the BFF branch
belongs to one of these functions and not the other, and it is unchanged by this contract.

## What a `null` principal means to each bucket

| Bucket | On `null` |
|---|---|
| `signInPerIp`, `signUpPerIp`, `otherPerIp` (Express, TASK-009) | the bucket **does not run**. The request proceeds to Better Auth |
| `@Public()` IP bucket in `RateLimitGuard` (TASK-051) | the bucket **does not run**. The request proceeds to the handler |
| `signInPerEmail` (Better Auth hook, TASK-009) | unaffected. It is keyed on the address, not on the IP |
| tenant-keyed write bucket (TASK-051) | unaffected. It is keyed on `tenantId` |
| `authBodyCap` (TASK-009) | unaffected. It is keyed on nothing |

**A `null` principal never becomes a bucket key.** Not a sentinel, not `'unknown'`, not the
empty string, not the peer address. A shared sentinel bucket would let one caller exhaust an
allowance every other caller falls into, which is the collapsed-bucket outage
`rate-limit.md`'s F-031 section exists to prevent, arriving by a different road.

Fail-open with signal, as F-033 ruled for the neighbouring case (ADR-0040 alternative 2). The
cost, accepted and named in ADR-0040: **no IP-keyed limit binds in any environment that exists
today**, so F-018's connection-pool protection on the invitation routes is off in compose, in
CI and in local dev. The boot assertion is what makes the state impossible in production.

## Invariants a caller may rely on

1. A value returned by `readTrustedClientAddress` was read from the header
   `TRUSTED_CLIENT_IP_HEADER` names, and from nowhere else.
2. **No resolver in this repository reads `X-Forwarded-For` or `Forwarded`, at any position,
   for any purpose.** Not leftmost, not rightmost, not after a hop count.
3. Every non-`null` return satisfies `isIP(value) !== 0`, so it is at most 45 characters and
   contains no separator that can break a Redis key.
4. `readTrustedClientAddress` never throws, whatever the headers or the environment contain.
5. `trustedClientIp` never returns a value obtained from `X-Shortkit-Client-IP`, whether or
   not `X-Shortkit-Proxy-Auth` matched.
6. A process declaring `CLIENT_TRUST_BOUNDARY=proxy` does not reach `listen()` unless a
   trusted header is declared, well formed and not forbidden. A process declaring an
   unrecognised boundary value does not reach `listen()` at all, in any environment.
   **Revised 2026-08-11 (F-380):** this invariant said "in production", which
   `Dockerfile:83` made true of `docker compose up`.
7. A `null` principal produces no bucket key, so no two unidentified callers ever share an
   allowance.

## What the implementer must guarantee

- One implementation of the read. Both resolvers call it. A second header lookup anywhere in
  `apps/api` is a defect, and so is inlining rules 1 to 4.
- `assertTrustedClientIpHeaderConfigured` is called in `main.ts` beside
  `assertBffProxySecretConfigured`, before `listen()`.
- No error message, log line or metric label carries the configured header's name or value.
- A test asserts that a request carrying only `X-Forwarded-For: 203.0.113.7` resolves to
  `null` from `readTrustedClientAddress` and to `UNKNOWN_IP_SENTINEL` from `trustedClientIp`,
  with no declared header and with one declared.
- A test asserts that a **repeated** declared header resolves to `null`, since that is the
  shape an appending proxy produces and the one a naive `[0]` would trust.
- The integration suite declares `TRUSTED_CLIENT_IP_HEADER=x-test-client-ip` and
  `CLIENT_TRUST_BOUNDARY=proxy` so the IP buckets are exercisable and the intent is on the
  record. Without the header, F-025's six-different-client-IPs test passes vacuously: it
  proves the email bucket fired without the IP bucket, and the IP bucket could not have fired
  under any input.
- **The assertion is called unconditionally and reads no `NODE_ENV`.** A test asserting the
  boot behaviour sets `CLIENT_TRUST_BOUNDARY`, never `NODE_ENV`. Three cases, all cheap:
  `proxy` with no header refuses; `CLIENT_TRUST_BOUNDARY=Proxy` refuses whatever else is set;
  unset with no header boots and resolves `null`.
- **`docker compose up` must boot `api` with neither variable set.** That is the case F-380
  was filed on, and it is worth an explicit test rather than an inference, because the image
  it runs carries `ENV NODE_ENV=production` and every future production-gated check will meet
  the same trap.

## Versioning

`TRUSTED_CLIENT_IP_HEADER` and `CLIENT_TRUST_BOUNDARY` are configuration, changeable by
redeploy. Changing either resets no state: rate-limit keys expire within their window and
`ip_hash` continuity is already tied to `CLICK_IP_HASH_KEY`, not to the header.

Adding a third `CLIENT_TRUST_BOUNDARY` value is a change to this contract. The set is two
because there are two topologies, and an enum that grows to cover deployment nuance is how a
trust boundary becomes a configuration language.

Accepting a **list** of header names, or a second header as a fallback, is a change to this
contract and needs its own reasoning. The single-name form is deliberate: a fallback chain is
how a trusted-header model becomes a guess.
