/**
 * THE HTTP ATTEMPT MECHANISM. Produced by: TASK-014.
 *
 * Contract: docs/contracts/isolation-coverage.md, docs/contracts/auth-tokens.md,
 *           docs/contracts/workspaces.md ("Endpoints").
 *
 * ===========================================================================
 * WHAT THIS ADDS, AND WHY THE TABLE BATTERY COULD NOT ADD IT
 * ===========================================================================
 *
 * Every attempt the rest of the harness runs is SQL through `withTenantTransaction`
 * against a live Postgres as `shortkit_app`. SC-4 asks for the one thing the harness has
 * never done: an attempt issued as an AUTHENTICATED REQUEST by a second tenant's operator,
 * signed in concurrently. That is a different surface — the composition root's guard, the
 * tenant-transaction interceptor, the exception filter and the repository, in front of the
 * same policies — and a leak can hide in any of them.
 *
 * `signedInTenants()` mints two real sessions through the shipped auth surface: two real
 * users, each with a real membership and a real minted token, against a child API booted
 * by `api-server.ts` (the only place the auth mount exists, ADR-0013). NOT a hand-forged
 * JWT: a forged token would prove the policy and skip the guard, and SC-4 is about what a
 * SIGNED-IN operator can reach. Each tenant's `tid` is the tenant its own signup created.
 *
 * `endpointAccess(spec)` is the HTTP analogue of `tableAccess()`: it returns a
 * `TenantScopedSurfaceRegistration` whose methods are HTTP attempts, so the existing
 * scoring, census and report read them exactly as they read a SQL attempt. Each method
 * issues a request as one tenant against a row belonging to the other and returns a
 * `CrossTenantAttemptResult`.
 *
 * ===========================================================================
 * A REFUSAL IS NOT A PASS, AND OVER HTTP THAT IS EASIER TO GET WRONG (F-296, F-342)
 * ===========================================================================
 *
 * A 404 from `PATCH /api/workspaces/:workspaceId` proves the row was invisible to the
 * policy, OR that the id was wrong, OR that the route was misspelled, OR (since TASK-1b-06)
 * that the actor holds no membership on its own row — and only the first is isolation. So every write attempt runs a POSITIVE CONTROL in the same attempt: the OWNER
 * of the addressed row issues the SAME request and must get a 2xx. If the owner's request
 * does not succeed, the route or the id is wrong, the cross-tenant refusal proves nothing,
 * and the attempt is scored `unverified` (it THROWS, which the runner classifies as a
 * non-policy refusal — F-294). Only when the owner's request succeeds AND the cross-tenant
 * request is refused AND the database shows no mutation is the attempt a pass.
 *
 * A 2xx that returned or mutated the target's row is a fail, and a MUTATION is verified
 * against the DATABASE — the runner's per-attempt census either side of the attempt, and
 * `assertNoTenantIdAltered()` — never against the response body, which an endpoint can
 * shape however it likes.
 *
 * Both directions always: the runner attempts every method as (A, B) and (B, A).
 *
 * ===========================================================================
 * SINCE TASK-1b-10: A SECOND GROUP, THE INVITATION ROUTES, AND THREE SHAPES THE FIRST
 * GROUP NEVER NEEDED
 * ===========================================================================
 *
 * `registrations.ts` builds two `EndpointAccessConfig`s over the same two signed-in
 * operators: the workspace routes (table `workspaces`) and the invitation routes (table
 * `invitations`, each tenant holding one seeded invitation whose RAW TOKEN the fixture keeps
 * in memory). Three spec fields exist for that group and are documented on
 * `EndpointAttemptSpec` below: `auth: 'anonymous'` for the one `@Public()` route,
 * `buildOwnRequest` for the positive control an argument swap cannot express, and
 * `targetMutated` for a refusal that must also be tied to the database — the accept route's
 * 409, which is raised before any statement (D-04) and so proves nothing on its own.
 */
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  authServerEnv,
  clearSignupState,
  jwtClaims,
  membershipsFor,
  mintToken,
  signIn,
  signUp,
  usersFor,
} from '../support/auth-fixture';
import { querySql } from '../support/psql';
import { migrationDsn } from '../support/rls-fixture';

import type {
  CrossTenantAttemptResult,
  HttpMethod,
  SurfaceId,
  TenantFixture,
  TenantScopedMethod,
  TenantScopedSurfaceRegistration,
} from './coverage';

/** One signed-in operator: a real user, membership and token minted through the surface. */
export interface SignedInTenant {
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly bearerToken: string;
  /** The session cookie, so a fresh token can be minted as the run goes on (no expiry race). */
  readonly cookie: string;
}

export interface SignedInTenants {
  readonly a: SignedInTenant;
  readonly b: SignedInTenant;
  /** The child API the sessions were minted against, and where endpoint attempts go. */
  readonly server: ApiServer;
}

/**
 * Signs up, signs in and mints for one address, and reads back the rows the surface wrote.
 * The tenant is the one signup created (the uninvited branch's generated uuid, ADR-0015);
 * the token's `tid` is that tenant, read from the claims rather than assumed.
 */
async function signInOneTenant(server: ApiServer, email: string): Promise<SignedInTenant> {
  const signedUp = await signUp(server, email, POLICY_COMPLIANT_PASSWORD);

  if (signedUp.status !== 200) {
    throw new Error(`sign-up for ${email} answered ${String(signedUp.status)}: ${signedUp.raw}`);
  }

  const signedIn = await signIn(server, email, POLICY_COMPLIANT_PASSWORD);

  if (signedIn.status !== 200) {
    throw new Error(`sign-in for ${email} answered ${String(signedIn.status)}: ${signedIn.raw}`);
  }

  const minted = await mintToken(server, signedIn.cookie);
  const token = (minted.body as { token?: unknown }).token;

  if (minted.status !== 200 || typeof token !== 'string') {
    throw new Error(`token mint for ${email} answered ${String(minted.status)}: ${minted.raw}`);
  }

  const [user] = usersFor(email);

  if (user === undefined) {
    throw new Error(`sign-up wrote no user row for ${email}.`);
  }

  const [membership] = membershipsFor(user.id);

  if (membership === undefined) {
    throw new Error(`sign-up wrote no membership row for ${email}.`);
  }

  const claimedTenant = jwtClaims(token).tid;

  if (claimedTenant !== membership.tenantId) {
    throw new Error(
      `the minted token's tid (${String(claimedTenant)}) is not the membership's tenant ` +
        `(${membership.tenantId}) for ${email}.`,
    );
  }

  return {
    tenantId: membership.tenantId,
    userId: user.id,
    email,
    bearerToken: token,
    cookie: signedIn.cookie,
  };
}

const SIGNED_IN_EMAIL_A = 'isolation-endpoint-a@example.com';
const SIGNED_IN_EMAIL_B = 'isolation-endpoint-b@example.com';

/** The two addresses the harness signs up, exposed so a caller can clear their signup state. */
export const SIGNED_IN_EMAILS = [SIGNED_IN_EMAIL_A, SIGNED_IN_EMAIL_B] as const;

/** The invite link's base in the child (see `signedInTenants`); a fixture value, never fetched. */
const SIGNED_IN_WEB_ORIGIN = 'http://localhost:3000';

/**
 * Two concurrent signed-in operators, minted through the shipped auth surface against a
 * freshly booted child API. The caller stops `server` and clears the two addresses'
 * signup state in `afterAll`.
 */
export async function signedInTenants(): Promise<SignedInTenants> {
  // A run killed before `afterAll` — a CI timeout, an OOM, a SIGKILL — leaves the two
  // addresses' user rows behind, and the next run's sign-up would then fail at `beforeAll`
  // with "already exists" instead of measuring anything. Clearing first makes the fixture
  // self-heal the way `createTenantFixtures()` does; on a clean database this is a no-op.
  clearSignupState(...SIGNED_IN_EMAILS);

  // TASK-1b-10. `WEB_APP_ORIGINS` beside the auth fixture's environment: the invitation
  // endpoint group's positive control is a real `POST /api/invitations`, whose after-commit
  // dispatch renders the mail — and the link base is that variable's first concrete origin
  // (`inviteLinkOrigin()`). Unset, every positive control would still be 201 but would
  // leave a `mail_dispatch_failed` error line per attempt in the child's output. The
  // transport stays UNSET (`none`, `NoopMailSender`): the rendered message, raw token and
  // all, is built and dropped, and no byte of it reaches this process or a log line.
  const server = await startApiServer({
    env: (baseUrl) => ({ ...authServerEnv(baseUrl), WEB_APP_ORIGINS: SIGNED_IN_WEB_ORIGIN }),
  });

  try {
    const a = await signInOneTenant(server, SIGNED_IN_EMAIL_A);
    const b = await signInOneTenant(server, SIGNED_IN_EMAIL_B);

    return { a, b, server };
  } catch (error) {
    await server.stop();

    throw error;
  }
}

/** Where the runner's per-attempt census sees this endpoint's rows, in this tenant. */
export interface EndpointAttemptContext {
  /** The id of the row this tenant owns in the endpoint's table. */
  seededRowId(tenantId: string): string;
}

export interface EndpointRequest {
  readonly path: string;
  readonly body?: unknown;
}

/**
 * How a correctly isolated endpoint denies the cross-tenant attempt. A `status` refusal is
 * a 404 or 403 that counts as a pass ONLY when the owner's positive control succeeded;
 * `absent-from-list` is a read whose isolation is the target's row not appearing;
 * `created-under-actor` is a create whose isolation is the new row belonging to the actor.
 */
export type EndpointRefusal =
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'absent-from-list' }
  | { readonly kind: 'created-under-actor' };

export interface EndpointAttemptSpec {
  /** The method name in the surface id's log form and the run log. */
  readonly name: string;
  readonly method: HttpMethod;
  /** The route PATTERN, e.g. `/api/workspaces/:workspaceId` — never a concrete path (log-safe). */
  readonly route: string;
  readonly httpKind: 'read' | 'write';
  readonly reaches: 'existing-row' | 'new-row';
  /**
   * REQUIRED, like every registered method. All five workspace routes are owner-qualified:
   * every statement the endpoint issues carries `tenant_id = currentTenantId()` or sets it
   * on insert, and the route offers no parameter or body field by which a caller names
   * another tenant — so the endpoint enforces owner-qualification whatever the request says.
   */
  readonly qualification: 'owner-qualified' | 'unqualified';
  /** The CROSS-TENANT request: `actor` acting against `target`'s row. */
  buildRequest(actor: TenantFixture, target: TenantFixture, ctx: EndpointAttemptContext): EndpointRequest;
  readonly expectedRefusal: EndpointRefusal;
  /**
   * TASK-1b-10. THE POSITIVE CONTROL, when swapping `buildRequest`'s arguments does not
   * build it. For every route that addresses a ROW — get, rename, archive, list-by-workspace,
   * revoke, accept — `buildRequest(target, actor)` is "the actor on its own row" and needs
   * no override. `POST /api/invitations/lookup` addresses a TOKEN whose prefix the attack
   * swaps: swapping the arguments would build the target's secret under the actor's
   * prefix, a second attack rather than a control. So the control is stated on its own:
   * the actor's untouched token, which must answer 200.
   */
  buildOwnRequest?(actor: TenantFixture, ctx: EndpointAttemptContext): EndpointRequest;
  /**
   * TASK-1b-10. `bearer` (default) sends the actor's freshly minted token; `anonymous`
   * sends NO Authorization header — the one `@Public()` route is attempted the way an
   * invitee reaches it, and a bearer on it would prove nothing about the route's own
   * authorisation (the capability token, ADR-0021).
   */
  readonly auth?: 'bearer' | 'anonymous';
  /**
   * TASK-1b-10. A DATABASE READBACK after a `status` refusal: `true` when the TARGET's rows
   * changed in a way the request could have caused, judged as one affected row (a leak),
   * whatever the status said. `POST /api/invitations/accept` uses it: the 409 is an
   * application refusal raised BEFORE any statement (D-04), so on its own it is a status the
   * harness accepts only with the owner's 200 beside it; the readback — the target's
   * invitation still `pending`, no `memberships` row for the actor's user in the target —
   * is what ties the refusal to the database rather than to the response body.
   */
  targetMutated?(actor: TenantFixture, target: TenantFixture, ctx: EndpointAttemptContext): boolean;
  /**
   * TASK-1b-10. Hand-set on the `@Public()` route only (coverage.ts, `TenantScopedMethod`).
   * Left undefined, the route is reported `authenticated: true`, which every other route is.
   */
  readonly authenticated?: boolean;
  readonly publicJustification?: string;
  readonly usesCapabilityToken?: boolean;
}

export interface EndpointAccessConfig {
  readonly subject: string;
  readonly table: string;
  readonly ownerColumn: string;
  /** Puts the endpoint's rows back for both tenants. Called before every attempt. */
  readonly reset: () => void | Promise<void>;
  /** Where requests go: the child API for the real routes, an in-process app for a control. */
  readonly baseUrl: string;
  /** A FRESH bearer token for a tenant, minted from its session cookie so it cannot expire. */
  readonly tokenFor: (tenantId: string) => Promise<string>;
  /** The row a tenant owns in `table`, for a request that addresses the target's row. */
  readonly seededRowId: (tenantId: string) => string;
  readonly endpoints: readonly EndpointAttemptSpec[];
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

async function issue(
  baseUrl: string,
  method: HttpMethod,
  request: EndpointRequest,
  token: string | undefined,
): Promise<HttpResult> {
  const payload = request.body === undefined ? undefined : JSON.stringify(request.body);

  const response = await fetch(`${baseUrl}${request.path}`, {
    method,
    headers: {
      // TASK-1b-10. NO KEEP-ALIVE ON AN ATTEMPT SOCKET. Every attempt is separated from
      // the next by a reset and two censuses — several psql spawns, seconds apart — and
      // undici keeps the socket to the child alive across that gap while the child's
      // `keepAliveTimeout` (5 s) closes it from the other end. The reuse of a socket the
      // server has just closed surfaces as `fetch failed: other side closed` on a request
      // that never reached the route, and the runner would score that `unverified` — a red
      // run naming a surface that was never attempted. `connection: close` is honoured by
      // undici (measured on Node 24: the header arrives and the server closes after the
      // response), so every request here opens its own socket and none can be stale.
      connection: 'close',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { body: payload }),
  });

  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as raw text */
  }

  return { status: response.status, body, raw };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Thrown when the positive control did not succeed, or the cross-tenant request answered a
 * status the endpoint's refusal rule does not recognise. The runner catches it and scores
 * the attempt `unverified` — a red run naming the surface, never a pass (F-294, F-296).
 */
class UnverifiedAttempt extends Error {}

/** The owner of the row the cross-tenant request addresses. For a create, the target too. */
function ownerReadsBackCreated(
  table: string,
  ownerColumn: string,
  id: string,
): string | undefined {
  const [row] = querySql<{ owner: string }>(
    migrationDsn(),
    `select ${ownerColumn} as owner from ${table} where id = :'id'::uuid`,
    { variables: { id } },
  );

  return row?.owner;
}

/**
 * The HTTP analogue of `tableAccess()`. Each spec becomes one `TenantScopedMethod` whose
 * `attempt` issues a real request and returns a `CrossTenantAttemptResult` the existing
 * scoring reads. The surface id is `route:${method} ${route}`, so the report names the
 * ROUTE rather than a repository method.
 */
export function endpointAccess(config: EndpointAccessConfig): TenantScopedSurfaceRegistration {
  const ctx: EndpointAttemptContext = { seededRowId: config.seededRowId };

  const methods: TenantScopedMethod[] = config.endpoints.map((spec) => {
    const surfaceId: SurfaceId = `route:${spec.method} ${spec.route}`;

    const attempt = async (
      actor: TenantFixture,
      target: TenantFixture,
    ): Promise<CrossTenantAttemptResult> => {
      const request = spec.buildRequest(actor, target, ctx);
      // The `@Public()` route is attempted with NO bearer (TASK-1b-10): its authorisation is
      // the capability token in the body, and the harness measures the tenant routing of
      // that token, not the guard.
      const actorToken = spec.auth === 'anonymous' ? undefined : await config.tokenFor(actor.id);
      // The actor's own request: on its own row by argument swap, or as the spec states it
      // when the swap would build a second attack rather than a control (lookup).
      const ownRequest = (): EndpointRequest =>
        spec.buildOwnRequest === undefined
          ? spec.buildRequest(target, actor, ctx)
          : spec.buildOwnRequest(actor, ctx);

      // ======================================================================
      // POSITIVE CONTROL. The actor performs the SAME operation on ITS OWN row, and it
      // must succeed. That is what proves a later 404 is isolation and not a bad id or a
      // misspelled route — the route answers 2xx for a legitimate request, and the runner's
      // census premise has already shown the target owns the row this attempt addresses.
      //
      // It runs on the ACTOR'S OWN row on purpose: the runner's foreign-row census excludes
      // the actor's own rows, so a mutating positive control here changes nothing the census
      // brackets and needs no restore. A positive control that mutated the TARGET's row and
      // was then re-seeded would change that row's timestamps, and the census — which reads a
      // per-row digest — would report the re-seed itself as a cross-tenant change (measured).
      // ======================================================================
      if (spec.expectedRefusal.kind === 'status') {
        // Get/rename/archive: the actor operates on its own row. `buildRequest` addresses its
        // second argument's row, so swapping the arguments builds the actor-on-own request.
        const own = ownRequest();
        const positive = await issue(config.baseUrl, spec.method, own, actorToken);

        if (!isSuccess(positive.status)) {
          throw new UnverifiedAttempt(
            `${surfaceId}: the actor's own request answered ${String(positive.status)}, so a ` +
              `cross-tenant refusal proves nothing about isolation (the route is wrong): ${positive.raw}`,
          );
        }
      } else if (spec.expectedRefusal.kind === 'absent-from-list') {
        // Read: the actor lists its own and must see its own seeded row, which proves the
        // route returns data — so an empty cross-tenant list is isolation, not a dead route.
        const own = ownRequest();
        const positive = await issue(config.baseUrl, spec.method, own, actorToken);
        const items = (positive.body as { items?: { id?: string }[] }).items ?? [];

        if (positive.status !== 200 || !items.some((item) => item.id === config.seededRowId(actor.id))) {
          throw new UnverifiedAttempt(
            `${surfaceId}: the actor's own list did not answer 200 with its seeded row, so an ` +
              `empty cross-tenant list proves nothing: ${positive.raw}`,
          );
        }
      }
      // `created-under-actor` needs no separate positive control: the cross-tenant create
      // is itself the actor's own create, and the interpret below already requires its 2xx.

      const crossTenant = await issue(config.baseUrl, spec.method, request, actorToken);

      switch (spec.expectedRefusal.kind) {
        case 'status': {
          if (crossTenant.status === spec.expectedRefusal.status) {
            // TASK-1b-10. The refusal status is only half the answer when the spec can read
            // the target back: a 409 raised before any statement, or a 404 from a route
            // that wrote first and refused second, both leave the database as the judge.
            return { rowsAffected: spec.targetMutated?.(actor, target, ctx) === true ? 1 : 0 };
          }

          if (isSuccess(crossTenant.status)) {
            // A 2xx on the target's row is the leak; the row count judges it and the census
            // verifies the mutation against the database independently.
            return { rowsAffected: 1 };
          }

          throw new UnverifiedAttempt(
            `${surfaceId}: the cross-tenant request answered ${String(crossTenant.status)}, ` +
              `neither the owner's success nor the expected refusal ` +
              `${String(spec.expectedRefusal.status)}: ${crossTenant.raw}`,
          );
        }

        case 'absent-from-list': {
          if (crossTenant.status !== 200) {
            throw new UnverifiedAttempt(
              `${surfaceId}: the cross-tenant list answered ${String(crossTenant.status)}, ` +
                `not 200: ${crossTenant.raw}`,
            );
          }

          const items = (crossTenant.body as { items?: { id?: string }[] }).items ?? [];

          // Only the target's seeded row is a leak; the actor's own rows are legitimate.
          return {
            rows: items
              .filter((item) => item.id === config.seededRowId(target.id))
              .map(() => ({ [config.ownerColumn]: target.id })),
          };
        }

        case 'created-under-actor': {
          if (!isSuccess(crossTenant.status)) {
            throw new UnverifiedAttempt(
              `${surfaceId}: the cross-tenant create answered ${String(crossTenant.status)}, ` +
                `not a 2xx: ${crossTenant.raw}`,
            );
          }

          const createdId = (crossTenant.body as { id?: unknown }).id;

          if (typeof createdId !== 'string') {
            throw new UnverifiedAttempt(
              `${surfaceId}: the cross-tenant create returned no id to verify ownership ` +
                `against the database: ${crossTenant.raw}`,
            );
          }

          const owner = ownerReadsBackCreated(config.table, config.ownerColumn, createdId);

          // Owned by the target is the leak — the create planted a row under another tenant;
          // owned by the actor is the only correct answer.
          return { rowsAffected: owner === target.id ? 1 : 0 };
        }
      }
    };

    return {
      name: spec.name,
      kind: spec.httpKind,
      reaches: spec.reaches,
      qualification: spec.qualification,
      surfaceId,
      ...(spec.authenticated === undefined ? {} : { authenticated: spec.authenticated }),
      ...(spec.publicJustification === undefined ? {} : { publicJustification: spec.publicJustification }),
      ...(spec.usesCapabilityToken === undefined ? {} : { usesCapabilityToken: spec.usesCapabilityToken }),
      attempt,
    };
  });

  return {
    subject: config.subject,
    table: config.table,
    ownerColumn: config.ownerColumn,
    reset: config.reset,
    methods,
  };
}
