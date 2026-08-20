import { Controller, Get, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { REQUEST_CONTEXT_KEY } from '../../src/auth/auth.guard';
import { revocationStore } from '../../src/auth/revocation-store';
import type { RequestContext } from '../../src/tenancy/tenant-context';
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
import { assertTenantsIsMigrated } from '../support/rls-fixture';

/**
 * STORY-002 — AC-10, AC-11 and AC-13's premise, end to end. TASK-005, wave 4.
 *
 * Contract: `docs/contracts/auth-tokens.md` ("Verification, performed by `AuthGuard`",
 * "Invariants a caller may rely on" 1 and 3, "What the implementer must guarantee": the JWKS
 * is fetched from the process's own mount). ADR-0013, ADR-0053, ADR-0059.
 *
 * ============================================================================
 * TWO PROCESSES, ON PURPOSE: THE REAL ISSUER, AND THE REAL GUARD IN FRONT OF A PROBE.
 * ============================================================================
 *
 * The child is the composition root booted by `api-server.ts` — the only place the auth
 * mount exists, so the only place a real sign-in can happen and a real token can be minted
 * against a real `/api/auth/jwks`. But that child carries no guarded route yet: `GET /health`
 * is public by design and TASK-006 and item 1b bring the first tenant-scoped handler. So the
 * guarded route is a probe controller registered beside `AppModule` IN THIS PROCESS, and the
 * guard in front of it is the real `APP_GUARD` from `AuthModule`, reading the real
 * `revocationStore` and the real `cachedKeySet` — nothing is overridden. `BETTER_AUTH_URL`
 * in this process is set to the child's origin, so the guard's `iss`/`aud` check and its
 * JWKS fetch both point at the child. A token minted by the child is verified here against
 * the key set the child served: that is the round trip AC-11 names.
 *
 * What this shape cannot show, and says so rather than approximating: sign-out in the child
 * writes to the CHILD's revocation store, and the guard here reads THIS process's (ADR-0053,
 * process-local by decision), so "sign out, then the token is refused" is not observable
 * across the two. The revoked-`jti` case is asserted with a write to the store the guard
 * reads, using the real `jti` of a real token. The one-process version of that assertion
 * belongs to the first TASK that ships a guarded route in the child (STORY-005's AC-21).
 * AC-12 (expiry) needs a token whose `exp` has passed and the child's signing key is not
 * available here to mint one; it is `src/auth/auth.guard.spec.ts`'s and `auth-claims.spec.ts`'s.
 */

const EMAIL = 'wave4-guard@example.com';

/** Every request that reached the probe handler. */
const handlerRuns: string[] = [];

@Controller('api/guard-probe')
class GuardProbeController {
  @Get()
  read(@Req() request: Record<PropertyKey, unknown>): RequestContext | null {
    handlerRuns.push('read');
    return (request[REQUEST_CONTEXT_KEY] as RequestContext | undefined) ?? null;
  }
}

let serverBoot: Promise<ApiServer>;
let server: ApiServer;

let app: INestApplication | undefined;
let probeBaseUrl: string;

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

async function probe(headers: Record<string, string> = {}): Promise<Probe> {
  const response = await fetch(`${probeBaseUrl}/api/guard-probe`, { headers });
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, body, raw };
}

/** Sign up, sign in, mint: the token a real BFF would hold, and the rows behind it. */
async function realToken(): Promise<{ token: string; userId: string; tenantId: string }> {
  const signedUp = await signUp(server, EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);

  const signedIn = await signIn(server, EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);

  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  const token = (minted.body as { token?: unknown }).token;
  expect(typeof token).toBe('string');

  const [user] = usersFor(EMAIL);
  expect(user, `signup wrote no user row for ${EMAIL}`).toBeDefined();
  const [membership] = membershipsFor(user.id);
  expect(membership, 'signup wrote no membership row').toBeDefined();

  return { token: token as string, userId: user.id, tenantId: membership.tenantId };
}

beforeAll(() => {
  serverBoot = startApiServer({ env: authServerEnv });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;

  if (app === undefined) {
    // The guard reads `BETTER_AUTH_URL` per request and the JWKS cache reads it per fetch, so
    // stubbing it after the child's port is known is enough; nothing here read it at import.
    vi.stubEnv('BETTER_AUTH_URL', server.baseUrl);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [GuardProbeController],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    probeBaseUrl = await app.getUrl();
  }

  assertTenantsIsMigrated();
  clearSignupState(EMAIL);
  handlerRuns.length = 0;
}, 180_000);

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  await server?.stop();
});

describe('AuthGuard against a token minted by the real issuer', () => {
  it('a token from a real sign-in passes the guard, verified against the JWKS the issuer serves', async () => {
    const { token, userId, tenantId } = await realToken();

    const result = await probe({ authorization: `Bearer ${token}` });

    expect(result.status, result.raw).toBe(200);
    expect(handlerRuns).toEqual(['read']);

    // Invariant 1: `tenantId` on the request IS the tenant the membership row names, and it
    // came from the claims alone — the guard made no database read to get it.
    const claims = jwtClaims(token);
    // `email` since TASK-1b-05 (D-06): the claim, verbatim — the address the account was created with.
    expect(result.body).toEqual({ userId, tenantId, email: EMAIL, emailVerified: false });
    expect(result.body).toEqual({ userId: claims.sub, tenantId: claims.tid, email: claims.email, emailVerified: claims.ev });
  });

  it('AC-10: the same route with no Authorization header is 401 unauthenticated and the handler never runs', async () => {
    const result = await probe();

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'unauthenticated', message: expect.any(String) });
    expect(handlerRuns).toEqual([]);
  });

  it('AC-11: a real token whose payload was altered after signing is 401 unauthenticated', async () => {
    const { token } = await realToken();
    const [header, payload, signature] = token.split('.');
    const altered = { ...(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>), tid: '00000000-0000-4000-8000-000000000000' };
    const forged = `${header}.${Buffer.from(JSON.stringify(altered)).toString('base64url')}.${signature}`;

    const result = await probe({ authorization: `Bearer ${forged}` });

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'unauthenticated', message: expect.any(String) });
    expect(handlerRuns).toEqual([]);
  });

  it('AC-11: a token carrying the real claims but signed by a key the issuer never published is 401 unauthenticated', async () => {
    const { token } = await realToken();
    const claims = jwtClaims(token);
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });

    const stranger = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'not-in-the-jwks' })
      .sign(privateKey);

    const result = await probe({ authorization: `Bearer ${stranger}` });

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'unauthenticated', message: expect.any(String) });
    expect(handlerRuns).toEqual([]);
  });

  it('a real token whose session id has been revoked in the store the guard reads is 401 unauthenticated', async () => {
    const { token } = await realToken();
    const jti = jwtClaims(token).jti;
    expect(typeof jti).toBe('string');

    // Before the write, the token passes; after it, the same token is refused. Both halves are
    // asserted so the refusal is shown to be the revocation and not something else.
    expect((await probe({ authorization: `Bearer ${token}` })).status).toBe(200);

    await revocationStore.revoke(jti as string);
    const result = await probe({ authorization: `Bearer ${token}` });

    expect(result.status, result.raw).toBe(401);
    expect(result.body).toEqual({ code: 'unauthenticated', message: expect.any(String) });
  });

  it('GET /health on the composition root answers 200 with no header, so the global guard exempts the platform probe', async () => {
    const response = await fetch(`${server.baseUrl}/health`);
    const raw = await response.text();

    expect(response.status, raw).toBe(200);
    expect((JSON.parse(raw) as { status?: unknown }).status).toBe('ok');
  });
});
