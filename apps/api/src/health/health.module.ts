/**
 * Produced by: TASK-003
 *
 * A module rather than a controller registered straight on `AppModule`, so the composition
 * root keeps naming feature modules and nothing else.
 */
import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
