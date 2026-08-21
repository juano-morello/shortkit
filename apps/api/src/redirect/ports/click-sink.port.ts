/**
 * Contract: docs/contracts/click-events.md ("Interfaces", "Invariants"),
 *           redirect-resolution.md (decision step 7)
 * ADR: adr-0010-click-event-write-path.md, adr-0011-branding-port.md (the same inversion)
 * Produced by: TASK-2-06 (the declaration). Bound by TASK-2-09's `ClicksModule`.
 *
 * ============================================================================
 * THE SECOND PORT, THE SAME DIRECTION, FOR THE SAME REASON (D-2-10).
 * ============================================================================
 *
 * The clicks module imports this module's token and binds the buffer to it; nothing here
 * imports the clicks module. Injected with `@Optional()`, so an unbound sink is a no-op and
 * the redirect module still boots and still answers, which is the state item 2's wave 3
 * ships in, and the reason the compose end-to-end check is sequenced after wave 4 rather
 * than claiming click rows nothing writes yet.
 *
 * ADR-0011's cost applies here too and its answer is TASK-2-09's: a production-module-graph
 * test asserting the token IS bound, because `@Optional()` degrades silently otherwise.
 *
 * ============================================================================
 * WHAT THE REDIRECT HANDS OVER, AND WHAT IT DELIBERATELY DOES NOT (GC-R).
 * ============================================================================
 *
 * NOT an `ip_hash`, and not a client address either. `ip_hash` is
 * HMAC(CLICK_IP_HASH_KEY, `${tenantId}:${ip}`) and the key is the clicks module's binding;
 * computing it here would put both the pseudonymisation key and the raw address inside the
 * redirect module, and GC-R says the raw IP exists in the trusted-address read's return
 * value and nowhere else. So the sink is handed the REQUEST'S HEADERS, a bag the handler
 * already holds, and the adapter behind the token performs the trusted read
 * (`readTrustedClientAddress`, never XFF, never the BFF pair) and the HMAC on its own side,
 * where the key lives. The redirect module never names an address, and F-320's
 * declared-header rule stays enforced in one place.
 *
 * `enqueue` is SYNCHRONOUS, allocation-only, returns no promise and cannot throw
 * (`click-events.md`, AC-2-35). The handler calls it exactly once, on `kind === 'redirect'`,
 * before the response is written, and guards the call anyway: a click that fails must never
 * turn a 302 into a 404 (AC-59).
 */

/** The Nest token TASK-2-09's `ClicksModule` binds the buffer to. */
export const REDIRECT_CLICK_SINK = Symbol('REDIRECT_CLICK_SINK');

/** Request headers as Node hands them over. Read by the adapter, never by this module. */
export type RedirectRequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Everything the resolved decision knows. `tenantId` and `domainId` come from the record
 * the resolution already read (or, from TASK-2-07, the cached one), so the click write
 * needs no second lookup and stays inside GC-5.
 */
export interface RedirectClickInput {
  readonly linkId: string;
  readonly domainId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly headers: RedirectRequestHeaders;
}

export interface RedirectClickSink {
  enqueue(input: RedirectClickInput): void;
}
