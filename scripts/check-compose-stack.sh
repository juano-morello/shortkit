#!/usr/bin/env bash
set -euo pipefail

# AC-115, measured. STORY-002 Amendment A-8, TASK-059. Text narrowed 2026-08-14
# (identity-membership F-145, ADR-0051) to name the one variable this harness now supplies.
#
#   AC-115: Given a machine with only Docker and a clone of this repository, and
#   `BETTER_AUTH_SECRET` supplied in the environment, when `docker compose up` is run at
#   the repository root, then Postgres, the API and the web app all reach a healthy
#   state, the migrations have been applied, the seed has run, and `GET /health` on the
#   composed API returns 200 with `status` equal to "ok".
#
# AC-28 (STORY-004, TASK-017), measured on the same stack, after AC-115's clauses and before
# the second `up`; its first clause is also AC-20's (STORY-003) sentence "a signup request
# issued through the web app answers 200":
#
#   AC-28: Given a machine with only Docker and a clone of this repository, when the
#   composed stack is driven through signup, then sign-in, then workspace creation, in that
#   order and through the web app, then all three succeed against a database with no seed
#   data and with no manual step between them.
#
# AC-1b-41 / AC-1b-42 (STORY-1b-09, TASK-1b-11), the second-human path on the same stack,
# after AC-28's clauses and before the second `up`. SC-2 extended: the owner invites a
# fresh address to the workspace, the invite link is read out of `docker compose logs api`
# (`MAIL_TRANSPORT=console`, D-02), the invitee signs up with the token, signs in, and sees
# exactly the granted workspace at the granted role -- and nothing the owner did not grant.
#
# AC-2-44 (STORY-2-09, TASK-2-12), item 2's loop on the same stack, after the invitation
# clauses and before the second `up`. SC-16: the owner creates a link through the web app,
# the short link is followed on the API's own published port, the click that visit wrote is
# read back through the web app, the destination is edited and the redirect follows it, the
# `redis` service is stopped and the redirect still serves, `redis` comes back, and a slug no
# link holds renders the 404.
#
# ADR: adr-0030 .. adr-0037, adr-0050, adr-0051, adr-0059; adr-0017 and adr-0021 for the
# invitation clauses; adr-0006, adr-0008, adr-0009, adr-0010, adr-0012 and adr-0063 for the
# redirect clauses. Contract: docs/contracts/rls-policy-template.md,
# docs/contracts/web-api-client.md, docs/contracts/mail-sender.md,
# docs/contracts/invitation-tokens.md, docs/contracts/redirect-resolution.md,
# docs/contracts/redirect-cache.md, docs/contracts/click-events.md.
#
#   ./scripts/check-compose-stack.sh
#
# This is a shell-and-Docker check rather than a vitest test, for the same reason AC-5,
# AC-7 and AC-113 are: what it measures is a running stack, and vitest cannot hold one.
# It is not exempt from being a test. It is red until `docker-compose.yml` exists.
#
# EXIT CODES, AND THE DISTINCTION IS THE POINT:
#   0  every clause passed.
#   1  at least one AC-115, AC-28, AC-1b-e2e or AC-2-e2e clause is red. The clause table
#      says which and why.
#   2  the CHECK could not run: no Docker, no node, or a machine that is not the
#      machine AC-115 describes. Nothing was measured, and nothing may be concluded
#      about AC-115, AC-28, the invitation clauses or the redirect clauses from a 2.
#
# WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT:
#
#   Each phrase of AC-115 is its own clause with its own id and its own reason string,
#   because "the stack is broken" tells an implementer nothing. `no compose file`,
#   `postgres never went healthy` and `the stack came up and the seed did not run` are
#   three different failures and they print as three different lines.
#
#   It does NOT assert the `commit` field of /health. Under ADR-0037 a bare
#   `docker compose up` builds with `GIT_COMMIT_SHA` defaulted to the git null object id
#   (forty zeros), which is accepted and correct: AC-115 asks for `status`, and says
#   nothing about provenance. The provenance form is
#   `GIT_COMMIT_SHA="$(git rev-parse HEAD)" docker compose up --build` and it belongs to
#   AC-6, which is measured against `docker build`, not against this stack.
#
#   It does NOT assert image tags, file layout, the shape of the compose file, or
#   anything about how the services are built. It reads only what AC-115 and the ADRs
#   make normative: the service names in ADR-0036's ordering table (`postgres`, `api`,
#   `web`), the roles and fixture passwords in ADR-0031, the published API port in
#   ADR-0031, the demo tenant id frozen in ADR-0034, and the schema the one migration in
#   `apps/api/drizzle` defines.
#
# TWO CLAUSES BEYOND AC-115'S TEXT, BOTH FROM THE CARD'S DoD:
#   `docker compose up` twice in a row succeeds with a seed that does not double the
#   data, and the data survives `docker compose restart` (ADR-0032, ADR-0034 rule 1).
#
# TWO GUARD CLAUSES, AND WHY A CHECK FOR AC-115 CARRIES THEM:
#   The design pass measured a failure that is silent (F-315, F-316). A single `$`
#   inside `configs.*.content` or `healthcheck.test` is interpolated by Compose at parse
#   time against the HOST environment, which on AC-115's own machine is empty; libpq
#   treats an empty user as unset, PostgreSQL answers `PASSWORD ''` with a NOTICE rather
#   than an error, `ON_ERROR_STOP=1` never fires, and the container reports
#   initialisation complete with two passwordless roles. A check that connects with
#   whatever the container says the password is cannot tell that apart from a correctly
#   provisioned stack. So GUARD-1 authenticates as `shortkit_app` over TCP with the
#   fixture password this repository commits, and GUARD-2 asserts a WRONG password is
#   refused, which is what catches the cheapest repair for "postgres is never healthy",
#   `POSTGRES_HOST_AUTH_METHOD=trust`, named in ADR-0036 as the one repair that is a
#   security defect.
#
#   GUARD-1 authenticates as `shortkit_auth` too (TASK-017, F-032): ADR-0050 splits Better
#   Auth's role out of `shortkit_app`, and a check that authenticated one runtime role would
#   go green against a stack whose init script never created the other -- the failure it
#   would miss is the one where `api` boots and the whole split is silently absent. Both
#   roles, one clause, and the reason string names the one that failed.
#
# THREE FLOW CLAUSES, AC-28's SENTENCE END TO END (TASK-017):
#   signup, sign-in and workspace creation, in that order, through the WEB APP at its
#   published port and never against the API directly, because AC-28's subject is an
#   operator with a browser and the web app's BFF route (apps/web/app/api/bff/[...path]/
#   route.ts, ADR-0014) is the transport a browser uses. The only inputs are HTTP requests
#   of the kind a browser makes: no fixture is inserted, and the address signed up has no
#   row in Better Auth's `user` table before the request (asserted) and one after (asserted),
#   so a 200 that Better Auth answers for a DUPLICATE address under `autoSignIn: false`
#   (ADR-0061) cannot pass this clause. Two things a browser does that `node -e` has to be
#   told to do: send an `Origin` header on state-changing requests -- the BFF answers 403
#   without one and `better-auth@1.6.26` answers `403 MISSING_OR_NULL_ORIGIN` -- and keep
#   the `HttpOnly` cookies sign-in sets and send them back. Over `http://` the cookies carry
#   no `Secure`, which is the only way they survive that origin (request-origin.ts).
#
#   `http://localhost:3000`, NOT `http://127.0.0.1:3000`, and the difference is two origin
#   checks: the BFF compares the request's `Origin` with the origin the request arrived on,
#   and forwards it to the API, whose `WEB_APP_ORIGINS` default in docker-compose.yml is
#   `http://localhost:3000` (ADR-0059). A request to 127.0.0.1 with a 127.0.0.1 origin passes
#   the first check and fails the second with `403 INVALID_ORIGIN`, which reads like an auth
#   defect and is not one.
#
#   These are transport-level. No tier in this repository drives a browser, and that
#   residual is stated in STORY-004 rather than closed here.
#
# FOUR INVITATION CLAUSES, THE SECOND HUMAN END TO END (TASK-1b-11, AC-1b-41, AC-1b-42):
#   the owner from AC-28 creates a second workspace and invites a fresh address to the first
#   one as `member` (AC-1b-e2e-1); the accept link is read out of `docker compose logs api`,
#   where the console transport prints one plain-text block per message with the URL on a
#   line of its own (AC-1b-e2e-2); the invitee signs up through the web app with the token
#   from the URL's fragment, which creates one `user` row and NO tenant (AC-1b-e2e-3); the
#   invitee signs in and the workspace list is exactly the granted workspace at `member`, an
#   archive and a rename are 403, the second workspace is 404, a second signup with the
#   same token is 409, and the owner's invitation list shows the row accepted (AC-1b-e2e-4).
#
#   THE TOKEN IS A BEARER CREDENTIAL AND IT IS NEVER PRINTED (F-379). It lives in a shell
#   variable, goes into two request bodies, and reaches no reason string, no note and no
#   file this script leaves behind. What IS asserted about it is where it appears in the
#   API log: on the console block's URL line and on no JSON line (SC-8), before the signup
#   and again after the whole flow.
#
#   `docker compose logs api` is the one command these clauses add. Reading a mail out of a
#   container log is exactly what D-02 traded for: without `console` there is no way for
#   this check, or a developer, to complete an invitation on this stack. A run against a
#   stack whose API is not printing mail is BLOCKED at AC-1b-e2e-2 with that reason, not
#   FAIL (AC-1b-42): nothing about the invitation path was measured, and the table says so.
#
# SEVEN REDIRECT CLAUSES, THE VISITOR'S LOOP END TO END (TASK-2-12, AC-2-44, SC-16):
#   the owner from AC-28 creates a link in the first workspace through the web app, on the
#   seeded system default domain (AC-2-e2e-1); the short link is followed on the API's own
#   published port and answers 302 with the stored destination byte for byte, plus
#   `Cache-Control: private, no-store` and `Referrer-Policy: unsafe-url` (AC-2-e2e-2); the
#   click that visit wrote is read back through the web app inside a bounded poll and the
#   response carries no address hash at any depth (AC-2-e2e-3); a PATCH of the destination is
#   serving on the redirect inside GC-2's five seconds (AC-2-e2e-4); `docker compose stop
#   redis` leaves the redirect answering 302 with the current destination, which is the only
#   place "degrades instead of failing" is measured against real containers (AC-2-e2e-5);
#   `start redis` brings the service back healthy with the redirect still answering
#   (AC-2-e2e-6); and a slug no link holds renders the 404 page with its own
#   `Content-Security-Policy` and no stack anywhere in the body (AC-2-e2e-7).
#
#   THE REDIRECT IS REACHED DIRECTLY AND NOT THROUGH THE WEB APP, which is the opposite of
#   AC-28's rule rather than an inconsistency with it. The visitor is anonymous, holds no
#   session and reaches no BFF: `GET /:slug` is registered OUTSIDE the `/api` prefix, on the
#   API's own listener (ADR-0006), and a browser that opened a short link never touched the
#   web app at all. Every management request in these clauses still goes through the web app,
#   exactly as AC-28's and the invitation clauses do.
#
# ENVIRONMENT KNOBS:
#   SHORTKIT_CHECK_KEEP_STACK=1    leave the stack up after the run (default: tear down).
#                                  The generated BETTER_AUTH_SECRET dies with this process
#                                  and is never printed (F-379), so it cannot be recovered.
#                                  Any further `docker compose` command against the kept
#                                  stack needs one exported: any value unblocks `ps`/`logs`,
#                                  but a DIFFERENT value plus `up` cannot decrypt the
#                                  existing jwks rows. Run `docker compose down -v` first
#                                  if you need the stack running again.
#   SHORTKIT_CHECK_UP_TIMEOUT=900  seconds allowed for each `up` (a cold first build)
#   SHORTKIT_CHECK_HEALTH_URL      default http://127.0.0.1:3001/health (ADR-0031)
#   SHORTKIT_CHECK_WEB_URL         default http://localhost:3000 (ADR-0031's web port; the
#                                  hostname is load-bearing, see the flow clauses above)
#   SHORTKIT_CHECK_REDIRECT_URL    default http://localhost:3001 (the API's published port,
#                                  where the redirect answers; the hostname is load-bearing
#                                  for a second reason, see the redirect clauses)

# ---------------------------------------------------------------------------
# Clause register. Every clause is declared up front with the result BLOCKED, so a run
# that aborts halfway still prints every clause and says which ones were never reached.
# A clause missing from the output would read as a clause that passed.
# ---------------------------------------------------------------------------

CLAUSE_IDS=()
CLAUSE_TEXT=()
CLAUSE_RESULT=()
CLAUSE_REASON=()

declare_clause() {
  CLAUSE_IDS+=("$1")
  CLAUSE_TEXT+=("$2")
  CLAUSE_RESULT+=('BLOCKED')
  CLAUSE_REASON+=('not reached')
}

set_result() { # id result reason
  local i
  for i in "${!CLAUSE_IDS[@]}"; do
    if [ "${CLAUSE_IDS[$i]}" = "$1" ]; then
      CLAUSE_RESULT[$i]="$2"
      CLAUSE_REASON[$i]="$3"
      printf '  %-10s %-6s %s\n' "$1" "$2" "$3" >&2
      return 0
    fi
  done
  printf 'check bug: no clause named %s\n' "$1" >&2
  exit 2
}

pass()    { set_result "$1" 'PASS' "$2"; }
fail()    { set_result "$1" 'FAIL' "$2"; }
blocked() { set_result "$1" 'BLOCK' "$2"; }

declare_clause 'AC-115.0' 'a compose file exists at the repository root and Compose can parse it'
declare_clause 'AC-115.1' 'the stack comes up from a clean state with one command'
declare_clause 'AC-115.2' 'Postgres reaches a healthy state'
declare_clause 'AC-115.3' 'the API reaches a healthy state'
declare_clause 'AC-115.4' 'the web app reaches a healthy state'
declare_clause 'GUARD-1'  'shortkit_app and shortkit_auth authenticate over TCP with the fixture passwords'
declare_clause 'GUARD-2'  'shortkit_app is refused over TCP with a wrong password'
declare_clause 'AC-115.5' 'the migrations have been applied: the schema they define is present'
declare_clause 'AC-115.6' 'every migration file in apps/api/drizzle is recorded as applied'
declare_clause 'AC-115.7' 'the seed has run: the demo tenant is present and the runtime role can read it'
declare_clause 'AC-115.8' 'GET /health on the composed API returns 200'
declare_clause 'AC-115.9' "GET /health on the composed API returns a body whose status is \"ok\""
declare_clause 'AC-28.1'  'signup through the web app succeeds for an address with no account, against a database with no seed data'
declare_clause 'AC-28.2'  'sign-in through the web app with those credentials returns a session'
declare_clause 'AC-28.3'  'a workspace created through the web app appears in the workspace list'
declare_clause 'AC-1b-e2e-1' 'the owner creates a second workspace and invites a fresh address to the first as member through the web app; the response carries no token'
declare_clause 'AC-1b-e2e-2' 'the invite URL is read from docker compose logs api: one console block for the address, the token on its URL line and on no JSON line'
declare_clause 'AC-1b-e2e-3' 'the invitee signs up through the web app with the token: one user row for the address, a member row in the owner tenant, and no new tenant'
declare_clause 'AC-1b-e2e-4' 'the invitee signs in and lists exactly the granted workspace as member; archive and rename are 403, the second workspace is 404, a second signup with the token is 409, the owner sees the invitation accepted'
declare_clause 'AC-2-e2e-1' 'the owner creates a link through the web app, on the seeded system default domain'
declare_clause 'AC-2-e2e-2' 'the short link answers 302 with the stored destination byte for byte, Cache-Control private, no-store and Referrer-Policy unsafe-url'
declare_clause 'AC-2-e2e-3' 'the click that visit wrote is readable through the web app inside the bound, and the response carries no address hash'
declare_clause 'AC-2-e2e-4' 'an edited destination is serving on the redirect within five seconds of the PATCH'
declare_clause 'AC-2-e2e-5' 'with the redis service stopped the redirect still answers 302 with the current destination'
declare_clause 'AC-2-e2e-6' 'redis started again reaches healthy and the redirect still answers 302'
declare_clause 'AC-2-e2e-7' 'a slug no link holds answers 404 with the redirect CSP and no stack in the body'
declare_clause 'DOD-1'    'docker compose up a second time succeeds'
declare_clause 'DOD-2'    'the second up did not double the seeded data'
declare_clause 'DOD-3'    'data survives docker compose restart'

summarise_and_exit() {
  local i worst=0
  printf '\n== clause table (AC-115, AC-28, AC-1b-e2e, AC-2-e2e) ==\n'
  for i in "${!CLAUSE_IDS[@]}"; do
    printf '%-10s %-6s %s\n           %s\n' \
      "${CLAUSE_IDS[$i]}" "${CLAUSE_RESULT[$i]}" "${CLAUSE_TEXT[$i]}" "-> ${CLAUSE_REASON[$i]}"
    [ "${CLAUSE_RESULT[$i]}" = 'PASS' ] || worst=1
  done
  printf '\n'
  if [ "$worst" -eq 0 ]; then
    printf 'AC-115, AC-28, AC-1b-e2e and AC-2-e2e: GREEN. Every clause passed.\n'
  else
    printf 'AC-115, AC-28, AC-1b-e2e or AC-2-e2e: RED. See the clause table above; each line fails on its own.\n'
  fi
  exit "$worst"
}

# ---------------------------------------------------------------------------
# Harness preconditions. A failure here is exit 2 and measures nothing.
# ---------------------------------------------------------------------------

refuse() {
  printf '\ncannot run the AC-115 check: %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  printf '\nNothing was measured. This is not an AC-115 result.\n' >&2
  exit 2
}

command -v git >/dev/null 2>&1 || refuse 'git is not on PATH, and the check has to run from the repository root.'
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

command -v docker >/dev/null 2>&1 || refuse 'docker is not on PATH.'
docker compose version >/dev/null 2>&1 || refuse \
  'docker compose (v2 or later) is not available.' \
  'ADR-0033 depends on `service_completed_successfully`, which is Compose v2 and later.'
docker info >/dev/null 2>&1 || refuse 'the Docker daemon is not reachable.'

# node, and only node. The repository declares `engines.node >= 24.13.0`, the API and web
# health probes are `node -e` one-liners for the same reason (ADR-0036), and this avoids
# depending on jq or curl being installed. It is used for JSON and for one HTTP request.
command -v node >/dev/null 2>&1 || refuse \
  'node is not on PATH.' \
  'It is used to make the HTTP requests and to parse the JSON they answer.' \
  'The repository already requires node >= 24.13.0 in package.json engines.'

# "A machine with only Docker and a clone of this repository." Three kinds of local
# contamination make a broken stack look green here and red on that machine, so the check
# refuses rather than measuring something that is not AC-115.
#
# The sharp one is the middle block. `configs.*.content` and `healthcheck.test` are
# interpolated by Compose against the HOST environment. If the compose file writes a
# single `$SHORTKIT_APP_PASSWORD` where ADR-0031 requires `$$SHORTKIT_APP_PASSWORD`, then
# a developer who happens to have that variable exported gets a working stack and AC-115's
# own machine gets two passwordless roles. Exporting it hides exactly the defect the
# design pass measured twice.
#
# SHORTKIT_AUTH_PASSWORD is the fourth (F-037): ADR-0050's role, created by the same init
# script with the same `$$` escape, and left out of this list it is the one exported value
# that silently repairs a missing escape for that role -- an empty-password shortkit_auth is
# not loginable externally, so this is availability rather than exposure, and it is still the
# class of hole this guard exists to close, one variable wide.
for contaminant in POSTGRES_USER SHORTKIT_MIGRATOR_PASSWORD SHORTKIT_APP_PASSWORD SHORTKIT_AUTH_PASSWORD; do
  if [ -n "${!contaminant:-}" ]; then
    refuse "\$${contaminant} is exported in this shell." \
      'AC-115 describes a machine with only Docker and a clone, where it is unset.' \
      'Compose interpolates configs.*.content and healthcheck.test against the host' \
      'environment at parse time (F-315, F-316), so an exported value here silently' \
      'repairs a missing `$$` escape and turns a stack that is red on a clean machine' \
      'green on yours. Run this in a shell that does not have it.'
  fi
done

if [ -f "$REPO_ROOT/.env" ]; then
  refuse 'there is a .env at the repository root.' \
    'Compose reads it for interpolation, so it masks the same defect an exported' \
    'variable masks, and it does not exist on a fresh clone: .env is gitignored.' \
    'Move it aside for the duration of this check.'
fi

for override in compose.override.yaml compose.override.yml \
                docker-compose.override.yaml docker-compose.override.yml; do
  if [ -f "$REPO_ROOT/$override" ] && ! git ls-files --error-unmatch "$override" >/dev/null 2>&1; then
    refuse "there is an untracked $override at the repository root." \
      'Compose merges it into every `docker compose up`, so it is not in the clone' \
      'AC-115 describes. Move it aside for the duration of this check.'
  fi
done

# Names, never values (F-379). `refuse` twenty lines up prints the NAME of a contaminating
# variable and nothing else; these notices are the same class of message and print the same
# thing. POSTGRES_SUPERUSER_PASSWORD is in this list, `.env.example` invites overriding it
# BY NAME, and this repository's convention is to paste check output verbatim into a
# committed report, so a value printed here reaches a terminal scrollback, a captured log
# and plausibly a public repository, from which a credential is rotated rather than deleted.
#
# The NAME is still printed, for the secret-shaped one too, rather than a count or a
# category. A name is not a secret: POSTGRES_SUPERUSER_PASSWORD is committed in
# `.env.example`. And the name is the entire actionable content of a message whose only
# claim is "this check does not assert it": "one credential variable is exported" leaves
# the reader nothing to unset.
#
# The two loops after the first are an assertion, not decoration. They re-read the text the
# first one produced and will not let it out if an exported value turns up inside, because
# putting `(%s)` and `"${!noisy}"` back is a one-token edit that reads as an improvement and
# F-379 is what it costs. The notices are built into a variable rather than printed as they
# are produced for exactly this reason: nothing can be asserted about a line already on the
# terminal.
#
# Two loops, not one, because this list holds two classes of name. A value that appears
# inside the notice text is a REINTRODUCED LEAK if the name is credential-shaped, and is far
# likelier to be a COINCIDENCE if it is not -- `COMPOSE_PROJECT_NAME=check` collides with the
# word "check" in the message and is a name someone would really choose. So the credential
# pass fails closed (exit 2, nothing measured, not one notice printed), and the other pass
# drops the notices, which are a courtesy, and says so without saying what collided. The
# credential pass is matched on the name's shape rather than a second hand-written list, so
# a name added to NOISY_NAMES later gets the strict half by default.
NOISY_NAMES=(GIT_COMMIT_SHA POSTGRES_SUPERUSER_PASSWORD COMPOSE_PROJECT_NAME)
NOISY_NOTES=''
for noisy in "${NOISY_NAMES[@]}"; do
  if [ -n "${!noisy:-}" ]; then
    NOISY_NOTES+="$(printf 'note: $%s is exported. AC-115 does not require it and this check does not assert it.' \
      "$noisy")"$'\n'
  fi
done

for noisy in "${NOISY_NAMES[@]}"; do
  noisy_value="${!noisy:-}"
  [ -n "$noisy_value" ] || continue
  case "$noisy" in *PASSWORD*|*SECRET*|*TOKEN*|*KEY*) ;; *) continue ;; esac
  case "$NOISY_NOTES" in
    *"$noisy_value"*)
      refuse "the notice for \$${noisy} would have printed its value, and this check prints no values." \
        'Its output is pasted verbatim into committed reports, so a value written here' \
        'leaves the machine and gets rotated rather than deleted (F-379). Nothing was' \
        'printed and nothing was measured.' \
        'Look at the printf that builds NOISY_NOTES: it interpolates the NAME, only.' \
        'If that printf is already correct then the value of this variable happens to be' \
        'a word inside the notice text. Unset it and re-run.'
      ;;
  esac
done

for noisy in "${NOISY_NAMES[@]}"; do
  noisy_value="${!noisy:-}"
  [ -n "$noisy_value" ] || continue
  case "$NOISY_NOTES" in
    *"$noisy_value"*)
      NOISY_NOTES=''
      printf 'note: the exported-variable notices were dropped. The value of $%s occurs inside their text, which is either a coincidence or a value being printed where only names may be (F-379). Nothing depends on these notices.\n' \
        "$noisy" >&2
      break
      ;;
  esac
done

printf '%s' "$NOISY_NOTES" >&2

# COMPOSE_FILE would silently retarget every `docker compose` below at something other
# than the repository root's file, which is the one AC-115 names.
if [ -n "${COMPOSE_FILE:-}" ]; then
  printf 'note: unsetting $COMPOSE_FILE (%s); AC-115 is about the file at the repository root.\n' \
    "$COMPOSE_FILE" >&2
  unset COMPOSE_FILE
fi

# MAIL_TRANSPORT is the same class of variable one service down: `docker-compose.yml` writes
# `${MAIL_TRANSPORT:-console}` (D-02) so a developer can run the silent stack with an
# exported `none`, and an exported value here would put a stack in front of the invitation
# clauses that is not the one the file declares. Unset, with a note; the value is a
# transport name, not a secret, so printing it is fine (F-379 is about credentials).
if [ -n "${MAIL_TRANSPORT:-}" ]; then
  printf 'note: unsetting $MAIL_TRANSPORT (%s); the invitation clauses measure the transport docker-compose.yml declares.\n' \
    "$MAIL_TRANSPORT" >&2
  unset MAIL_TRANSPORT
fi

# ADR-0051: `docker-compose.yml:295` carries no default for BETTER_AUTH_SECRET any more,
# so this harness generates one and exports it for the duration of this run. It must land
# before `trap cleanup EXIT` below, not merely before the first `docker compose config` --
# `cleanup()` itself runs `docker compose down -v`, which parses the file. One value for
# the whole run: DOD-1's second `up` and DOD-3's `restart` share the volume, and a second
# value mid-run would fail to decrypt the previous run's `jwks.privateKey`. It overrides
# anything inherited, the same idiom as APP_PASSWORD below, so a developer's own export
# cannot turn AC-115.3 red for their shell. Never written to disk, never printed (F-379):
# only the name may appear in a message here, never the value.
BETTER_AUTH_SECRET="$(node -e '
  console.log(require("node:crypto").randomBytes(32).toString("base64url"));
')" || refuse 'could not generate a BETTER_AUTH_SECRET value.' \
     'node -e failed generating 32 random bytes as base64url; see the error above.'
[ -n "$BETTER_AUTH_SECRET" ] || refuse 'node produced an empty BETTER_AUTH_SECRET value.'
[ "${#BETTER_AUTH_SECRET}" -ge 32 ] || refuse \
  'the generated BETTER_AUTH_SECRET is shorter than the 32 characters ADR-0051 requires.' \
  '43 characters is what 32 base64url-encoded bytes should produce; something upstream' \
  'of this check changed shape. Name only, never the value (F-379).'
export BETTER_AUTH_SECRET

TMPDIR_CHECK="$(mktemp -d)"
STACK_OWNED=0

cleanup() {
  local status=$?
  # Tear the stack down only if this run established that the project is ours. Never
  # touch a project this check refused to take over.
  if [ "$STACK_OWNED" -eq 1 ] && [ -z "${SHORTKIT_CHECK_KEEP_STACK:-}" ]; then
    printf '\n-- tearing down (SHORTKIT_CHECK_KEEP_STACK=1 to keep it)\n' >&2
    docker compose down -v --rmi local --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$TMPDIR_CHECK"
  return "$status"
}
trap cleanup EXIT

UP_TIMEOUT="${SHORTKIT_CHECK_UP_TIMEOUT:-900}"
HEALTH_URL="${SHORTKIT_CHECK_HEALTH_URL:-http://127.0.0.1:3001/health}"
WEB_URL="${SHORTKIT_CHECK_WEB_URL:-http://localhost:3000}"
WEB_URL="${WEB_URL%/}"
# Where the redirect answers: the API's own published port, outside the `/api` prefix
# (ADR-0006). The HOSTNAME is what the seeded system default domain row is matched on; see
# the redirect clauses. `REDIRECT_HOSTNAME` is derived from this one value rather than
# written twice, so an override moves both.
REDIRECT_URL="${SHORTKIT_CHECK_REDIRECT_URL:-http://localhost:3001}"
REDIRECT_URL="${REDIRECT_URL%/}"
REDIRECT_HOSTNAME="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$REDIRECT_URL")"

# ADR-0031's fixture defaults, and they are literals here on purpose: the harness refuses
# to run with the override exported, so this is the password the stack must have set. A
# check that read the password out of the container would agree with a container that set
# no password at all.
APP_ROLE='shortkit_app'
APP_PASSWORD='app'
AUTH_ROLE='shortkit_auth'   # ADR-0050: Better Auth's role, and nothing else connects as it
AUTH_PASSWORD='auth'
APP_DATABASE='shortkit'
SUPERUSER='postgres'
DEMO_TENANT_ID='00000000-0000-4000-8000-000000000001'  # frozen by ADR-0034

with_timeout() { # seconds cmd...
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

# ---------------------------------------------------------------------------
# AC-115.0: is there anything to measure at all
# ---------------------------------------------------------------------------

printf '\n== AC-115: %s ==\n' "$REPO_ROOT" >&2

COMPOSE_FILE_FOUND=''
for candidate in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  if [ -f "$REPO_ROOT/$candidate" ]; then COMPOSE_FILE_FOUND="$REPO_ROOT/$candidate"; break; fi
done

if [ -z "$COMPOSE_FILE_FOUND" ]; then
  fail 'AC-115.0' 'no compose file at the repository root (looked for compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml). `docker compose up` has nothing to run.'
  blocked 'AC-115.1' 'no compose file: nothing was started'
  blocked 'AC-115.2' 'no compose file: no Postgres container exists to be healthy'
  blocked 'AC-115.3' 'no compose file: no API container exists to be healthy'
  blocked 'AC-115.4' 'no compose file: no web container exists to be healthy'
  blocked 'GUARD-1'  'no compose file: no database to authenticate against'
  blocked 'GUARD-2'  'no compose file: no database to authenticate against'
  blocked 'AC-115.5' 'no compose file: no database to inspect for the migrated schema'
  blocked 'AC-115.6' 'no compose file: no database to inspect for applied migrations'
  blocked 'AC-115.7' 'no compose file: no database to inspect for the seeded demo tenant'
  blocked 'AC-115.8' 'no compose file: nothing is serving /health'
  blocked 'AC-115.9' 'no compose file: nothing is serving /health'
  blocked 'AC-28.1'  'no compose file: no web app to sign up through'
  blocked 'AC-28.2'  'no compose file: no web app to sign in through'
  blocked 'AC-28.3'  'no compose file: no web app to create a workspace through'
  blocked 'AC-1b-e2e-1' 'no compose file: no web app to invite through'
  blocked 'AC-1b-e2e-2' 'no compose file: no API log to read an invite URL from'
  blocked 'AC-1b-e2e-3' 'no compose file: no web app to sign the invitee up through'
  blocked 'AC-1b-e2e-4' 'no compose file: no web app to sign the invitee in through'
  blocked 'AC-2-e2e-1' 'no compose file: no web app to create a link through'
  blocked 'AC-2-e2e-2' 'no compose file: nothing is serving the redirect'
  blocked 'AC-2-e2e-3' 'no compose file: no redirect was served, so no click exists to read'
  blocked 'AC-2-e2e-4' 'no compose file: no link to edit and no redirect to follow it'
  blocked 'AC-2-e2e-5' 'no compose file: there is no redis service to stop'
  blocked 'AC-2-e2e-6' 'no compose file: there is no redis service to start'
  blocked 'AC-2-e2e-7' 'no compose file: nothing is serving the 404'
  blocked 'DOD-1'    'no compose file: a second up cannot be attempted'
  blocked 'DOD-2'    'no compose file: there is no seeded data to count'
  blocked 'DOD-3'    'no compose file: there is nothing to restart'
  summarise_and_exit
fi

if ! docker compose config --format json >"$TMPDIR_CHECK/config.json" 2>"$TMPDIR_CHECK/config.err"; then
  fail 'AC-115.0' "compose file $(basename "$COMPOSE_FILE_FOUND") exists but Compose cannot parse it: $(tr '\n' ' ' <"$TMPDIR_CHECK/config.err" | cut -c1-300)"
  blocked 'AC-115.1' 'the compose file does not parse, so nothing was started'
  summarise_and_exit
fi
pass 'AC-115.0' "$(basename "$COMPOSE_FILE_FOUND") parses"

# The interpolation diagnostic, and it is a hint rather than a clause.
#
# Compose warns once per unresolved reference at parse time. On this machine, with
# nothing exported and no .env, a reference that should have been written `$$NAME` and was
# written `$NAME` warns here and is then substituted with the empty string (F-315, F-316).
# A correctly escaped `$$NAME` emits NO warning at all, because the lexer consumes the
# escape before it looks for a name -- so the ABSENCE of a warning is the signal, and its
# presence names the variable that will reach the container empty. Every reference the
# ADRs specify carries a `:-default`, so a warning here always means something is wrong.
INTERP_HINT=''
docker compose config -q >/dev/null 2>"$TMPDIR_CHECK/interp.err" || true
INTERP_UNSET="$(sed -n 's/.*The [^A-Za-z0-9_]*\([A-Za-z0-9_]\{1,\}\)[^A-Za-z0-9_]* variable is not set.*/\1/p' \
  "$TMPDIR_CHECK/interp.err" | sort -u | tr '\n' ' ' | sed 's/ $//')"
if [ -n "$INTERP_UNSET" ]; then
  INTERP_HINT=" [Compose reported these variables unset at parse time and substituted the empty string: ${INTERP_UNSET}. A single \$ in configs.*.content, healthcheck.test or command is interpolated against the HOST environment, which is empty on AC-115's machine -- F-315, F-316. It must be written \$\$.]"
  printf '\n!! %s\n' "$INTERP_HINT" >&2
fi

PROJECT_NAME="$(node -e 'const fs=require("node:fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).name||"")' "$TMPDIR_CHECK/config.json")"
[ -n "$PROJECT_NAME" ] || refuse 'Compose reported no project name; cannot tell this stack apart from another.'

# The project name is the directory basename (ADR-0032, F-318), and `docker-compose.test.yml`
# lives in this same directory and also declares a service named `postgres`. So both stacks
# land in one Compose project, and `up` or `down -v` here would recreate or delete the
# integration suite's container even though ADR-0031 puts the two databases on different
# ports. Ports do not separate Compose stacks; the project name does. Refuse rather than
# clobber someone else's container.
FOREIGN=''
while read -r cfg; do
  [ -n "$cfg" ] || continue
  case ",$cfg," in
    *",$COMPOSE_FILE_FOUND,"*) ;;
    *) FOREIGN="$cfg" ;;
  esac
done < <(docker ps -a --filter "label=com.docker.compose.project=$PROJECT_NAME" \
           --format '{{.Label "com.docker.compose.project.config_files"}}' | sort -u)

if [ -n "$FOREIGN" ]; then
  refuse "Compose project '$PROJECT_NAME' already holds containers from another compose file." \
    "  $FOREIGN" \
    'They share a project name because Compose derives it from the directory basename,' \
    'so this check would recreate or delete those containers. Stop that stack first:' \
    "  docker compose -f $FOREIGN down" \
    'or give one of the two stacks its own COMPOSE_PROJECT_NAME.'
fi

STACK_OWNED=1

# ---------------------------------------------------------------------------
# AC-115.1: one command, from a clean state
#
# "A machine with only Docker and a clone" has no volume, no image and no container.
# `down -v` alone removes the volume and leaves the images, which skips the build the
# ADR-0037 null-SHA default lives in, so the card's DoD names `--rmi local` and so does
# this. `--rmi local` removes only images with no custom tag, so `postgres:17-alpine`
# stays pulled and other projects keep theirs.
#
# Without this, a warm `pgdata` makes AC-115.5 and AC-115.7 pass over a stack whose
# migration and seed never ran on this invocation: the Postgres entrypoint runs
# /docker-entrypoint-initdb.d only against an empty data directory (ADR-0032).
# ---------------------------------------------------------------------------

printf '\n-- clean state: docker compose down -v --rmi local --remove-orphans\n' >&2
docker compose down -v --rmi local --remove-orphans || true

printf '\n-- docker compose up -d --wait   (AC-115 names bare `docker compose up`; `-d --wait`\n' >&2
printf '   is the same start that returns only when every service is healthy or has\n' >&2
printf '   completed successfully -- ADR-0036 names it as the form a check should use)\n' >&2

if with_timeout "$UP_TIMEOUT" docker compose up -d --wait; then
  pass 'AC-115.1' 'up -d --wait returned 0 from a state with no volume, no container and no built image'
  UP_OK=1
else
  rc=$?
  UP_OK=0
  if [ "$rc" -eq 124 ]; then
    fail 'AC-115.1' "up -d --wait did not return within ${UP_TIMEOUT}s"
  else
    fail 'AC-115.1' "up -d --wait exited $rc; the failing service is named in the output above"
  fi
fi

# ---------------------------------------------------------------------------
# AC-115.2 / .3 / .4: "Postgres, the API and the web app all reach a healthy state"
#
# Service names come from ADR-0036's ordering table and ADR-0033's chain. They are
# normative, not incidental: AC-115 names three things and something has to identify
# which container is which.
#
# These are evaluated even when AC-115.1 failed, because "which one did not go healthy"
# is the whole diagnostic and `up` failing tells you only that something did not.
# ---------------------------------------------------------------------------

service_health() { # service -> healthy | unhealthy | starting | NO-HEALTHCHECK | NO-CONTAINER | NO-SUCH-SERVICE
  local svc="$1" cid
  if ! cid="$(docker compose ps --all -q "$svc" 2>/dev/null)"; then echo 'NO-SUCH-SERVICE'; return; fi
  cid="$(printf '%s' "$cid" | head -n1)"
  if [ -z "$cid" ]; then echo 'NO-CONTAINER'; return; fi
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}NO-HEALTHCHECK{{end}}' "$cid" 2>/dev/null \
    || echo 'NO-CONTAINER'
}

assert_healthy() { # clause service label [hint]
  local clause="$1" svc="$2" label="$3" hint="${4:-}" state
  state="$(service_health "$svc")"
  case "$state" in
    healthy)
      pass "$clause" "service '$svc' is healthy" ;;
    NO-SUCH-SERVICE)
      fail "$clause" "the compose file defines no service named '$svc', so $label cannot be identified (ADR-0036 names it)" ;;
    NO-CONTAINER)
      fail "$clause" "service '$svc' has no container: it was never created" ;;
    NO-HEALTHCHECK)
      fail "$clause" "service '$svc' declares no healthcheck, so '$label reaches a healthy state' is unobservable (ADR-0036 specifies one)" ;;
    *)
      fail "$clause" "service '$svc' is '$state', not healthy${hint}" ;;
  esac
}

printf '\n-- health\n' >&2
assert_healthy 'AC-115.2' 'postgres' 'Postgres' "$INTERP_HINT"
assert_healthy 'AC-115.3' 'api'      'the API'
assert_healthy 'AC-115.4' 'web'      'the web app'

# ---------------------------------------------------------------------------
# GUARD-1 / GUARD-2: the roles are real
#
# Both run psql inside the Postgres container, with a password this script supplies and
# never one the container supplies, AND over an address the server does not trust.
#
# NOT 127.0.0.1, and this is measured rather than assumed. `postgres:17-alpine` generates
# this pg_hba.conf:
#
#     local  all all                 trust
#     host   all all 127.0.0.1/32    trust     <-- initdb's default, always present
#     host   all all ::1/128         trust
#     host   all all all             scram-sha-256   <-- appended by the entrypoint
#
# So a probe that connects to 127.0.0.1 from inside the container never authenticates:
# PGPASSWORD is ignored on that line. Connecting to the container's own bridge address
# falls through to the last line and is a real scram-sha-256 exchange. Verified on
# postgres:17-alpine 2026-08-11: wrong password to 127.0.0.1 -> accepted; wrong password
# to the bridge address -> `FATAL: password authentication failed for user shortkit_app`.
# ---------------------------------------------------------------------------

PG_CONTAINER_IP=''
if PG_CONTAINER_IP="$(docker compose exec -T postgres sh -c 'hostname -i' 2>/dev/null | tr -d '\r' | awk '{print $1}')"; then :; fi

psql_app() { # sql -> stdout, non-zero on any psql error
  docker compose exec -T -e "PGPASSWORD=$APP_PASSWORD" postgres \
    psql -v ON_ERROR_STOP=1 -h "$PG_CONTAINER_IP" -p 5432 -U "$APP_ROLE" -d "$APP_DATABASE" -tAc "$1"
}

# The same exchange as shortkit_auth (ADR-0050). Used by GUARD-1 and by nothing after it:
# no clause reads Better Auth's tables as this role, the API does that.
psql_auth() { # sql -> stdout, non-zero on any psql error
  docker compose exec -T -e "PGPASSWORD=$AUTH_PASSWORD" postgres \
    psql -v ON_ERROR_STOP=1 -h "$PG_CONTAINER_IP" -p 5432 -U "$AUTH_ROLE" -d "$APP_DATABASE" -tAc "$1"
}

# The superuser over the unix socket, which the postgres image's generated pg_hba trusts.
# Needed for exactly two things `shortkit_app` cannot do and must not be able to do:
# read `drizzle.__drizzle_migrations` (no USAGE on schema drizzle) and count every row in
# `tenants` (RLS shows it only the tenant matching app.tenant_id, so it cannot see a
# duplicate the seed created under another id).
psql_super() { # sql -> stdout
  docker compose exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "$SUPERUSER" -d "$APP_DATABASE" -tAqc "$1"
}

# Compose writes its own `time=... level=warning` lines to the same stderr psql writes to,
# and they are long enough to push the actual error past any truncation. They are not
# discarded: the interpolation diagnostic below reads them deliberately.
one_line() {
  { grep -v 'level=\(warning\|info\)' || true; } | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//' | cut -c1-300
}

printf '\n-- roles\n' >&2
if [ -z "$PG_CONTAINER_IP" ]; then
  APP_AUTH_OK=0
  fail 'GUARD-1' "the postgres container's own address could not be determined, so no authenticated connection could be made"
  fail 'GUARD-2' "the postgres container's own address could not be determined, so nothing was established"
elif ! psql_app 'select 1' >"$TMPDIR_CHECK/guard1.out" 2>"$TMPDIR_CHECK/guard1.err"; then
  APP_AUTH_OK=0
  fail 'GUARD-1' "$APP_ROLE could not authenticate over TCP with the fixture password: $(one_line <"$TMPDIR_CHECK/guard1.err")${INTERP_HINT}"
elif ! psql_auth 'select 1' >"$TMPDIR_CHECK/guard1-auth.out" 2>"$TMPDIR_CHECK/guard1-auth.err"; then
  # shortkit_app is fine, so the clauses that read as it still run; the third role is what
  # is missing, and that is the ADR-0050 split silently absent (F-032).
  APP_AUTH_OK=1
  fail 'GUARD-1' "$APP_ROLE authenticated, but $AUTH_ROLE could not authenticate over TCP with the fixture password (ADR-0050's role is missing or has no password): $(one_line <"$TMPDIR_CHECK/guard1-auth.err")${INTERP_HINT}"
else
  pass 'GUARD-1' "$APP_ROLE and $AUTH_ROLE authenticated over TCP with the fixture passwords"
  APP_AUTH_OK=1
fi

if [ -n "$PG_CONTAINER_IP" ]; then
  WRONG_PASSWORD="not-the-password-$RANDOM$RANDOM"
  if docker compose exec -T -e "PGPASSWORD=$WRONG_PASSWORD" postgres \
       psql -v ON_ERROR_STOP=1 -h "$PG_CONTAINER_IP" -p 5432 -U "$APP_ROLE" -d "$APP_DATABASE" -tAc 'select 1' \
       >"$TMPDIR_CHECK/guard2.out" 2>"$TMPDIR_CHECK/guard2.err"; then
    fail 'GUARD-2' "$APP_ROLE was accepted with a wrong password on a non-loopback address: the role has no password, or host auth is trust (ADR-0036 names POSTGRES_HOST_AUTH_METHOD=trust as the repair that is a security defect)"
  else
    err="$(one_line <"$TMPDIR_CHECK/guard2.err")"
    case "$err" in
      *authentication*|*password*)
        pass 'GUARD-2' 'a wrong password is refused on a non-loopback address, so host auth is not trust (GUARD-1 is the half that establishes the password is the fixture one)' ;;
      *)
        fail 'GUARD-2' "the wrong-password connection failed for a reason that is not authentication, so nothing was established: ${err}${INTERP_HINT}" ;;
    esac
  fi
fi

# ---------------------------------------------------------------------------
# AC-115.5 / .6: "the migrations have been applied"
#
# .5 is the effect: the schema the migration in this repository defines is present, read
# through pg_class as shortkit_app. Never information_schema: it is privilege-filtered by
# the SQL standard, and as this role it answers "nothing is there" when it means "I cannot
# see it" (F-213).
#
# .6 is the bookkeeping, and it is the half that does not rot: it compares the number of
# migration files in the working tree against the number drizzle-kit recorded as applied,
# so a second migration that never ran is red here even though the first table exists.
# ---------------------------------------------------------------------------

printf '\n-- migrations\n' >&2
if [ "$APP_AUTH_OK" -eq 1 ]; then
  if out="$(psql_app "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'tenants' and c.relkind in ('r','p')" 2>"$TMPDIR_CHECK/m5.err")"; then
    out="$(printf '%s' "$out" | tr -d '[:space:]')"
    if [ "$out" = '1' ]; then
      pass 'AC-115.5' "table public.tenants exists in database $APP_DATABASE"
    else
      fail 'AC-115.5' "table public.tenants does not exist in database $APP_DATABASE: the migration in apps/api/drizzle was not applied"
    fi
  else
    fail 'AC-115.5' "could not query the catalogue as $APP_ROLE: $(one_line <"$TMPDIR_CHECK/m5.err")"
  fi
else
  blocked 'AC-115.5' "GUARD-1 failed, so the schema could not be read as $APP_ROLE"
fi

MIGRATION_FILES="$(find "$REPO_ROOT/apps/api/drizzle" -maxdepth 1 -name '*.sql' -type f 2>/dev/null | wc -l | tr -d '[:space:]')"
if [ "$MIGRATION_FILES" = '0' ]; then
  blocked 'AC-115.6' 'there are no .sql files under apps/api/drizzle, so there is nothing to have applied'
elif applied="$(psql_super 'select count(*) from drizzle.__drizzle_migrations' 2>"$TMPDIR_CHECK/m6.err")"; then
  applied="$(printf '%s' "$applied" | tr -d '[:space:]')"
  if [ "${applied:-0}" -ge "$MIGRATION_FILES" ] 2>/dev/null; then
    pass 'AC-115.6' "$applied migration(s) recorded applied for $MIGRATION_FILES migration file(s)"
  else
    fail 'AC-115.6' "$MIGRATION_FILES migration file(s) in apps/api/drizzle, only $applied recorded as applied"
  fi
else
  fail 'AC-115.6' "drizzle's bookkeeping table is not readable, so no migration was applied by drizzle-kit: $(one_line <"$TMPDIR_CHECK/m6.err")"
fi

# ---------------------------------------------------------------------------
# AC-115.7: "the seed has run"
#
# Asserted as its effect and read as shortkit_app, which is the connection ADR-0033 makes
# load-bearing: `ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator` grants this role DML
# only on tables that identity created, so a stack that migrated as anyone else answers
# `permission denied for table tenants` here rather than a row count.
#
# `tenants` carries FORCE ROW LEVEL SECURITY and `tenants_self_select` admits only the row
# whose id equals current_setting('app.tenant_id'), so the flag is set first. That is the
# same statement shape tenant-context.md specifies.
#
# THE THIRD ARGUMENT IS `true`, transaction-scoped, which is the normative form (GC-5,
# rls-policy-template.md, seed.mts:246) and no query path is exempt from it including this
# one (F-381). It is correct here and not merely copied: psql documents that a `-c` string
# holding multiple commands is processed in ONE implicit transaction, so the `select count`
# that follows the semicolon runs inside the transaction the setting is scoped to. A
# session-scoped `false` would also work in a one-shot psql, and that is exactly why it does
# not belong here: this file is the kind of worked example someone lifts into a pooled
# connection, where `false` leaks one tenant's id onto the next request that borrows it.
#
# The tenant id is interpolated rather than bound, which the normative form does with $1.
# `psql -c` takes no bind parameters. It is safe only because DEMO_TENANT_ID is a literal
# frozen by ADR-0034 forty lines above and never reaches this script from outside it; a
# value from anywhere else must be bound, not pasted.
# ---------------------------------------------------------------------------

printf '\n-- seed\n' >&2
seed_row_visible() {
  psql_app "select set_config('app.tenant_id', '$DEMO_TENANT_ID', true); select count(*) from tenants where id = '$DEMO_TENANT_ID'" \
    2>"$TMPDIR_CHECK/seed.err" | tail -n1 | tr -d '[:space:]'
}

if [ "$APP_AUTH_OK" -eq 1 ]; then
  if visible="$(seed_row_visible)" && [ -n "$visible" ]; then
    if [ "$visible" = '1' ]; then
      pass 'AC-115.7' "the demo tenant $DEMO_TENANT_ID is present and readable by $APP_ROLE"
    else
      fail 'AC-115.7' "the demo tenant $DEMO_TENANT_ID is not in table tenants: the seed did not run, or it wrote a different id (ADR-0034 freezes this one)"
    fi
  else
    fail 'AC-115.7' "could not read table tenants as $APP_ROLE: $(one_line <"$TMPDIR_CHECK/seed.err")"
  fi
else
  blocked 'AC-115.7' "GUARD-1 failed, so table tenants could not be read as $APP_ROLE"
fi

# ---------------------------------------------------------------------------
# AC-115.8 / .9: GET /health on the composed API
#
# One request, two clauses: a 502 and a 200 with the wrong body are different defects.
# From the host against the published port, because "on the composed API" is what an
# auditor with a browser would do, and ADR-0031 fixes the binding at 127.0.0.1:3001.
# The `commit` field is deliberately not read (ADR-0037).
# ---------------------------------------------------------------------------

printf '\n-- GET %s\n' "$HEALTH_URL" >&2
node -e '
const fs = require("node:fs");
const [url, statusFile, bodyFile] = process.argv.slice(1);
fetch(url, { signal: AbortSignal.timeout(15000) })
  .then(async (r) => {
    fs.writeFileSync(statusFile, String(r.status));
    fs.writeFileSync(bodyFile, await r.text());
  })
  .catch((e) => {
    fs.writeFileSync(statusFile, "TRANSPORT-ERROR");
    fs.writeFileSync(bodyFile, String((e && e.message) || e));
  });
' "$HEALTH_URL" "$TMPDIR_CHECK/health.status" "$TMPDIR_CHECK/health.body" || true

HTTP_STATUS="$(cat "$TMPDIR_CHECK/health.status" 2>/dev/null || echo 'NO-REQUEST')"
if [ "$HTTP_STATUS" = '200' ]; then
  pass 'AC-115.8' "$HEALTH_URL returned 200"
elif [ "$HTTP_STATUS" = 'TRANSPORT-ERROR' ]; then
  fail 'AC-115.8' "$HEALTH_URL could not be reached: $(one_line <"$TMPDIR_CHECK/health.body")"
else
  fail 'AC-115.8' "$HEALTH_URL returned $HTTP_STATUS, not 200"
fi

if [ -s "$TMPDIR_CHECK/health.body" ] && [ "$HTTP_STATUS" != 'TRANSPORT-ERROR' ]; then
  BODY_STATUS="$(node -e '
    const fs = require("node:fs");
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch { console.log("NOT-JSON"); process.exit(0); }
    console.log(typeof parsed.status === "string" ? parsed.status : "ABSENT");
  ' "$TMPDIR_CHECK/health.body")"
  case "$BODY_STATUS" in
    ok)       pass 'AC-115.9' 'the response body has status "ok"' ;;
    NOT-JSON) fail 'AC-115.9' "the response body is not JSON: $(one_line <"$TMPDIR_CHECK/health.body")" ;;
    ABSENT)   fail 'AC-115.9' 'the response body has no string `status` field' ;;
    *)        fail 'AC-115.9' "the response body has status \"$BODY_STATUS\", not \"ok\"" ;;
  esac
else
  blocked 'AC-115.9' 'no response body to read'
fi

# ---------------------------------------------------------------------------
# AC-28.1 / .2 / .3: signup, sign-in, workspace creation, through the web app (TASK-017)
#
# Every request goes to WEB_URL, the web app's published port, and reaches the API only
# through apps/web/app/api/bff/[...path]/route.ts -- the leg a browser takes (ADR-0014).
# `bff` below is the browser: it sends `Origin` on every request (the BFF's CSRF check and
# better-auth's origin check both refuse a state-changing request without one), keeps every
# `Set-Cookie` in a jar under $TMPDIR_CHECK and sends the jar back as `Cookie`, exactly as
# a browser does with the two HttpOnly cookies sign-in sets (`sk_at`, `sk_rt`).
#
# Placed here, after /health and BEFORE the second `up` and the `restart`, because these
# three need `api` and `web` healthy and DOD-3's `restart` puts both through a boot the
# script only waits out for postgres. DOD-2's census is taken after this block, so the tenant
# signup provisions (ADR-0054) is inside both of its counts and does not read as a doubling.
#
# NO SEED DATA, ASSERTED RATHER THAN ASSUMED: the address is generated by this run, and
# Better Auth's `user` table is counted for it before the request (must be 0) and after
# (must be 1), read by the superuser over the unix socket because that table is
# `shortkit_auth`'s (ADR-0050) and `shortkit_app` holds no grant on it. The count after is
# what makes the 200 mean something: under `autoSignIn: false` better-auth answers 200 for
# an address that already exists (ADR-0061), so the status alone would pass a stack whose
# signup wrote nothing. The address is bound as a psql variable, never pasted (the rule the
# AC-115.7 comment states for a value that is not a frozen literal).
#
# NOTHING FROM THESE REQUESTS IS PRINTED BUT STATUS CODES AND ERROR BODIES. The password is
# generated, used twice and dropped; no reason string carries it (F-379).
# ---------------------------------------------------------------------------

# bff METHOD PATH [JSON-BODY] -> $TMPDIR_CHECK/bff.status, bff.body; the jar in $BFF_JAR
# is read before the request and rewritten after it. Never fails the script: a transport
# error is a status of TRANSPORT-ERROR with the message as the body, like the /health probe.
#
# $BFF_JAR is the browser's identity. AC-28 has one browser, the owner's; the invitation
# clauses add a second (the invitee) and a third (the second signup), and switch by
# assigning BFF_JAR around their requests. Two people, two jars, one helper.
BFF_JAR="$TMPDIR_CHECK/bff.jar"
bff() {
  node -e '
const fs = require("node:fs");
const [method, url, body, jarFile, statusFile, bodyFile] = process.argv.slice(1);
let jar = {};
try { jar = JSON.parse(fs.readFileSync(jarFile, "utf8")); } catch { jar = {}; }
const headers = { origin: new URL(url).origin };
if (body !== "") headers["content-type"] = "application/json";
const cookie = Object.entries(jar).map(([name, c]) => `${name}=${c.value}`).join("; ");
if (cookie !== "") headers.cookie = cookie;
fetch(url, { method, headers, body: body === "" ? undefined : body, redirect: "manual", signal: AbortSignal.timeout(20000) })
  .then(async (r) => {
    for (const line of r.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const lower = attrs.map((a) => a.toLowerCase());
      const maxAge = lower.find((a) => a.startsWith("max-age="));
      if (value === "" || (maxAge !== undefined && Number(maxAge.slice(8)) <= 0)) { delete jar[name]; continue; }
      jar[name] = { value, httpOnly: lower.includes("httponly"), secure: lower.includes("secure") };
    }
    fs.writeFileSync(jarFile, JSON.stringify(jar));
    fs.writeFileSync(statusFile, String(r.status));
    fs.writeFileSync(bodyFile, await r.text());
  })
  .catch((e) => {
    fs.writeFileSync(statusFile, "TRANSPORT-ERROR");
    fs.writeFileSync(bodyFile, String((e && e.message) || e));
  });
' "$1" "$WEB_URL$2" "${3:-}" "$BFF_JAR" "$TMPDIR_CHECK/bff.status" "$TMPDIR_CHECK/bff.body" || true
}
bff_status() { cat "$TMPDIR_CHECK/bff.status" 2>/dev/null || echo 'NO-REQUEST'; }
bff_body()   { one_line <"$TMPDIR_CHECK/bff.body" 2>/dev/null || printf 'no body recorded'; }

# bff_field a.b.c -> the string value at that path in the last body, or ABSENT / NOT-JSON.
bff_field() {
  node -e '
const fs = require("node:fs");
let v;
try { v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("NOT-JSON"); process.exit(0); }
for (const key of process.argv[2].split(".")) { v = (v !== null && typeof v === "object") ? v[key] : undefined; }
console.log(v === undefined || v === null ? "ABSENT" : (typeof v === "string" ? v : JSON.stringify(v)));
' "$TMPDIR_CHECK/bff.body" "$1"
}

# jar_cookie NAME -> "httponly=1 secure=0" style flags, or ABSENT.
jar_cookie() {
  node -e '
const fs = require("node:fs");
let jar = {};
try { jar = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { jar = {}; }
const c = jar[process.argv[2]];
console.log(c === undefined ? "ABSENT" : `httponly=${c.httpOnly ? 1 : 0} secure=${c.secure ? 1 : 0}`);
' "$BFF_JAR" "$1"
}

# user_rows_for EMAIL -> the number of rows in public."user" with that email, as the
# superuser over the socket; the address is a bound psql variable.
user_rows_for() {
  printf '%s\n' "select count(*) from public.\"user\" where email = :'email';" \
    | docker compose exec -T postgres \
        psql -v ON_ERROR_STOP=1 -v "email=$1" -U "$SUPERUSER" -d "$APP_DATABASE" -tAq \
        2>"$TMPDIR_CHECK/userrows.err" | tr -d '[:space:]'
}

printf '\n-- the flow, through %s\n' "$WEB_URL" >&2
FLOW_EMAIL="sc2-$(node -e 'console.log(require("node:crypto").randomBytes(6).toString("hex"))')@example.test"
FLOW_PASSWORD="$(node -e 'console.log(require("node:crypto").randomBytes(18).toString("base64url"))')"
FLOW_NAME='SC-2 Operator'
WORKSPACE_NAME='Acme'
rm -f "$BFF_JAR"

SIGNUP_OK=0
if [ "$UP_OK" -ne 1 ]; then
  blocked 'AC-28.1' 'the stack did not come up (AC-115.1), so nothing was driven through the web app'
elif [ "$(service_health web)" != 'healthy' ] || [ "$(service_health api)" != 'healthy' ]; then
  blocked 'AC-28.1' "the web app or the API is not healthy (web: $(service_health web), api: $(service_health api)), so nothing was driven through the web app"
elif before="$(user_rows_for "$FLOW_EMAIL")" && [ -n "$before" ] && [ "$before" != '0' ]; then
  fail 'AC-28.1' "the fresh address already has $before row(s) in public.\"user\" before signup: the database is not the empty one AC-28 describes"
elif [ -z "${before:-}" ]; then
  fail 'AC-28.1' "could not count public.\"user\" rows for the address before signup: $(one_line <"$TMPDIR_CHECK/userrows.err")"
else
  bff POST /api/bff/auth/sign-up/email "$(node -e 'console.log(JSON.stringify({ email: process.argv[1], password: process.argv[2], name: process.argv[3] }))' "$FLOW_EMAIL" "$FLOW_PASSWORD" "$FLOW_NAME")"
  status="$(bff_status)"
  if [ "$status" = 'TRANSPORT-ERROR' ]; then
    fail 'AC-28.1' "POST $WEB_URL/api/bff/auth/sign-up/email could not be reached: $(bff_body)"
  elif [ "$status" != '200' ]; then
    fail 'AC-28.1' "POST /api/bff/auth/sign-up/email returned $status, not 200: $(bff_body)"
  elif after="$(user_rows_for "$FLOW_EMAIL")" && [ "$after" = '1' ]; then
    SIGNUP_OK=1
    pass 'AC-28.1' "POST /api/bff/auth/sign-up/email returned 200 for a fresh address, and public.\"user\" went from 0 to 1 row for it (no seed data, no fixture)"
  elif [ -z "${after:-}" ]; then
    fail 'AC-28.1' "signup returned 200 but public.\"user\" could not be counted afterwards: $(one_line <"$TMPDIR_CHECK/userrows.err")"
  else
    fail 'AC-28.1' "signup returned 200 but public.\"user\" holds $after row(s) for the address, not 1: the account was not created (better-auth answers 200 for a duplicate under autoSignIn: false, ADR-0061)"
  fi
fi

SIGNIN_OK=0
if [ "$SIGNUP_OK" -ne 1 ]; then
  blocked 'AC-28.2' 'signup did not succeed, so there are no credentials to sign in with'
else
  bff POST /api/bff/auth/sign-in/email "$(node -e 'console.log(JSON.stringify({ email: process.argv[1], password: process.argv[2] }))' "$FLOW_EMAIL" "$FLOW_PASSWORD")"
  status="$(bff_status)"
  AT="$(jar_cookie sk_at)"
  RT="$(jar_cookie sk_rt)"
  if [ "$status" = 'TRANSPORT-ERROR' ]; then
    fail 'AC-28.2' "POST $WEB_URL/api/bff/auth/sign-in/email could not be reached: $(bff_body)"
  elif [ "$status" != '200' ]; then
    fail 'AC-28.2' "POST /api/bff/auth/sign-in/email returned $status, not 200: $(bff_body)"
  elif [ "$AT" = 'ABSENT' ] || [ "$RT" = 'ABSENT' ]; then
    fail 'AC-28.2' "sign-in returned 200 but set no session cookie (sk_at: $AT, sk_rt: $RT): the BFF did not mint a session (ADR-0014)"
  elif [ "${AT#httponly=1}" = "$AT" ] || [ "${RT#httponly=1}" = "$RT" ]; then
    fail 'AC-28.2' "sign-in set both cookies but not HttpOnly (sk_at: $AT, sk_rt: $RT); web-api-client.md requires HttpOnly on both"
  else
    bff GET /api/bff/session
    session_status="$(bff_status)"
    projected="$(bff_field status)"
    projected_email="$(bff_field user.email)"
    if [ "$session_status" != '200' ]; then
      fail 'AC-28.2' "sign-in set both cookies but GET /api/bff/session returned $session_status: $(bff_body)"
    elif [ "$projected" != 'authenticated' ] || [ "$projected_email" != "$FLOW_EMAIL" ]; then
      fail 'AC-28.2' "sign-in set both cookies but GET /api/bff/session projects status \"$projected\" for user.email \"$projected_email\", not an authenticated session for the signed-up address"
    else
      SIGNIN_OK=1
      pass 'AC-28.2' 'POST /api/bff/auth/sign-in/email returned 200 and set HttpOnly sk_at and sk_rt; GET /api/bff/session projects the address as authenticated'
    fi
  fi
fi

WORKSPACE_OK=0
W1_ID=''
if [ "$SIGNIN_OK" -ne 1 ]; then
  blocked 'AC-28.3' 'sign-in did not return a session, so no workspace could be created'
else
  bff POST /api/bff/workspaces "$(node -e 'console.log(JSON.stringify({ name: process.argv[1] }))' "$WORKSPACE_NAME")"
  status="$(bff_status)"
  created_id="$(bff_field id)"
  created_name="$(bff_field name)"
  if [ "$status" = 'TRANSPORT-ERROR' ]; then
    fail 'AC-28.3' "POST $WEB_URL/api/bff/workspaces could not be reached: $(bff_body)"
  elif [ "$status" != '201' ]; then
    fail 'AC-28.3' "POST /api/bff/workspaces returned $status, not 201: $(bff_body)"
  elif [ "$created_id" = 'ABSENT' ] || [ "$created_id" = 'NOT-JSON' ] || [ "$created_name" != "$WORKSPACE_NAME" ]; then
    fail 'AC-28.3' "POST /api/bff/workspaces returned 201 but the body is not a workspace (id: $created_id, name: $created_name): $(bff_body)"
  else
    bff GET /api/bff/workspaces
    list_status="$(bff_status)"
    listed="$(node -e '
const fs = require("node:fs");
let b;
try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("NOT-JSON"); process.exit(0); }
if (b === null || typeof b !== "object" || !Array.isArray(b.items)) { console.log("NO-ITEMS-ARRAY"); process.exit(0); }
const hit = b.items.find((w) => w && w.id === process.argv[2]);
console.log(hit === undefined ? `NOT-LISTED (${b.items.length} item(s))` : (hit.name === process.argv[3] ? "LISTED" : `LISTED-AS ${JSON.stringify(hit.name)}`));
' "$TMPDIR_CHECK/bff.body" "$created_id" "$WORKSPACE_NAME")"
    if [ "$list_status" != '200' ]; then
      fail 'AC-28.3' "the workspace was created but GET /api/bff/workspaces returned $list_status: $(bff_body)"
    elif [ "$listed" != 'LISTED' ]; then
      fail 'AC-28.3' "the workspace was created (id $created_id) but the workspace list did not contain it as \"$WORKSPACE_NAME\": $listed"
    else
      WORKSPACE_OK=1
      W1_ID="$created_id"
      pass 'AC-28.3' "POST /api/bff/workspaces returned 201 with id $created_id, and GET /api/bff/workspaces lists it as \"$WORKSPACE_NAME\""
    fi
  fi
fi

# ---------------------------------------------------------------------------
# AC-1b-e2e-1 .. -4: invite, read the link out of the log, accept, see only yours
# (TASK-1b-11; AC-1b-41, AC-1b-42; SC-2 extended by SC-6..SC-8)
#
# The same browser stand-in as AC-28, and one more person. The owner (signed in above)
# creates a SECOND workspace, so that "the invitee sees only their workspace" has something
# to be measured against, then invites a fresh address to the FIRST one as `member`. Nothing
# in the invitation's response may carry the token: the link is the capability (D-01), and
# the only place it exists is the mail, which on this stack is a plain-text block the console
# transport prints to the API's stdout (D-02, `MAIL_TRANSPORT=console` in docker-compose.yml).
# So the check does what a developer does -- `docker compose logs api` -- and takes the token
# off the URL line of the block addressed to the invitee. Then the invitee signs up with it
# through the web app, signs in with a jar of their own, and the workspace list is exactly
# [W1] at `member`, W2 is 404, a rename and an archive of W1 are 403, and the token is spent.
#
# NEVER PRINTED (F-379): the token, the two passwords, the invite URL. Reason strings carry
# statuses, codes, counts and ids. THE LOG IS READ TWICE for the token, both times as a
# fixed-string grep over the API log split by line: once when the URL is taken (AC-1b-e2e-2:
# it is on the block's URL line and on no line that parses as JSON), and once after the whole
# flow (AC-1b-e2e-4's last step: still exactly one line), because the signup and the second
# signup are the two requests that carried it and would be where a request logger leaked it.
#
# BLOCKED, NOT FAIL, when the log holds no block for the address (AC-1b-42): a stack whose
# API is not printing mail -- MAIL_TRANSPORT overridden, or the console block's shape
# changed -- has told this check nothing about invitations, and the three clauses after it
# are BLOCKED on that too. FAIL is reserved for a measured refusal: a wrong status, a wrong
# count, a wrong role.
#
# DOD-2's census runs after this block, so the invitee's rows are inside both of its counts.
# ---------------------------------------------------------------------------

# The tenant census, as the superuser: shortkit_app sees only the tenant matching
# app.tenant_id, so a row the seed or an invited signup created under another id is
# invisible to it. Defined here because AC-1b-e2e-3 counts before and after the invited
# signup, and DOD-2 / DOD-3 count across the second up and the restart.
census() { psql_super 'select count(*) from public.tenants' 2>"$TMPDIR_CHECK/census.err" | tr -d '[:space:]'; }
census_err() { one_line <"$TMPDIR_CHECK/census.err" 2>/dev/null || printf 'no error recorded'; }

# The API's log, prefix stripped. `docker compose logs` prefixes every line with the
# container name and ` | `; the first ` | ` on a line is that prefix and nothing the API
# writes precedes it. Written to a file under $TMPDIR_CHECK, which cleanup() removes.
api_log() { docker compose logs --no-color api 2>/dev/null | sed 's/^[^|]*| //' >"$TMPDIR_CHECK/api.log"; }

# invite_url_for EMAIL -> the URL line of the console block addressed to EMAIL, or nothing.
# Reads the LAST block for that address, so a re-sent invitation reads as the newest one.
# The block's three fixed lines are the header, `To: <address>` and the footer
# (console-mail-sender.ts, "THE SHAPE"); the URL is the one line inside it that carries the
# accept path. Prints one line and nothing else -- the caller keeps it in a variable.
invite_url_for() {
  awk -v to="To: $1" \
      -v header='--- outbound mail (console transport; nothing was sent) ---' \
      -v footer='--- end of outbound mail ---' '
    $0 == header { inblock = 1; mine = 0; url = ""; next }
    inblock && $0 == to { mine = 1; next }
    inblock && mine && index($0, "/invitations/accept#token=") > 0 { url = $0 }
    $0 == footer { if (mine && url != "") last = url; inblock = 0; mine = 0 }
    END { if (last != "") print last }
  ' "$TMPDIR_CHECK/api.log"
}

# mail_blocks_for EMAIL -> how many console blocks in the API log are addressed to EMAIL.
mail_blocks_for() { grep -c -x -F -- "To: $1" "$TMPDIR_CHECK/api.log" || true; }

# token_lines TOKEN -> "<all> <json>": lines of the API log holding the token as a fixed
# string, and how many of those start with `{` (pino's shape; every JSON line the API
# writes is one object per line). Never prints the token.
token_lines() {
  local all json
  all="$(grep -c -F -- "$1" "$TMPDIR_CHECK/api.log" || true)"
  json="$(grep -F -- "$1" "$TMPDIR_CHECK/api.log" | grep -c '^{' || true)"
  printf '%s %s' "${all:-0}" "${json:-0}"
}

# member_rows_for EMAIL OWNER_EMAIL -> the number of tenant_memberships rows for EMAIL at
# role `member` in the tenant OWNER_EMAIL belongs to; both addresses bound, never pasted.
member_rows_for() {
  printf '%s\n' "select count(*) from public.tenant_memberships tm join public.\"user\" u on u.id = tm.user_id where u.email = :'email' and tm.role = 'member' and tm.tenant_id = (select tm2.tenant_id from public.tenant_memberships tm2 join public.\"user\" u2 on u2.id = tm2.user_id where u2.email = :'owner');" \
    | docker compose exec -T postgres \
        psql -v ON_ERROR_STOP=1 -v "email=$1" -v "owner=$2" -U "$SUPERUSER" -d "$APP_DATABASE" -tAq \
        2>"$TMPDIR_CHECK/memberrows.err" | tr -d '[:space:]'
}

printf '\n-- the second human, through %s and docker compose logs api\n' "$WEB_URL" >&2
INVITEE_EMAIL="invitee-$(node -e 'console.log(require("node:crypto").randomBytes(6).toString("hex"))')@example.test"
INVITEE_PASSWORD="$(node -e 'console.log(require("node:crypto").randomBytes(18).toString("base64url"))')"
INVITEE_NAME='SC-2 Invitee'
SECOND_EMAIL="invitee2-$(node -e 'console.log(require("node:crypto").randomBytes(6).toString("hex"))')@example.test"
W2_NAME='Beta'
OWNER_JAR="$TMPDIR_CHECK/bff.jar"
INVITEE_JAR="$TMPDIR_CHECK/bff.jar.invitee"
SECOND_JAR="$TMPDIR_CHECK/bff.jar.second"
rm -f "$INVITEE_JAR" "$SECOND_JAR"

INVITE_OK=0
W2_ID=''
INVITATION_ID=''
if [ "$WORKSPACE_OK" -ne 1 ]; then
  blocked 'AC-1b-e2e-1' 'AC-28.3 did not create and list a workspace, so there is nothing to invite anyone to'
else
  BFF_JAR="$OWNER_JAR"
  bff POST /api/bff/workspaces "$(node -e 'console.log(JSON.stringify({ name: process.argv[1] }))' "$W2_NAME")"
  status="$(bff_status)"
  W2_ID="$(bff_field id)"
  if [ "$status" = 'TRANSPORT-ERROR' ]; then
    fail 'AC-1b-e2e-1' "step 1 (second workspace): POST $WEB_URL/api/bff/workspaces could not be reached: $(bff_body)"
  elif [ "$status" != '201' ] || [ "$W2_ID" = 'ABSENT' ] || [ "$W2_ID" = 'NOT-JSON' ]; then
    fail 'AC-1b-e2e-1' "step 1 (second workspace): POST /api/bff/workspaces returned $status (id: $W2_ID), not 201 with an id: $(bff_body)"
  else
    bff POST /api/bff/invitations "$(node -e 'console.log(JSON.stringify({ email: process.argv[1], workspaces: [{ workspaceId: process.argv[2], workspaceRole: "member" }] }))' "$INVITEE_EMAIL" "$W1_ID")"
    status="$(bff_status)"
    INVITATION_ID="$(bff_field id)"
    inv_state="$(bff_field state)"
    inv_token_key="$(node -e '
const fs = require("node:fs");
let b;
try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("NOT-JSON"); process.exit(0); }
const hasToken = (v) => v !== null && typeof v === "object" && (Object.prototype.hasOwnProperty.call(v, "token") || Object.values(v).some(hasToken));
console.log(hasToken(b) ? "PRESENT" : "ABSENT");
' "$TMPDIR_CHECK/bff.body")"
    inv_grant="$(node -e '
const fs = require("node:fs");
let b;
try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("NOT-JSON"); process.exit(0); }
const ws = Array.isArray(b && b.workspaces) ? b.workspaces : [];
console.log(ws.length === 1 && ws[0].workspaceId === process.argv[2] && ws[0].workspaceRole === "member" ? "W1-AS-MEMBER" : JSON.stringify(ws.map((w) => [w && w.workspaceId, w && w.workspaceRole])));
' "$TMPDIR_CHECK/bff.body" "$W1_ID")"
    if [ "$status" = 'TRANSPORT-ERROR' ]; then
      fail 'AC-1b-e2e-1' "step 2 (invite): POST $WEB_URL/api/bff/invitations could not be reached: $(bff_body)"
    elif [ "$status" != '201' ]; then
      fail 'AC-1b-e2e-1' "step 2 (invite): POST /api/bff/invitations returned $status, not 201: $(bff_body)"
    elif [ "$inv_token_key" != 'ABSENT' ]; then
      fail 'AC-1b-e2e-1' "step 2 (invite): POST /api/bff/invitations returned 201 but the body carries a \`token\` key ($inv_token_key): the response must never carry the capability (invitations/index.ts header, SC-8)"
    elif [ "$INVITATION_ID" = 'ABSENT' ] || [ "$INVITATION_ID" = 'NOT-JSON' ] || [ "$inv_state" != 'pending' ] || [ "$inv_grant" != 'W1-AS-MEMBER' ]; then
      fail 'AC-1b-e2e-1' "step 2 (invite): POST /api/bff/invitations returned 201 but the body is not a pending invitation naming W1 as member (id: $INVITATION_ID, state: $inv_state, workspaces: $inv_grant): $(bff_body)"
    else
      INVITE_OK=1
      pass 'AC-1b-e2e-1' "POST /api/bff/workspaces created a second workspace ($W2_ID); POST /api/bff/invitations returned 201, state pending, naming $W1_ID as member, with no token key anywhere in the body"
    fi
  fi
fi

TOKEN_OK=0
INVITE_TOKEN=''
if [ "$INVITE_OK" -ne 1 ]; then
  blocked 'AC-1b-e2e-2' 'no invitation was created, so there is no invite URL to read'
else
  api_log
  blocks="$(mail_blocks_for "$INVITEE_EMAIL")"
  invite_url="$(invite_url_for "$INVITEE_EMAIL")"
  INVITE_TOKEN="${invite_url##*#token=}"
  if [ "${blocks:-0}" = '0' ]; then
    blocked 'AC-1b-e2e-2' "docker compose logs api holds no console-transport block addressed to the invited address: the API is not printing mail, so MAIL_TRANSPORT is not console on this stack (docker-compose.yml declares it, D-02) or the block's shape changed (console-mail-sender.ts). Nothing about the invitation path was measured."
  elif [ "$blocks" != '1' ]; then
    fail 'AC-1b-e2e-2' "docker compose logs api holds $blocks console-transport blocks addressed to the invited address; one invitation must produce exactly one message (SC-6)"
  elif [ -z "$invite_url" ]; then
    fail 'AC-1b-e2e-2' 'the console-transport block for the invited address holds no line carrying /invitations/accept#token= (workspace-invitation.ts puts the URL on a line of its own)'
  elif [ "$INVITE_TOKEN" = "$invite_url" ] || [ "${#INVITE_TOKEN}" -ne 80 ]; then
    fail 'AC-1b-e2e-2' "the URL line was found but what follows #token= is not an 80-character capability token (length ${#INVITE_TOKEN}; invitation-tokens.md fixes <uuid>.<43 base64url>)"
  elif [ "${invite_url#"$WEB_URL/invitations/accept#token="}" = "$invite_url" ]; then
    fail 'AC-1b-e2e-2' "the invite URL is not $WEB_URL/invitations/accept#token=<token>: the link's origin is not the web app's (WEB_APP_ORIGINS in docker-compose.yml is what invitation-mail.ts builds it on)"
  else
    read -r tl_all tl_json <<<"$(token_lines "$INVITE_TOKEN")"
    if [ "$tl_json" != '0' ]; then
      fail 'AC-1b-e2e-2' "the token appears on $tl_json JSON log line(s) of the API log; it may appear on the console block's URL line and nowhere else (SC-8, GC-K)"
    elif [ "$tl_all" != '1' ]; then
      fail 'AC-1b-e2e-2' "the token appears on $tl_all line(s) of the API log; exactly one, the console block's URL line, is the only place it may be (SC-8)"
    else
      TOKEN_OK=1
      pass 'AC-1b-e2e-2' "docker compose logs api holds exactly one console-transport block for the invited address; its URL line is $WEB_URL/invitations/accept#token=<80 characters>, and the token is on that line and on no JSON line"
    fi
  fi
fi

INVITEE_SIGNUP_OK=0
if [ "$TOKEN_OK" -ne 1 ]; then
  blocked 'AC-1b-e2e-3' 'no invite URL was read, so there is no token to sign up with'
elif before="$(user_rows_for "$INVITEE_EMAIL")" && [ -n "$before" ] && [ "$before" != '0' ]; then
  fail 'AC-1b-e2e-3' "the invited address already has $before row(s) in public.\"user\" before signup: the database is not the empty one AC-28 describes"
elif [ -z "${before:-}" ]; then
  fail 'AC-1b-e2e-3' "could not count public.\"user\" rows for the invited address before signup: $(one_line <"$TMPDIR_CHECK/userrows.err")"
elif tenants_before="$(census || true)" && [ -z "$tenants_before" ]; then
  fail 'AC-1b-e2e-3' "could not count public.tenants before the invited signup: $(census_err)"
else
  BFF_JAR="$INVITEE_JAR"
  bff POST /api/bff/auth/sign-up/email "$(node -e 'console.log(JSON.stringify({ email: process.argv[1], password: process.argv[2], name: process.argv[3], invitationToken: process.argv[4] }))' "$INVITEE_EMAIL" "$INVITEE_PASSWORD" "$INVITEE_NAME" "$INVITE_TOKEN")"
  status="$(bff_status)"
  if [ "$status" = 'TRANSPORT-ERROR' ]; then
    fail 'AC-1b-e2e-3' "step 1 (invited signup): POST $WEB_URL/api/bff/auth/sign-up/email could not be reached: $(bff_body)"
  elif [ "$status" != '200' ]; then
    fail 'AC-1b-e2e-3' "step 1 (invited signup): POST /api/bff/auth/sign-up/email with invitationToken returned $status, not 200: $(bff_body)"
  elif ! after="$(user_rows_for "$INVITEE_EMAIL")" || [ -z "$after" ]; then
    fail 'AC-1b-e2e-3' "step 2 (user row): the invited signup returned 200 but public.\"user\" could not be counted afterwards: $(one_line <"$TMPDIR_CHECK/userrows.err")"
  elif [ "$after" != '1' ]; then
    fail 'AC-1b-e2e-3' "step 2 (user row): the invited signup returned 200 but public.\"user\" holds $after row(s) for the address, not 1: the account was not created (better-auth answers 200 for a duplicate under autoSignIn: false, ADR-0061)"
  elif ! tenants_after="$(census)" || [ -z "$tenants_after" ]; then
    fail 'AC-1b-e2e-3' "step 3 (no new tenant): could not count public.tenants after the invited signup: $(census_err)"
  elif [ "$tenants_before" != "$tenants_after" ]; then
    fail 'AC-1b-e2e-3' "step 3 (no new tenant): public.tenants went from $tenants_before row(s) to $tenants_after across the invited signup; an invited signup joins the inviter's tenant and creates none (ADR-0015, SC-7)"
  elif ! member_rows="$(member_rows_for "$INVITEE_EMAIL" "$FLOW_EMAIL")" || [ -z "$member_rows" ]; then
    fail 'AC-1b-e2e-3' "step 4 (tenant membership): could not read public.tenant_memberships for the invited address: $(one_line <"$TMPDIR_CHECK/memberrows.err")"
  elif [ "$member_rows" != '1' ]; then
    fail 'AC-1b-e2e-3' "step 4 (tenant membership): public.tenant_memberships holds $member_rows row(s) for the invited address at role member in the owner's tenant, not 1 (ADR-0015, A-8: the invitee joins as member)"
  else
    INVITEE_SIGNUP_OK=1
    pass 'AC-1b-e2e-3' "POST /api/bff/auth/sign-up/email with invitationToken returned 200; public.\"user\" went from 0 to 1 row for the invited address, public.tenants stayed at $tenants_after, and the invitee holds one tenant_memberships row at member in the owner's tenant"
  fi
fi

if [ "$INVITEE_SIGNUP_OK" -ne 1 ]; then
  blocked 'AC-1b-e2e-4' 'the invited signup did not succeed, so there is no invitee to sign in'
else
  BFF_JAR="$INVITEE_JAR"
  bff POST /api/bff/auth/sign-in/email "$(node -e 'console.log(JSON.stringify({ email: process.argv[1], password: process.argv[2] }))' "$INVITEE_EMAIL" "$INVITEE_PASSWORD")"
  status="$(bff_status)"
  AT="$(jar_cookie sk_at)"
  RT="$(jar_cookie sk_rt)"
  if [ "$status" = 'TRANSPORT-ERROR' ]; then
    fail 'AC-1b-e2e-4' "step 1 (invitee sign-in): POST $WEB_URL/api/bff/auth/sign-in/email could not be reached: $(bff_body)"
  elif [ "$status" != '200' ]; then
    fail 'AC-1b-e2e-4' "step 1 (invitee sign-in): POST /api/bff/auth/sign-in/email returned $status, not 200: $(bff_body)"
  elif [ "$AT" = 'ABSENT' ] || [ "$RT" = 'ABSENT' ]; then
    fail 'AC-1b-e2e-4' "step 1 (invitee sign-in): 200 but no session cookie was set (sk_at: $AT, sk_rt: $RT): the BFF did not mint a session for the invitee (ADR-0014)"
  else
    bff GET /api/bff/workspaces
    list_status="$(bff_status)"
    seen="$(node -e '
const fs = require("node:fs");
let b;
try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("NOT-JSON"); process.exit(0); }
if (b === null || typeof b !== "object" || !Array.isArray(b.items)) { console.log("NO-ITEMS-ARRAY"); process.exit(0); }
const ids = b.items.map((w) => (w && w.id) || "?");
if (b.items.length !== 1) { console.log(`${b.items.length} item(s): ${ids.join(", ")}`); process.exit(0); }
const w = b.items[0];
if (w.id !== process.argv[2]) { console.log(`one item, id ${w.id}, not the granted workspace`); process.exit(0); }
console.log(w.workspaceRole === "member" ? "EXACTLY-W1-AS-MEMBER" : `the granted workspace, at workspaceRole ${JSON.stringify(w.workspaceRole)}, not member`);
' "$TMPDIR_CHECK/bff.body" "$W1_ID")"
    if [ "$list_status" != '200' ]; then
      fail 'AC-1b-e2e-4' "step 2 (scoped list): GET /api/bff/workspaces as the invitee returned $list_status: $(bff_body)"
    elif [ "$seen" != 'EXACTLY-W1-AS-MEMBER' ]; then
      fail 'AC-1b-e2e-4' "step 2 (scoped list): GET /api/bff/workspaces as the invitee is not exactly the granted workspace at member: $seen (SC-7; the list is membership-filtered, D-10)"
    else
      bff POST "/api/bff/workspaces/$W1_ID/archive"
      archive_status="$(bff_status)"
      archive_code="$(bff_field code)"
      bff PATCH "/api/bff/workspaces/$W1_ID" "$(node -e 'console.log(JSON.stringify({ name: process.argv[1] }))' 'Renamed by a member')"
      rename_status="$(bff_status)"
      rename_code="$(bff_field code)"
      bff GET "/api/bff/workspaces/$W2_ID"
      w2_status="$(bff_status)"
      w2_code="$(bff_field code)"
      if [ "$archive_status" != '403' ] || [ "$archive_code" != 'insufficient_workspace_role' ]; then
        fail 'AC-1b-e2e-4' "step 3 (member cannot archive): POST /api/bff/workspaces/<W1>/archive as the invitee returned $archive_status $archive_code, not 403 insufficient_workspace_role (workspace-authorization.md: archive is workspace_admin)"
      elif [ "$rename_status" != '403' ] || [ "$rename_code" != 'insufficient_workspace_role' ]; then
        fail 'AC-1b-e2e-4' "step 3 (member cannot rename): PATCH /api/bff/workspaces/<W1> as the invitee returned $rename_status $rename_code, not 403 insufficient_workspace_role"
      elif [ "$w2_status" != '404' ] || [ "$w2_code" != 'not_found' ]; then
        fail 'AC-1b-e2e-4' "step 4 (the other workspace is invisible): GET /api/bff/workspaces/<W2> as the invitee returned $w2_status $w2_code, not 404 not_found (SC-7)"
      else
        BFF_JAR="$SECOND_JAR"
        bff POST /api/bff/auth/sign-up/email "$(node -e 'console.log(JSON.stringify({ email: process.argv[1], password: process.argv[2], name: process.argv[3], invitationToken: process.argv[4] }))' "$SECOND_EMAIL" "$INVITEE_PASSWORD" 'SC-2 Second Signup' "$INVITE_TOKEN")"
        second_status="$(bff_status)"
        second_code="$(bff_field code)"
        second_rows="$(user_rows_for "$SECOND_EMAIL" || true)"
        BFF_JAR="$OWNER_JAR"
        bff GET "/api/bff/invitations?workspaceId=$W1_ID"
        inv_list_status="$(bff_status)"
        inv_seen="$(node -e '
const fs = require("node:fs");
let b;
try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("NOT-JSON"); process.exit(0); }
if (b === null || typeof b !== "object" || !Array.isArray(b.items)) { console.log("NO-ITEMS-ARRAY"); process.exit(0); }
const hit = b.items.find((i) => i && i.id === process.argv[2]);
if (hit === undefined) { console.log(`NOT-LISTED (${b.items.length} item(s))`); process.exit(0); }
const hasToken = (v) => v !== null && typeof v === "object" && (Object.prototype.hasOwnProperty.call(v, "token") || Object.values(v).some(hasToken));
console.log(hasToken(b) ? "TOKEN-KEY-PRESENT" : String(hit.state));
' "$TMPDIR_CHECK/bff.body" "$INVITATION_ID")"
        api_log
        read -r tl_all tl_json <<<"$(token_lines "$INVITE_TOKEN")"
        if [ "$second_status" != '409' ] || [ "$second_code" != 'invitation_already_accepted' ]; then
          fail 'AC-1b-e2e-4' "step 5 (the token is spent): a second signup with the same token returned $second_status $second_code, not 409 invitation_already_accepted (SC-8): $(bff_body)"
        elif [ "$second_rows" != '0' ]; then
          fail 'AC-1b-e2e-4' "step 5 (the token is spent): the second signup was refused but public.\"user\" holds ${second_rows:-an unreadable count of} row(s) for its address, not 0"
        elif [ "$inv_list_status" != '200' ]; then
          fail 'AC-1b-e2e-4' "step 6 (the owner sees it accepted): GET /api/bff/invitations?workspaceId=<W1> as the owner returned $inv_list_status: $(bff_body)"
        elif [ "$inv_seen" != 'accepted' ]; then
          fail 'AC-1b-e2e-4' "step 6 (the owner sees it accepted): GET /api/bff/invitations?workspaceId=<W1> lists the invitation as \"$inv_seen\", not accepted"
        elif [ "$tl_json" != '0' ] || [ "$tl_all" != '1' ]; then
          fail 'AC-1b-e2e-4' "step 7 (the token stayed out of the log): after the whole flow the token appears on $tl_all line(s) of the API log, $tl_json of them JSON; exactly one line, the console block's URL line, and no JSON line is the rule (SC-8)"
        else
          pass 'AC-1b-e2e-4' "the invitee signed in with HttpOnly cookies; GET /api/bff/workspaces is exactly [$W1_ID] at member; archive and rename of it are 403 insufficient_workspace_role; GET of $W2_ID is 404 not_found; a second signup with the token is 409 invitation_already_accepted with no user row; the owner's list shows the invitation accepted; the token is still on one API log line and no JSON line"
        fi
      fi
    fi
  fi
fi
BFF_JAR="$OWNER_JAR"

# ---------------------------------------------------------------------------
# AC-2-e2e-1 .. -7: create, redirect, click, edit, Redis down, Redis back, unknown slug
# (TASK-2-12; AC-2-44, SC-16; redirect-resolution.md, redirect-cache.md, click-events.md)
#
# The same browser stand-in as AC-28 for everything the OPERATOR does, and a second kind of
# request for everything the VISITOR does: no cookie jar, no `Origin`, no session, straight
# at the API's own published port, with `redirect: manual` so the 302 is observed rather
# than followed.
#
# `http://localhost:3001` AND NOT `http://127.0.0.1:3001`, and the hostname is as
# load-bearing here as it is on WEB_URL, through a different mechanism. The seeded system
# default domain's hostname is `localhost` (`SYSTEM_DEFAULT_DOMAIN` in docker-compose.yml,
# D-2-02); step 1 of the decision order lowercases the `Host` header and strips the port,
# and step 2 resolves a `domains` row from what is left. A request to 127.0.0.1 resolves NO
# domain and gets the default 404, which reads like a broken redirect and is a wrong
# address. The /health probe above may use either, and uses 127.0.0.1, because that route
# reads no `Host` header at all.
#
# THE SLUG CARRIES A PER-RUN NONCE, AND THAT IS NOT DECORATION. Uniqueness is
# `(domain_id, slug)` and never global (slug.md), every link in item 2 lands on the ONE
# seeded system default domain whatever tenant created it (D-2-12), and this stack's volume
# survives `docker compose down` and every previous run of this check. A slug written as a
# literal here would answer 409 `slug_taken` the second time this check ran against a kept
# volume, and would read as a broken create route. Six random bytes as hex per run, and a
# second nonce for the slug that must NOT exist.
#
# NO CLAUSE HERE ASSERTS A CACHE STATE, AND THE REASON IS MEASURED RATHER THAN ASSUMED. A
# mutation deletes the link's key and then deletes the SAME key again a second later
# (`INVALIDATION_SECOND_PASS_DELAY_MS`, redirect-cache.md's "stale set race"), and a create
# is a mutation, so a key that a visit warms inside that second is gone right after it.
# Measured on this stack on 2026-08-19, with `EXISTS sk:dev:rdr:v1:localhost:<slug>` against
# the running redis: 0 after the create and before any visit; 1 immediately after a visit at
# +346 ms; 0 at +2237 ms, with nothing else touching the link; 1 again immediately after the
# next visit, which answered the identical 302 having refilled the key from Postgres; and
# still 1 two seconds after THAT, since no mutation followed it. So every clause below
# asserts what the VISITOR RECEIVED (the status, the `Location`, the headers, the click
# row), and none asserts the key, the read cost, or which store answered. The edit clause
# POLLS to its bound rather than reading once, for the same reason.
#
# THE DEGRADATION CLAUSE STOPS A SERVICE AND THE ONE AFTER IT STARTS THE SERVICE AGAIN.
# That pair is ordered and neither half is optional: DOD-1's `up -d --wait` further down
# would start `redis` anyway and would then be reporting a service it started itself as one
# that recovered. Recovery is measured where it happens, before anything else touches the
# stack, and the stack is left with `redis` running either way.
#
# A 500 FROM THE CREATE ROUTE ON A STACK THAT CAME UP GREEN IS THE SEED AND NOT THE ROUTE,
# and the reason string says so. Every link references the system default domain by foreign
# key (D-2-12, ADR-0063), and a volume from before item 2 carries no `domains` row for it.
# This run always starts from `down -v`, so it is not reachable here; whoever sees it will
# be running against a kept volume, and the README's reset ladder carries the repair.
#
# Placed after the invitation clauses and BEFORE the second `up` and the `restart`, for
# AC-28's reason: these need `api` and `web` healthy, and DOD-3's `restart` puts both
# through a boot this script only waits out for postgres. DOD-2's census counts tenants and
# these clauses create none.
# ---------------------------------------------------------------------------

# visit PATH -> $TMPDIR_CHECK/visit.status, visit.headers, visit.body. The anonymous
# visitor: no jar, no `Origin`, and `redirect: manual`, because the whole assertion is the
# 302 itself. Never fails the script: a transport error is a status of TRANSPORT-ERROR with
# the message as the body, the same shape `bff` and the /health probe use.
visit() {
  node -e '
const fs = require("node:fs");
const [url, statusFile, headerFile, bodyFile] = process.argv.slice(1);
fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20000) })
  .then(async (r) => {
    const headers = {};
    for (const [name, value] of r.headers) headers[name.toLowerCase()] = value;
    fs.writeFileSync(statusFile, String(r.status));
    fs.writeFileSync(headerFile, JSON.stringify(headers));
    fs.writeFileSync(bodyFile, await r.text());
  })
  .catch((e) => {
    fs.writeFileSync(statusFile, "TRANSPORT-ERROR");
    fs.writeFileSync(headerFile, "{}");
    fs.writeFileSync(bodyFile, String((e && e.message) || e));
  });
' "$REDIRECT_URL$1" "$TMPDIR_CHECK/visit.status" "$TMPDIR_CHECK/visit.headers" "$TMPDIR_CHECK/visit.body" || true
}
visit_status() { cat "$TMPDIR_CHECK/visit.status" 2>/dev/null || echo 'NO-REQUEST'; }
visit_body()   { one_line <"$TMPDIR_CHECK/visit.body" 2>/dev/null || printf 'no body recorded'; }

# visit_header NAME -> the value of that response header on the last visit, or ABSENT. The
# name is lower-case: `visit` lower-cases every name as it records them.
visit_header() {
  node -e '
const fs = require("node:fs");
let h = {};
try { h = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { h = {}; }
const v = h[process.argv[2]];
console.log(v === undefined ? "ABSENT" : v);
' "$TMPDIR_CHECK/visit.headers" "$1"
}

# The flush interval is 1000 ms and a batch is at most 100 rows (ADR-0010), so a click is
# readable about a second after the visit. Ten is that with room for a loaded machine, and
# it is a BOUND: the clause fails when it runs out, it does not wait longer.
CLICK_POLL_SECONDS=10

# GC-2 and AC-51: a destination edit is visible on the redirect path within five seconds of
# commit. The clause polls to exactly that and no further.
EDIT_BOUND_SECONDS=5

printf '\n-- the visitor, on %s\n' "$REDIRECT_URL" >&2
LINK_NONCE="$(node -e 'console.log(require("node:crypto").randomBytes(6).toString("hex"))')"
LINK_SLUG="e2e-$LINK_NONCE"
UNKNOWN_SLUG="e2e-unknown-$(node -e 'console.log(require("node:crypto").randomBytes(6).toString("hex"))')"
# Both are already what `new URL().href` produces, which is what the contract stores
# (D-2-08), so "the stored destination is the one that was sent" is an equality rather than
# a normalisation to reason about. The `|` is deliberate: `new URL()` leaves it alone and
# Express's `res.location()` would percent-encode it, so a `Location` written the wrong way
# is a byte different and this clause sees it (AC-2-14).
LINK_DESTINATION="https://example.test/e2e/$LINK_NONCE?q=a%20b&r=c|d"
LINK_DESTINATION_EDITED="https://example.test/e2e/$LINK_NONCE/edited?q=a%20b"

LINK_OK=0
LINK_ID=''
LINK_DESTINATION_STORED=''
if [ "$WORKSPACE_OK" -ne 1 ]; then
  blocked 'AC-2-e2e-1' 'AC-28.3 did not create and list a workspace, so there is nowhere to create a link'
else
  BFF_JAR="$OWNER_JAR"
  bff POST /api/bff/links "$(node -e 'console.log(JSON.stringify({ workspaceId: process.argv[1], slug: process.argv[2], destinationUrl: process.argv[3] }))' "$W1_ID" "$LINK_SLUG" "$LINK_DESTINATION")"
  status="$(bff_status)"
  LINK_ID="$(bff_field id)"
  created_slug="$(bff_field slug)"
  created_hostname="$(bff_field hostname)"
  LINK_DESTINATION_STORED="$(bff_field destinationUrl)"
  if [ "$status" = 'TRANSPORT-ERROR' ]; then
    fail 'AC-2-e2e-1' "POST $WEB_URL/api/bff/links could not be reached: $(bff_body)"
  elif [ "$status" = '500' ]; then
    fail 'AC-2-e2e-1' "POST /api/bff/links returned 500 on a stack that came up green, which is the seed and not the route: every link references the system default domain by foreign key (D-2-12, ADR-0063) and a volume from before item 2 has no domains row for it. This run starts from down -v so it should not be reachable here; against a kept volume, re-run the seed (a plain up runs it, and its inserts are ON CONFLICT DO NOTHING) or docker compose down -v. Body: $(bff_body)"
  elif [ "$status" != '201' ]; then
    fail 'AC-2-e2e-1' "POST /api/bff/links returned $status, not 201: $(bff_body)"
  elif [ "$LINK_ID" = 'ABSENT' ] || [ "$LINK_ID" = 'NOT-JSON' ] || [ "$created_slug" != "$LINK_SLUG" ]; then
    fail 'AC-2-e2e-1' "POST /api/bff/links returned 201 but not the link that was asked for (id: $LINK_ID, slug: $created_slug for a request that named $LINK_SLUG): $(bff_body)"
  elif [ "$LINK_DESTINATION_STORED" != "$LINK_DESTINATION" ]; then
    fail 'AC-2-e2e-1' "POST /api/bff/links stored destinationUrl \"$LINK_DESTINATION_STORED\" for a request that sent \"$LINK_DESTINATION\"; the contract stores new URL().href and this input already is it (D-2-08)"
  elif [ "$created_hostname" != "$REDIRECT_HOSTNAME" ]; then
    fail 'AC-2-e2e-1' "the link was created on hostname \"$created_hostname\", not \"$REDIRECT_HOSTNAME\": the seeded system default domain is not the one this check redirects on (SYSTEM_DEFAULT_DOMAIN in docker-compose.yml, D-2-02)"
  else
    LINK_OK=1
    pass 'AC-2-e2e-1' "POST /api/bff/links returned 201 with id $LINK_ID on $created_hostname/$LINK_SLUG, carrying the destination that was sent"
  fi
fi

REDIRECT_OK=0
if [ "$LINK_OK" -ne 1 ]; then
  blocked 'AC-2-e2e-2' 'no link was created, so there is no short link to follow'
else
  visit "/$LINK_SLUG"
  status="$(visit_status)"
  location="$(visit_header location)"
  cache_control="$(visit_header cache-control)"
  referrer_policy="$(visit_header referrer-policy)"
  if [ "$status" = 'TRANSPORT-ERROR' ]; then
    fail 'AC-2-e2e-2' "GET $REDIRECT_URL/<slug> could not be reached: $(visit_body)"
  elif [ "$status" = '404' ]; then
    fail 'AC-2-e2e-2' "GET $REDIRECT_URL/<slug> returned 404 for a link the create route had just answered 201 for: the request's Host resolved no active domain, or the link did not resolve on the domain it was created on (decision order steps 2 and 3)"
  elif [ "$status" != '302' ]; then
    fail 'AC-2-e2e-2' "GET $REDIRECT_URL/<slug> returned $status, not 302: $(visit_body)"
  elif [ "$location" != "$LINK_DESTINATION_STORED" ]; then
    fail 'AC-2-e2e-2' "the 302 carries Location \"$location\", not the stored destination byte for byte (AC-2-14: setHeader and never res.redirect, whose encodeUrl rewrites the value)"
  elif [ "$cache_control" != 'private, no-store' ]; then
    fail 'AC-2-e2e-2' "the 302 carries Cache-Control \"$cache_control\", not \"private, no-store\" (redirect-resolution.md's header table: every response)"
  elif [ "$referrer_policy" != 'unsafe-url' ]; then
    fail 'AC-2-e2e-2' "the 302 carries Referrer-Policy \"$referrer_policy\", not \"unsafe-url\" (the header table: the 302 and nothing else)"
  else
    REDIRECT_OK=1
    pass 'AC-2-e2e-2' "GET $REDIRECT_URL/$LINK_SLUG answered 302 with the stored destination byte for byte, Cache-Control \"private, no-store\" and Referrer-Policy \"unsafe-url\""
  fi
fi

if [ "$REDIRECT_OK" -ne 1 ]; then
  blocked 'AC-2-e2e-3' 'the redirect did not serve, so no click can have been emitted to read back'
else
  BFF_JAR="$OWNER_JAR"
  click_waited=0
  click_status=''
  click_items=''
  while :; do
    bff GET "/api/bff/links/$LINK_ID/clicks"
    click_status="$(bff_status)"
    click_items="$(node -e '
const fs = require("node:fs");
let b;
try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("NOT-JSON"); process.exit(0); }
if (b === null || typeof b !== "object" || !Array.isArray(b.items)) { console.log("NO-ITEMS-ARRAY"); process.exit(0); }
console.log(String(b.items.length));
' "$TMPDIR_CHECK/bff.body")"
    case "$click_items" in
      ''|*[!0-9]*) ;;
      *) [ "$click_items" -ge 1 ] && break ;;
    esac
    [ "$click_waited" -ge "$CLICK_POLL_SECONDS" ] && break
    sleep 1; click_waited=$((click_waited + 1))
  done
  # The whole body, at any depth, and by the CLASS of name rather than one spelling: the
  # column exists and is pseudonymous per tenant, and what D-2-19 forbids is any of it
  # reaching the wire.
  click_address_key="$(node -e '
const fs = require("node:fs");
let b;
try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("NOT-JSON"); process.exit(0); }
const NAMES = ["ipHash", "ip_hash", "ip", "ipAddress", "address", "clientIp"];
const hit = (v) => {
  if (v === null || typeof v !== "object") return null;
  for (const key of Object.keys(v)) { if (NAMES.includes(key)) return key; }
  for (const child of Object.values(v)) { const found = hit(child); if (found !== null) return found; }
  return null;
};
const found = hit(b);
console.log(found === null ? "ABSENT" : found);
' "$TMPDIR_CHECK/bff.body")"
  if [ "$click_status" != '200' ]; then
    fail 'AC-2-e2e-3' "GET /api/bff/links/<id>/clicks returned $click_status, not 200: $(bff_body)"
  elif [ "$click_items" = 'NOT-JSON' ] || [ "$click_items" = 'NO-ITEMS-ARRAY' ]; then
    fail 'AC-2-e2e-3' "GET /api/bff/links/<id>/clicks returned 200 with a body that is not a page of items ($click_items): $(bff_body)"
  elif [ "$click_items" = '0' ]; then
    fail 'AC-2-e2e-3' "the redirect served but no click row appeared within ${click_waited}s (the flush interval is 1000 ms and a batch is 100 rows, ADR-0010); the buffer never flushed, or the sink is unbound (D-2-10: an unbound sink is a silent no-op)"
  elif [ "$click_address_key" != 'ABSENT' ]; then
    fail 'AC-2-e2e-3' "the click page carries a \"$click_address_key\" key: ip_hash is pseudonymous per tenant and never leaves the database, not in a response, a log line or an error (D-2-19, GC-R)"
  else
    pass 'AC-2-e2e-3' "GET /api/bff/links/<id>/clicks answered 200 with $click_items click row(s) ${click_waited}s after the visit, and no address key at any depth of the body"
  fi
fi

EDIT_OK=0
if [ "$REDIRECT_OK" -ne 1 ]; then
  blocked 'AC-2-e2e-4' 'the redirect never served the first destination, so a change to it cannot be observed'
else
  BFF_JAR="$OWNER_JAR"
  bff PATCH "/api/bff/links/$LINK_ID" "$(node -e 'console.log(JSON.stringify({ destinationUrl: process.argv[1] }))' "$LINK_DESTINATION_EDITED")"
  patch_status="$(bff_status)"
  patched_destination="$(bff_field destinationUrl)"
  if [ "$patch_status" != '200' ]; then
    fail 'AC-2-e2e-4' "PATCH /api/bff/links/<id> returned $patch_status, not 200: $(bff_body)"
  elif [ "$patched_destination" != "$LINK_DESTINATION_EDITED" ]; then
    fail 'AC-2-e2e-4' "PATCH /api/bff/links/<id> returned 200 carrying destinationUrl \"$patched_destination\", not the edited one: the write did not take"
  else
    edit_waited=0
    served=''
    while :; do
      visit "/$LINK_SLUG"
      served="$(visit_header location)"
      [ "$served" = "$LINK_DESTINATION_EDITED" ] && break
      [ "$edit_waited" -ge "$EDIT_BOUND_SECONDS" ] && break
      sleep 1; edit_waited=$((edit_waited + 1))
    done
    if [ "$(visit_status)" != '302' ]; then
      fail 'AC-2-e2e-4' "after the edit the redirect answered $(visit_status), not 302: $(visit_body)"
    elif [ "$served" != "$LINK_DESTINATION_EDITED" ]; then
      fail 'AC-2-e2e-4' "${EDIT_BOUND_SECONDS}s after the PATCH returned, the redirect still serves \"$served\" and not the edited destination: the invalidation subscriber did not delete the key, and the TTL is 3600 s (GC-2, AC-51, redirect-cache.md invariant 1)"
    else
      EDIT_OK=1
      pass 'AC-2-e2e-4' "the redirect served the edited destination ${edit_waited}s after the PATCH returned, inside the ${EDIT_BOUND_SECONDS}s bound (GC-2, AC-51)"
    fi
  fi
fi

REDIS_STOPPED=0
if [ "$EDIT_OK" -ne 1 ]; then
  blocked 'AC-2-e2e-5' 'the redirect was not established as serving the current destination, so a degraded run of it would measure nothing'
elif ! docker compose stop redis >/dev/null 2>"$TMPDIR_CHECK/redis-stop.err"; then
  blocked 'AC-2-e2e-5' "docker compose stop redis exited non-zero, so the cache was never taken away and nothing about degradation was measured: $(one_line <"$TMPDIR_CHECK/redis-stop.err")"
else
  REDIS_STOPPED=1
  visit "/$LINK_SLUG"
  status="$(visit_status)"
  location="$(visit_header location)"
  if [ "$status" = 'TRANSPORT-ERROR' ]; then
    fail 'AC-2-e2e-5' "with redis stopped, GET $REDIRECT_URL/<slug> could not be reached at all: $(visit_body)"
  elif [ "$status" != '302' ]; then
    fail 'AC-2-e2e-5' "with redis stopped the redirect answered $status, not 302: the cache is a dependency rather than a cache. Every read must answer 'unavailable' and fall through to Postgres (D-2-09, redirect-cache.md invariant 2, ADR-0012)"
  elif [ "$location" != "$LINK_DESTINATION_EDITED" ]; then
    fail 'AC-2-e2e-5' "with redis stopped the redirect answered 302 to \"$location\", not the current destination: it is serving something other than what Postgres holds"
  else
    pass 'AC-2-e2e-5' 'with the redis service stopped the redirect still answered 302 with the current destination, resolved from Postgres'
  fi
fi

if [ "$REDIS_STOPPED" -ne 1 ]; then
  blocked 'AC-2-e2e-6' 'redis was never stopped, so there is nothing to recover from'
elif ! docker compose start redis >/dev/null 2>"$TMPDIR_CHECK/redis-start.err"; then
  fail 'AC-2-e2e-6' "docker compose start redis exited non-zero, so the service did not come back: $(one_line <"$TMPDIR_CHECK/redis-start.err")"
else
  redis_waited=0
  while [ "$redis_waited" -lt 60 ]; do
    [ "$(service_health redis)" = 'healthy' ] && break
    sleep 2; redis_waited=$((redis_waited + 2))
  done
  visit "/$LINK_SLUG"
  status="$(visit_status)"
  location="$(visit_header location)"
  if [ "$(service_health redis)" != 'healthy' ]; then
    fail 'AC-2-e2e-6' "redis is '$(service_health redis)' and not healthy ${redis_waited}s after start; the redirect answered $status"
  elif [ "$status" != '302' ] || [ "$location" != "$LINK_DESTINATION_EDITED" ]; then
    fail 'AC-2-e2e-6' "redis is healthy again but the redirect answered $status to \"$location\", not 302 to the current destination: the client did not reconnect (ADR-0012's retry strategy) or it is serving a record from before the stop"
  else
    pass 'AC-2-e2e-6' "redis reached healthy ${redis_waited}s after start and the redirect still answered 302 with the current destination"
  fi
fi

if [ "$UP_OK" -ne 1 ]; then
  blocked 'AC-2-e2e-7' 'the stack did not come up, so nothing is serving the 404'
else
  visit "/$UNKNOWN_SLUG"
  status="$(visit_status)"
  csp="$(visit_header content-security-policy)"
  nosniff="$(visit_header x-content-type-options)"
  # A scan over an empty body finds no stack, so the page is identified first and the scan
  # below is only meaningful because it ran over the real one.
  page="$(node -e '
const fs = require("node:fs");
const body = fs.readFileSync(process.argv[1], "utf8");
if (body.indexOf("<title>Link not found</title>") === -1) { console.log("NOT-THE-404-PAGE"); process.exit(0); }
const SHAPES = [
  ["a stack frame", /\bat\s+\S+\s+\(/],
  ["a source location", /\.(?:ts|js|mjs|cjs):\d+:\d+/],
  ["a node internal", /node:internal/],
  ["a dependency path", /node_modules/],
  ["a repository path", /\/apps\/api\//],
  ["an error class name", /[A-Za-z]*Error:/],
];
for (const [label, pattern] of SHAPES) { if (pattern.test(body)) { console.log(label); process.exit(0); } }
console.log("CLEAN");
' "$TMPDIR_CHECK/visit.body")"
  if [ "$status" = 'TRANSPORT-ERROR' ]; then
    fail 'AC-2-e2e-7' "GET $REDIRECT_URL/<unknown slug> could not be reached: $(visit_body)"
  elif [ "$status" != '404' ]; then
    fail 'AC-2-e2e-7' "a slug no link holds answered $status, not 404 (decision order step 6; this surface answers 302 or 404 and never a 5xx, invariant 1)"
  elif [ "$page" = 'NOT-THE-404-PAGE' ]; then
    fail 'AC-2-e2e-7' "the 404's body is not the rendered not-found page, so what it does carry was never scanned: $(visit_body)"
  elif [ "$page" != 'CLEAN' ]; then
    fail 'AC-2-e2e-7' "the 404's body carries $page: a visitor is told the link does not work and never how the server is built (invariant 1's other half; the error goes to the log, not to the response)"
  elif [ "$csp" = 'ABSENT' ]; then
    fail 'AC-2-e2e-7' 'the 404 carries no Content-Security-Policy; the per-response CSP belongs on this response and on no other (redirect-resolution.md, header table)'
  elif [ "${csp#*frame-ancestors}" = "$csp" ]; then
    fail 'AC-2-e2e-7' "the 404's Content-Security-Policy is \"$csp\" and names no frame-ancestors directive: it REPLACES helmet's, and frame-ancestors does not fall back to default-src, so this response would carry no framing policy at all (D-2-14, the open half of F-280)"
  elif [ "$nosniff" != 'nosniff' ]; then
    fail 'AC-2-e2e-7' "the 404 carries X-Content-Type-Options \"$nosniff\", not \"nosniff\""
  else
    pass 'AC-2-e2e-7' 'a slug no link holds answered 404 with the rendered not-found page, a Content-Security-Policy naming frame-ancestors, X-Content-Type-Options nosniff, and no stack, source location or error class anywhere in the body'
  fi
fi

# ---------------------------------------------------------------------------
# DOD-1 / DOD-2: `docker compose up` twice in a row, with an idempotent seed
#
# The census is taken by the superuser, which is the only connection that can see a row
# the seed might have inserted under a second id: shortkit_app sees only the tenant
# matching app.tenant_id, so under RLS a doubling is invisible to it.
# ---------------------------------------------------------------------------

printf '\n-- second up\n' >&2
if [ "$UP_OK" -eq 1 ]; then
  BEFORE="$(census || true)"
  if with_timeout "$UP_TIMEOUT" docker compose up -d --wait; then
    pass 'DOD-1' 'a second `up` against the existing volume returned 0'
    AFTER="$(census || true)"
    if [ -z "$BEFORE" ] || [ -z "$AFTER" ]; then
      fail 'DOD-2' "could not count rows in tenants before/after the second up (before='$BEFORE' after='$AFTER'): $(census_err)"
    elif [ "$BEFORE" = '0' ]; then
      fail 'DOD-2' 'there were no rows in tenants after the first up, so idempotency is not being measured'
    elif [ "$BEFORE" = "$AFTER" ]; then
      pass 'DOD-2' "tenants held $BEFORE row(s) before and after the second up"
    else
      fail 'DOD-2' "tenants went from $BEFORE row(s) to $AFTER: the seed is not idempotent"
    fi
  else
    fail 'DOD-1' 'a second `up` exited non-zero; the failing service is named in the output above'
    blocked 'DOD-2' 'the second up failed, so nothing can be concluded about the row count'
  fi
else
  blocked 'DOD-1' 'the first `up` did not succeed, so a second one measures nothing'
  blocked 'DOD-2' 'the first `up` did not succeed, so there is no seeded data to count'
fi

# ---------------------------------------------------------------------------
# DOD-3: data survives `docker compose restart`
#
# ADR-0036: `restart` restarts the exited one-shots too and ignores depends_on
# conditions, so `migrate` and `seed` come back against a Postgres that is not yet
# accepting connections and exit non-zero. That is expected and is not what this clause
# measures. The clause measures the data, which is ADR-0032's whole reason for a named
# volume rather than the test stack's tmpfs.
# ---------------------------------------------------------------------------

printf '\n-- restart\n' >&2
if [ "$UP_OK" -eq 1 ]; then
  BEFORE_RESTART="$(census || true)"
  docker compose restart || printf 'note: `docker compose restart` exited non-zero; see ADR-0036 on the one-shots.\n' >&2

  waited=0
  while [ "$waited" -lt 120 ]; do
    [ "$(service_health postgres)" = 'healthy' ] && break
    sleep 2; waited=$((waited + 2))
  done

  AFTER_RESTART="$(census || true)"
  if [ "$(service_health postgres)" != 'healthy' ]; then
    fail 'DOD-3' "Postgres did not return to healthy within ${waited}s of 'docker compose restart'"
  elif [ -z "$BEFORE_RESTART" ] || [ -z "$AFTER_RESTART" ]; then
    fail 'DOD-3' "could not count rows in tenants across the restart (before='$BEFORE_RESTART' after='$AFTER_RESTART'): $(census_err)"
  elif [ "$BEFORE_RESTART" = '0' ]; then
    fail 'DOD-3' 'table tenants was empty before the restart, so survival of the seeded data is not being measured'
  elif [ "$BEFORE_RESTART" = "$AFTER_RESTART" ]; then
    pass 'DOD-3' "tenants still holds $AFTER_RESTART row(s) after 'docker compose restart'"
  else
    fail 'DOD-3' "tenants went from $BEFORE_RESTART row(s) to $AFTER_RESTART across 'docker compose restart': the data did not survive"
  fi
else
  blocked 'DOD-3' 'the first `up` did not succeed, so there is no data to survive a restart'
fi

summarise_and_exit
