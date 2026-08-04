import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

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
