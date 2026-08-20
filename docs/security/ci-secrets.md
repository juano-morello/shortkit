# CI secrets and variables

What the GitHub Actions workflows read, where each value is registered, and the one rule
that must hold when any of them is rotated.

## The register

| Name | Kind | Where it must be registered | Read by |
| --- | --- | --- | --- |
| `BFF_PROXY_SECRET` | secret | Actions **and** Dependabot | `quality`, at job level |
| `NEXT_PUBLIC_API_BASE_URL` | variable | Actions | `quality`, at job level |
| `API_BASE_URL` | variable | Actions | `quality`, at job level |

The two variables are public by design. `NEXT_PUBLIC_API_BASE_URL` is the browser-visible
API base URL and `API_BASE_URL` is the same Fly origin the BFF proxy calls; both are
discoverable from any redirect response and both are committed in cleartext in
`apps/web/.env.example`. They are variables rather than secrets so they render in logs,
which is what makes a wrong value diagnosable.

## The rule: CI's `BFF_PROXY_SECRET` is never production's

**Never set the CI secret to the value registered on Vercel.** Rotate them independently.
They are two unrelated values that happen to satisfy the same format.

The reason is what the value is used *for* on each side. On Vercel it is real: the API is
**required to** perform a constant-time match on it before honouring a forwarded
`x-shortkit-client-ip`, so publishing it would let anyone forge that header and collapse
every IP-keyed rate-limit bucket into one shared by the whole product (ADR-0014,
`docs/contracts/web-api-client.md`).

That match is **not implemented yet**: it is TASK-012's, and
`grep -rn "timingSafeEqual\|BFF_PROXY_SECRET" apps/api/src` currently returns nothing.
Stated as a requirement rather than as behaviour, because the rule below has to hold from
the day the secret exists rather than from the day something reads it.

In CI the value is a **search needle** and nothing else: `assert-no-inlined-secrets.mjs`
needs some conforming value present in the environment so it has something to look for in
the built output. CI never talks to Fly. A random base64url string does the job exactly as
well.

That divergence is what makes the workflow's job-level `env:` cheap. The secret is
declared once for the whole `quality` job, deliberately, so the build and the check
cannot see different environments (F-156), which puts it in scope for every step in that
job, including `pnpm install --frozen-lockfile` and the build scripts of `@swc/core` and
`esbuild`. Today that reach is worth nothing because the value authenticates nothing. Set
the two to the same value and the same structure hands a compromised transitive build
script the live secret.

**The plausible way this goes wrong is a repair, not an attack**: someone hits the
Dependabot problem below, sees "the values don't match", and pastes Vercel's secret into
the CI secret to make them agree. No test, no gate and no reviewer checklist rejects that
change. This document is the thing that does.

Generate a CI value the same way as any other:

```
openssl rand 24 | base64 | tr '+/' '-_' | tr -d '='
```

32 base64url characters, no padding: the floor `assert-no-inlined-secrets.mjs` enforces.

## Register `BFF_PROXY_SECRET` twice

Once under **Settings > Secrets and variables > Actions**, and again under **Settings >
Secrets and variables > Dependabot**, with the same value.

GitHub runs Dependabot-triggered `push` and `pull_request` events with a read-only
`GITHUB_TOKEN` and with Dependabot secrets only; Actions secrets are not exposed to them.
Without the second registration `secrets.BFF_PROXY_SECRET` is empty on every Dependabot
run, and `quality` fails, correctly, since a guard with nothing to search for would
otherwise pass having checked nothing.

That failure is not cosmetic. ADR-0018 makes Dependabot the only mechanism in the project
that raises a version, so a bump that can never go green is a security patch that can
never merge without someone bypassing branch protection. Bypassing the gate is then a
habit learned on exactly the pull requests that carry security fixes.

**Do not repair it by skipping the guard when the secret is absent.** A conditional skip
reports the check as having run and is the vacuous pass the guard exists to prevent. The
`quality` job instead fails at its first step, naming this cause and pointing here.

Pull requests from forks receive no secrets at all, by design, and fail the same way. On
this repository that is accepted (F-182): there are no external contributors, and failing
loudly is the right direction to fail in.

## What CI deliberately does not hold

No Fly, Vercel, Neon or Upstash credentials, and no deploy step: Vercel deploys through
its own git integration rather than through Actions. `permissions: contents: read` at
workflow level in both workflows, with `permissions: {}` on `gate`; nothing requests a
write scope. A compromised action would get a token that can read a repository the whole
internet can already read.
