import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from './app.module';

describe('AppModule', () => {
  let moduleRef: TestingModule | null = null;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = null;
  });

  it('compiles as a Nest composition root', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(AppModule)).toBeInstanceOf(AppModule);
  });

  it('starts with no feature modules registered', () => {
    expect(Reflect.getMetadata('imports', AppModule)).toEqual([]);
  });
});
