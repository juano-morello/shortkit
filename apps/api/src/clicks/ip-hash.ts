/**
 * Contract: docs/contracts/click-events.md ("`ip_hash`"), trusted-client-address.md
 * ADR: adr-0010-click-event-write-path.md, adr-0051 / adr-0058 (the BETTER_AUTH_SECRET
 *      posture this copies), adr-0029 (no configured value in error text), adr-0040 (a
 *      boot-time choice keys on a declared property, never on `NODE_ENV`)
 * Decision: D-2-17 (`CLICK_IP_HASH_KEY` is required at boot)
 * Produced by: TASK-2-09 (item 2, wave 4).
 * Consumed by: `main.ts` (`assertClickIpHashKeyConfigured`), `clicks.module.ts`
 *              (`clickIpHashKeyFor`), `click-event-buffer.ts` (`clickIpHash`).
 *
 * ============================================================================
 * `CLICK_IP_HASH_KEY` IS READ IN THIS FILE AND NOWHERE ELSE. NEVER `NODE_ENV` (GC-B).
 * ============================================================================
 *
 * The shape is `BETTER_AUTH_SECRET`'s, which D-2-17 chose deliberately: a missing
 * pseudonymisation key must not silently produce reversible hashes, so the assertion is
 * UNCONDITIONAL and the refusal is `boot_precondition: 'click_ip_hash_key'`. There is no
 * `MAIL_TRANSPORT`-style absent-selects-a-binding branch, because the harmless option does
 * not exist: a constant fallback key is a hash every deployment sharing that constant can
 * reverse, and writing no row at all would silently empty the stream SC-6 exists for.
 *
 * HMAC, NOT A BARE HASH, and the reason is arithmetic: a plain SHA-256 of an IPv4 address is
 * reversible by exhausting four billion candidates in seconds. THE MESSAGE IS SALTED WITH
 * `tenant_id` (F-009), so the same visitor produces different hashes for different tenants
 * and two operators comparing exports cannot confirm the same person clicked in both.
 *
 * STATED RATHER THAN SOLVED (`click-events.md`): the key is per-deployment, not per-tenant,
 * so an operator holding their own export who also obtains this key can confirm-by-guess
 * whether a specific address appears in their own data. Rotating breaks `ip_hash` continuity
 * across the rotation, so there is no scheduled rotation; the key rotates on suspected
 * compromise only.
 *
 * NO REFUSAL QUOTES THE VALUE (ADR-0029). The messages name the rule and the generation
 * command; the operator has the environment in front of them.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { logger } from '../observability/logger';

export const CLICK_IP_HASH_KEY_ENV = 'CLICK_IP_HASH_KEY';

/**
 * The Nest token `ClicksModule` binds the resolved key to, and the ONE way the buffer gets
 * it. A `process.env` read inside `enqueue` would put the decision on the visitor's path and
 * make the value un-substitutable in a spec; binding it makes the environment read happen
 * once, when the module compiles.
 */
export const CLICK_IP_HASH_KEY = Symbol('CLICK_IP_HASH_KEY');

/** `click-events.md`: "a 32-byte secret from the environment". */
export const CLICK_IP_HASH_KEY_LENGTH_BYTES = 32;

/** 32 bytes of base64url, unpadded, is exactly 43 characters. */
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

/** `click-events.md`: base64url of the HMAC, truncated. 22 characters is 132 bits. */
export const CLICK_IP_HASH_LENGTH = 22;

export const CLICK_IP_HASH_KEY_UNSET_MESSAGE =
  'CLICK_IP_HASH_KEY is not set. It is the HMAC key that turns a visitor address into ' +
  'click_events.ip_hash, and without it the process would either store a reversible hash or ' +
  'store nothing. Generate one with: node -e \'console.log(require("node:crypto").randomBytes(32).toString("base64url"))\'. ' +
  'See apps/api/.env.example and docs/contracts/click-events.md.';

export const CLICK_IP_HASH_KEY_MALFORMED_MESSAGE =
  `CLICK_IP_HASH_KEY is not ${String(CLICK_IP_HASH_KEY_LENGTH_BYTES)} bytes of base64url ` +
  '(43 characters, A-Z a-z 0-9 - _). This refusal names the rule and never the value. ' +
  'Generate one with: node -e \'console.log(require("node:crypto").randomBytes(32).toString("base64url"))\'. ' +
  'See docs/contracts/click-events.md.';

/**
 * The refusal, and what `main.ts`'s `bootstrap().catch` maps onto
 * `boot_precondition: 'click_ip_hash_key'`, the arrangement `RedisBindingError`,
 * `MailBindingError` and `AuthBindingError` already have, so the line an operator reads names
 * WHICH declaration refused (F-245).
 *
 * A class of its own rather than `main.ts`'s module-private `BootPreconditionError`, for the
 * reason `mail-transport.ts` and `redis-client.ts` record: `main.ts` calls `bootstrap()` at
 * module scope, so a leaf module importing that class would boot the API.
 */
export class ClickIpHashKeyError extends Error {
  readonly binding = 'click_ip_hash_key' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ClickIpHashKeyError';
  }
}

/**
 * The declared key, or `undefined` when the variable is absent. THE ONE READ; the boot
 * assertion and the module factory both go through it, so a refusal and a construction
 * cannot disagree on what "set" means.
 *
 * Empty is unset (`CLICK_IP_HASH_KEY=` is what an env file produces for an absent variable).
 * A value that is SET AND MALFORMED is not absence: it throws, everywhere, because a typo
 * that silently minted an ephemeral key would produce a stream whose hashes stop matching
 * across a restart while every assertion stayed green.
 *
 * The length is checked on the DECODED buffer as well as on the encoded shape, because
 * `Buffer.from(value, 'base64url')` drops what it cannot read rather than throwing: without
 * the pattern, a 43-character string of punctuation would decode to a short key.
 */
export function readClickIpHashKey(env: NodeJS.ProcessEnv): Buffer | undefined {
  const declared = env[CLICK_IP_HASH_KEY_ENV];

  if (declared === undefined || declared.trim() === '') {
    return undefined;
  }

  if (!BASE64URL_32_BYTES.test(declared)) {
    throw new ClickIpHashKeyError(CLICK_IP_HASH_KEY_MALFORMED_MESSAGE);
  }

  const key = Buffer.from(declared, 'base64url');

  if (key.length !== CLICK_IP_HASH_KEY_LENGTH_BYTES) {
    throw new ClickIpHashKeyError(CLICK_IP_HASH_KEY_MALFORMED_MESSAGE);
  }

  return key;
}

/**
 * The boot half (D-2-17). Called UNCONDITIONALLY from `assertBootPreconditions()`, beside the
 * other `process.env` reads and ahead of anything that opens a connection. Reads no
 * `NODE_ENV`: the discriminator is the declaration itself.
 */
export function assertClickIpHashKeyConfigured(env: NodeJS.ProcessEnv): void {
  if (readClickIpHashKey(env) === undefined) {
    throw new ClickIpHashKeyError(CLICK_IP_HASH_KEY_UNSET_MESSAGE);
  }
}

/**
 * The key the buffer is constructed with.
 *
 * ============================================================================
 * ABSENCE MINTS AN EPHEMERAL KEY. IT NEVER FALLS BACK TO A CONSTANT, AND IT NEVER THROWS
 * HERE.
 * ============================================================================
 *
 * `main.ts` refuses to boot without the variable, so a SERVING process always has the
 * declared key. What reaches this branch is a module graph compiled outside `main.ts`:
 * `app.module.spec.ts`, and every integration suite that builds `AppModule` in-process. A
 * factory that threw there would turn another card's shipped test red for a variable that
 * card never declared; a factory that fell back to a CONSTANT would put a reversible hash
 * one forgotten variable away from a real deployment.
 *
 * Thirty-two random bytes per process is the option that can do no harm: rows still land, no
 * two processes agree on a hash, and nothing about the value is guessable. One warn line
 * says so: the MAIL_TRANSPORT / D-2-09 shape, absence landing loudly on the harmless thing.
 * The line carries `code` and nothing else (GC-G: item 2 appends `link_id` and `attempts` to
 * `LOGGABLE_FIELDS`, and nothing here needs a field).
 */
export function clickIpHashKeyFor(env: NodeJS.ProcessEnv): Buffer {
  const declared = readClickIpHashKey(env);

  if (declared !== undefined) {
    return declared;
  }

  logger.warn(
    { code: 'click_ip_hash_key_ephemeral' },
    'CLICK_IP_HASH_KEY is not set, so this process minted a random one: click rows are still ' +
      'written and no hash is reversible, but ip_hash values do not survive a restart and do ' +
      'not match any other process. A serving process refuses to boot without the variable ' +
      '(boot_precondition: click_ip_hash_key). See docs/contracts/click-events.md.',
  );

  return randomBytes(CLICK_IP_HASH_KEY_LENGTH_BYTES);
}

/**
 * `base64url(hmacSha256(key, `${tenantId}:${ip}`)).slice(0, 22)`, character for character as
 * `click-events.md` writes it.
 *
 * SYNCHRONOUS AND ALLOCATION-ONLY, because it runs inside `enqueue`, which
 * `click-events.md` requires to perform no I/O and create no promise. One HMAC over a short
 * message is a few microseconds and it is the whole added cost of GC-R's "the raw address
 * exists in the read's return value and nowhere else": hashing at enqueue is what keeps the
 * address out of the buffer, out of a row, out of a log line and out of an error.
 */
export function clickIpHash(key: Buffer, tenantId: string, ip: string): string {
  return createHmac('sha256', key)
    .update(`${tenantId}:${ip}`)
    .digest('base64url')
    .slice(0, CLICK_IP_HASH_LENGTH);
}
