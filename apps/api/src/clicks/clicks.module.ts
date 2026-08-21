/**
 * Contract: docs/contracts/click-events.md
 * ADR: adr-0010-click-event-write-path.md, adr-0011-branding-port.md (the inversion this
 *      binds the other half of), adr-0020
 * Decision: D-2-10 (the redirect declares `REDIRECT_CLICK_SINK`; this module binds it),
 *           D-2-17 (`CLICK_IP_HASH_KEY` is a declared binding)
 * Produced by: TASK-2-09 (item 2, wave 4).
 *
 * ============================================================================
 * THE ARROW POINTS THIS WAY, AND THAT IS THE WHOLE POINT (GC-N).
 * ============================================================================
 *
 * This module imports the redirect module's TOKEN FILE and binds the buffer to it. Nothing
 * in `apps/api/src/redirect/**` imports anything here: the static import scan in
 * `redirect-isolation.spec.ts` is what keeps that true, so the redirect keeps no dependency
 * on the clicks module, on drizzle, or on `CLICK_IP_HASH_KEY`.
 *
 * `@Optional()` ON THE CONSUMER'S SIDE MEANS A MISSING BINDING DEGRADES SILENTLY, which is
 * ADR-0011's named cost and the reason `clicks.module.spec.ts` asserts the token IS bound in
 * the PRODUCTION module graph. Without that test, deleting the line below would leave every
 * redirect answering correctly and no click row ever written, with a green suite.
 *
 * `LinksModule` IS IMPORTED FOR `LinkRepository`, which it exports, rather than registering a
 * second copy (the 1b-W3-08 finding, closed there): the read route resolves its link through
 * the same repository the link routes use, so "another tenant's link is a 404" is one rule in
 * one place. `AuthorizationModule` is imported for `WorkspaceAuthorizer`, which Form B calls.
 *
 * THE BUFFER IS EXPORTED so `main.ts` can reach it for the `SIGTERM` drain (ADR-0010: the
 * drain is bounded at 5 s and registered beside the app close path). It is the only provider
 * here that anything outside this module holds.
 *
 * ============================================================================
 * `@Global()`, AND IT IS THE MECHANISM THAT MAKES THE INVERSION WORK AT ALL. MEASURED.
 * ============================================================================
 *
 * ADR-0011 and D-2-10 describe the binding as "the other module binds the token and
 * `AppModule` imports both", and that description is incomplete in a way only the first
 * actual binding could expose. Nest resolves a provider from the CONSUMER'S module scope: a
 * token bound here reaches `RedirectController` only if this module exports it AND the
 * redirect module imports this one, which GC-N forbids and the port's own docblock rules
 * out ("nothing here imports the clicks module"). Measured on the shipped graph before this
 * line existed: every redirect answered 302, `@Optional()` handed the controller `null`, and
 * NO CLICK ROW WAS EVER WRITTEN, with `app.get(REDIRECT_CLICK_SINK, { strict: false })`
 * resolving the buffer perfectly, because a non-strict `get` searches the whole container, so even
 * a module-graph test can be green while the injection point is empty.
 *
 * `@Global()` registers the exports in the root injector, so the consumer needs no import
 * and the arrow keeps pointing the permitted way. It is the narrowest fix available: the two
 * exported symbols, and no import edge anywhere. `clicks.module.spec.ts` now asserts what
 * the controller actually RECEIVED rather than what the container holds, which is the
 * assertion that would have caught this.
 *
 * Item 3 inherits the same requirement for `REDIRECT_BRANDING_PORT`: the module that binds
 * it has to make it globally visible too, or the redirect will render the default page
 * forever while every test agrees the port is bound.
 */
import { Global, Module } from '@nestjs/common';

import { AuthorizationModule } from '../common/authorization/authorization.module';
import { LinksModule } from '../links/links.module';
import { REDIRECT_CLICK_SINK } from '../redirect/ports/click-sink.port';

import { ClickEventBuffer } from './click-event-buffer';
import { ClickEventReaderRepository } from './click-event.reader';
import { ClickEventWriterRepository } from './click-event.writer';
import { ClicksController } from './clicks.controller';
import { ClicksService } from './clicks.service';
import { CLICK_IP_HASH_KEY, clickIpHashKeyFor } from './ip-hash';

@Global()
@Module({
  imports: [AuthorizationModule, LinksModule],
  controllers: [ClicksController],
  providers: [
    /**
     * Read when the module compiles, not when this file is imported and not per enqueue.
     * `main.ts` has already refused to boot without the variable by then (D-2-17); a graph
     * compiled outside `main.ts` (`app.module.spec.ts`, the in-process integration suites), which
     * gets an ephemeral key and one warn line, which is the branch `ip-hash.ts` explains.
     */
    { provide: CLICK_IP_HASH_KEY, useFactory: (): Buffer => clickIpHashKeyFor(process.env) },
    ClickEventWriterRepository,
    ClickEventReaderRepository,
    ClickEventBuffer,
    // The binding ADR-0011's lesson requires a test for. `useExisting`, so the redirect's
    // sink and the drain's buffer are ONE instance: two would mean the drain flushed a
    // buffer nobody had enqueued into.
    { provide: REDIRECT_CLICK_SINK, useExisting: ClickEventBuffer },
    ClicksService,
  ],
  // The token FIRST, because it is the one the redirect injects and the one `@Global()`
  // exists for; the buffer, because `main.ts` drains it.
  exports: [REDIRECT_CLICK_SINK, ClickEventBuffer],
})
export class ClicksModule {}
