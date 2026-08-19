import { Injectable, Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import {
  NO_TENANT_TRANSACTION_METADATA,
  NoTenantTransaction,
  PUBLIC_ROUTE_METADATA,
  Public,
  TENANT_SCOPED_REPOSITORY_METADATA,
  TenantScopedRepository,
} from './tenancy/tenant-context';

/**
 * ADR-0001 accepts one piece of extra configuration: `apps/api` compiles through
 * unplugin-swc because esbuild does not emit `emitDecoratorMetadata`, and NestJS
 * resolves constructor dependencies from that metadata. Nothing else in the API
 * fails loudly when the transform regresses — providers just resolve to
 * undefined — so the toolchain gets its own assertion.
 */
@Injectable()
class Dependency {
  readonly value = 'resolved';
}

@Injectable()
class Consumer {
  constructor(readonly dependency: Dependency) {}
}

@Module({ providers: [Dependency, Consumer] })
class MetadataProbeModule {}

describe('decorator metadata', () => {
  it('records constructor parameter types', () => {
    expect(Reflect.getMetadata('design:paramtypes', Consumer)).toEqual([Dependency]);
  });

  it('lets Nest inject a dependency declared only by its constructor type', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MetadataProbeModule] }).compile();

    expect(moduleRef.get(Consumer).dependency).toBeInstanceOf(Dependency);
    expect(moduleRef.get(Consumer).dependency.value).toBe('resolved');

    await moduleRef.close();
  });
});

/**
 * TASK-006 — the three tenancy decorators in `tenancy/tenant-context.ts`, which until wave 5
 * threw `not implemented`. Contract: `docs/contracts/tenant-context.md` (`Public` takes a
 * required justification), `docs/contracts/isolation-coverage.md` ("Discovery" 1 and 2: the
 * justification is printed and `TENANT_SCOPED_REPOSITORY_METADATA` marks a provider). ADR-0020.
 *
 * What is asserted is the metadata each decorator writes, read the way both readers read it —
 * `Reflector.getAllAndOverride` over `[handler, class]` — so a change to WHERE the key lands
 * fails here before it fails a request. The request-level behaviour (the guard skipping, the
 * interceptor skipping or opening a transaction) is `tenancy/tenant-transaction.interceptor.spec.ts`.
 */
describe('the tenancy decorators write the metadata their readers read', () => {
  const reflector = new Reflector();

  class RouteShapedProbe {
    @Public('spec: a handler-level public route')
    publicHandler(): void {}

    @NoTenantTransaction('spec: a handler that opens its own transactions')
    ownTransactions(): void {}

    plain(): void {}
  }

  @Public('spec: a class-level public controller')
  class ClassPublicProbe {
    read(): void {}
  }

  @NoTenantTransaction('spec: a class-level own-transaction controller')
  class ClassOwnTransactionsProbe {
    read(): void {}
  }

  @TenantScopedRepository()
  class RepositoryProbe {}

  class UnmarkedProvider {}

  it('@Public(justification) sets PUBLIC_ROUTE_METADATA to the justification on a handler', () => {
    const handler = RouteShapedProbe.prototype.publicHandler;

    expect(Reflect.getMetadata(PUBLIC_ROUTE_METADATA, handler)).toBe('spec: a handler-level public route');
    expect(reflector.getAllAndOverride(PUBLIC_ROUTE_METADATA, [handler, RouteShapedProbe])).toBe(
      'spec: a handler-level public route',
    );
    // Only the key it owns: a public handler is not thereby an own-transaction one.
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION_METADATA, handler)).toBeUndefined();
  });

  it('@Public(justification) on a class covers every handler through the handler-then-class read', () => {
    const handler = ClassPublicProbe.prototype.read;

    expect(Reflect.getMetadata(PUBLIC_ROUTE_METADATA, handler)).toBeUndefined();
    expect(Reflect.getMetadata(PUBLIC_ROUTE_METADATA, ClassPublicProbe)).toBe('spec: a class-level public controller');
    expect(reflector.getAllAndOverride(PUBLIC_ROUTE_METADATA, [handler, ClassPublicProbe])).toBe(
      'spec: a class-level public controller',
    );
  });

  it('@NoTenantTransaction(justification) sets NO_TENANT_TRANSACTION_METADATA on a handler and on a class', () => {
    const handler = RouteShapedProbe.prototype.ownTransactions;

    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION_METADATA, handler)).toBe(
      'spec: a handler that opens its own transactions',
    );
    expect(Reflect.getMetadata(PUBLIC_ROUTE_METADATA, handler)).toBeUndefined();
    expect(
      reflector.getAllAndOverride(NO_TENANT_TRANSACTION_METADATA, [
        ClassOwnTransactionsProbe.prototype.read,
        ClassOwnTransactionsProbe,
      ]),
    ).toBe('spec: a class-level own-transaction controller');
  });

  it('a handler carrying neither decorator carries neither key, on itself or its class', () => {
    const targets = [RouteShapedProbe.prototype.plain, RouteShapedProbe];

    expect(reflector.getAllAndOverride(PUBLIC_ROUTE_METADATA, targets)).toBeUndefined();
    expect(reflector.getAllAndOverride(NO_TENANT_TRANSACTION_METADATA, targets)).toBeUndefined();
  });

  it('@TenantScopedRepository() sets TENANT_SCOPED_REPOSITORY_METADATA on the class and nothing else', () => {
    expect(Reflect.getMetadata(TENANT_SCOPED_REPOSITORY_METADATA, RepositoryProbe)).toBe(true);
    expect(Reflect.getMetadata(TENANT_SCOPED_REPOSITORY_METADATA, UnmarkedProvider)).toBeUndefined();
    expect(Reflect.getMetadata(PUBLIC_ROUTE_METADATA, RepositoryProbe)).toBeUndefined();
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION_METADATA, RepositoryProbe)).toBeUndefined();
  });

  it('the three keys are distinct symbols, so a reader of one cannot be satisfied by another', () => {
    expect(new Set([PUBLIC_ROUTE_METADATA, NO_TENANT_TRANSACTION_METADATA, TENANT_SCOPED_REPOSITORY_METADATA]).size).toBe(3);
  });

  it('@Public() and @NoTenantTransaction() refuse an empty or whitespace-only justification at decoration time', () => {
    // The report prints the justification beside the route (ADR-0020); a blank one is a hole
    // nobody explained, and the refusal has to happen at module load, not on a request.
    for (const blank of ['', ' ', '\n\t']) {
      expect(() => Public(blank), JSON.stringify(blank)).toThrow(/non-empty justification/);
      expect(() => NoTenantTransaction(blank), JSON.stringify(blank)).toThrow(/non-empty justification/);
    }
    // And a value that is not a string at all, which the types forbid and a JS caller can pass.
    expect(() => Public(undefined as unknown as string)).toThrow(/non-empty justification/);
    expect(() => NoTenantTransaction(undefined as unknown as string)).toThrow(/non-empty justification/);
  });

  it('a non-empty justification is kept as written, so the report prints what the author wrote', () => {
    class Kept {
      @Public('  padded but not empty  ')
      read(): void {}
    }

    expect(Reflect.getMetadata(PUBLIC_ROUTE_METADATA, Kept.prototype.read)).toBe('  padded but not empty  ');
  });
});
