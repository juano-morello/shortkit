import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

const DEFAULT_PORT = 3001;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // ADR-0006: every controller answers under /api. GET /health stays at the
  // root so the platform health check never depends on the API surface.
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });

  await app.listen(process.env.PORT ?? DEFAULT_PORT);
}

void bootstrap();
