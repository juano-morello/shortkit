---
id: ADR-0037
slug: foundation
title: The compose build defaults GIT_COMMIT_SHA to the git null SHA, and that narrows ADR-0027 for images that cannot reach traffic
status: accepted
supersedes: null
narrows: ADR-0027
date: 2026-08-11
accepted_at: 2026-08-11
---

> **ACCEPTED BY JUANO 2026-08-11.** It was raised as `proposed` because it narrows accepted
> ADR-0027, and the rules of this phase say an accepted ADR is superseded explicitly or the
> conflict is flagged. It was flagged, and this is the ruling.
>
> **The narrowing is upheld as written**: an image that cannot reach traffic may report an
> unknown commit; an image that can, may not. The architect's reasoning carried it: ADR-0027
> rejected a sentinel because it "keeps the Fly check green, which keeps the deploy
> succeeding", and ADR-0030 removes the premise that there is a deploy. The alternative,
> `${GIT_COMMIT_SHA:?...}` plus an amendment to AC-115, was rejected: AC-115 was minted the
> same day by ruling and its "one command from nothing" text is deliberate, so amending it
> twice in a day to fit an implementation is the wrong direction of travel.
>
> **The precondition this adds to ADR-0030 is load-bearing and is not optional**: whatever
> builds a deployed image supplies a real SHA, and nothing inherits this default. When a
> deploy target is chosen, the premise returns and so does ADR-0027 in full.

## Context

ADR-0027 requires `GIT_COMMIT_SHA` to be a full 40-character lowercase hex SHA and refuses
its absence at three layers with no fallback at any of them: the Dockerfile's runtime stage
fails the build against `/^[0-9a-f]{40}$/`, `main.ts` refuses to boot, and the handler
throws. It rejected `?? 'unknown'` and it rejected an obviously-wrong sentinel such as
`commit: "UNSET"`, and the stated reason for rejecting the sentinel was: it keeps `/health`
answering, which keeps the Fly check green, which keeps the deploy succeeding, and "the
whole value of AC-6 is that a deploy nobody can identify should not reach traffic."

AC-115 requires that a machine with **only Docker and a clone** run `docker compose up` and
get a working stack.

These two collide, and the collision is mechanical rather than philosophical. Docker Compose
performs variable interpolation from the shell environment and from a `.env` file in the
project directory. It cannot run a command, so it cannot call `git rev-parse HEAD`. `.env` is
gitignored, so a fresh clone has none. BuildKit's automatic git detection from a local
context produces provenance attestations and, behind `BUILDX_GIT_LABELS`, OCI labels; it
produces no build argument and no environment variable. So on a fresh clone, `docker compose
up` has no way to learn the commit, and with `${GIT_COMMIT_SHA}` unset the Dockerfile guard
fails the build with `GIT_COMMIT_SHA must be a 40-character lowercase hex git SHA, got ''`.

That is a correct, loud failure. It is also AC-115 red on the exact command AC-115 names.

## Alternatives considered

**Fail, and document `GIT_COMMIT_SHA="$(git rev-parse HEAD)" docker compose up`.** Compose
uses `${GIT_COMMIT_SHA:?...}` so the message is ours rather than the Dockerfile's. Pros:
ADR-0027 is untouched; `/health` in the compose stack always reports a true commit; there is
no sentinel anywhere to copy into a future deploy. Cons: bare `docker compose up` does not
work, so AC-115 as written is not met and would need its own amendment. Why it is a real
contender: it is the only option that keeps provenance honest in every case, and the cost is
one exported variable that a README can carry. Why it lost: AC-115 was minted five days ago
by ruling, its text is deliberate, and Design does not get to narrow an AC by choosing an
implementation that cannot satisfy it.

**Bind-mount `.git` into a build stage and compute the SHA with `git rev-parse` at build
time.** Pros: no sentinel, no exported variable, works on a bare `up`. Cons: `.dockerignore`
excludes `.git` so it needs an additional build context; it needs `git` in the build image;
and it reports `HEAD` regardless of whether the tree is dirty, which is the lie
`infra/deploy.sh`'s dirty-tree refusal existed to catch and which ADR-0027 rejected when it
rejected `git rev-parse` at runtime. It also changes the production image's build for every
consumer to solve a local-stack problem. Why it lost: it weakens the guard for the artifact
AC-6 measures, in order to help the artifact AC-6 does not measure.

**Give the compose stack a separate image stage with no provenance guard, and let
`main.ts`'s boot check refuse.** Pros: the production stage keeps all three layers. Cons:
`main.ts` refuses to boot without the variable, so the stack still needs a value from
somewhere; this only moves the failure from build to boot. Why it lost: it does not solve
the problem, it relocates it.

**Commit a `.env` holding a real SHA.** Pros: bare `up` works. Cons: `.env` is gitignored on
purpose, and a committed SHA is stale on the next commit, which is the exact failure ADR-0027
rejected `[build.args]` for. Why it lost: rejected by ADR-0027 already, under a different
file name.

**Default the build argument to the git null SHA.** Adopted below.

## Decision

**`docker-compose.yml` passes the build argument with a default, and the default is the git
null object id.**

```yaml
api:
  build:
    context: .
    dockerfile: Dockerfile
    target: runtime
    args:
      GIT_COMMIT_SHA: ${GIT_COMMIT_SHA:-0000000000000000000000000000000000000000}
  pull_policy: build
```

Forty zeros. It matches `/^[0-9a-f]{40}$/`, so the Dockerfile guard, the boot check and the
handler are all unchanged, and no `??`, `||`, default parameter or sentinel string is added
to any TypeScript file. It is git's own value for "no commit" and `git rev-parse HEAD` can
never return it, so `/health` reporting it is unambiguous: this image was built by
`docker compose` on a developer machine and its provenance is unknown.

**`pull_policy: build`, and it is the reason the override works at all.** Added 2026-08-11
(F-319). `docker compose up` builds an image only when one does not already exist, and
AC-115 forces a bare `up` first, so without this the documented remedy below is a no-op on
every machine that has ever run the stack: Compose finds the forty-zeros image present,
reuses it, and `/health` keeps reporting forty zeros no matter what the developer exports.
`pull_policy: build` makes `up` rebuild instead of reusing, which also fixes the larger
version of the same problem: after a source edit, a bare `up` used to serve the previous
image, and since both builds report forty zeros nothing could tell them apart. Verified that
Compose parses and preserves the field. It applies to `api`, `web`, `migrate` and `seed`,
which are the four built services.

**The override is documented in the README, in this order and with `--build` written out:**

```
docker compose up                                                   # AC-115's literal command
GIT_COMMIT_SHA="$(git rev-parse HEAD)" docker compose up --build    # real provenance
```

`--build` is belt and braces beside `pull_policy: build`, and it is what a developer will
reach for from memory when the compose file is not in front of them. It is load-bearing, not
incidental, and the README says which.

**Real provenance is not sticky, and the README says so beside the command.** `pull_policy:
build` rebuilds on every `up`, so the next bare `docker compose up` rebuilds with the
forty-zeros default and `/health` reverts. That is the correct semantics for a flag supplied
on one invocation, and it is the opposite of what a developer expects from something that
looked like configuration: nothing announces the reversion, and `/health` answers 200 either
way. The rule is that the exported variable belongs on every `up` that is meant to carry a
real SHA, not on the first one.

**The `migrator` stage takes no build argument and runs no guard** (ADR-0033). Neither
one-shot service serves a request or reports a commit.

### Containment, and what it is actually made of

Revised 2026-08-11 (F-323). This section previously claimed the sentinel "exists in exactly
one line of one file, and that file is local-only". That overstates it, and the overstatement
is in the direction that makes the narrowing look safer than it is.

Two things are true. The `api` service builds `target: runtime`, which is the **production
image** AC-6 measures, not a compose-only variant, so the artifact carrying the sentinel is
deployable as it stands. And "cannot reach traffic" is a property of the `127.0.0.1:` port
prefix, which is one character away from `0.0.0.0`, rather than a property of the image.
ADR-0030's own rejected alternatives name "a VPS running the compose stack" as a live deploy
candidate, so the file most likely to become a deploy mechanism is the file whose banner
declares it local-only.

So the containment is not structural and is not claimed to be. It is three things, in
descending strength:

1. **ADR-0030's precondition list carries the rule**, and it is a condition of this ADR
   rather than a follow-up: *whatever builds a `runtime`-target image that will serve a
   request supplies a real `GIT_COMMIT_SHA`, and no build inherits the compose default.*
   Worded against the image, not against the file, because the image is what travels. That
   entry is in ADR-0030 now, applied in the same round as this ADR's acceptance.
2. The `LOCAL DEVELOPMENT ONLY` banner in `docker-compose.yml` (ADR-0031).
3. The fact that a reader of `/health` on a compose stack is the person who built it.

### Why the narrowing is defensible rather than convenient

ADR-0027 rejected a sentinel because it "keeps the Fly check green, which keeps the deploy
succeeding". That reasoning has a premise: there is a deploy. ADR-0030 removes it. With no
deploy target, the only image that can carry this default is one running on the developer's
own machine, where the person reading `/health` is the person who ran the build.

The narrowing is precisely: **an image that cannot reach traffic may report an unknown
commit; an image that can, may not.** If a deploy target is chosen later, the premise
returns and so does ADR-0027 in full.

## Consequences

### Positive

- `docker compose up` on a fresh clone builds and runs, which is what AC-115 says.
- All three refusal layers stay in place unmodified. No fallback enters `main.ts`,
  `build-commit.ts`, the health handler or the Dockerfile, so F-225's ungated path stays
  unreachable and the specs need no edit.
- Forty zeros is legible without documentation to anyone who has used git, and it can never
  collide with a real commit.
- Real provenance is one exported variable and one flag away, and `pull_policy: build` makes
  that actually take effect rather than reuse the previous image.
- Every `up` now serves the source in the working tree, which fixes a staleness problem that
  had nothing to do with the sentinel.

### The cost accepted

- **`/health` on the compose stack reports a commit that is not the running code's commit.**
  That is a weakening of the property ADR-0027 exists to guarantee, taken knowingly, and
  scoped to a stack that serves nobody.
- **The default is copyable, and the image carrying it is the production image.** The `api`
  service builds `target: runtime`, so this is not a compose-only artifact. Someone standing
  up a deploy later will read `docker-compose.yml` first, because it will be the only working
  example of building this image. ADR-0030's precondition and the banner are what stand in
  the way, and neither is a guard.
- **AC-6 and AC-115 now want different build invocations.** AC-6 is measured against
  `docker build --build-arg GIT_COMMIT_SHA=$(git rev-parse HEAD)`; AC-115's bare
  `docker compose up` produces an image whose `commit` field would read red against AC-6.
  Both commands belong in the README and an auditor needs to know which criterion each
  serves.
- **A developer debugging a stale container has one fewer signal.** Two images built from
  different commits both report forty zeros, so `/health` cannot distinguish them.
  `pull_policy: build` removes most of the occasions for this rather than the ambiguity
  itself.
- **`pull_policy: build` makes every `up` pay a build-graph evaluation.** With a warm
  BuildKit cache that is a second or two; with a cold one, after a `docker system prune`, it
  is a full rebuild of four images on a command a developer expected to be instant.
- **This ADR is a second place ADR-0027 has to be read from.** Anyone reasoning about
  provenance now reads two documents, and the second one contradicts a sentence in the first.

### Follow-ups this creates

- ~~Juano rules on this ADR before TASK-059 is dispatched.~~ **Ruled 2026-08-11: accepted as
  written.** The null-SHA default stands and the "require the variable and amend AC-115"
  alternative was rejected, because AC-115 was minted the same day by ruling and its text is
  deliberate.
- **The DoD's clean-state demonstration names the image removal explicitly.** `down -v`
  removes the volume and leaves the images, so a demonstration that stops there does not
  exercise the build the sentinel lives in. The card's DoD already prefers "no images
  cached"; it now says how: `docker compose down -v --rmi local`.
- ADR-0027's "What happens when the value is absent" section gains a pointer to this
  narrowing. That file is entangled with the open TASK-003 and is not TASK-059's to edit.
- ADR-0030's precondition list carries this ADR's containment rule. Applied, not pending.
- ADR-0030's precondition list gains the entry above.
