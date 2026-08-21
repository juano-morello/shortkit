# The redirect latency baseline

Measured 2026-08-19 by TASK-2-11. Contracts: `docs/contracts/loadtest-result.md`,
`infra/loadtest/types.ts`. ADRs: ADR-0018 (the gate), ADR-0010 (the click write path),
ADR-0030 (why half of ADR-0018 is not built), ADR-0008 / ADR-0009 (the cache path this
measures).

## The two numbers, before any figure

**`serverP99` is the commitment. `clientP99` is not, and nothing gates on it.**

`serverP99` comes off `Server-Timing: app;dur=<ms>`, which the redirect handler measures with
`process.hrtime.bigint()` around its own work (`apps/api/src/redirect/redirect.controller.ts`).
It excludes the network, the socket and the load generator's scheduling. It includes everything
the handler itself waits on, the cache read included, which is why a managed cache would move
it. It is the number SC-2 constrains when it says "p99 no worse than 25 ms **server-side**",
and the only one the CI gate compares against anything.

`clientP99` is what the generator saw on the wire. On the runs below it is roughly two to
three times the server figure, and that gap is the machine: sockets, loopback, the generator's
own scheduling, and whatever else the box was doing. It is recorded because a gap that
suddenly widens is worth knowing about, and it is gated on by nothing, ever. A gate on it
fails builds for the machine's mood.

Quoting `ciP99BudgetMs` (below) as "our latency" is the third confusion this document exists
to prevent. That number is a regression tripwire on a shared CI runner at a fifth of the rate.
It is not a promise to anybody.

## The machine, named, because a baseline that is not attributable is not a baseline

| | |
|---|---|
| Host | `juano`, 13th Gen Intel Core i9-13950HX, 32 logical CPUs, 30 GiB RAM, Linux 7.0.0-29-generic |
| Stack | `docker compose up -d api`: the production image (`Dockerfile` target `runtime`, `node:24-alpine`), `postgres:17-alpine`, `redis:7-alpine`, all on loopback |
| Docker | Engine 29.7.2, Compose v5.4.0 |
| Generator | k6 v2.2.0 (`sha256:b5a8003c86f35f5cd5ceef1490312c48e587696c94d998cefc6d7b3b4cb1597d`, the release the CI job pins) |
| Tree | commit `3f24c9c0cc4a7178cef68288d6303b2f8232cd7b`, working tree dirty, digest `c58cfc147dc7e0d8`, and see below |
| Load average | 2.6 to 5.8 across the session. **The machine was not idle.** |

Two of those rows matter more than they look.

**The tree was dirty on purpose, and the artifact is still attributable to a commit.**
TASK-2-09's click emission was uncommitted when this was measured. Measuring without it would
have recorded a number the shipped redirect cannot meet, because the emission is on the path.
The digest is `sha256(git status --porcelain + git diff)` truncated to 16 characters, and every
result file carries it beside the commit.

That work landed minutes later as `0a91ca959d138ae6f4c8e5e9e961d5e103db4400`, and the
substitution was checked rather than assumed. Rebuilding the image from the committed tree
reproduced the runtime stage's `COPY --from=build /repo/apps/api/dist` **from cache**, which
means the built artifact is byte-identical to the one that commit produces. Across every path
the `Dockerfile` copies, the two trees differ by one character inside
`apps/api/src/clicks/click-event-buffer.spec.ts`, a test file no bundle imports. **The figures
below therefore describe the code at `0a91ca9`**, measured a few minutes before it had a commit
id.

**The machine was busy.** Other work was running on it throughout. That is visible in the
three CI-rate runs below, where the worst run's p99 is five times the best one's, and it is
the exact condition ADR-0018's median-of-three exists for. A quieter machine would produce
tighter numbers and a weaker demonstration.

## The figures

### At 500 RPS for 60 seconds, after a 10 second warm-up that is excluded

`infra/loadtest/results/2026-08-19T21-18-07.759Z.json`, and the source of `baseline.json`'s
`p50` / `p95` / `p99`.

| | p50 | p95 | p99 |
|---|---|---|---|
| **server (gated, SC-2)** | **0.327 ms** | **1.847 ms** | **2.850 ms** |
| client (reported, never gated) | 0.702 ms | 3.727 ms | 7.999 ms |

30 001 requests in the measured window, 0 errors, 500.017 RPS achieved of 500 requested, 0
dropped iterations, cache hit ratio 1.0.

`targetP99` is recorded as **6 ms**: `ceil(2.850 x 2)`, the measured p99 with a factor of two
of headroom. It is not 25. AC-62 caps the target at 25 and the contract says the target is
"derived from p99, never chosen first", so writing the ceiling into the file would have been
the failure that rule describes. It is not 2.850 either: a commitment set at exactly the best
measurement is one a warm afternoon breaks.

### At the CI rate: 100 RPS for 30 seconds, three consecutive runs, unchanged build

This is AC-64's property, verified locally: three runs against a build that did not change,
and the same verdict from all three.

| Run | server p50 | server p95 | **server p99** | client p99 | Verdict against the 19 ms budget |
|---|---|---|---|---|---|
| 1 (`21-19-55.371Z`) | 0.413 ms | 3.213 ms | **3.754 ms** | 6.991 ms | within |
| 2 (`21-20-50.451Z`) | 0.602 ms | 0.909 ms | **1.157 ms** | 2.304 ms | within |
| 3 (`21-23-41.896Z`) | 0.398 ms | 0.592 ms | **0.708 ms** | 1.380 ms | within |

Median server p99: **1.157 ms**. Each run: 3 001 requests, 0 errors, 100.033 RPS achieved of
100 requested, 0 dropped iterations, cache hit ratio 1.0.
`node infra/loadtest/gate.mjs --runs 3 --assert-agreement` exits 0 on these three.

The spread is the finding worth keeping: 0.708 ms to 3.754 ms on the same build, on a machine
doing other work. A single-run gate calibrated on run 3 would have failed on run 1 with
nothing wrong.

## `ciP99BudgetMs` is 19 ms, it is provisional, and it is a tripwire

**No measurement from `ubuntu-latest` exists yet.** The `performance` job had never run when
this was written, so `baseline.json` carries `ciMeasuredP99: null`, and 19 ms is
`ceil(3.754 x 5)`: the worst of the three local runs above, times a factor of five standing in
for a slower, shared, four-vCPU runner. **That factor is the only figure in this document that
is not measured.** It is a guess about a machine this baseline could not run on, and it is
written down as one rather than presented as calibration.

**The first green `performance` job is the calibration.** When it runs:

1. Read the three `serverP99` values it prints.
2. Set `ciMeasuredP99` to the median.
3. Set `ciP99BudgetMs` to `ceil(worst of the three x 2)`, the same doubling used for
   `targetP99`.
4. Record the run's URL and its three figures in this document, under a dated heading.

A red first run is a measurement, not a regression. What it is never a reason for is editing
`infra/loadtest/gate.mjs`.

**19 ms is not a latency commitment.** It is 100 RPS against containers on a runner GitHub can
replace without telling anybody, which is a recorded exposure in ADR-0018: a runner class
change silently invalidates the budget and the symptom is a build that starts failing with no
code change. Read it as "nothing has regressed", never as "the redirect answers in under
19 ms".

## The half that is not built, recorded as impossible rather than skipped

ADR-0018 has a layer 2: job `performance-full`, 500 RPS for 60 seconds against **a deployed
instance with a real managed cache**, gating `serverP99` against `targetP99`. It is the
configuration SC-2's sentence actually describes.

**It is not built, because there is nothing to run it against.** ADR-0030 chose no deploy
target for `apps/api`: no hosted API, no URL a browser on the internet can reach, and no
managed Redis. The closest existing thing to a deployment is the local compose stack, which is
what produced the 500 RPS figures above and what `baseline.json` names in its `environment`
field. Substituting one for the other silently is what this paragraph exists to prevent.

What the substitution costs, stated so nobody has to rediscover it:

- **The cache round trip is inside the server measurement.** `Server-Timing: app;dur=` wraps
  the whole handler, cache reads included. Loopback Redis answers in tens of microseconds; a
  managed cache over a network does not. The 2.850 ms above therefore has no bearing on what
  the same code does with a hosted cache, and `targetP99` inherits that.
- **The detection gap ADR-0018 accepted stays open.** The PR gate runs at 100 RPS with local
  Redis, so a regression that only appears under connection-pool or event-loop pressure at
  500 RPS, or one caused by a change in Redis command count per request, passes it. Layer 2
  was the thing that caught those. Nothing catches them now.
- **Neither GC-3's cost arithmetic nor the managed cache's command count has been exercised
  at rate.** ADR-0018 prices a layer 2 run at roughly 30 000 commands. Nothing has spent one.

**What reopens it:** the ADR that supersedes ADR-0030 and chooses a deploy target. That ADR
adds `performance-full`, re-runs the 500 RPS measurement against the deployment, and
re-derives `targetP99` from it before the number is quoted to anybody. ADR-0030's own "What
has to be true before this is revisited" section lists the six conditions; this is a seventh
consequence of them, not an independent decision.

## What the deferred-batch write path loses on a crash

`emissionMode` is `deferred-batch` (ADR-0010): the redirect enqueues a click into an in-process
buffer and answers; the buffer flushes on whichever comes first, **100 buffered events or
1000 ms**.

**Up to 1000 ms or 100 events are lost if the process dies without `SIGTERM`.** An OOM kill, a
`SIGKILL` or a hardware failure drops whatever is buffered. `SIGTERM` drains the buffer with a
five second bound, so an orderly stop loses nothing. Under sustained overload the buffer drops
events past its capacity (10 000 events or 4 MiB) with a counter and a log line and no marker
in the data.

SC-6 requires the click stream to be populated and queryable, not that every individual click
is durable, so this sits inside the criterion as written. It is a real gap and this is the
performance record ADR-0010 said it belongs in.

## Click row growth (D-2-03)

D-2-03 ruled no retention knobs and no cost controls in item 2, and put the arithmetic here.

**Measured, not estimated.** After 47 841 rows written by the runs above, on the stack above:

| | Bytes | Per row |
|---|---|---|
| Heap | 6 758 400 | 141.3 |
| Indexes (4) | 5 619 712 | 117.5 |
| **Total** | **12 419 072** | **259.6** |

The `user_agent` values in that sample average 16 bytes, because they came from k6 and curl. A
browser's is nearer 120, and `user_agent` is `varchar(512)` truncated at enqueue, stored inline
at that size, so **budget about 365 bytes per click for real traffic**: 260 measured plus about
105 for a realistic user agent.

| Clicks per day | Per month | Per year |
|---|---|---|
| 1 000 | ~11 MB | ~133 MB |
| 10 000 | ~110 MB | ~1.3 GB |
| 100 000 | ~1.1 GB | ~13 GB |

Four indexes cost 45% of the total, which is the half that is easy to forget: `(link_id,
occurred_at DESC)` for the click list, plus `tenant_id`, `domain_id` and the primary key.

Nothing prunes any of it. The rows go away in exactly two ways, both of them cascades:
deleting a link takes its clicks (`ON DELETE CASCADE`, and link deletion is a hard delete),
and deleting a tenant takes everything under it. There is no retention job, no partition, and
no archive, by ruling rather than by omission. Whoever prices a deploy target against GC-3's
$25 a month reads this table first: at 10 000 clicks a day the stream alone adds a gigabyte a
year, and no storage ceiling is recorded anywhere in this repository to compare it against.

## `Server-Timing` tells every visitor how long the server took

The header ships on **every** redirect response, to anyone who clicks a link. It exposes
internal timing: how long the handler took, and therefore whether a request hit the cache,
missed it, or waited on a connection.

**This is deliberate and it is ADR-0018's accepted cost.** The alternative is gating on
client-observed latency, which measures the runner and the internet instead of the code, and is
both noisier and wrong against SC-2's wording. The disclosure is one header of a few bytes on a
public redirect that reveals nothing about any tenant, any user or any other link. It is
recorded here rather than only in the ADR so that a reviewer meeting the header on the wire
finds a decision instead of a leak.

## Running it

```
docker compose up -d api                       # the stack the figures above came from
pnpm loadtest --rate 100 --duration 30         # one run, writes infra/loadtest/results/<timestamp>.json
node infra/loadtest/gate.mjs --runs 3          # the verdict: median server p99 vs ciP99BudgetMs
node infra/loadtest/gate.mjs --runs 3 --assert-agreement   # AC-64: three runs, one verdict
```

`docker compose up` refuses without `BETTER_AUTH_SECRET` in the environment or in a root
`.env`, by design (ADR-0051: that value signs JWTs, so none is committed). Generate one the way
`.env.example` line 11 says.

`pnpm loadtest` needs k6 on `PATH` or `K6_BIN` pointing at it; the version and checksum the CI
job pins are in `.github/workflows/ci.yml`, job `performance`. It also needs the cache the
target is using, `--redis`, which defaults to the compose stack's `127.0.0.1:56379`: the
hit-ratio check is the only evidence a run stayed on the cache-hit path, since a hit and a
miss are the same 302 to a client.

The harness signs in as `loadtest-harness@shortkit.test` and signs that account up the first
time only, because `signUpPerIp` allows three per hour per address and a harness that made a
new account per run would refuse its own fourth run of the hour.

The harness seeds its workspace and its link **through the API** on every run. Seeding by SQL
would skip slug validation, the mutation event and the cache invalidation, and would measure a
link the product cannot create.

## What these figures do not cover

- **One link, one slug, one tenant, always a cache hit.** This is GC-1's path and nothing else.
  A cold cache, a negative cache hit, an expired link, an unknown host and the 404 page are all
  unmeasured.
- **The management API is not under load.** The pool is shared with it, and F-152's
  connection-acquisition timeout is exactly what a burst of dashboard traffic can produce.
  Nothing here exercises that interaction.
- **No managed anything.** Local Postgres, local Redis, loopback, one machine, no TLS
  termination, no proxy hop, no cold start.
- **A busy developer machine, not a controlled environment.** The three-run spread above is
  the honest form of that caveat.
- **The CI budget has never been measured on the runner it names.**
