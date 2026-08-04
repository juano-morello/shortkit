import { Module } from '@nestjs/common';

/**
 * Composition root. Feature modules register here, each added by its own TASK.
 *
 * The redirect module stays isolated from links, workspaces and tenancy: it is
 * imported here and imports nothing from them.
 */
@Module({
  imports: [],
})
export class AppModule {}
