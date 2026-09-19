import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Logger } from 'nestjs-pino';

import { WorkerModule } from './app/worker.module';
import { startWorkerHealthServer } from './app/worker-health';
import { WorkerRunner } from './app/worker-runner';
import { ensureWritableDirectory } from './common/fs/ensure-dir';
import { loadConfig } from './config/config.loader';
import { parseEnv } from './config/env.schema';

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const config = await loadConfig(env, process.env);
  await ensureWritableDirectory(env.STORAGE_DIR);

  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env, config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // SIGTERM / SIGINT -> onApplicationShutdown on every provider, then close.
  app.enableShutdownHooks();
  await app.init();

  const runner = app.get(WorkerRunner);
  const health =
    env.WORKER_HEALTH_PORT === 0
      ? undefined
      : await startWorkerHealthServer(
          env.WORKER_HEALTH_PORT,
          env.HTTP_HOST,
          runner,
          app.get<Connection>(getConnectionToken()),
          () => new Date(),
        );

  await runner.waitUntilStopped();
  health?.close();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`pecmailer worker failed to start\n${message}\n`);
  process.exitCode = 1;
});
